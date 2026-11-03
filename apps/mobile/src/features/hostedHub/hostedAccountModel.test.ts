import {
  configureHostedRuntime,
  HOSTED_ACCOUNT_DELETION_UNSUPPORTED_MESSAGE,
  HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE,
  HostedHubApiError,
  hostedAccountStore,
  hostedHubController,
  hostedHubStore,
  hostedRecoveryCodeDisplayStore,
  PASSKEY_SESSION_REQUIRED_CODE,
  STEP_UP_REQUIRED_CODE,
  type HostedAccountState,
  type HostedHubApi,
  type HostedHubPasskey,
  type HostedHubSessionResponse,
  type HostedHubState,
  type HostedNodeLifecycle,
  type HostedRuntimeConfiguration,
} from "@ryco/client-runtime/authorization";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createHostedAccountPromptDraft,
  createHostedRefusalMatcher,
  deriveHostedAccountManagementView,
  HOSTED_ACCOUNT_INTENTS,
  hostedAccountDraftSurvives,
  isHostedPasskeySessionMessage,
  isHostedStepUpMessage,
  leaseHostedRecoveryCodeDisplay,
  type HostedAccountActions,
  type HostedAccountManagementView,
  type HostedAccountPromptDraft,
  type HostedAccountPromptId,
  type HostedAccountPromptView,
} from "./hostedAccountModel";

/**
 * The runtime's real refusal text, built the way the runtime builds it. The
 * controller only ever publishes `HostedHubApiError.message`, so these are the
 * exact strings the account store carries on a refusal.
 */
const STEP_UP_MESSAGE = new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403).message;
const PASSKEY_SESSION_MESSAGE = new HostedHubApiError(PASSKEY_SESSION_REQUIRED_CODE, 403).message;

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function passkey(overrides: Partial<HostedHubPasskey> = {}): HostedHubPasskey {
  return {
    id: "pkey_01J8ZQ5V2N7X0000000000",
    label: "Studio Mac",
    createdAt: NOW - 20 * DAY,
    lastUsedAt: NOW - 2 * HOUR,
    backupEligible: true,
    backupState: true,
    revokedAt: null,
    revocationReasonCode: null,
    ...overrides,
  };
}

function hubState(overrides: Partial<HostedHubState> = {}): HostedHubState {
  return {
    bootstrapAvailable: false,
    accountStatus: "authenticated",
    account: {
      id: "acct_01J8ZQ5V2N7X0000000000",
      displayName: "Ada Lovelace",
      role: "owner",
      createdAt: 1_700_000_000_000,
      disabledAt: null,
    },
    session: {
      id: "sess_01J8ZQ5V2N7X1111111111",
      accountId: "acct_01J8ZQ5V2N7X0000000000",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
      lastSeenAt: 1_700_000_060_000,
      revokedAt: null,
      revocationReasonCode: null,
    },
    directoryStatus: "ready",
    nodes: [],
    selectedNode: null,
    selectionStatus: "none",
    effectiveRole: null,
    transportStatus: "idle",
    sessionStatus: "closed",
    sessionEstablished: false,
    sessionRecoveredAfterUnknown: false,
    browserStatus: "current",
    recoveryCodes: [],
    totpEnrollment: null,
    errorMessage: null,
    generation: 0,
    ...overrides,
  };
}

function accountState(overrides: Partial<HostedAccountState> = {}): HostedAccountState {
  return {
    externalIdentityConfiguration: { version: 1, providers: [] },
    externalIdentityConfigurationStatus: "ready",
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
    actionStatus: "idle",
    errorMessage: null,
    ...overrides,
  };
}

/** Every button press is fire-and-forget, so a settled press needs a flush. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Every prompt the surface can open. One list, so no sweep can drift from it. */
const PROMPT_IDS: ReadonlyArray<HostedAccountPromptId> = [
  "add-passkey",
  "revoke-passkey",
  "regenerate-recovery-codes",
  "set-password",
  "remove-password",
  "enroll-totp",
  "revoke-totp",
  "verify-email",
  "connect-github",
  "disconnect-github",
  "delete-account",
];

interface Harness {
  readonly view: () => HostedAccountManagementView;
  readonly prompt: () => HostedAccountPromptView;
  readonly open: (id: HostedAccountPromptId) => void;
  readonly type: (patch: Partial<HostedAccountPromptDraft>) => void;
  readonly draft: () => HostedAccountPromptDraft | null;
  readonly actions: {
    [K in keyof HostedAccountActions]: ReturnType<typeof vi.fn>;
  };
  readonly setAccount: (patch: Partial<HostedAccountState>) => void;
  readonly setHub: (patch: Partial<HostedHubState>) => void;
  /** The store error the *next* controller call publishes. */
  readonly nextOutcome: (message: string | null) => void;
  /**
   * Hold the *next* controller call open, the way a platform sheet or a slow
   * Hub does, and hand back the release. Everything a stale result can collide
   * with happens in that window.
   */
  readonly hold: () => () => void;
  /**
   * Let a TOTP confirm commit *without* the runtime clearing the enrolment
   * slot — what happens whenever the runtime's own commit thunk does not run,
   * and the case the surface's "no secret once it is reporting the outcome"
   * guard exists for.
   */
  readonly keepEnrollmentSlot: () => void;
  /** Close the open prompt the way the surface's own dismissal would. */
  readonly close: () => void;
}

function harness(initial?: {
  readonly hub?: Partial<HostedHubState>;
  readonly account?: Partial<HostedAccountState>;
}): Harness {
  let hub = hubState(initial?.hub);
  let account = accountState(initial?.account);
  let draft: HostedAccountPromptDraft | null = null;
  const outcomes: Array<string | null> = [];
  let held: Promise<void> | null = null;
  let clearsEnrollmentOnConfirm = true;

  /**
   * Every controller fake settles the store the way the controller would: it
   * waits out whatever `hold()` armed, then records the outcome. The controller
   * resolves for a refusal as readily as for a commit, so the fakes do too.
   */
  const commit = async () => {
    const wait = held;
    held = null;
    if (wait !== null) await wait;
    const message = outcomes.length > 0 ? outcomes.shift()! : null;
    account = { ...account, errorMessage: message };
  };

  const actions = {
    refreshPasskeys: vi.fn(),
    refreshAccountSecurity: vi.fn(),
    refreshExternalIdentityConfiguration: vi.fn(),
    addPasskey: vi.fn(async () => commit()),
    revokePasskey: vi.fn(async () => commit()),
    regenerateRecoveryCodes: vi.fn(async () => commit()),
    setPassword: vi.fn(async () => commit()),
    removePassword: vi.fn(async () => commit()),
    beginTotpEnrollment: vi.fn(async () => {
      await commit();
      if (account.errorMessage === null) {
        hub = {
          ...hub,
          totpEnrollment: {
            secretBase32: "JBSWY3DPEHPK3PXP",
            provisioningUri:
              "otpauth://totp/Ryco:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Ryco",
          },
        };
      }
    }),
    confirmTotpEnrollment: vi.fn(async () => {
      await commit();
      if (account.errorMessage === null && clearsEnrollmentOnConfirm) {
        hub = { ...hub, totpEnrollment: null };
      }
    }),
    revokeTotp: vi.fn(async () => commit()),
    requestEmailVerification: vi.fn(async () => commit()),
    connectExternalIdentity: vi.fn(async () => commit()),
    disconnectExternalIdentity: vi.fn(async () => commit()),
    cancelExternalIdentityConnection: vi.fn(),
    deleteAccount: vi.fn(async () => commit()),
    dismissTotpEnrollment: vi.fn(() => {
      hub = { ...hub, totpEnrollment: null };
    }),
    // What the controller really does: it abandons the operation and resets the
    // surface to idle with no error — indistinguishable, in the store alone,
    // from the action having succeeded.
    cancelAccountAction: vi.fn(() => {
      account = { ...account, actionStatus: "idle", errorMessage: null };
    }),
  };

  const view = () =>
    deriveHostedAccountManagementView({
      state: hub,
      accountState: account,
      draft,
      actions: actions as unknown as HostedAccountActions,
      readAccountState: () => account,
      readHubState: () => hub,
      readDraft: () => draft,
      onDraftChange: (next) => {
        draft = next;
      },
      now: NOW,
    });

  return {
    view,
    prompt: () => {
      const current = view().prompt;
      if (current === null) throw new Error("expected an open prompt");
      return current;
    },
    open: (id) => {
      draft = createHostedAccountPromptDraft(id);
    },
    type: (patch) => {
      if (draft === null) throw new Error("no draft");
      draft = { ...draft, ...patch };
    },
    draft: () => draft,
    actions,
    setAccount: (patch) => {
      account = { ...account, ...patch };
    },
    setHub: (patch) => {
      hub = { ...hub, ...patch };
    },
    nextOutcome: (message) => {
      outcomes.push(message);
    },
    hold: () => {
      let release!: () => void;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    keepEnrollmentSlot: () => {
      clearsEnrollmentOnConfirm = false;
    },
    close: () => {
      draft = null;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hosted account management surface", () => {
  it("renders nothing to manage without an authenticated session", () => {
    for (const patch of [
      { accountStatus: "signed-out" as const },
      { accountStatus: "session-expired" as const },
      { accountStatus: "authenticated" as const, account: null },
    ]) {
      const view = harness({ hub: patch }).view();
      expect(view.available).toBe(false);
      expect(view.sections).toEqual([]);
      expect(view.passkeyRows).toEqual([]);
      expect(view.prompt).toBeNull();
    }
  });

  it("offers only setup actions when fallback credentials are not configured", () => {
    const view = harness().view();
    expect(view.sections.map((section) => section.id)).toEqual([
      "passkeys",
      "recovery-codes",
      "password",
      "two-factor",
      "email",
    ]);
    expect(view.sections.flatMap((section) => section.rows.map((row) => row.id))).toEqual([
      "add-passkey",
      "regenerate-recovery-codes",
      "set-password",
      "enroll-totp",
      "verify-email",
    ]);
    expect(view.sections.find((section) => section.id === "password")?.status).toBe("Not set");
    expect(view.sections.find((section) => section.id === "two-factor")?.status).toBe("Off");
  });

  it("offers only change/removal actions when password and TOTP are configured", () => {
    const view = harness({
      account: {
        security: {
          passwordConfigured: true,
          totpEnrolled: true,
          emailDeliveryConfigured: false,
          email: { address: "ada@example.test", verified: true },
          externalIdentities: [],
        },
      },
    }).view();

    expect(view.sections.flatMap((section) => section.rows.map((row) => row.id))).toEqual([
      "add-passkey",
      "regenerate-recovery-codes",
      "set-password",
      "remove-password",
      "revoke-totp",
      "verify-email",
    ]);
    expect(view.sections.find((section) => section.id === "password")?.status).toBe("Set");
    expect(view.sections.find((section) => section.id === "two-factor")?.status).toBe("On");
    expect(view.sections.find((section) => section.id === "email")?.status).toBe("Verified");
  });

  it("withholds credential actions until security state is known and exposes a stale retry", () => {
    const loading = harness({
      account: { security: null, securityStatus: "loading" },
    }).view();
    expect(
      loading.sections
        .filter((section) => ["password", "two-factor", "email"].includes(section.id))
        .flatMap((section) => section.rows),
    ).toEqual([]);
    expect(loading.securityMessage).toContain("Checking");
    expect(loading.securityRetry).toBeNull();

    const test = harness({
      account: { security: null, securityStatus: "stale" },
    });
    const stale = test.view();
    expect(stale.securityMessage).toContain("could not be loaded");
    stale.securityRetry?.run();
    expect(test.actions.refreshAccountSecurity).toHaveBeenCalledWith({ force: true });
  });

  it("hides GitHub actions without policy and shows only bounded connected metadata", () => {
    const absent = harness().view();
    expect(absent.sections.find((section) => section.id === "external-identities")).toBeUndefined();

    const connected = harness({
      account: {
        externalIdentityConfiguration: null,
        security: {
          ...accountState().security!,
          externalIdentities: [
            {
              provider: "github",
              login: "octocat",
              displayName: "The Octocat",
              connectedAt: NOW - DAY,
              lastUsedAt: NOW - HOUR,
            },
          ],
        },
      },
    }).view();
    const section = connected.sections.find((candidate) => candidate.id === "external-identities");
    expect(section?.status).toBe("@octocat");
    expect(section?.footnote).toContain("The Octocat");
    expect(section?.footnote).toContain("Repository access remains separate");
    expect(section?.rows).toEqual([]);
  });

  it("offers policy-gated GitHub connect and disconnect prompts", async () => {
    const policy = {
      version: 1 as const,
      providers: [{ provider: "github" as const, login: true, signup: true, link: true }],
    } as const;
    const connect = harness({ account: { externalIdentityConfiguration: policy } });
    const connectSection = connect
      .view()
      .sections.find((section) => section.id === "external-identities");
    expect(connectSection?.status).toBe("Not connected");
    expect(connectSection?.rows.map((row) => row.id)).toEqual(["connect-github"]);
    connectSection?.rows[0]?.run();
    expect(connect.prompt().message).toContain("system browser");
    connect.prompt().submit?.run();
    await flush();
    expect(connect.actions.connectExternalIdentity).toHaveBeenCalledWith("github", {});

    const disconnect = harness({
      account: {
        externalIdentityConfiguration: policy,
        security: {
          ...accountState().security!,
          externalIdentities: [
            {
              provider: "github",
              login: "octocat",
              displayName: null,
              connectedAt: NOW - DAY,
              lastUsedAt: null,
            },
          ],
        },
      },
    });
    const disconnectRow = disconnect
      .view()
      .sections.find((section) => section.id === "external-identities")?.rows[0];
    expect(disconnectRow?.id).toBe("disconnect-github");
    expect(disconnectRow?.destructive).toBe(true);
    disconnectRow?.run();
    expect(disconnect.prompt().message).toContain("only primary sign-in method");
    disconnect.prompt().submit?.run();
    await flush();
    expect(disconnect.actions.disconnectExternalIdentity).toHaveBeenCalledWith("github", {});
  });

  it("retries stale provider policy without exposing a connect action", () => {
    const test = harness({
      account: {
        externalIdentityConfiguration: null,
        externalIdentityConfigurationStatus: "stale",
      },
    });
    const view = test.view();
    expect(view.externalIdentityMessage).toContain("could not be loaded");
    expect(view.sections.find((section) => section.id === "external-identities")).toBeUndefined();
    view.externalIdentityRetry?.run();
    expect(test.actions.refreshExternalIdentityConfiguration).toHaveBeenCalledWith({ force: true });
    expect(test.actions.refreshAccountSecurity).toHaveBeenCalledWith({ force: true });
  });

  /**
   * The one thing a mount must never do. Regenerating recovery codes rotates
   * them — every code the user saved stops working — so nothing that merely
   * *renders* the surface may reach a controller action.
   */
  it("calls no controller action from a derivation", () => {
    const test = harness();
    const view = test.view();
    // Deriving with a prompt open, and with one mid-flight, must be inert too.
    test.open("regenerate-recovery-codes");
    test.view();
    test.setAccount({ actionStatus: "regenerating-recovery-codes" });
    test.view();
    for (const [name, fake] of Object.entries(test.actions)) {
      expect(fake, `derivation called ${name}`).not.toHaveBeenCalled();
    }
    expect(view.sections.length).toBeGreaterThan(0);
  });

  it("refuses every row while another account change is in flight, at the model layer", () => {
    const test = harness({ account: { actionStatus: "setting-password" } });
    const view = test.view();
    expect(view.busy).toBe(true);
    for (const section of view.sections) {
      for (const row of section.rows) {
        expect(row.disabled, row.id).toBe(true);
        // Not merely greyed out: pressing it anyway opens nothing.
        row.run();
      }
    }
    expect(test.draft()).toBeNull();
  });
});

/**
 * The copy may not claim a binding the app cannot attest to — the same defect
 * as the account header claiming a session came from a passkey.
 *
 * A platform passkey syncs through iCloud Keychain or Google Password Manager
 * by default, and `passkeyTone` renders a "Synced" pill for exactly that. So
 * "never leaves this device" is true of Ryco's own DPoP key and false of the
 * credential, and any sentence that pairs the two contradicts the pill the user
 * is looking at three lines above.
 */
describe("copy claims no hardware binding for a credential the platform may sync", () => {
  const HARDWARE_CLAIM = /never leaves|secure hardware|only on this device|keeps its own/i;

  const sentences = (copy: string): ReadonlyArray<string> =>
    copy.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0);

  /** Every string this surface renders, prompts included. */
  function allCopy(test: Harness): ReadonlyArray<string> {
    const copy: string[] = [];
    const collect = (view: HostedAccountManagementView) => {
      for (const section of view.sections) {
        copy.push(section.title, section.footnote, ...section.rows.map((row) => row.label));
      }
      for (const row of view.passkeyRows) copy.push(row.label, row.detail, row.tone?.label ?? "");
      const prompt = view.prompt;
      if (prompt !== null) {
        copy.push(prompt.title, prompt.message, prompt.notice ?? "");
      }
    };
    collect(test.view());
    for (const id of PROMPT_IDS) {
      test.open(id);
      collect(test.view());
    }
    test.close();
    return copy;
  }

  function syncedHarness(): Harness {
    return harness({
      account: {
        passkeys: [
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000002", label: "iPhone", backupState: true }),
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000003", label: "iPad", backupState: true }),
        ],
      },
    });
  }

  it("renders a Synced pill for a credential the platform backed up", () => {
    const rows = syncedHarness().view().passkeyRows;
    expect(rows.map((row) => row.tone?.label)).toEqual(["Synced", "Synced"]);
  });

  it("pairs no hardware claim with a passkey in the same sentence", () => {
    const test = syncedHarness();
    const claims = allCopy(test)
      .flatMap((copy) => sentences(copy))
      .filter((sentence) => HARDWARE_CLAIM.test(sentence));
    // The claim is made somewhere — this is not vacuous.
    expect(claims.length).toBeGreaterThan(0);
    for (const sentence of claims) {
      expect(sentence, sentence).not.toMatch(/passkey/i);
    }
  });

  it("says where a passkey is kept wherever it introduces one", () => {
    const test = syncedHarness();
    const footnote = test.view().sections.find((section) => section.id === "passkeys")?.footnote;
    expect(footnote).toMatch(/sync/i);
    test.open("add-passkey");
    expect(test.prompt().message).toMatch(/sync/i);
  });
});

describe("passkey rows", () => {
  it("lists revoked credentials rather than hiding them", () => {
    const view = harness({
      account: {
        passkeys: [
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000001", label: "Old laptop", revokedAt: NOW - DAY }),
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000002", label: "iPhone" }),
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000003", label: "iPad" }),
        ],
      },
    }).view();
    expect(view.passkeyRows.map((row) => row.label)).toEqual(["Old laptop", "iPhone", "iPad"]);
    expect(view.passkeyRows[0]?.revoked).toBe(true);
    expect(view.passkeyRows[0]?.detail).toBe("Revoked 1d ago");
    expect(view.passkeyRows[0]?.tone?.label).toBe("Revoked");
    // A revoked credential cannot be revoked again.
    expect(view.passkeyRows[0]?.revoke).toBeUndefined();
    expect(view.passkeyRows[1]?.detail).toBe("Added 20d ago · Last used 2h ago");
  });

  it("names an unlabelled credential and reports one never used", () => {
    const view = harness({
      account: { passkeys: [passkey({ label: null, lastUsedAt: null, backupState: false })] },
    }).view();
    expect(view.passkeyRows[0]?.label).toBe("Unnamed passkey");
    expect(view.passkeyRows[0]?.detail).toBe("Added 20d ago · Never used");
    expect(view.passkeyRows[0]?.tone?.label).toBe("This device only");
  });

  it("withholds the revoke on the last remaining credential, and says why", () => {
    const single = harness().view();
    expect(single.passkeyRows).toHaveLength(1);
    expect(single.passkeyRows[0]?.revoke).toBeUndefined();
    expect(single.sections[0]?.footnote).toContain("only one left");

    const pair = harness({
      account: {
        passkeys: [passkey(), passkey({ id: "pkey_01J8ZQ5V2N7X0000000009", label: "iPhone" })],
      },
    }).view();
    expect(pair.passkeyRows.every((row) => row.revoke !== undefined)).toBe(true);
    expect(pair.sections[0]?.footnote).not.toContain("only one left");
  });

  it("opens a revoke confirmation naming the credential, and never the id", () => {
    const test = harness({
      account: {
        passkeys: [
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000002", label: "iPhone" }),
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000003", label: "iPad" }),
        ],
      },
    });
    test.view().passkeyRows[1]?.revoke?.();
    const prompt = test.prompt();
    expect(prompt.id).toBe("revoke-passkey");
    expect(prompt.destructive).toBe(true);
    expect(prompt.message).toContain("iPad");
    expect(prompt.message).toContain("sign in again");
    expect(test.draft()?.credentialId).toBe("pkey_01J8ZQ5V2N7X0000000003");
  });

  /**
   * The credential handle is a public identifier, but it is an identifier all
   * the same: it belongs in a revoke argument and a list key, never in copy.
   */
  it("renders no credential id", () => {
    const test = harness({
      account: {
        passkeys: [
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000002", label: "iPhone" }),
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000003", label: "iPad" }),
        ],
      },
    });
    test.view().passkeyRows[0]?.revoke?.();
    const view = test.view();
    const rendered = [
      ...view.passkeyRows.flatMap((row) => [row.label, row.detail, row.tone?.label ?? ""]),
      ...view.sections.flatMap((section) => [
        section.title,
        section.footnote,
        ...section.rows.map((row) => row.label),
      ]),
      view.prompt?.title ?? "",
      view.prompt?.message ?? "",
    ].join(" ");
    expect(rendered).not.toContain("pkey_");
  });

  /**
   * The list's trash affordance is a mutation like any other row, and the busy
   * interlock has to hold for it too: two revokes in flight is the one thing
   * the runtime's single-action guard would answer with "another account change
   * is still in progress" — after the user had already destroyed a credential.
   */
  it("withholds the revoke while another account change is in flight", () => {
    const passkeys = [
      passkey({ id: "pkey_01J8ZQ5V2N7X0000000002", label: "iPhone" }),
      passkey({ id: "pkey_01J8ZQ5V2N7X0000000003", label: "iPad" }),
    ];
    const idle = harness({ account: { passkeys } }).view();
    expect(idle.passkeyRows.every((row) => row.revoke !== undefined)).toBe(true);

    const test = harness({ account: { passkeys, actionStatus: "setting-password" } });
    const view = test.view();
    expect(view.busy).toBe(true);
    // Not merely greyed out by the list: there is no handler to press at all.
    expect(view.passkeyRows.map((row) => row.revoke)).toEqual([undefined, undefined]);
    for (const row of view.passkeyRows) row.revoke?.();
    expect(test.draft()).toBeNull();
  });

  /**
   * `revoke-passkey` is the one prompt that cannot be opened from a section row
   * — it needs a credential the list names. A draft without one has nothing to
   * revoke, and must not be submittable: the action would otherwise settle with
   * no error and read as a successful revocation that never happened.
   */
  it("cannot submit a revoke that names no credential", async () => {
    const test = harness();
    test.open("revoke-passkey");
    expect(test.draft()?.credentialId).toBeNull();

    const prompt = test.prompt();
    expect(prompt.submit?.disabled).toBe(true);
    prompt.submit?.run();
    await flush();
    expect(test.actions.revokePasskey).not.toHaveBeenCalled();
    // And nothing reported an outcome: the prompt is still open and unattempted.
    expect(test.draft()).not.toBeNull();
    expect(test.draft()?.attempted).toBe(false);
    expect(test.draft()?.completed).toBe(false);
  });

  it("revokes through the controller with the credential the row named", async () => {
    const test = harness({
      account: {
        passkeys: [
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000002", label: "iPhone" }),
          passkey({ id: "pkey_01J8ZQ5V2N7X0000000003", label: "iPad" }),
        ],
      },
    });
    test.view().passkeyRows[1]?.revoke?.();
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.revokePasskey).toHaveBeenCalledWith("pkey_01J8ZQ5V2N7X0000000003");
    // The list is the visible outcome, so the prompt gets out of the way.
    expect(test.draft()).toBeNull();
  });
});

describe("adding a passkey", () => {
  it("enrols this device natively, with an optional name", async () => {
    const test = harness();
    test.view().sections[0]?.rows[0]?.run();
    test.type({ text: "  iPhone  " });
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.addPasskey).toHaveBeenCalledWith({ passkeyLabel: "iPhone" });
    expect(test.draft()).toBeNull();
  });

  it("sends no label at all when the field is left blank", async () => {
    const test = harness();
    test.open("add-passkey");
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.addPasskey).toHaveBeenCalledWith({ passkeyLabel: null });
  });

  it("keeps the prompt open and shows the runtime's message when the Hub refuses", async () => {
    const test = harness();
    test.open("add-passkey");
    test.nextOutcome("The passkey could not be verified.");
    test.prompt().submit?.run();
    await flush();
    expect(test.draft()).not.toBeNull();
    expect(test.prompt().errorMessage).toBe("The passkey could not be verified.");
  });

  it("offers a way out of a platform sheet that never returns", () => {
    const test = harness({ account: { actionStatus: "adding-passkey" } });
    test.open("add-passkey");
    const prompt = test.prompt();
    expect(prompt.busy).toBe(true);
    expect(prompt.submit?.disabled).toBe(true);
    expect(prompt.dismiss.disabled).toBe(true);
    prompt.cancel?.run();
    expect(test.actions.cancelAccountAction).toHaveBeenCalledTimes(1);
  });
});

/**
 * The fallback-session step-up.
 *
 * A session minted from a password, a recovery code, or an email link must
 * present a current TOTP code where TOTP is enrolled; a passkey session must
 * not be asked for one. Nothing the client can read says which kind of session
 * it holds, so the action is attempted and only the runtime's own refusal turns
 * the field on.
 */
describe("TOTP step-up", () => {
  /**
   * The runtime builds a refusal message from the code **and the route**, and
   * every account error the controller publishes carries one. So detection has
   * to hold for every intent, not only for the intent-less text.
   */
  it("recognises each refusal on every route it can arrive from", () => {
    expect(HOSTED_ACCOUNT_INTENTS.length).toBeGreaterThan(0);
    for (const intent of HOSTED_ACCOUNT_INTENTS) {
      const stepUp = new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403, undefined, intent).message;
      expect(isHostedStepUpMessage(stepUp), intent).toBe(true);
      expect(isHostedPasskeySessionMessage(stepUp), intent).toBe(false);

      const passkeySession = new HostedHubApiError(
        PASSKEY_SESSION_REQUIRED_CODE,
        403,
        undefined,
        intent,
      ).message;
      expect(isHostedPasskeySessionMessage(passkeySession), intent).toBe(true);
      expect(isHostedStepUpMessage(passkeySession), intent).toBe(false);
    }
  });

  /**
   * The failure this guards against cannot be reproduced against the runtime as
   * it stands — it route-scopes `conflict`, `authentication_failed`, and
   * `not_found`, but not this code. So the scoping is stood in, because the
   * cost of getting it wrong is silent: on that one route the authenticator
   * field would never appear and the action would be uncompletable for every
   * fallback session.
   */
  it("keeps recognising a refusal the runtime starts route-scoping", () => {
    const SCOPED = "Enter a current code from your authenticator app to remove your password.";
    const match = createHostedRefusalMatcher(STEP_UP_REQUIRED_CODE, (intent) =>
      intent === "remove-password"
        ? SCOPED
        : new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403, undefined, intent).message,
    );
    expect(match(SCOPED)).toBe(true);
    // And the generic text still matches: scoping one route narrows nothing else.
    expect(match(STEP_UP_MESSAGE)).toBe(true);
    expect(match("You are not authorized to perform this action.")).toBe(false);
    expect(match(null)).toBe(false);
  });

  it("acts on the runtime's step-up refusal and on nothing else", () => {
    // Pinned deliberately: this is a string comparison against another
    // package's copy, so a reword there must fail here rather than silently
    // disable the step-up prompt.
    expect(STEP_UP_MESSAGE).toBe(
      "Enter a current code from your authenticator app to confirm this change.",
    );
    expect(isHostedStepUpMessage(STEP_UP_MESSAGE)).toBe(true);
    expect(isHostedStepUpMessage(null)).toBe(false);
    // A generic authorization failure is a different thing and must not open a
    // code field the Hub never asked for.
    expect(isHostedStepUpMessage("You are not authorized to perform this action.")).toBe(false);
    expect(isHostedStepUpMessage(PASSKEY_SESSION_MESSAGE)).toBe(false);
    expect(isHostedPasskeySessionMessage(PASSKEY_SESSION_MESSAGE)).toBe(true);
    expect(isHostedPasskeySessionMessage(STEP_UP_MESSAGE)).toBe(false);
    expect(STEP_UP_MESSAGE).not.toBe(PASSKEY_SESSION_MESSAGE);
  });

  it("asks for a code only after the Hub demands one, then retries with it", async () => {
    const test = harness();
    test.open("remove-password");
    // No code is offered up front, and none is sent.
    expect(test.prompt().fields).toEqual([]);
    test.nextOutcome(STEP_UP_MESSAGE);
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.removePassword).toHaveBeenLastCalledWith({});

    const stepped = test.prompt();
    expect(stepped.fields.map((field) => field.key)).toEqual(["stepUpCode"]);
    expect(stepped.errorMessage).toBe(STEP_UP_MESSAGE);
    // The retry is the user's: an empty or short code cannot be submitted.
    expect(stepped.submit?.disabled).toBe(true);
    stepped.submit?.run();
    await flush();
    expect(test.actions.removePassword).toHaveBeenCalledTimes(1);

    test.type({ stepUpCode: "123456" });
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.removePassword).toHaveBeenLastCalledWith({ totpCode: "123456" });
  });

  it("retries a pending GitHub link with TOTP without inventing a second action", async () => {
    const test = harness();
    test.open("connect-github");
    test.nextOutcome(STEP_UP_MESSAGE);
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.connectExternalIdentity).toHaveBeenCalledWith("github", {});

    test.type({ stepUpCode: "123456" });
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.connectExternalIdentity).toHaveBeenLastCalledWith("github", {
      totpCode: "123456",
    });
    expect(test.actions.connectExternalIdentity).toHaveBeenCalledTimes(2);
  });

  it("discards the staged GitHub link when the step-up prompt is cancelled", async () => {
    const test = harness();
    test.open("connect-github");
    test.nextOutcome(STEP_UP_MESSAGE);
    test.prompt().submit?.run();
    await flush();

    test.prompt().dismiss.run();

    expect(test.actions.cancelExternalIdentityConnection).toHaveBeenCalledWith("github");
    expect(test.draft()).toBeNull();
  });

  it("clears a rejected code and keeps the refusal visible", async () => {
    const test = harness();
    test.open("revoke-totp");
    test.nextOutcome(STEP_UP_MESSAGE);
    test.prompt().submit?.run();
    await flush();
    test.type({ stepUpCode: "000000" });
    test.nextOutcome(STEP_UP_MESSAGE);
    test.prompt().submit?.run();
    await flush();
    expect(test.draft()?.stepUpCode).toBe("");
    expect(test.draft()?.stepUpRequired).toBe(true);
    expect(test.prompt().errorMessage).toBe(STEP_UP_MESSAGE);
  });

  it("never offers a code field for a refusal that needs a passkey session", async () => {
    const test = harness();
    test.open("enroll-totp");
    test.nextOutcome(PASSKEY_SESSION_MESSAGE);
    test.prompt().submit?.run();
    await flush();
    const prompt = test.prompt();
    expect(test.draft()?.stepUpRequired).toBe(false);
    expect(prompt.fields).toEqual([]);
    // The runtime's own message is the whole instruction: sign in with a
    // passkey. A code field here would imply a fallback session could stand in.
    expect(prompt.errorMessage).toBe(PASSKEY_SESSION_MESSAGE);
    expect(prompt.errorMessage).toContain("passkey");
  });

  it("carries the step-up on every action the Hub gates with one", async () => {
    const cases: ReadonlyArray<{
      readonly id: HostedAccountPromptId;
      readonly fill?: Partial<HostedAccountPromptDraft>;
      readonly fake: keyof Harness["actions"];
      readonly expected: Record<string, unknown>;
    }> = [
      {
        id: "add-passkey",
        fake: "addPasskey",
        expected: { passkeyLabel: null, totpCode: "111111" },
      },
      {
        id: "regenerate-recovery-codes",
        fake: "regenerateRecoveryCodes",
        expected: { totpCode: "111111" },
      },
      {
        id: "set-password",
        fill: { text: "correct horse battery", secondary: "correct horse battery" },
        fake: "setPassword",
        expected: { password: "correct horse battery", totpCode: "111111" },
      },
      { id: "remove-password", fake: "removePassword", expected: { totpCode: "111111" } },
      { id: "revoke-totp", fake: "revokeTotp", expected: { totpCode: "111111" } },
      {
        id: "verify-email",
        fill: { text: "ada@example.com" },
        fake: "requestEmailVerification",
        expected: { email: "ada@example.com", totpCode: "111111" },
      },
    ];
    for (const scenario of cases) {
      const test = harness();
      test.open(scenario.id);
      if (scenario.fill) test.type(scenario.fill);
      test.nextOutcome(STEP_UP_MESSAGE);
      test.prompt().submit?.run();
      await flush();
      test.type({ stepUpCode: "111111" });
      test.prompt().submit?.run();
      await flush();
      expect(test.actions[scenario.fake], scenario.id).toHaveBeenLastCalledWith(scenario.expected);
    }
  });
});

describe("recovery codes", () => {
  it("states what regeneration destroys before it runs", () => {
    const test = harness();
    const row = test.view().sections.find((section) => section.id === "recovery-codes")?.rows[0];
    expect(row?.destructive).toBe(true);
    row?.run();
    const prompt = test.prompt();
    expect(prompt.destructive).toBe(true);
    expect(prompt.message).toContain("stops working immediately");
    expect(prompt.notice).toContain("no way to undo");
    expect(prompt.submit?.destructive).toBe(true);
    // Opening the confirmation rotates nothing.
    expect(test.actions.regenerateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("rotates only from the explicit submit", async () => {
    const test = harness();
    test.open("regenerate-recovery-codes");
    expect(test.actions.regenerateRecoveryCodes).not.toHaveBeenCalled();
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.regenerateRecoveryCodes).toHaveBeenCalledTimes(1);
    // The new codes land in the hosted store and are displayed by the account
    // view, so the confirmation gets out of the way rather than repeating them.
    expect(test.draft()).toBeNull();
  });
});

/** A restored Hub session for the tests that drive the real controller. */
const session: HostedHubSessionResponse = {
  account: {
    id: "acct_01J8ZQ5V2N7X0000000000",
    displayName: "Ada Lovelace",
    role: "owner",
    createdAt: 1,
    disabledAt: null,
  },
  session: {
    id: "sess_01J8ZQ5V2N7X1111111111",
    accountId: "acct_01J8ZQ5V2N7X0000000000",
    createdAt: 1,
    expiresAt: 2,
    lastSeenAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
  },
  csrfToken: "csrf-sensitive-canary",
};

/** Every platform service the recovery-code path must not reach. */
const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("the hosted account surface must not reach a platform service");
    },
  },
) as never;

const nodeLifecycle: HostedNodeLifecycle = {
  activate: vi.fn(async () => undefined),
  suspend: vi.fn(async () => undefined),
  deactivate: vi.fn(async () => undefined),
  clearNodeScopedState: vi.fn(),
  writePrimaryEnvironmentDescriptor: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(async () => undefined),
  setActiveEnvironmentId: vi.fn(),
};

function runtime(): HostedRuntimeConfiguration {
  return {
    endpoint: unusedService,
    httpClient: unusedService,
    passkeyCeremony: unusedService,
    sessionCredentials: unusedService,
    nodeLifecycle,
    timers: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
      queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
    },
    isForeground: () => true,
    subscribeForeground: () => () => undefined,
    hasPendingRelayRequests: () => false,
    resetRelayAttemptFactory: () => undefined,
    relayUrl: () => "wss://hub.example.test/v1/relay/client",
    createRelaySocket: () => ({}),
  };
}

/**
 * The account surface's ownership of the two one-shot secrets it renders,
 * asserted against the **real** `hostedHubController` over a fake transport.
 *
 * Every other test on this surface injects a fake `regenerateRecoveryCodes`,
 * and that is exactly how the defect this replaces shipped: the runtime only
 * publishes a rotation's codes if a display lease was live when the user asked
 * for it, this screen never took one, and no fake could say so. A fake cannot
 * refuse the way the runtime refuses — so this block does not use one for the
 * controller. The Hub is the only thing faked, and the controller in front of
 * it is the one the app runs.
 *
 * One seam stays uncovered, and it is the `.tsx`'s single line binding
 * {@link leaseHostedRecoveryCodeDisplay} to the screen's `useEffect`. There is
 * no React renderer here — `react-native` ships untranspiled Flow the runner
 * cannot parse — so nothing below can mount the screen and observe that it
 * mounts the lease. Everything the effect *does* is asserted; that it is called
 * is not. Closing it needs a renderer able to load the RN packages.
 */
describe("the account surface owns the display, not the secrets", () => {
  const CODES = ["recovery-sensitive-canary-1", "recovery-sensitive-canary-2"] as const;
  const ENROLLMENT = {
    secretBase32: "TOTPSECRETSENSITIVECANARY",
    provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
  } as const;

  /** The Hub, and nothing else about the runtime, replaced by fakes. */
  function hubApi(overrides?: Partial<Record<keyof HostedHubApi, unknown>>): HostedHubApi {
    return {
      restoreSession: vi.fn(async () => session),
      listNodes: vi.fn(async () => []),
      listPasskeys: vi.fn(async () => []),
      regenerateRecoveryCodes: vi.fn(async () => [...CODES]),
      beginTotpEnrollment: vi.fn(async () => ENROLLMENT),
      clearSessionMaterial: vi.fn(),
      ...overrides,
    } as unknown as HostedHubApi;
  }

  /** Sign in for real, the way `bootstrap()` does on a restored session. */
  async function signIn(api: HostedHubApi = hubApi()): Promise<HostedHubApi> {
    configureHostedRuntime(runtime(), api);
    await hostedHubController.bootstrap();
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
    return api;
  }

  /** Mount the account screen's one lifetime effect; the return is its cleanup. */
  const mount = (): (() => void) => leaseHostedRecoveryCodeDisplay(hostedHubController);

  /** The microtask on which a released lease settles as "nothing is showing". */
  const settleLease = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  afterEach(() => {
    hostedHubController.resetForTests();
  });

  it("declares the display while the screen is mounted", async () => {
    await signIn();
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(false);
    const unmount = mount();
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(true);
    unmount();
    await settleLease();
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(false);
  });

  /**
   * The bug, from the button inwards: rotation is destructive server-side and
   * the runtime withholds the result from a caller with no display, so a screen
   * that never leased one killed the user's saved codes and then told them the
   * new ones could not be shown.
   */
  it("shows the codes a rotation from the mounted screen produces", async () => {
    await signIn();
    const unmount = mount();

    const outcome = await hostedHubController.regenerateRecoveryCodes();

    expect(outcome).toEqual({ status: "committed", displayed: true });
    expect(hostedHubStore.getState().recoveryCodes).toEqual([...CODES]);
    // Nothing to apologise for: the codes are on screen.
    expect(hostedAccountStore.getState().errorMessage).toBeNull();
    unmount();
  });

  it("cannot show the codes at all without the mount that declares the display", async () => {
    await signIn();

    // No mount: the shape this screen shipped, and what it cost.
    const outcome = await hostedHubController.regenerateRecoveryCodes();

    expect(outcome).toEqual({ status: "committed", displayed: false });
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    expect(hostedAccountStore.getState().errorMessage).toBe(
      HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE,
    );
  });

  /**
   * The F1/F5 defect on this screen. A back-swipe, the settings sheet closing,
   * a sign-out underneath, a re-render at a new position — none of them is the
   * user saying they have saved anything, and by now the rotation has already
   * invalidated the set they had.
   */
  it("destroys neither secret when the screen goes away", async () => {
    await signIn();
    const unmount = mount();
    await hostedHubController.regenerateRecoveryCodes();
    await hostedHubController.beginTotpEnrollment();
    expect(hostedHubStore.getState().recoveryCodes).toEqual([...CODES]);
    expect(hostedHubStore.getState().totpEnrollment).toEqual(ENROLLMENT);

    unmount();
    await settleLease();

    expect(hostedHubStore.getState().recoveryCodes).toEqual([...CODES]);
    expect(hostedHubStore.getState().totpEnrollment).toEqual(ENROLLMENT);
    // Left unleased, so the next visit to this screen renders them with their
    // acknowledgement rather than the account silently holding codes nobody has.
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(false);
  });

  it("keeps a rotation that only lands after the screen is gone", async () => {
    // Assigned by the executor, which `new Promise` runs synchronously — so it
    // is set before the controller's call to the Hub returns to us.
    let settle!: (codes: ReadonlyArray<string>) => void;
    await signIn(
      hubApi({
        regenerateRecoveryCodes: vi.fn(
          () =>
            new Promise<ReadonlyArray<string>>((resolve) => {
              settle = resolve;
            }),
        ),
      }),
    );
    const unmount = mount();

    const pending = hostedHubController.regenerateRecoveryCodes();
    // Nothing about leaving reaches the Hub: the rotation commits either way,
    // so the codes the user had saved are already dead by the time this lands.
    unmount();
    settle([...CODES]);

    expect(await pending).toEqual({ status: "committed", displayed: true });
    expect(hostedHubStore.getState().recoveryCodes).toEqual([...CODES]);
  });

  it("drops both secrets on the acknowledgements the surface offers", async () => {
    await signIn();
    const unmount = mount();
    await hostedHubController.regenerateRecoveryCodes();
    await hostedHubController.beginTotpEnrollment();

    // "I saved the codes", and the enrolment prompt's own close.
    hostedHubController.dismissRecoveryCodes();
    hostedHubController.dismissTotpEnrollment();

    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    expect(hostedHubStore.getState().totpEnrollment).toBeNull();
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("sensitive-canary");
    unmount();
  });

  /**
   * React Navigation re-renders this screen at a new position — a header
   * change, a tier flip — by unmounting the old subtree before mounting the
   * replacement. Publishing "nothing is showing" in that gap would be wrong
   * about the only thing this store is read for.
   */
  it("never reports the display gone across a remount", async () => {
    await signIn();
    const published: Array<boolean> = [];
    const unsubscribe = hostedRecoveryCodeDisplayStore.subscribe(() => {
      published.push(hostedRecoveryCodeDisplayStore.getState().leased);
    });
    try {
      const unmount = mount();
      expect(published).toEqual([true]);

      unmount();
      const remounted = mount();
      await settleLease();

      expect(published, "a remount published an unleased display").toEqual([true]);
      remounted();
    } finally {
      unsubscribe();
    }
  });
});

describe("password", () => {
  it("never presents a password as equivalent to a passkey", () => {
    const test = harness();
    const section = test.view().sections.find((candidate) => candidate.id === "password");
    expect(section?.footnote).toContain("fallback credential");
    expect(section?.footnote).toContain("weaker than a passkey");
    test.open("set-password");
    expect(test.prompt().message).toContain("fallback, not a replacement");
  });

  it("requires a confirmed, long-enough password before it can be submitted", () => {
    const test = harness();
    test.open("set-password");
    expect(test.prompt().submit?.disabled).toBe(true);

    test.type({ text: "short", secondary: "short" });
    expect(test.prompt().submit?.disabled).toBe(true);

    test.type({ text: "correct horse battery", secondary: "correct horse" });
    expect(test.prompt().submit?.disabled).toBe(true);
    expect(test.prompt().notice).toBe("The two entries do not match.");

    test.type({ text: "correct horse battery", secondary: "correct horse battery" });
    expect(test.prompt().submit?.disabled).toBe(false);
  });

  it("reports the outcome rather than closing on a change nothing else shows", async () => {
    const test = harness();
    test.open("set-password");
    test.type({ text: "correct horse battery", secondary: "correct horse battery" });
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.setPassword).toHaveBeenCalledWith({ password: "correct horse battery" });
    const prompt = test.prompt();
    expect(prompt.message).toBe("Your password was saved.");
    expect(prompt.submit).toBeNull();
    expect(prompt.fields).toEqual([]);
    expect(prompt.dismiss.label).toBe("Done");
    prompt.dismiss.run();
    expect(test.draft()).toBeNull();
  });
});

describe("TOTP enrolment", () => {
  it("shows the secret once, only in the enrolment prompt, and never before", async () => {
    const test = harness();
    test.open("enroll-totp");
    // Nothing is requested by opening the screen.
    expect(test.prompt().enrollment).toBeNull();
    expect(test.actions.beginTotpEnrollment).not.toHaveBeenCalled();

    test.prompt().submit?.run();
    await flush();
    expect(test.actions.beginTotpEnrollment).toHaveBeenCalledTimes(1);

    const enrolling = test.prompt();
    expect(enrolling.enrollment).toEqual({
      secretBase32: "JBSWY3DPEHPK3PXP",
      provisioningUri: "otpauth://totp/Ryco:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Ryco",
    });
    expect(enrolling.message).toContain("displayed once");
    expect(enrolling.fields.map((field) => field.key)).toEqual(["text"]);
    // Nothing outside the prompt sees it.
    const view = test.view();
    expect(JSON.stringify(view.sections)).not.toContain("JBSWY3DPEHPK3PXP");
    expect(JSON.stringify(view.passkeyRows)).not.toContain("JBSWY3DPEHPK3PXP");
  });

  /** The secret must not outlive the screen that exists to display it. */
  it("drops the secret on every close path", async () => {
    const test = harness();
    test.open("enroll-totp");
    test.prompt().submit?.run();
    await flush();
    expect(test.prompt().enrollment).not.toBeNull();

    test.prompt().dismiss.run();
    expect(test.actions.dismissTotpEnrollment).toHaveBeenCalledTimes(1);
    expect(test.draft()).toBeNull();
    expect(test.view().prompt).toBeNull();
  });

  it("confirms with the code from the app and reports that it is on", async () => {
    const test = harness();
    test.open("enroll-totp");
    test.prompt().submit?.run();
    await flush();

    expect(test.prompt().submit?.disabled).toBe(true);
    test.type({ text: "12345" });
    expect(test.prompt().submit?.disabled).toBe(true);
    test.type({ text: " 123456 " });
    expect(test.prompt().submit?.disabled).toBe(false);

    test.prompt().submit?.run();
    await flush();
    expect(test.actions.confirmTotpEnrollment).toHaveBeenCalledWith({ code: "123456" });
    const prompt = test.prompt();
    expect(prompt.message).toContain("Two-factor authentication is on");
    expect(prompt.enrollment).toBeNull();
    expect(prompt.submit).toBeNull();
  });

  /**
   * The completion stage shows no secret *whatever the runtime still holds*.
   *
   * Clearing the slot is the runtime's job on a confirm, but it does that from
   * a commit thunk it does not always run — its own session fence can skip the
   * commit while leaving the account store idle and error-free, which this
   * surface reads as a success and turns into `completed`. The QR and the
   * base32 key would then re-render under "Two-factor authentication is on".
   * So the prompt drops the projection itself rather than trusting the slot.
   */
  it("shows no secret once the prompt is reporting the outcome", async () => {
    const test = harness();
    test.open("enroll-totp");
    test.prompt().submit?.run();
    await flush();
    expect(test.prompt().enrollment).not.toBeNull();

    // The runtime commits the confirm but leaves the enrolment slot populated.
    test.keepEnrollmentSlot();
    test.type({ text: "123456" });
    test.prompt().submit?.run();
    await flush();

    const prompt = test.prompt();
    expect(test.draft()?.completed).toBe(true);
    expect(prompt.message).toContain("Two-factor authentication is on");
    expect(prompt.enrollment).toBeNull();
    expect(prompt.fields).toEqual([]);
    // Nothing anywhere on the surface still carries the shared key.
    expect(JSON.stringify(test.view())).not.toContain("JBSWY3DPEHPK3PXP");
    expect(JSON.stringify(test.view())).not.toContain("otpauth://");
  });

  it("says a passkey session is required, without offering a shortcut", () => {
    const test = harness();
    const section = test.view().sections.find((candidate) => candidate.id === "two-factor");
    expect(section?.footnote).toContain("passkey session");
    test.open("enroll-totp");
    expect(test.prompt().message).toContain("passkey session on this device");
  });
});

describe("email verification", () => {
  it("says the Hub cannot deliver mail rather than letting the user wait", async () => {
    const test = harness();
    const section = test.view().sections.find((candidate) => candidate.id === "email");
    expect(section?.footnote).toContain("no mail transport configured");
    expect(section?.footnote).toContain("no message will arrive");

    test.open("verify-email");
    expect(test.prompt().notice).toContain("discarded rather than delivered");

    test.type({ text: "ada@example.com" });
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.requestEmailVerification).toHaveBeenCalledWith({
      email: "ada@example.com",
    });
    // The Hub answers 202 uniformly, so the copy claims acceptance, never that
    // the address is known — and never that a message is on its way.
    expect(test.prompt().message).toBe(
      "Your Hub accepted the request. It cannot deliver mail yet, so no message will arrive.",
    );
  });

  it("describes real delivery when the Hub has mail configured", async () => {
    const test = harness({
      account: {
        security: {
          passwordConfigured: false,
          totpEnrolled: false,
          emailDeliveryConfigured: true,
          email: null,
          externalIdentities: [],
        },
      },
    });
    const section = test.view().sections.find((candidate) => candidate.id === "email");
    expect(section?.footnote).not.toContain("no mail transport configured");

    test.open("verify-email");
    expect(test.prompt().notice).toBeNull();
    test.type({ text: "ada@example.com" });
    test.prompt().submit?.run();
    await flush();
    expect(test.prompt().message).toBe(
      "Your Hub accepted the request. Check your inbox and spam folder; delivery may take a moment.",
    );
  });

  it("will not submit an address that is obviously not one", () => {
    const test = harness();
    test.open("verify-email");
    for (const value of ["", "ada", "ada@example", "ada @example.com", "a@b@example.com"]) {
      test.type({ text: value });
      expect(test.prompt().submit?.disabled, value).toBe(true);
    }
    test.type({ text: "ada@example.com" });
    expect(test.prompt().submit?.disabled).toBe(false);
  });
});

describe("deleting the account", () => {
  it("is offered last, apart from the credential sections, and only while signed in", () => {
    const view = harness().view();
    expect(view.sections.map((section) => section.id)).not.toContain("delete-account");
    expect(view.deleteAccount?.rows.map((row) => [row.id, row.label, row.destructive])).toEqual([
      ["delete-account", "Delete account…", true],
    ]);
    expect(view.deleteAccount?.footnote).toContain("Chats and projects on your nodes stay there.");
    expect(harness({ hub: { accountStatus: "signed-out" } }).view().deleteAccount).toBeNull();
    expect(
      harness({ account: { actionStatus: "setting-password" } }).view().deleteAccount?.rows[0]
        ?.disabled,
    ).toBe(true);
  });

  it("stays inert until the email or username is typed, then sends what was typed", async () => {
    const test = harness();
    test.view().deleteAccount?.rows[0]?.run();
    expect(test.prompt().id).toBe("delete-account");
    expect(test.prompt().destructive).toBe(true);
    expect(test.prompt().fields.map((field) => field.key)).toEqual(["text"]);

    test.prompt().submit?.run();
    test.type({ text: "   " });
    test.prompt().submit?.run();
    await flush();
    expect(test.prompt().submit?.disabled).toBe(true);
    expect(test.actions.deleteAccount).not.toHaveBeenCalled();

    test.type({ text: "ada@example.test" });
    test.prompt().submit?.run();
    await flush();
    // The Hub checks that it is the account's own; the runtime trims it.
    expect(test.actions.deleteAccount).toHaveBeenCalledWith({ identifier: "ada@example.test" });
  });

  it("asks a fallback session for an authenticator code and sends it along", async () => {
    const test = harness();
    test.open("delete-account");
    test.type({ text: "ada" });
    test.nextOutcome(STEP_UP_MESSAGE);
    test.prompt().submit?.run();
    await flush();
    expect(test.prompt().fields.map((field) => field.key)).toEqual(["text", "stepUpCode"]);
    expect(test.prompt().submit?.disabled).toBe(true);

    test.type({ stepUpCode: "123456" });
    test.prompt().submit?.run();
    await flush();
    expect(test.actions.deleteAccount).toHaveBeenLastCalledWith({
      identifier: "ada",
      totpCode: "123456",
    });
  });

  it("closes the confirmation for good once the account session ends", () => {
    // A committed deletion signs this device out; the screen can stay mounted,
    // and signing in again must not reopen the sheet with the typed identifier.
    expect(hostedAccountDraftSurvives(hubState())).toBe(true);
    for (const patch of [
      { accountStatus: "signed-out" as const },
      { accountStatus: "session-expired" as const },
      { account: null },
    ]) {
      expect(hostedAccountDraftSurvives(hubState(patch))).toBe(false);
    }
  });

  it("says so in the prompt when the Hub cannot delete accounts yet", async () => {
    const deleteAccount = vi.fn(async () => {
      throw new HostedHubApiError("not_found", 404, undefined, "delete-account");
    });
    configureHostedRuntime(runtime(), {
      restoreSession: vi.fn(async () => session),
      listNodes: vi.fn(async () => []),
      listPasskeys: vi.fn(async () => []),
      clearSessionMaterial: vi.fn(),
      deleteAccount,
    } as unknown as HostedHubApi);
    try {
      await hostedHubController.bootstrap();
      let draft: HostedAccountPromptDraft | null = createHostedAccountPromptDraft("delete-account");
      const view = () =>
        deriveHostedAccountManagementView({
          state: hostedHubStore.getState(),
          accountState: hostedAccountStore.getState(),
          draft,
          actions: hostedHubController,
          readAccountState: () => hostedAccountStore.getState(),
          readHubState: () => hostedHubStore.getState(),
          readDraft: () => draft,
          onDraftChange: (next) => {
            draft = next;
          },
        });
      view().prompt?.fields[0]?.onChangeText("ada@example.test");
      view().prompt?.submit?.run();
      await vi.waitFor(() => expect(view().prompt?.errorMessage).not.toBeNull());

      expect(deleteAccount).toHaveBeenCalledTimes(1);
      expect(view().prompt?.errorMessage).toBe(HOSTED_ACCOUNT_DELETION_UNSUPPORTED_MESSAGE);
      // Nothing was deleted, so this device stays signed in.
      expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
      expect(view().prompt?.submit).not.toBeNull();
    } finally {
      hostedHubController.resetForTests();
    }
  });
});

describe("errors", () => {
  it("shows a store message on the screen, but never inside a prompt that has not run", () => {
    const test = harness({ account: { errorMessage: "Hub is temporarily unavailable." } });
    expect(test.view().errorMessage).toBe("Hub is temporarily unavailable.");
    test.open("set-password");
    // The prompt has attempted nothing, so the leftover message is not its own.
    expect(test.prompt().errorMessage).toBeNull();
    // And a single refusal is never rendered twice.
    expect(test.view().errorMessage).toBeNull();
  });

  it("explains an unreadable passkey list instead of showing an empty one", () => {
    expect(
      harness({ account: { passkeys: [], passkeysStatus: "stale" } }).view().passkeysEmptyDetail,
    ).toBe("The passkey list could not be loaded.");
    expect(
      harness({ account: { passkeys: [], passkeysStatus: "ready" } }).view().passkeysEmptyDetail,
    ).toBe("No passkeys are registered on this account yet.");
    expect(
      harness({ account: { passkeys: [], passkeysStatus: "loading" } }).view().passkeysEmptyDetail,
    ).toBe("Loading your passkeys.");
  });
});

/**
 * A submit outlives the prompt that started it, and the account store cannot
 * say whose result it is holding: a commit, an abandoned operation, and a
 * session that rotated underneath all leave it idle with no error. So every
 * result is fenced on the prompt it belongs to, the attempt that is still live,
 * and the session that issued it — never on the awaited call merely returning.
 */
describe("a result only lands on the state it was started from", () => {
  const PASSWORD = { text: "correct horse battery", secondary: "correct horse battery" };

  /** Start a submit and leave it in flight, with the surface marked busy. */
  function inFlight(test: Harness, status: HostedAccountState["actionStatus"]) {
    const release = test.hold();
    test.prompt().submit?.run();
    test.setAccount({ actionStatus: status });
    return release;
  }

  it("does not close, or complete, a prompt opened after the one it belongs to", async () => {
    const test = harness();
    test.open("add-passkey");
    const release = inFlight(test, "adding-passkey");

    // The user dismisses the prompt and opens something else entirely.
    test.close();
    test.open("verify-email");
    test.setAccount({ actionStatus: "idle" });
    const opened = test.draft();

    release();
    await flush();
    // Byte for byte the prompt the user opened: not closed, not completed, and
    // not carrying the older action's outcome.
    expect(test.draft()).toBe(opened);
    expect(test.view().prompt?.id).toBe("verify-email");
  });

  /**
   * The prompt half of the fence on its own: the newer prompt has been
   * submitted once itself, so it carries the same attempt number as the
   * abandoned one and only its *identity* tells the two apart.
   */
  it("does not close a different prompt that has since been submitted itself", async () => {
    const test = harness();
    test.open("add-passkey");
    const releaseStale = inFlight(test, "adding-passkey");

    test.close();
    test.open("verify-email");
    test.type({ text: "ada@example.com" });
    test.setAccount({ actionStatus: "idle" });
    test.nextOutcome("Hub is temporarily unavailable.");
    const releaseCurrent = inFlight(test, "requesting-email-verification");
    releaseCurrent();
    await flush();
    test.setAccount({ actionStatus: "idle" });
    expect(test.draft()?.attempt).toBe(1);
    expect(test.prompt().errorMessage).toBe("Hub is temporarily unavailable.");

    // The abandoned passkey request finally returns, and reads as a commit.
    releaseStale();
    await flush();
    // `add-passkey` closes itself on a commit. Closing *this* prompt would take
    // the user's open, refused email attempt with it.
    expect(test.view().prompt?.id).toBe("verify-email");
    expect(test.draft()).not.toBeNull();
  });

  it("cannot resurrect a prompt the user dismissed", async () => {
    const test = harness();
    test.open("set-password");
    test.type(PASSWORD);
    const release = inFlight(test, "setting-password");

    test.close();
    test.setAccount({ actionStatus: "idle" });
    release();
    await flush();
    // `set-password` reports its outcome rather than closing, so an unfenced
    // result would push a completed prompt back onto an empty surface.
    expect(test.draft()).toBeNull();
    expect(test.view().prompt).toBeNull();
  });

  /**
   * The reported sequence. "Stop waiting" resets the store to idle with no
   * error, which is exactly what a success looks like from here.
   */
  it("reports no success for an attempt the user stopped waiting on", async () => {
    const test = harness();
    test.open("set-password");
    test.type(PASSWORD);
    const release = inFlight(test, "setting-password");

    test.prompt().cancel?.run();
    expect(test.actions.cancelAccountAction).toHaveBeenCalledTimes(1);
    expect(test.draft()?.completed).toBe(false);

    release();
    await flush();
    const prompt = test.prompt();
    expect(test.draft()?.completed).toBe(false);
    expect(prompt.message).not.toBe("Your password was saved.");
    expect(prompt.message).toContain("fallback, not a replacement");
    // Still submittable: the user can try again, which is the only retry there is.
    expect(prompt.submit).not.toBeNull();
  });

  it("reports no success for a result whose session rotated underneath", async () => {
    const test = harness();
    test.open("remove-password");
    const release = inFlight(test, "removing-password");

    // The runtime drops the operation and leaves the store idle and error-free.
    const session = hubState().session;
    test.setHub({ session: session === null ? null : { ...session, id: "sess_rotated" } });
    test.setAccount({ actionStatus: "idle" });
    release();
    await flush();
    expect(test.draft()?.completed).toBe(false);
    expect(test.prompt().message).not.toBe("Password sign-in is off.");
  });

  it("reports no success for a result that outlived the session entirely", async () => {
    const test = harness();
    test.open("revoke-totp");
    const release = inFlight(test, "revoking-totp");

    test.setHub({ accountStatus: "signed-out" });
    test.setAccount({ actionStatus: "idle" });
    release();
    await flush();
    expect(test.draft()?.completed).toBe(false);
    // And the surface itself is gone, so nothing renders the stale prompt.
    expect(test.view().available).toBe(false);
  });

  it("does not turn on a step-up field the newer prompt was never refused", async () => {
    const test = harness();
    test.open("remove-password");
    const release = inFlight(test, "removing-password");

    test.close();
    test.open("verify-email");
    test.setAccount({ actionStatus: "idle" });
    test.nextOutcome(STEP_UP_MESSAGE);
    release();
    await flush();
    expect(test.draft()?.stepUpRequired).toBe(false);
    expect(test.draft()?.attempted).toBe(false);
    expect(test.prompt().fields.map((field) => field.key)).toEqual(["text"]);
    expect(test.prompt().errorMessage).toBeNull();
  });

  it("still settles the prompt it does belong to", async () => {
    const test = harness();
    test.open("set-password");
    test.type(PASSWORD);
    const release = inFlight(test, "setting-password");
    test.setAccount({ actionStatus: "idle" });
    release();
    await flush();
    // The fence refuses stale results, not slow ones.
    expect(test.prompt().message).toBe("Your password was saved.");
    expect(test.draft()?.completed).toBe(true);
  });

  it("gives every prompt its own identity, carried through edits", () => {
    const test = harness();
    test.open("set-password");
    const first = test.draft();
    test.type({ text: "typing" });
    expect(test.draft()?.generation).toBe(first?.generation);
    test.close();
    test.open("set-password");
    // Same id, different prompt.
    expect(test.draft()?.generation).not.toBe(first?.generation);
  });
});

/**
 * The falsifiable security assertion for this surface: no view model carries
 * session material, and the only secret it may carry — the TOTP enrolment key —
 * appears in exactly one place, the enrolment prompt.
 */
describe("no unexpected secret material reaches a view model", () => {
  const SECRET_KEY_PATTERN =
    /token|proof|jwk|jws|jwt|\bath\b|\bjti\b|ticket|csrf|cookie|bearer|dpop|authorization|password/i;

  function walk(value: unknown, keys: string[], strings: string[]): void {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, keys, strings);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      walk(child, keys, strings);
    }
  }

  it("exposes no credential-shaped key on the surface or any prompt", async () => {
    for (const id of PROMPT_IDS) {
      const test = harness();
      test.open(id);
      if (id === "enroll-totp") {
        test.prompt().submit?.run();
        await flush();
      }
      const keys: string[] = [];
      walk(test.view(), keys, []);
      const offenders = keys.filter((key) => SECRET_KEY_PATTERN.test(key));
      expect(offenders, `prompt ${id}`).toEqual([]);
    }
  });

  it("keeps a typed password out of the view model it renders from", () => {
    const test = harness();
    test.open("set-password");
    test.type({ text: "correct horse battery", secondary: "correct horse battery" });
    const keys: string[] = [];
    walk(test.view(), keys, []);
    // The value rides the field's `value` slot, which is what a controlled
    // input requires — but nothing is stored under a credential-shaped key, and
    // no title, message, notice, or error echoes it.
    const prompt = test.prompt();
    const copy = [
      prompt.title,
      prompt.message,
      prompt.notice ?? "",
      prompt.errorMessage ?? "",
    ].join(" ");
    expect(copy).not.toContain("correct horse battery");
    expect(keys.filter((key) => key === "password")).toEqual([]);
  });

  it("never projects a provider token or subject into mobile props or diagnostics", () => {
    const canaryToken = "github_token_canary_9f42";
    const canarySubject = "github_subject_canary_18492";
    const state = accountState({
      externalIdentityConfiguration: {
        version: 1,
        providers: [{ provider: "github", login: true, signup: true, link: true }],
        providerToken: canaryToken,
      } as never,
      security: {
        ...accountState().security!,
        externalIdentities: [
          {
            provider: "github",
            login: "octocat",
            displayName: null,
            connectedAt: NOW,
            lastUsedAt: null,
            providerSubject: canarySubject,
          } as never,
        ],
      },
    });
    const rendered = JSON.stringify(harness({ account: state }).view());
    expect(rendered).not.toContain(canaryToken);
    expect(rendered).not.toContain(canarySubject);
  });
});
