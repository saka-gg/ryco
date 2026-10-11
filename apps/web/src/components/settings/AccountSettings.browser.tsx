// Behaviour of the hosted account settings surface, against the real runtime
// stores with only the controller's network-touching actions stubbed.
//
// What is pinned here is not markup. It is the things that would be a security
// defect rather than a cosmetic one:
//
//   * a destructive action never fires before an explicit confirmation;
//   * a freshly minted set of recovery codes cannot be destroyed by an accident
//     — no Escape, no backdrop, no close button, one explicit acknowledgement;
//   * a TOTP field appears only after the Hub has demanded a step-up, and only
//     for the gate that has a step-up out of it, and the retry carries the code;
//   * a committed credential is never reported as a failed one, because that
//     invites a second ceremony and a duplicate credential;
//   * a request that never answers can always be abandoned;
//   * secret material never reaches a persisted store, the URL, or a DOM
//     attribute, and an *acknowledged* secret is cleared from the runtime rather
//     than merely hidden — while a secret whose display merely went away (an
//     unmount, a remount at a new position) is kept, because neither of those
//     was the user saying they had saved it.
import "../../index.css";

import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

// Hosted mode, which no browser test gets by default: there is no `.env` in
// this harness, so `isHostedHubMode()` answers false and every hosted gate runs
// as the standard client. See `HostedNodeDirectory.browser.tsx` for the full
// note.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
}));

import {
  HostedHubApiError,
  HOSTED_PASSKEY_UNCONFIRMED_MESSAGE,
  HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE,
  PASSKEY_SESSION_REQUIRED_CODE,
  STEP_UP_REQUIRED_CODE,
  type HostedAccountCommitted,
  type HostedAccountE2eeDevice,
  type HostedAccountRefused,
  type HostedAddPasskeyCommitted,
  type HostedHubPasskey,
  type HostedPasskeyConfirmation,
  type HostedRecoveryCodesCommitted,
} from "@ryco/client-runtime/authorization";

import {
  hostedAccountStore,
  hostedHubController,
  hostedHubStore,
  hostedRecoveryCodeDisplayStore,
} from "../../hostedHub/state";
import { resetHubRoutesForTests } from "../../hostedHub/hubRoutes";
import { hostedHubApi } from "../../hostedHub/api";
import { AccountSettingsPanel } from "./AccountSettings";
import {
  STEP_UP_INFERRED_ATTEMPT_LIMIT,
  STEP_UP_UNRESOLVED_MESSAGE,
} from "./AccountSettings.logic";

const STEP_UP_MESSAGE = new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403).message;
const PASSKEY_SESSION_MESSAGE = new HostedHubApiError(PASSKEY_SESSION_REQUIRED_CODE, 403).message;

const RECOVERY_CODES = [
  "aaaa-1111-bbbb",
  "cccc-2222-dddd",
  "eeee-3333-ffff",
  "gggg-4444-hhhh",
] as const;

const TOTP_SECRET = "JBSWY3DPEHPK3PXPZZZZ";
const TOTP_URI = `otpauth://totp/Ryco:ada@example.com?secret=${TOTP_SECRET}&issuer=Ryco`;

const ACCOUNT = {
  id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  displayName: "Ada",
  role: "owner" as const,
  createdAt: 1_700_000_000_000,
  disabledAt: null,
};

const SESSION = {
  id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
  accountId: ACCOUNT.id,
  createdAt: 1_700_000_000_000,
  expiresAt: 1_800_000_000_000,
  lastSeenAt: 1_700_000_000_000,
  revokedAt: null,
  revocationReasonCode: null,
};

const E2EE_GRANT_CANARY = "e2ee-grant-canary-must-never-render-or-persist";

function e2eeDevice(overrides: Partial<HostedAccountE2eeDevice> = {}): HostedAccountE2eeDevice {
  return {
    enrollmentId: `enr_${"e".repeat(22)}` as never,
    enrollmentRevision: 3 as never,
    accountAuthEpoch: 1 as never,
    deviceAuthEpoch: 1 as never,
    platform: "darwin",
    appVersion: "1.2.3",
    reportedKeyBacking: "secure-enclave",
    deviceLabel: "Studio Mac",
    identityFingerprint: "i".repeat(43) as never,
    agreementFingerprint: "a".repeat(43) as never,
    clientPrekeyCertificateDigest: "c".repeat(43) as never,
    certificateExpiresAt: 1_800_000_000_000,
    status: "active",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    lastUsedAt: 1_700_000_400_000,
    revokedAt: null,
    ...overrides,
  };
}

function passkey(overrides: Partial<HostedHubPasskey> = {}): HostedHubPasskey {
  return {
    id: "pkey_aaaaaaaaaaaaaaaaaaaaaa",
    label: "Work laptop",
    createdAt: 1_700_000_000_000,
    lastUsedAt: 1_700_000_500_000,
    backupEligible: true,
    backupState: true,
    revokedAt: null,
    revocationReasonCode: null,
    ...overrides,
  };
}

/** A promise plus the handle that settles it, for a request that has not landed. */
function deferred(): { readonly promise: Promise<void>; readonly land: () => void } {
  let land = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    land = resolve;
  });
  return { promise, land };
}

/**
 * Publish an account-action outcome the way the runtime does — the discriminated
 * value to the caller **and** the matching error slots to the store — and return
 * it.
 *
 * The pair is what a stub has to reproduce faithfully: a double that returned a
 * refusal without writing the store, or wrote the store without returning the
 * refusal, would let a surface that reads the wrong one of the two pass.
 */
function publishCommitted<T extends HostedAccountCommitted>(outcome: T): T {
  hostedAccountStore.setState({ errorMessage: null, errorCode: null, errorCodeInferred: false });
  return outcome;
}

function publishRefusal(overrides: Partial<HostedAccountRefused> = {}): HostedAccountRefused {
  const outcome: HostedAccountRefused = {
    status: "refused",
    reason: "request-failed",
    errorCode: null,
    wireErrorCode: null,
    inferredErrorCode: false,
    errorMessage: null,
    ...overrides,
  };
  hostedAccountStore.setState({
    errorMessage: outcome.errorMessage,
    errorCode: outcome.errorCode,
    errorCodeInferred: outcome.inferredErrorCode,
  });
  return outcome;
}

/**
 * The step-up refusal exactly as the runtime builds it: the code is
 * *synthesised* from a bare `forbidden` — the Hub never sends `step_up_required`
 * — so `inferredErrorCode` is true and `wireErrorCode` is what actually arrived.
 */
function stepUpRefusal(): HostedAccountRefused {
  return publishRefusal({
    errorCode: STEP_UP_REQUIRED_CODE,
    wireErrorCode: "forbidden",
    inferredErrorCode: true,
    errorMessage: STEP_UP_MESSAGE,
  });
}

function committed(): HostedAccountCommitted {
  return publishCommitted({ status: "committed" });
}

function addPasskeyCommitted(confirmation: HostedPasskeyConfirmation): HostedAddPasskeyCommitted {
  return publishCommitted({ status: "committed", confirmation, passkey: null });
}

function recoveryCodesCommitted(displayed: boolean): HostedRecoveryCodesCommitted {
  return publishCommitted({ status: "committed", displayed });
}

/**
 * Give any dismissal, navigation, or store write that was going to happen the
 * chance to happen. Assertions that something did *not* occur are worthless
 * against a retrying matcher that passes on the first frame.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => {
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB request failed."));
    });
  });
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return requestResult(indexedDB.open(name));
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Every record in every IndexedDB database this origin holds. */
async function indexedDbSnapshot(): Promise<string> {
  const parts: Array<string> = [];
  for (const { name } of await indexedDB.databases()) {
    if (name === undefined) continue;
    parts.push(name);
    const database = await openDatabase(name);
    try {
      const storeNames = Array.from(database.objectStoreNames);
      if (storeNames.length === 0) continue;
      const transaction = database.transaction(storeNames, "readonly");
      for (const storeName of storeNames) {
        const store = transaction.objectStore(storeName);
        parts.push(
          storeName,
          describeValue(await requestResult(store.getAllKeys())),
          describeValue(await requestResult(store.getAll())),
        );
      }
    } finally {
      database.close();
    }
  }
  return parts.join("\n");
}

/**
 * Everything the browser would still be holding after a reload.
 *
 * Both web storages are the obvious places, and they are not the only ones: a
 * secret written to IndexedDB or set as a cookie survives a reload exactly as
 * well, and a snapshot blind to those would report "never persisted" for a
 * surface that had persisted them. The self-check below proves this can see all
 * four before any test leans on it.
 */
async function persistedStorageSnapshot(): Promise<string> {
  const parts: Array<string> = [document.cookie];
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null) continue;
      parts.push(key, storage.getItem(key) ?? "");
    }
  }
  parts.push(await indexedDbSnapshot());
  return parts.join("\n");
}

/**
 * Every attribute value in the document.
 *
 * `textContent` cannot see an `<img src>`, a `data:` URI, or a `value` — which
 * is exactly where a secret rendered by the wrong primitive would end up, still
 * in the DOM and still readable, while a textContent assertion reported it gone.
 */
function domAttributeSnapshot(): string {
  const parts: Array<string> = [];
  for (const element of Array.from(document.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      parts.push(`${attribute.name}=${attribute.value}`);
    }
  }
  return parts.join("\n");
}

/** The outside press that ordinarily dismisses a dialog. */
function pressBackdrop(): void {
  const backdrop = document.querySelector('[data-slot="dialog-backdrop"]');
  if (!(backdrop instanceof HTMLElement)) throw new Error("Expected a dialog backdrop to press.");
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    backdrop.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        isPrimary: true,
      }),
    );
  }
}

type Mounted = Awaited<ReturnType<typeof render>> & {
  cleanup?: () => Promise<void>;
  unmount?: () => Promise<void>;
};

describe("AccountSettingsPanel", () => {
  let mounted: Mounted | null = null;
  let clipboard: Array<string> = [];

  const mount = async () => {
    mounted = await render(<AccountSettingsPanel />);
    return mounted;
  };

  const teardown = async () => {
    if (!mounted) return;
    const stop = mounted.cleanup ?? mounted.unmount;
    await stop?.call(mounted).catch(() => undefined);
    mounted = null;
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    clipboard = [];
    // Drops any display lease a previous test left behind, which is the only
    // thing the runtime keeps outside its two stores.
    hostedHubController.resetForTests();
    resetHubRoutesForTests();
    hostedHubStore.setState(
      {
        ...hostedHubStore.getInitialState(),
        accountStatus: "authenticated",
        account: ACCOUNT,
        session: SESSION,
      },
      true,
    );
    hostedAccountStore.setState(
      {
        ...hostedAccountStore.getInitialState(),
        passkeys: [passkey()],
        passkeysStatus: "ready",
        security: {
          passwordConfigured: false,
          totpEnrolled: false,
          emailDeliveryConfigured: false,
          email: null,
          externalIdentities: [],
        },
        securityStatus: "ready",
      },
      true,
    );
    // The mount read is a read; it must never be the thing that reaches the Hub
    // in a test about mutations.
    vi.spyOn(hostedHubController, "refreshPasskeys").mockResolvedValue();
    vi.spyOn(hostedHubController, "refreshE2eeDevices").mockResolvedValue();
    vi.spyOn(hostedHubController, "refreshAccountSecurity").mockResolvedValue();
    vi.spyOn(hostedHubController, "refreshExternalIdentityConfiguration").mockResolvedValue();
    vi.spyOn(hostedHubApi, "getPendingExternalIdentity").mockResolvedValue({ status: "none" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          clipboard.push(value);
          return Promise.resolve();
        },
      },
    });
  });

  afterEach(async () => {
    await teardown();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /* --------------------------------------------------- the tools themselves */

  it("shows public native device facts without exposing transient grant material", async () => {
    const device = {
      ...e2eeDevice(),
      // A hostile or accidentally widened runtime record must still not turn
      // grant bytes into presentation data: the component selects a closed
      // public fact list instead of serializing the object it receives.
      deviceGrant: E2EE_GRANT_CANARY,
    } as HostedAccountE2eeDevice;
    hostedAccountStore.setState({
      e2eeDevices: [device],
      e2eeDevicesStatus: "ready",
    });
    const logged: Array<unknown> = [];
    vi.spyOn(console, "log").mockImplementation((...values) => logged.push(values));
    vi.spyOn(console, "info").mockImplementation((...values) => logged.push(values));
    vi.spyOn(console, "warn").mockImplementation((...values) => logged.push(values));
    vi.spyOn(console, "error").mockImplementation((...values) => logged.push(values));

    await mount();

    await expect.element(page.getByText("Encrypted devices")).toBeVisible();
    await expect.element(page.getByText("Studio Mac", { exact: false })).toBeVisible();
    await expect.element(page.getByText(device.identityFingerprint)).toBeVisible();
    await expect.element(page.getByText(device.agreementFingerprint)).toBeVisible();
    await expect.element(page.getByText(/does not protect against a malicious Hub/)).toBeVisible();
    expect(document.body.innerHTML).not.toContain(E2EE_GRANT_CANARY);
    expect(window.location.href).not.toContain(E2EE_GRANT_CANARY);
    expect(await persistedStorageSnapshot()).not.toContain(E2EE_GRANT_CANARY);
    expect(describeValue(logged)).not.toContain(E2EE_GRANT_CANARY);
  });

  it("renames and revokes an enrollment only through explicit bounded actions", async () => {
    const device = e2eeDevice();
    hostedAccountStore.setState({ e2eeDevices: [device], e2eeDevicesStatus: "ready" });
    const rename = vi.spyOn(hostedHubController, "renameE2eeDevice").mockResolvedValue(committed());
    const revoke = vi.spyOn(hostedHubController, "revokeE2eeDevice").mockResolvedValue(committed());

    await mount();
    await page.getByRole("button", { name: "Rename" }).click();
    const name = page.getByLabelText("Device name");
    await name.clear();
    await name.fill("Travel Mac");
    await page.getByRole("button", { name: "Save name" }).click();
    expect(rename).toHaveBeenCalledWith(device.enrollmentId, {
      expectedEnrollmentRevision: device.enrollmentRevision,
      deviceLabel: "Travel Mac",
    });

    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    expect(revoke).not.toHaveBeenCalled();
    await expect.element(page.getByText("Revoke this encrypted device?")).toBeVisible();
    await page.getByRole("button", { name: "Revoke device" }).click();
    expect(revoke).toHaveBeenCalledWith(device.enrollmentId, {
      expectedEnrollmentRevision: device.enrollmentRevision,
      reasonCode: "owner_requested",
    });
  });

  it("shows a bounded GitHub connection row and confirms disconnect", async () => {
    const externalIdentity = {
      provider: "github",
      login: "octocat",
      displayName: "The Octocat",
      connectedAt: 1_700_000_000_000,
      lastUsedAt: null,
    } as const;
    hostedAccountStore.setState({
      externalIdentityConfiguration: {
        version: 1,
        providers: [{ provider: "github", login: true, signup: true, link: true }],
      },
      externalIdentityConfigurationStatus: "ready",
      security: {
        ...hostedAccountStore.getState().security!,
        externalIdentities: [externalIdentity],
      },
    });
    const disconnect = vi
      .spyOn(hostedHubController, "disconnectExternalIdentity")
      .mockResolvedValue({ status: "committed" });

    await mount();
    await expect.element(page.getByText("GitHub · @octocat")).toBeVisible();
    await expect
      .element(page.getByText("Repository access remains separate.", { exact: false }))
      .toBeVisible();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    expect(disconnect).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Disconnect GitHub", exact: true }).click();
    expect(disconnect).toHaveBeenCalledWith("github", {});
  });

  it("finishes a staged browser GitHub link and hides actions without provider policy", async () => {
    const externalIdentity = {
      provider: "github",
      login: "octocat",
      displayName: null,
      connectedAt: 1_700_000_000_000,
      lastUsedAt: null,
    } as const;
    hostedAccountStore.setState({
      externalIdentityConfiguration: null,
      externalIdentityConfigurationStatus: "ready",
      security: {
        ...hostedAccountStore.getState().security!,
        externalIdentities: [externalIdentity],
      },
    });
    vi.mocked(hostedHubApi.getPendingExternalIdentity).mockResolvedValue({
      status: "link",
      externalIdentity,
      expiresAt: 1_800_000_000_000,
    });
    const finish = vi
      .spyOn(hostedHubController, "finishBrowserExternalIdentityConnection")
      .mockResolvedValue({ status: "committed" });

    await mount();
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith("github", {}));
    await expect.element(page.getByText("GitHub · @octocat")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Disconnect", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Connect GitHub", exact: true }))
      .not.toBeInTheDocument();
  });

  it("has a persistence snapshot that can actually see every store a secret could reach", async () => {
    const canary = "canary-3f9c2a";
    const database = "account-settings-snapshot-self-check";
    window.localStorage.setItem("local", `${canary}-local`);
    window.sessionStorage.setItem("session", `${canary}-session`);
    document.cookie = `snapshot-self-check=${canary}-cookie; path=/`;
    const opened = indexedDB.open(database, 1);
    opened.addEventListener("upgradeneeded", () => {
      opened.result.createObjectStore("records");
    });
    const connection = await requestResult(opened);
    await new Promise<void>((resolve, reject) => {
      const transaction = connection.transaction(["records"], "readwrite");
      transaction.objectStore("records").put(`${canary}-indexeddb`, "record");
      transaction.addEventListener("complete", () => {
        resolve();
      });
      transaction.addEventListener("error", () => {
        reject(transaction.error ?? new Error("IndexedDB write failed."));
      });
    });
    connection.close();

    try {
      const persisted = await persistedStorageSnapshot();
      for (const store of ["local", "session", "cookie", "indexeddb"]) {
        expect(persisted, `the snapshot is blind to ${store}`).toContain(`${canary}-${store}`);
      }
    } finally {
      document.cookie = "snapshot-self-check=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      indexedDB.deleteDatabase(database);
    }
  });

  it("dismisses an ordinary dialog on Escape and on a backdrop press", async () => {
    // The control for every "this one does not dismiss" assertion below: if
    // these two gestures were inert in this harness, those assertions would
    // pass without proving anything.
    await mount();
    await page.getByRole("button", { name: "Add passkey" }).click();
    await expect.element(page.getByText("Add a passkey")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Add a passkey")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Add passkey" }).click();
    await expect.element(page.getByText("Add a passkey")).toBeVisible();

    pressBackdrop();
    await expect.element(page.getByText("Add a passkey")).not.toBeInTheDocument();
  });

  /* ------------------------------------------- destructive actions confirm */

  it("shows only the credential actions supported by the confirmed Hub state", async () => {
    await mount();

    await expect.element(page.getByRole("button", { name: "Set password" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Set up" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Delete the fallback password" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Turn off two-factor authentication" }))
      .not.toBeInTheDocument();

    hostedAccountStore.setState({
      security: {
        passwordConfigured: true,
        totpEnrolled: true,
        emailDeliveryConfigured: false,
        email: { address: "ada@example.com", verified: true },
        externalIdentities: [],
      },
      securityStatus: "ready",
    });

    await expect.element(page.getByRole("button", { name: "Change", exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Delete the fallback password" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Turn off two-factor authentication" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Set password" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Set up" })).not.toBeInTheDocument();
    await expect.element(page.getByText(/Verified · ada@example\.com/)).toBeVisible();
  });

  it("hides credential mutations until the Hub security state is known", async () => {
    hostedAccountStore.setState({ security: null, securityStatus: "loading" });

    await mount();

    await expect.element(page.getByText("Checking account security")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Set password" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Change", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Delete the fallback password" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Set up" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Turn off two-factor authentication" }))
      .not.toBeInTheDocument();
  });

  it("retries a stale account security read without discarding the last known state", async () => {
    hostedAccountStore.setState({
      security: {
        passwordConfigured: true,
        totpEnrolled: false,
        emailDeliveryConfigured: false,
        email: null,
        externalIdentities: [],
      },
      securityStatus: "stale",
    });
    const refresh = vi.mocked(hostedHubController.refreshAccountSecurity);

    await mount();
    await expect.element(page.getByText("Account security may be outdated")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Change", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();

    expect(refresh).toHaveBeenLastCalledWith({ force: true });
  });

  it("rotates recovery codes only after an explicit confirmation that says what it destroys", async () => {
    const regenerate = vi
      .spyOn(hostedHubController, "regenerateRecoveryCodes")
      .mockImplementation(async () => {
        hostedHubStore.setState({ recoveryCodes: [...RECOVERY_CODES] });
        return recoveryCodesCommitted(true);
      });

    await mount();
    await page.getByRole("button", { name: "Generate new codes" }).click();

    expect(
      regenerate,
      "the trigger opens a confirmation; it must not rotate on its own",
    ).not.toHaveBeenCalled();
    await expect
      .element(page.getByText(/Every code you have already saved stops working immediately/i))
      .toBeVisible();

    await page.getByRole("button", { name: "Replace codes" }).click();
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it("leaves the saved codes alone when the confirmation is declined", async () => {
    const regenerate = vi
      .spyOn(hostedHubController, "regenerateRecoveryCodes")
      .mockImplementation(async () => recoveryCodesCommitted(true));

    await mount();
    await page.getByRole("button", { name: "Generate new codes" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect
      .element(page.getByText(/Every code you have already saved stops working/i))
      .not.toBeInTheDocument();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("never rotates recovery codes as a side effect of mounting the surface", async () => {
    const regenerate = vi
      .spyOn(hostedHubController, "regenerateRecoveryCodes")
      .mockImplementation(async () => recoveryCodesCommitted(true));

    await mount();
    await expect.element(page.getByText("One-time recovery codes")).toBeVisible();

    expect(regenerate).not.toHaveBeenCalled();
  });

  it("revokes a passkey only after an explicit confirmation", async () => {
    const revoke = vi
      .spyOn(hostedHubController, "revokePasskey")
      .mockImplementation(async () => committed());

    await mount();
    await page.getByRole("button", { name: "Revoke Work laptop" }).click();

    expect(revoke).not.toHaveBeenCalled();
    await expect.element(page.getByText(/will stop working immediately/i)).toBeVisible();

    await page.getByRole("button", { name: "Revoke passkey" }).click();
    expect(revoke).toHaveBeenCalledWith("pkey_aaaaaaaaaaaaaaaaaaaaaa");
  });

  it("warns about the last usable passkey without refusing to revoke it", async () => {
    // The Hub owns this rule and answers `conflict` on the last credential. A
    // client-side disable would be a guess whenever the list is stale — and a
    // client must not enforce a server rule it only inferred. So the blast
    // radius is stated, and the control still works.
    const revoke = vi
      .spyOn(hostedHubController, "revokePasskey")
      .mockImplementation(async () => committed());

    await mount();
    const trigger = page.getByRole("button", { name: "Revoke Work laptop" });
    await expect.element(trigger).toBeEnabled();
    await trigger.click();

    await expect
      .element(page.getByText(/This is the only usable passkey on this account/i))
      .toBeVisible();
    await page.getByRole("button", { name: "Revoke passkey" }).click();
    expect(revoke).toHaveBeenCalledWith("pkey_aaaaaaaaaaaaaaaaaaaaaa");
  });

  it("does not warn about the last passkey when another usable one exists", async () => {
    hostedAccountStore.setState({
      passkeys: [passkey(), passkey({ id: "pkey_bbbbbbbbbbbbbbbbbbbbbb", label: "Phone" })],
      passkeysStatus: "ready",
    });

    await mount();
    await page.getByRole("button", { name: "Revoke Work laptop" }).click();
    await expect
      .element(page.getByText(/This is the only usable passkey on this account/i))
      .not.toBeInTheDocument();
  });

  it("reports the revoke while it is running, on the row being revoked", async () => {
    const pending = deferred();
    vi.spyOn(hostedHubController, "revokePasskey").mockImplementation(async () => {
      hostedAccountStore.setState({ actionStatus: "revoking-passkey" });
      await pending.promise;
      return committed();
    });

    await mount();
    await page.getByRole("button", { name: "Revoke Work laptop" }).click();
    await page.getByRole("button", { name: "Revoke passkey" }).click();

    // A destructive action that reports nothing while it runs reads as a dead
    // control, and invites a second press.
    await vi.waitFor(() => {
      const button = page.getByRole("button", { name: "Revoke Work laptop" }).element();
      expect(button.querySelector('[role="status"]'), "the revoke spinner never renders").not.toBe(
        null,
      );
    });

    pending.land();
  });

  /* -------------------------------------------------------- step-up retry */

  it("asks for a TOTP code only after the Hub demands one, then retries with it", async () => {
    const attempts: Array<{ readonly email: string; readonly totpCode?: string }> = [];
    vi.spyOn(hostedHubController, "requestEmailVerification").mockImplementation(async (input) => {
      attempts.push(input);
      return input.totpCode === undefined ? stepUpRefusal() : committed();
    });

    await mount();

    // A passkey session must never be shown a code field up front — and the
    // client cannot tell which kind of session it is on, so "up front" means
    // "before the Hub has said so".
    await expect
      .element(page.getByRole("textbox", { name: "Authenticator code" }))
      .not.toBeInTheDocument();

    await page.getByRole("textbox", { name: "Email address" }).fill("ada@example.com");
    await page.getByRole("button", { name: "Send verification" }).click();

    await expect.element(page.getByText("Confirm the email change")).toBeVisible();
    expect(attempts).toEqual([{ email: "ada@example.com" }]);

    await page.getByRole("textbox", { name: "Authenticator code" }).fill("123 456");
    await page.getByRole("button", { name: "Confirm code" }).click();

    expect(attempts).toEqual([
      { email: "ada@example.com" },
      { email: "ada@example.com", totpCode: "123456" },
    ]);
    await expect.element(page.getByText("Confirm the email change")).not.toBeInTheDocument();
    await expect.element(page.getByText(/Request accepted by the Hub/i)).toBeVisible();
    // The address has reached the Hub; it does not stay in the field afterwards.
    await expect.element(page.getByRole("textbox", { name: "Email address" })).toHaveValue("");
  });

  it("re-prompts on a rejected code instead of reporting success", async () => {
    const codes: Array<string | undefined> = [];
    vi.spyOn(hostedHubController, "requestEmailVerification").mockImplementation(async (input) => {
      codes.push(input.totpCode);
      return input.totpCode === "654321" ? committed() : stepUpRefusal();
    });

    await mount();
    await page.getByRole("textbox", { name: "Email address" }).fill("ada@example.com");
    await page.getByRole("button", { name: "Send verification" }).click();
    await expect.element(page.getByText("Confirm the email change")).toBeVisible();

    await page.getByRole("textbox", { name: "Authenticator code" }).fill("111111");
    await page.getByRole("button", { name: "Confirm code" }).click();

    // Still open, and the copy no longer claims to know why it failed. This
    // refusal is the runtime's *inferred* `step_up_required` — synthesised from
    // a bare `forbidden` — so the retry copy must also concede that the code may
    // not be the obstacle at all.
    await expect.element(page.getByText(/may not be about the code at all/i)).toBeVisible();
    await expect.element(page.getByText(/Request accepted by the Hub/i)).not.toBeInTheDocument();

    await page.getByRole("textbox", { name: "Authenticator code" }).fill("654321");
    await page.getByRole("button", { name: "Confirm code" }).click();

    expect(codes).toEqual([undefined, "111111", "654321"]);
    await expect.element(page.getByText(/Request accepted by the Hub/i)).toBeVisible();
  });

  it("never opens a step-up prompt for a session the Hub accepts", async () => {
    vi.spyOn(hostedHubController, "requestEmailVerification").mockImplementation(async () =>
      committed(),
    );

    await mount();
    await page.getByRole("textbox", { name: "Email address" }).fill("ada@example.com");
    await page.getByRole("button", { name: "Send verification" }).click();

    await expect.element(page.getByText(/Request accepted by the Hub/i)).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Authenticator code" }))
      .not.toBeInTheDocument();
  });

  it("never turns an ordinary refusal into a step-up prompt", async () => {
    // The step-up gate is one specific refusal. A classifier that fired on any
    // failure would demand an authenticator code for a rejected address — and
    // would then re-send the same doomed request with a code attached.
    vi.spyOn(hostedHubController, "requestEmailVerification").mockImplementation(async () =>
      publishRefusal({
        errorCode: "conflict",
        wireErrorCode: "conflict",
        errorMessage: "That address was not accepted.",
      }),
    );

    await mount();
    await page.getByRole("textbox", { name: "Email address" }).fill("ada@example.com");
    await page.getByRole("button", { name: "Send verification" }).click();

    await expect.element(page.getByText("That address was not accepted.")).toBeVisible();
    await settle();
    await expect
      .element(page.getByRole("textbox", { name: "Authenticator code" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(/Request accepted by the Hub/i)).not.toBeInTheDocument();
  });

  it("does not offer a step-up out of the passkey-session gate, on an action that has one", async () => {
    // `revoke-totp` is one of the intents whose refusal legitimately *does*
    // become a step-up prompt, so it is the only place the two gates can be
    // confused. An action that never routes through the step-up path could not
    // show a code field whatever the classifier said, and proves nothing.
    vi.spyOn(hostedHubController, "revokeTotp").mockImplementation(async () =>
      publishRefusal({
        errorCode: PASSKEY_SESSION_REQUIRED_CODE,
        wireErrorCode: "forbidden",
        inferredErrorCode: true,
        errorMessage: PASSKEY_SESSION_MESSAGE,
      }),
    );
    hostedAccountStore.setState({
      security: {
        passwordConfigured: false,
        totpEnrolled: true,
        emailDeliveryConfigured: false,
        email: null,
        externalIdentities: [],
      },
      securityStatus: "ready",
    });

    await mount();
    await page.getByRole("button", { name: "Turn off two-factor authentication" }).click();
    await page.getByRole("button", { name: "Remove two-factor" }).click();

    await expect.element(page.getByText("Passkey needed")).toBeVisible();
    await settle();
    await expect
      .element(page.getByRole("textbox", { name: "Authenticator code" }))
      .not.toBeInTheDocument();
  });

  it("presents the passkey-session gate as a passkey prompt rather than a failure", async () => {
    vi.spyOn(hostedHubController, "beginTotpEnrollment").mockImplementation(async () =>
      publishRefusal({
        errorCode: PASSKEY_SESSION_REQUIRED_CODE,
        wireErrorCode: "forbidden",
        inferredErrorCode: true,
        errorMessage: PASSKEY_SESSION_MESSAGE,
      }),
    );

    await mount();
    await page.getByRole("button", { name: "Set up" }).click();

    await expect.element(page.getByText("Passkey needed")).toBeVisible();
    await expect.element(page.getByText("That did not work")).not.toBeInTheDocument();
  });

  it("lets the user out of a step-up retry the Hub never answers", async () => {
    const pending = deferred();
    vi.spyOn(hostedHubController, "requestEmailVerification").mockImplementation(async (input) => {
      if (input.totpCode === undefined) return stepUpRefusal();
      hostedAccountStore.setState({ actionStatus: "requesting-email-verification" });
      await pending.promise;
      // What an aborted operation resolves to: a refusal that deliberately
      // carries no message, because the user did not fail at anything.
      return publishRefusal({ reason: "cancelled" });
    });
    const abort = vi.spyOn(hostedHubController, "cancelAccountAction").mockImplementation(() => {
      hostedAccountStore.setState({ actionStatus: "idle", errorMessage: null });
      pending.land();
    });

    await mount();
    await page.getByRole("textbox", { name: "Email address" }).fill("ada@example.com");
    await page.getByRole("button", { name: "Send verification" }).click();
    await expect.element(page.getByText("Confirm the email change")).toBeVisible();

    await page.getByRole("textbox", { name: "Authenticator code" }).fill("123456");
    await page.getByRole("button", { name: "Confirm code" }).click();
    await expect.element(page.getByText("Confirm the email change")).toBeVisible();

    // Nothing else can end this: submit is disabled while busy, and a modal
    // with no working exit leaves a page reload as the only way out.
    await page.getByRole("button", { name: "Cancel" }).click();

    expect(
      abort,
      "the cancel must abort the operation, not just hide the prompt",
    ).toHaveBeenCalled();
    await expect.element(page.getByText("Confirm the email change")).not.toBeInTheDocument();
    await settle();
    // An aborted operation leaves the store idle with no error — byte for byte
    // what a commit looks like. It must not be reported as one.
    await expect.element(page.getByText(/Request accepted by the Hub/i)).not.toBeInTheDocument();
  });

  it("stops asking for a code once an inferred step-up refusal has been refused to its limit", async () => {
    // `step_up_required` is *synthesised* from a bare `forbidden` — the Hub never
    // sends it. When the 403 was really a role check, an operator disabling the
    // account, or a gateway in front of the Hub, no code the user types can ever
    // satisfy this prompt, and a surface that re-prompts on every refusal asks
    // forever for something that was never the obstacle.
    const codes: Array<string | undefined> = [];
    vi.spyOn(hostedHubController, "requestEmailVerification").mockImplementation(async (input) => {
      codes.push(input.totpCode);
      return stepUpRefusal();
    });

    await mount();
    await page.getByRole("textbox", { name: "Email address" }).fill("ada@example.com");
    await page.getByRole("button", { name: "Send verification" }).click();
    await expect.element(page.getByText("Confirm the email change")).toBeVisible();

    for (let attempt = 0; attempt < STEP_UP_INFERRED_ATTEMPT_LIMIT; attempt += 1) {
      await page.getByRole("textbox", { name: "Authenticator code" }).fill("123456");
      await page.getByRole("button", { name: "Confirm code" }).click();
    }

    await expect.element(page.getByText("Confirm the email change")).not.toBeInTheDocument();
    // And it does not repeat the one claim it now knows may be false.
    await expect.element(page.getByText(STEP_UP_UNRESOLVED_MESSAGE)).toBeVisible();
    await expect.element(page.getByText(STEP_UP_MESSAGE)).not.toBeInTheDocument();

    await settle();
    expect(codes, "the surface kept re-sending after it stopped prompting").toHaveLength(
      STEP_UP_INFERRED_ATTEMPT_LIMIT + 1,
    );
  });

  it("keeps a step-up prompt built on an inferred code escapable", async () => {
    vi.spyOn(hostedHubController, "requestEmailVerification").mockImplementation(async () =>
      stepUpRefusal(),
    );
    const abort = vi.spyOn(hostedHubController, "cancelAccountAction").mockImplementation(() => {
      hostedAccountStore.setState({ actionStatus: "idle" });
    });

    await mount();
    await page.getByRole("textbox", { name: "Email address" }).fill("ada@example.com");
    await page.getByRole("button", { name: "Send verification" }).click();
    await expect.element(page.getByText("Confirm the email change")).toBeVisible();

    // The demand for a code is this client's guess, not the Hub's answer, so the
    // user must always be able to walk away from it rather than be held by a
    // prompt that may be about something else entirely.
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByText("Confirm the email change")).not.toBeInTheDocument();
    expect(abort, "escaping the prompt must abort the operation too").toHaveBeenCalled();
  });

  it("lets the user out of a set-password the Hub never answers, and keeps nothing", async () => {
    const pending = deferred();
    vi.spyOn(hostedHubController, "setPassword").mockImplementation(async () => {
      hostedAccountStore.setState({ actionStatus: "setting-password" });
      await pending.promise;
      return publishRefusal({ reason: "cancelled" });
    });
    const abort = vi.spyOn(hostedHubController, "cancelAccountAction").mockImplementation(() => {
      hostedAccountStore.setState({ actionStatus: "idle", errorMessage: null });
      pending.land();
    });

    await mount();
    await page.getByRole("button", { name: "Set password" }).click();
    await page.getByLabelText("New password").fill("correct horse battery staple");
    await page.getByLabelText("Confirm password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Save password" }).click();

    await page.getByRole("button", { name: "Cancel" }).click();

    expect(abort).toHaveBeenCalled();
    await expect.element(page.getByText("Set a fallback password")).not.toBeInTheDocument();

    // Reopening must not hand the abandoned plaintext back.
    await page.getByRole("button", { name: "Set password" }).click();
    await expect.element(page.getByLabelText("New password")).toHaveValue("");
  });

  /* ------------------------------------------------------- passkey commits */

  it("does not invite a second ceremony when the confirming re-read of a committed passkey fails", async () => {
    // What the runtime reports when the Hub accepted the ceremony and the forced
    // read that confirms it could not reach the Hub: the credential *is*
    // enrolled — `committed` — and the failed read has published its own message
    // on the same slot a refusal would use. The outcome, not the message, is
    // what says so.
    const add = vi.spyOn(hostedHubController, "addPasskey").mockImplementation(async () => {
      hostedAccountStore.setState({ passkeysStatus: "stale" });
      const outcome = addPasskeyCommitted("unverified");
      hostedAccountStore.setState({ errorMessage: "The Hub could not be reached." });
      return outcome;
    });

    await mount();
    await page.getByRole("button", { name: "Add passkey" }).click();
    await page.getByRole("textbox", { name: "Name (optional)" }).fill("Work laptop");
    await page.getByRole("button", { name: "Create passkey" }).click();

    // Leaving the dialog open with the label intact puts "Create passkey" one
    // press away from a second ceremony and a duplicate credential.
    await expect.element(page.getByText("Add a passkey")).not.toBeInTheDocument();
    await expect.element(page.getByText("The Hub could not be reached.")).toBeVisible();
    expect(add).toHaveBeenCalledOnce();
  });

  it("does not invite a second ceremony when the Hub does not list the passkey it accepted", async () => {
    const add = vi.spyOn(hostedHubController, "addPasskey").mockImplementation(async () => {
      hostedAccountStore.setState({ passkeysStatus: "ready" });
      const outcome = addPasskeyCommitted("missing");
      hostedAccountStore.setState({ errorMessage: HOSTED_PASSKEY_UNCONFIRMED_MESSAGE });
      return outcome;
    });

    await mount();
    await page.getByRole("button", { name: "Add passkey" }).click();
    await page.getByRole("button", { name: "Create passkey" }).click();

    await expect.element(page.getByText("Add a passkey")).not.toBeInTheDocument();
    await expect.element(page.getByText(HOSTED_PASSKEY_UNCONFIRMED_MESSAGE)).toBeVisible();
    expect(add).toHaveBeenCalledOnce();
  });

  it("keeps the add dialog open when the ceremony itself was refused", async () => {
    vi.spyOn(hostedHubController, "addPasskey").mockImplementation(async () => {
      hostedAccountStore.setState({ passkeysStatus: "ready" });
      return publishRefusal({
        errorCode: "conflict",
        wireErrorCode: "conflict",
        errorMessage: "That credential is already registered.",
      });
    });

    await mount();
    await page.getByRole("button", { name: "Add passkey" }).click();
    await page.getByRole("button", { name: "Create passkey" }).click();

    // Nothing was enrolled, so the retry is the right offer to make.
    await expect.element(page.getByText("That credential is already registered.")).toBeVisible();
    await expect.element(page.getByText("Add a passkey")).toBeVisible();
  });

  it("keeps the add dialog open for a refusal that arrives on an already-stale list", async () => {
    // The case a message-and-list-status heuristic cannot get right, and the
    // reason the runtime reports the outcome as data instead. A pre-commit
    // refusal leaves the list exactly as stale as a failed post-commit read
    // does, so classifying by "is the list stale?" closes the dialog on a
    // ceremony that enrolled nothing — and silently drops the one retry the user
    // needed. The outcome says `refused`; nothing else has to be inferred.
    const add = vi.spyOn(hostedHubController, "addPasskey").mockImplementation(async () =>
      publishRefusal({
        errorCode: "internal_error",
        wireErrorCode: "internal_error",
        errorMessage: "Hub is temporarily unavailable.",
      }),
    );

    hostedAccountStore.setState({ passkeys: [], passkeysStatus: "stale" });

    await mount();
    await page.getByRole("button", { name: "Add passkey" }).click();
    await page.getByRole("textbox", { name: "Name (optional)" }).fill("Work laptop");
    await page.getByRole("button", { name: "Create passkey" }).click();

    await expect.element(page.getByText("Hub is temporarily unavailable.")).toBeVisible();
    await expect.element(page.getByText("Add a passkey")).toBeVisible();
    // The label survives too: the user has to be able to press the one control
    // that retries what actually failed.
    await expect
      .element(page.getByRole("textbox", { name: "Name (optional)" }))
      .toHaveValue("Work laptop");
    expect(add).toHaveBeenCalledOnce();
  });

  it("closes the add dialog on a confirmed enrolment", async () => {
    const add = vi
      .spyOn(hostedHubController, "addPasskey")
      .mockImplementation(async () => addPasskeyCommitted("confirmed"));

    await mount();
    await page.getByRole("button", { name: "Add passkey" }).click();
    await page.getByRole("textbox", { name: "Name (optional)" }).fill("Work laptop");
    await page.getByRole("button", { name: "Create passkey" }).click();

    await expect.element(page.getByText("Add a passkey")).not.toBeInTheDocument();
    await expect.element(page.getByText("That did not work")).not.toBeInTheDocument();
    expect(add).toHaveBeenCalledOnce();
  });

  /* ------------------------------------------------------ secret handling */

  it("shows recovery codes once, with copy, and never writes them to a persisted store", async () => {
    vi.spyOn(hostedHubController, "regenerateRecoveryCodes").mockImplementation(async () => {
      hostedHubStore.setState({ recoveryCodes: [...RECOVERY_CODES] });
      return recoveryCodesCommitted(true);
    });

    await mount();
    await page.getByRole("button", { name: "Generate new codes" }).click();
    await page.getByRole("button", { name: "Replace codes" }).click();

    await expect.element(page.getByText(RECOVERY_CODES[0])).toBeVisible();

    const displayed = await persistedStorageSnapshot();
    for (const code of RECOVERY_CODES) {
      expect(displayed, `recovery code ${code} reached a persisted store`).not.toContain(code);
      expect(window.location.href).not.toContain(code);
    }

    // Copy is the one affordance that hands the codes to another API, and the
    // snapshot has to be taken *after* it: a copy helper that cached, logged, or
    // queued what it copied would leave the pre-click snapshot clean and the
    // proof vacuous.
    await page.getByRole("button", { name: "Copy codes" }).click();
    await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
    await settle();

    expect(clipboard).toEqual([RECOVERY_CODES.join("\n")]);
    const copied = await persistedStorageSnapshot();
    for (const code of RECOVERY_CODES) {
      expect(copied, `copying recovery code ${code} persisted it`).not.toContain(code);
      expect(window.location.href).not.toContain(code);
    }
  });

  it("gives freshly minted recovery codes exactly one exit", async () => {
    vi.spyOn(hostedHubController, "regenerateRecoveryCodes").mockImplementation(async () => {
      hostedHubStore.setState({ recoveryCodes: [...RECOVERY_CODES] });
      return recoveryCodesCommitted(true);
    });

    await mount();
    await page.getByRole("button", { name: "Generate new codes" }).click();
    await page.getByRole("button", { name: "Replace codes" }).click();
    await expect.element(page.getByText(RECOVERY_CODES[0])).toBeVisible();

    // By now the rotation has invalidated every code the user had written down.
    // What is on screen is the only copy of what protects the account, and an
    // accident that clears it leaves the account holding recovery codes its
    // owner does not have.
    await expect.element(page.getByRole("button", { name: "Close" })).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await settle();
    expect(hostedHubStore.getState().recoveryCodes, "Escape destroyed the codes").toEqual([
      ...RECOVERY_CODES,
    ]);
    await expect.element(page.getByText(RECOVERY_CODES[0])).toBeVisible();

    pressBackdrop();
    await settle();
    expect(hostedHubStore.getState().recoveryCodes, "a backdrop press destroyed the codes").toEqual(
      [...RECOVERY_CODES],
    );
    await expect.element(page.getByText(RECOVERY_CODES[0])).toBeVisible();

    // The acknowledgement is the one exit, and it clears the runtime slot
    // rather than merely hiding the display.
    await page.getByRole("button", { name: "I saved the codes" }).click();
    await expect.element(page.getByText(RECOVERY_CODES[0])).not.toBeInTheDocument();
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
  });

  it("keeps a rotation that lands after the surface is gone, for the root to show", async () => {
    const pending = deferred();
    vi.spyOn(hostedHubController, "regenerateRecoveryCodes").mockImplementation(async () => {
      await pending.promise;
      // The runtime publishes a rotation it accepted under a live lease even if
      // the display went away in between: the Hub has already invalidated every
      // code the user had saved, so this set is the only one that still opens
      // the account.
      hostedHubStore.setState({ recoveryCodes: [...RECOVERY_CODES] });
      return recoveryCodesCommitted(true);
    });

    await mount();
    await page.getByRole("button", { name: "Generate new codes" }).click();
    await page.getByRole("button", { name: "Replace codes" }).click();

    await teardown();

    pending.land();
    await settle();

    // Nothing here may destroy them. Unleased, they are exactly what the hosted
    // root's full-screen takeover exists to put in front of the user.
    expect(hostedHubStore.getState().recoveryCodes).toEqual([...RECOVERY_CODES]);
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(false);
  });

  it("keeps both held secrets when the surface is torn down without an acknowledgement", async () => {
    // This panel is unmounted by things that were never the user's decision:
    // `clearWebHostedNodeScopedState` closes the settings dialog on every
    // hosted node deactivate, suspend, and switch. By then the rotation has
    // already invalidated the codes the user had saved, and this Hub refuses a
    // second TOTP enrolment — so clearing either slot here leaves the account
    // holding credentials its owner never saw.
    await mount();
    hostedHubStore.setState({
      recoveryCodes: [...RECOVERY_CODES],
      totpEnrollment: { secretBase32: TOTP_SECRET, provisioningUri: TOTP_URI },
    });
    await expect.element(page.getByText(RECOVERY_CODES[0])).toBeVisible();

    await teardown();
    await settle();

    expect(hostedHubStore.getState().recoveryCodes, "an unmount destroyed the codes").toEqual([
      ...RECOVERY_CODES,
    ]);
    expect(
      hostedHubStore.getState().totpEnrollment,
      "an unmount destroyed the enrolment secret",
    ).toEqual({ secretBase32: TOTP_SECRET, provisioningUri: TOTP_URI });
    // Held is not the same as rendered: nothing that is gone from the screen may
    // still be in the document. `innerHTML`, not `textContent` — the enrolment
    // secret is rendered as text *and* encoded into a provisioning URI, and a
    // URI stranded in an attribute is invisible to a textContent assertion.
    const dom = document.body.innerHTML;
    expect(dom).not.toContain(TOTP_SECRET);
    expect(dom).not.toContain("otpauth:");
    for (const code of RECOVERY_CODES) expect(dom).not.toContain(code);
    // …and neither of them reached anything that survives a reload.
    const persisted = await persistedStorageSnapshot();
    expect(persisted).not.toContain(TOTP_SECRET);
    for (const code of RECOVERY_CODES) expect(persisted).not.toContain(code);
  });

  it("keeps both held secrets across a remount at a new position", async () => {
    // `LazySettingsDialogMount` forks on the presentation tier, so crossing the
    // phone breakpoint replaces this panel with a fresh instance in a different
    // position. React runs the deleted tree's cleanups *before* the new tree's
    // mount effects, so at the moment of teardown a remount is indistinguishable
    // from a disappearance — and the old instance's cleanup used to be what
    // destroyed the secrets the new instance was about to render.
    const leases: Array<boolean> = [];
    const unsubscribe = hostedRecoveryCodeDisplayStore.subscribe(() => {
      leases.push(hostedRecoveryCodeDisplayStore.getState().leased);
    });
    try {
      mounted = await render(
        <div data-tier="desktop">
          <AccountSettingsPanel />
        </div>,
      );
      hostedHubStore.setState({
        recoveryCodes: [...RECOVERY_CODES],
        totpEnrollment: { secretBase32: TOTP_SECRET, provisioningUri: TOTP_URI },
      });
      await expect.element(page.getByText(RECOVERY_CODES[0])).toBeVisible();

      // A different element type at the same position: React unmounts the old
      // subtree and mounts a new one, exactly as the tier fork does.
      await mounted.rerender(
        <section data-tier="phone">
          <AccountSettingsPanel />
        </section>,
      );
      await settle();

      expect(hostedHubStore.getState().recoveryCodes, "a remount destroyed the codes").toEqual([
        ...RECOVERY_CODES,
      ]);
      expect(
        hostedHubStore.getState().totpEnrollment,
        "a remount destroyed the enrolment secret",
      ).toEqual({ secretBase32: TOTP_SECRET, provisioningUri: TOTP_URI });
      await expect.element(page.getByText(RECOVERY_CODES[0])).toBeVisible();

      // And the display was never reported as gone, so the hosted root's
      // takeover had no frame in which to seize the viewport mid-flow.
      expect(leases, "a remount published an unleased display").toEqual([true]);
    } finally {
      unsubscribe();
    }
  });

  it("draws the enrolment QR rather than stranding the provisioning URI in an attribute", async () => {
    await mount();
    hostedHubStore.setState({
      totpEnrollment: { secretBase32: TOTP_SECRET, provisioningUri: TOTP_URI },
    });
    await expect.element(page.getByLabelText("Two-factor setup code")).toBeVisible();

    // An `<img src="otpauth://…">`, or a `data:` URI built from one, would put
    // the account's shared secret in an attribute — where it survives in the
    // DOM, in a copied `outerHTML`, and in anything that reads attributes.
    const qr = document.querySelector('[aria-label="Two-factor setup code"]');
    expect(qr?.tagName.toLowerCase()).toBe("svg");
    expect(qr?.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(qr?.querySelector("img")).toBeNull();

    const attributes = domAttributeSnapshot();
    expect(attributes, "the enrolment secret reached a DOM attribute").not.toContain(TOTP_SECRET);
    expect(attributes, "the provisioning URI reached a DOM attribute").not.toContain("otpauth:");
  });

  it("shows the TOTP enrolment key once and clears it on dismissal", async () => {
    await mount();
    hostedHubStore.setState({
      totpEnrollment: { secretBase32: TOTP_SECRET, provisioningUri: TOTP_URI },
    });

    await expect.element(page.getByLabelText("Two-factor setup key")).toBeVisible();
    await expect.element(page.getByLabelText("Two-factor setup code")).toBeVisible();

    const persisted = await persistedStorageSnapshot();
    expect(persisted).not.toContain(TOTP_SECRET);
    expect(window.location.href).not.toContain(TOTP_SECRET);

    await page.getByRole("button", { name: "Cancel" }).click();

    expect(hostedHubStore.getState().totpEnrollment).toBeNull();
    await expect.element(page.getByLabelText("Two-factor setup key")).not.toBeInTheDocument();
    const dom = document.body.innerHTML;
    expect(dom).not.toContain(TOTP_SECRET);
    expect(dom).not.toContain("otpauth:");
  });

  it("holds the runtime's recovery-code display lease for exactly as long as it is mounted", async () => {
    // Not defensive: the runtime publishes rotated codes only if a lease was
    // live when the rotation was asked for. Without this lease every rotation
    // started here would rotate the user's codes server-side and then come back
    // `displayed: false` with nothing to show.
    let released = 0;
    const lease = vi
      .spyOn(hostedHubController, "leaseRecoveryCodeDisplay")
      .mockImplementation(() => {
        return () => {
          released += 1;
        };
      });

    await mount();
    expect(lease).toHaveBeenCalledOnce();
    expect(released, "the lease was released while the surface was still live").toBe(0);

    await teardown();
    expect(released).toBe(1);
  });

  it("reports a rotation that committed without reaching a display", async () => {
    // The rotation happened, so every code the user had saved is already dead.
    // Silence here would leave them believing they still hold working recovery
    // credentials.
    vi.spyOn(hostedHubController, "regenerateRecoveryCodes").mockImplementation(async () => {
      const outcome = recoveryCodesCommitted(false);
      hostedAccountStore.setState({ errorMessage: HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE });
      return outcome;
    });

    await mount();
    await page.getByRole("button", { name: "Generate new codes" }).click();
    await page.getByRole("button", { name: "Replace codes" }).click();

    await expect.element(page.getByText(HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE)).toBeVisible();
    await expect.element(page.getByText("Save your recovery codes")).not.toBeInTheDocument();
  });

  it("keeps the hosted root's full-screen code takeover out of the way while it is mounted", async () => {
    await mount();
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(true);
    await teardown();
    await settle();
    // Released, not acknowledged: the takeover is now free to show whatever is
    // still in the slot, which is the point — an orphaned set gets seen.
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(false);
  });

  /* ------------------------------------------------------------------ copy */

  it("says that email verification currently delivers nothing", async () => {
    await mount();
    await expect.element(page.getByText("No mail will arrive yet")).toBeVisible();
    await expect.element(page.getByText(/no mail transport configured/i)).toBeVisible();
  });

  it("does not show the no-delivery warning when account email is configured", async () => {
    hostedAccountStore.setState({
      security: {
        passwordConfigured: false,
        totpEnrolled: false,
        emailDeliveryConfigured: true,
        email: null,
        externalIdentities: [],
      },
      securityStatus: "ready",
    });

    await mount();
    await expect.element(page.getByText("No mail will arrive yet")).not.toBeInTheDocument();
    await expect
      .element(page.getByText(/Used for account recovery after verification/i))
      .toBeVisible();
  });

  it("never presents a fallback credential as the equal of a passkey", async () => {
    await mount();
    await expect
      .element(page.getByText(/A password is a fallback, not an equal of a passkey/i))
      .toBeVisible();
    await expect
      .element(page.getByText(/They are a last resort, not a substitute for one/i))
      .toBeVisible();
  });

  it("reports a revoked credential rather than hiding it", async () => {
    hostedAccountStore.setState({
      passkeys: [
        passkey(),
        passkey({
          id: "pkey_bbbbbbbbbbbbbbbbbbbbbb",
          label: "Old phone",
          revokedAt: 1_700_000_900_000,
          revocationReasonCode: "device_lost",
        }),
      ],
      passkeysStatus: "ready",
    });

    await mount();
    await expect.element(page.getByText("Old phone", { exact: false })).toBeVisible();
    await expect.element(page.getByText(/device_lost/)).toBeVisible();
    await expect.element(page.getByText("1 usable passkey")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Revoke Old phone" }))
      .not.toBeInTheDocument();
  });
});
