import type { EnvironmentId } from "@ryco/contracts";
import {
  HOSTED_CONNECTION_STATUS_INDICATORS,
  HOSTED_CONNECTION_STATUS_TEXTS,
  type HostedAccountActionStatus,
  type HostedE2eeChannelStatus,
  type HostedHubState,
  type HostedNativeDeviceSecurityStatus,
} from "@ryco/client-runtime/authorization";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const controller = vi.hoisted(() => ({
  signIn: vi.fn(async () => undefined),
  signInWithExternalProvider: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
  bootstrap: vi.fn(async () => undefined),
  cancelAuthentication: vi.fn(),
  dismissRecoveryCodes: vi.fn(),
  acknowledgeDeliveryUnknown: vi.fn(),
}));

// Mocked rather than injected: the real module configures the hosted runtime,
// which reaches the enclave device key, SecureStore, and `expo-constants`.
// Nothing in this suite should touch the native bridge.
vi.mock("../../hostedHub/state", () => ({ hostedHubController: controller }));

import {
  deriveHostedAccountView,
  deriveHostedBrowserSignInAction,
  deriveHostedSignInView,
  HOSTED_DEVICE_REMOVED_MESSAGE,
  hostedStatusTone,
  type HostedAccountView,
  type HostedSignInView,
} from "./hostedAuthModel";

const ENVIRONMENT_ID = "env-1" as EnvironmentId;

/**
 * A store snapshot. The defaults are the runtime's own initial state; each case
 * patches only the slots its surface reads, so a surface that starts depending
 * on a new slot fails loudly rather than silently reading a default.
 */
function hostedState(overrides: Partial<HostedHubState> = {}): HostedHubState {
  return {
    bootstrapAvailable: false,
    accountStatus: "signed-out",
    account: null,
    session: null,
    directoryStatus: "idle",
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
    errorMessage: null,
    errorReason: null,
    generation: 0,
    ...overrides,
  };
}

const AUTHENTICATED: Partial<HostedHubState> = {
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
};

const ONLINE_NODE: Partial<HostedHubState> = {
  directoryStatus: "ready",
  transportStatus: "online",
  sessionStatus: "ready",
  browserStatus: "current",
  selectionStatus: "online",
  effectiveRole: "owner",
  sessionEstablished: true,
  selectedNode: {
    id: "node_01J8ZQ5V2N7X2222222222",
    environmentId: ENVIRONMENT_ID,
    label: "Studio",
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "1.2.3",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastAuthenticatedAt: 1_700_000_000_000,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant_01J8ZQ5V2N7X3333333333", role: "owner" },
    effectiveRole: "owner",
    presence: { online: true, lastHeartbeatAt: 1_700_000_000_000 },
  },
};

function signInView(
  overrides: Partial<HostedHubState> = {},
  options: {
    readonly hostedModeAvailable?: boolean;
    readonly e2eeStatus?: HostedE2eeChannelStatus;
    readonly github?: boolean;
  } = {},
): HostedSignInView {
  return deriveHostedSignInView({
    state: hostedState(overrides),
    externalIdentityConfiguration: {
      version: 1,
      providers:
        options.github === true
          ? [{ provider: "github", login: true, signup: true, link: true }]
          : [],
    },
    hostedModeAvailable: options.hostedModeAvailable ?? true,
    e2eeStatus: options.e2eeStatus ?? "unavailable",
    onPairDevice: vi.fn(),
    onDone: vi.fn(),
  });
}

function accountView(
  overrides: Partial<HostedHubState> = {},
  options: {
    readonly hostedModeAvailable?: boolean;
    readonly actionStatus?: HostedAccountActionStatus;
    readonly e2eeStatus?: HostedE2eeChannelStatus;
    readonly nativeDeviceSecurityStatus?: HostedNativeDeviceSecurityStatus;
  } = {},
): HostedAccountView {
  return deriveHostedAccountView({
    state: hostedState(overrides),
    hostedModeAvailable: options.hostedModeAvailable ?? true,
    e2eeStatus: options.e2eeStatus ?? "unavailable",
    ...(options.nativeDeviceSecurityStatus === undefined
      ? {}
      : { nativeDeviceSecurityStatus: options.nativeDeviceSecurityStatus }),
    onSignIn: vi.fn(),
    actionStatus: options.actionStatus ?? "idle",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hosted sign-in surface", () => {
  it("exposes the generic browser handoff for native credential surfaces", async () => {
    const action = deriveHostedBrowserSignInAction();

    expect([action.id, action.label, action.disabled]).toEqual([
      "sign-in",
      "Continue in browser",
      false,
    ]);
    await action.run();
    expect(controller.signIn).toHaveBeenCalledTimes(1);
  });

  it("offers one browser sign-in when signed out, and calls signIn()", () => {
    const view = signInView();
    expect(view.surface).toBe("signed-out");
    expect(view.primaryAction?.id).toBe("sign-in");
    expect(view.primaryAction?.label).toBe("Continue in browser");
    expect(view.secondaryAction).toBeNull();
    view.primaryAction?.run();
    expect(controller.signIn).toHaveBeenCalledTimes(1);
  });

  it("offers the typed GitHub handoff only when provider policy advertises login", () => {
    expect(signInView().providerActions).toEqual([]);

    const view = signInView({}, { github: true });
    expect(view.providerActions.map((provider) => [provider.id, provider.label])).toEqual([
      ["sign-in-github", "Continue with GitHub"],
    ]);
    view.providerActions[0]?.run();
    expect(controller.signInWithExternalProvider).toHaveBeenCalledWith("github");
    expect(controller.signIn).not.toHaveBeenCalled();
  });

  it("routes first run through the same browser handoff", () => {
    const view = signInView({ bootstrapAvailable: true });
    expect(view.surface).toBe("first-run");
    expect(view.primaryAction?.id).toBe("sign-in");
    expect(view.secondaryAction).toBeNull();
    view.primaryAction?.run();
    expect(controller.signIn).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight ceremony through cancelAuthentication()", () => {
    const view = signInView({ accountStatus: "authenticating" });
    expect(view.surface).toBe("authenticating");
    expect(view.busy).toBe(true);
    expect(view.primaryAction?.id).toBe("cancel-authentication");
    view.primaryAction?.run();
    expect(controller.cancelAuthentication).toHaveBeenCalledTimes(1);
  });

  it("offers sign-in again when the session expired", () => {
    const view = signInView({ accountStatus: "session-expired" });
    expect(view.surface).toBe("session-expired");
    view.primaryAction?.run();
    expect(controller.signIn).toHaveBeenCalledTimes(1);
    expect(view.secondaryAction).toBeNull();
  });

  it("explains an unreachable Hub and retries through bootstrap()", () => {
    const view = signInView({ accountStatus: "unavailable" });
    expect(view.surface).toBe("hub-unreachable");
    expect(view.primaryAction?.id).toBe("retry-hub");
    view.primaryAction?.run();
    expect(controller.bootstrap).toHaveBeenCalledTimes(1);
    expect(view.secondaryAction?.id).toBe("pair-device");
  });

  it("offers only the direct-node path when hosted mode is unavailable", () => {
    const onPairDevice = vi.fn();
    const view = deriveHostedSignInView({
      state: hostedState({ accountStatus: "authenticated", ...AUTHENTICATED }),
      externalIdentityConfiguration: null,
      hostedModeAvailable: false,
      e2eeStatus: "unavailable",
      onPairDevice,
      onDone: vi.fn(),
    });
    expect(view.surface).toBe("unavailable");
    expect(view.primaryAction?.id).toBe("pair-device");
    expect(view.secondaryAction).toBeNull();
    view.primaryAction?.run();
    expect(onPairDevice).toHaveBeenCalledTimes(1);
    // No hosted controller call is reachable from this surface.
    expect(controller.signIn).not.toHaveBeenCalled();
    expect(controller.bootstrap).not.toHaveBeenCalled();
  });

  it("shows recovery codes ahead of the connected summary and dismisses them", () => {
    const view = signInView({ ...AUTHENTICATED, recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] });
    expect(view.surface).toBe("recovery-codes");
    expect(view.recoveryCodes).toEqual(["aaaa-bbbb", "cccc-dddd"]);
    expect(view.primaryAction?.id).toBe("dismiss-recovery-codes");
    view.primaryAction?.run();
    expect(controller.dismissRecoveryCodes).toHaveBeenCalledTimes(1);
  });

  it("renders the runtime's bounded status once authenticated", () => {
    const view = signInView({ ...AUTHENTICATED, ...ONLINE_NODE });
    expect(view.surface).toBe("authenticated");
    expect(view.statusText).toBe("Online");
    expect(view.statusIndicator).toEqual({
      shortLabel: "Online",
      connected: true,
      guarantee: "none",
    });
    expect(HOSTED_CONNECTION_STATUS_TEXTS).toContain(view.statusText);
    expect(view.detail).toBe("Signed in as Ada Lovelace.");
  });

  it("keeps the delivery-unknown acknowledgement mandatory and never auto-dismisses it", () => {
    const pending = signInView({
      ...AUTHENTICATED,
      ...ONLINE_NODE,
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
    });
    expect(pending.deliveryUnknown?.action.disabled).toBe(true);
    pending.deliveryUnknown?.action.run();
    // A disabled action is inert at the model layer too, not merely greyed out
    // by whichever surface remembered to pass the flag through.
    expect(controller.acknowledgeDeliveryUnknown).not.toHaveBeenCalled();
    // Still offered — a disabled affordance is not a dismissed one.
    expect(pending.deliveryUnknown).not.toBeNull();

    const recovered = signInView({
      ...AUTHENTICATED,
      ...ONLINE_NODE,
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    expect(recovered.deliveryUnknown?.action.disabled).toBe(false);
    expect(recovered.statusText).toBe("Delivery unknown");
    recovered.deliveryUnknown?.action.run();
    expect(controller.acknowledgeDeliveryUnknown).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to press while signing out", () => {
    const view = signInView({ accountStatus: "signing-out" });
    expect(view.surface).toBe("signing-out");
    expect(view.busy).toBe(true);
    expect(view.primaryAction).toBeNull();
    expect(view.secondaryAction).toBeNull();
  });

  it("surfaces the store's error message without inventing one", () => {
    expect(signInView({ errorMessage: "Hub is temporarily unavailable." }).errorMessage).toBe(
      "Hub is temporarily unavailable.",
    );
  });

  it("renders the bounded explanation for a typed native-session failure", () => {
    expect(
      signInView({
        accountStatus: "session-expired",
        errorMessage: null,
        errorReason: "missing-token",
      }).errorMessage,
    ).toBe("This device no longer has its secure Hub session. Sign in again to continue.");
  });
});

describe("hosted account surface", () => {
  it("is entirely unavailable without hosted mode", () => {
    const view = accountView({ ...AUTHENTICATED }, { hostedModeAvailable: false });
    expect(view.available).toBe(false);
    expect(view.signedIn).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.signInAction).toBeNull();
    expect(view.deliveryUnknown).toBeNull();
  });

  it("offers a sign-in route while signed out", () => {
    const onSignIn = vi.fn();
    const view = deriveHostedAccountView({
      state: hostedState(),
      hostedModeAvailable: true,
      e2eeStatus: "unavailable",
      onSignIn,
      actionStatus: "idle",
    });
    expect(view.signedIn).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.detail).toBe(
      "Continue in your browser to sign in and reach the nodes on your Hub.",
    );
    expect(view.signInAction?.label).toBe("Continue in browser");
    view.signInAction?.run();
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("signs out through signOut(), behind a confirmation", () => {
    const view = accountView({ ...AUTHENTICATED, ...ONLINE_NODE });
    const signOut = view.rows.find((row) => row.id === "sign-out");
    expect(signOut?.destructive).toBe(true);
    expect(signOut?.confirm?.confirmText).toBe("Sign out");
    expect(signOut?.confirm?.message).toContain("Studio");
    signOut?.run();
    expect(controller.signOut).toHaveBeenCalledTimes(1);
  });

  /**
   * The regression this change exists to prevent.
   *
   * "Add this device" and "Recovery codes" used to open the Hub's web app from
   * here, because the runtime had no client method for either ceremony. Both
   * are now DPoP-native and live on the account-management surface, so an
   * authenticated account view must have no route into the browser at all —
   * sign-out is the only row it offers, and nothing on it can start a fallback
   * session.
   */
  it("reaches no browser from an authenticated account", () => {
    const view = accountView({ ...AUTHENTICATED, ...ONLINE_NODE });
    expect(view.rows.map((row) => row.id)).toEqual(["sign-out"]);
    for (const row of view.rows) row.run();
    view.dismissRecoveryCodes?.run();
    view.deliveryUnknown?.action.run();
    expect(controller.signIn).not.toHaveBeenCalled();
  });

  /**
   * The session kind is not knowable from here. A session minted from a
   * password, a recovery code, or an email link looks identical to a passkey
   * one at both the client type and the Hub, so the account header must not
   * claim the stronger of the two.
   */
  it("claims only what the client can attest to about the session", () => {
    const view = accountView({ ...AUTHENTICATED, ...ONLINE_NODE });
    expect(view.detail).toBe(
      "Every request from this device is signed with a key held in its secure hardware.",
    );
    expect(view.detail).not.toMatch(/passkey/i);
  });

  it("names a removed device as removed and points at a fresh sign-in", () => {
    const view = accountView(
      { ...AUTHENTICATED, ...ONLINE_NODE },
      { nativeDeviceSecurityStatus: "revoked" },
    );
    expect(view.statusText).toBe("Device removed");
    expect(view.statusIndicator?.shortLabel).toBe("Removed");
    expect(view.detail).toBe(HOSTED_DEVICE_REMOVED_MESSAGE);
    expect(view.rows.map((row) => row.id)).toEqual(["sign-out"]);
    // The app ships apart from the Hub: a Hub that cannot re-enroll a removed
    // installation answers every fresh sign-in with `Device encryption
    // unavailable`, so the copy must not promise that signing in is enough.
    expect(view.detail).toMatch(/Device encryption unavailable/);
    expect(view.detail).toMatch(/reinstall/i);
  });

  it("acknowledges rotated recovery codes only from the explicit action", () => {
    const none = accountView({ ...AUTHENTICATED, ...ONLINE_NODE });
    expect(none.recoveryCodes).toEqual([]);
    expect(none.dismissRecoveryCodes).toBeNull();

    const shown = accountView({
      ...AUTHENTICATED,
      ...ONLINE_NODE,
      recoveryCodes: ["aaaa-bbbb", "cccc-dddd"],
    });
    expect(shown.recoveryCodes).toEqual(["aaaa-bbbb", "cccc-dddd"]);
    expect(controller.dismissRecoveryCodes).not.toHaveBeenCalled();
    shown.dismissRecoveryCodes?.run();
    expect(controller.dismissRecoveryCodes).toHaveBeenCalledTimes(1);
  });

  it("refuses to acknowledge the displayed codes while their replacement is in flight", () => {
    // The codes on screen are the ones the rotation is about to invalidate, so
    // this tap cannot mean "I saved the new ones" — it would clear the display
    // the replacement is due to arrive in, having already agreed to kill the
    // set the user just wrote down.
    const rotating = accountView(
      { ...AUTHENTICATED, ...ONLINE_NODE, recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] },
      { actionStatus: "regenerating-recovery-codes" },
    );

    // Visible, so the state is never a mystery — and inert, including for a
    // hardware keyboard or an accessibility action that never sees `disabled`.
    expect(rotating.dismissRecoveryCodes?.disabled).toBe(true);
    rotating.dismissRecoveryCodes?.run();
    expect(controller.dismissRecoveryCodes).not.toHaveBeenCalled();

    // Any other action in flight is unrelated to what is on screen.
    const adding = accountView(
      { ...AUTHENTICATED, ...ONLINE_NODE, recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] },
      { actionStatus: "adding-passkey" },
    );
    expect(adding.dismissRecoveryCodes?.disabled).toBe(false);
    adding.dismissRecoveryCodes?.run();
    expect(controller.dismissRecoveryCodes).toHaveBeenCalledTimes(1);
  });

  it("gates node affordances with the runtime's capability resolution", () => {
    const ready = accountView({ ...AUTHENTICATED, ...ONLINE_NODE });
    expect(ready.capability).toEqual({ hosted: true, allowed: true, reason: null });
    expect(ready.capabilityNotice).toBeNull();
    expect(ready.statusText).toBe("Online");
    expect(ready.roleLabel).toBe("Owner");

    const stale = accountView({ ...AUTHENTICATED, ...ONLINE_NODE, browserStatus: "stale" });
    expect(stale.capability.allowed).toBe(false);
    expect(stale.capabilityNotice).toBe(stale.capability.reason);
    expect(stale.capabilityNotice).toBeTruthy();

    const viewer = accountView({ ...AUTHENTICATED, ...ONLINE_NODE, effectiveRole: "viewer" });
    expect(viewer.capability.allowed).toBe(false);
    expect(viewer.capabilityNotice).toContain("role");
  });

  it("carries the same mandatory delivery-unknown acknowledgement", () => {
    const view = accountView({
      ...AUTHENTICATED,
      ...ONLINE_NODE,
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    view.deliveryUnknown?.action.run();
    expect(controller.acknowledgeDeliveryUnknown).toHaveBeenCalledTimes(1);
  });
});

describe("hosted status tone", () => {
  it("colours only from the runtime's indicator and never relabels it", () => {
    expect(hostedStatusTone({ shortLabel: "Online", connected: true, guarantee: "none" })).toEqual({
      label: "Online",
      pillClassName: "bg-success-bg border border-success-border",
      textClassName: "text-success",
    });
    expect(
      hostedStatusTone({ shortLabel: "Revoked", connected: false, guarantee: "none" })
        .textClassName,
    ).toBe("text-danger-foreground");
    expect(
      hostedStatusTone({ shortLabel: "Connecting", connected: false, guarantee: "none" })
        .textClassName,
    ).toBe("text-foreground-muted");
  });

  it("withholds the connected token from a legacy channel and never relabels it", () => {
    // docs/relay-e2ee-protocol.md §12.2: a channel that fell back is labeled
    // legacy in every user-facing surface and displays no E2EE claim. A green
    // pill reading `Legacy` is that label wearing the verified session's colour.
    const legacy = hostedStatusTone(HOSTED_CONNECTION_STATUS_INDICATORS["Legacy connection"]);
    expect(legacy.label).toBe("Legacy");
    expect(legacy.textClassName).not.toBe("text-success");
    const encrypted = hostedStatusTone(
      HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted · Verified locally"],
    );
    expect(encrypted.label).toBe("Verified");
    expect(encrypted.textClassName).toBe("text-success");
    // §13.1's release gate: an unverified E2EE channel is not a usable session.
    expect(
      hostedStatusTone(HOSTED_CONNECTION_STATUS_INDICATORS["Not verified"]).textClassName,
    ).toBe("text-danger-foreground");
  });

  it("withholds the verified session's colour from §2.2's web row", () => {
    // §2.2/§2.4: the Hub serves the browser's JavaScript, so the web NX row is
    // encrypted while that code is honest and NOT the operator-proof row. The
    // mapper is the repository's only tone decision, so a web chip that differs
    // from the verified one by a noun and by nothing else is §2.2's "stronger
    // claim for a weaker configuration" rendered.
    const web = hostedStatusTone(HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted web"]);
    const verified = hostedStatusTone(
      HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted · Verified locally"],
    );
    expect(web.textClassName).not.toBe("text-success");
    expect(web.pillClassName).not.toBe(verified.pillClassName);
    expect(web).not.toEqual({ ...verified, label: web.label });
    // …and it is not the fallback's colour either: a web NX channel IS
    // encrypted, and §12.2's amber is the label for one that is not.
    const legacy = hostedStatusTone(HOSTED_CONNECTION_STATUS_INDICATORS["Legacy connection"]);
    expect(web.pillClassName).not.toBe(legacy.pillClassName);
    expect(web.textClassName).not.toBe(legacy.textClassName);
    // Nor the tone of a state that is not a usable connection at all: the web
    // row IS one (§13.1's release gate is native-only).
    expect(web.textClassName).not.toBe(
      hostedStatusTone(HOSTED_CONNECTION_STATUS_INDICATORS.connecting).textClassName,
    );
    expect(web.label).toBe(HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted web"].shortLabel);
  });

  it("cannot contradict its own label, for any status in the vocabulary", () => {
    for (const text of HOSTED_CONNECTION_STATUS_TEXTS) {
      const indicator = HOSTED_CONNECTION_STATUS_INDICATORS[text];
      const tone = hostedStatusTone(indicator);
      // The label is the runtime's, never the mapper's.
      expect(tone.label).toBe(indicator.shortLabel);
      // And the success token is reachable only where §2.2 permits a claim,
      // stated POSITIVELY: a usable connection whose guarantee is the absence of
      // a claim or §2.2's bottom row. Written as `!== "legacy"` this admitted
      // every guarantee added later — `web` among them — by default, which is
      // exactly how the web NX row took the verified session's colour.
      if (tone.textClassName === "text-success") {
        expect(indicator.connected).toBe(true);
        expect(["none", "e2ee"], `guarantee for "${text}"`).toContain(indicator.guarantee);
      }
    }
  });

  it("uses only design tokens — no hardcoded colours and no `dark:` prefixes", () => {
    // The REAL indicators as well as the synthetic disconnected ones: keyed on
    // `guarantee: "none"` alone this walked two of the mapper's branches and
    // never saw the tokens a claim chooses.
    const tones = [
      ...HOSTED_CONNECTION_STATUS_TEXTS.map((label) =>
        hostedStatusTone({ shortLabel: label, connected: false, guarantee: "none" }),
      ),
      ...HOSTED_CONNECTION_STATUS_TEXTS.map((text) =>
        hostedStatusTone(HOSTED_CONNECTION_STATUS_INDICATORS[text]),
      ),
    ];
    for (const tone of tones) {
      const classNames = `${tone.pillClassName} ${tone.textClassName}`;
      expect(classNames).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(classNames).not.toMatch(/\bdark:/);
      expect(classNames).not.toMatch(/\brgba?\(/);
    }
    // Every branch of the mapper is actually exercised above, so the scan cannot
    // pass by visiting one of them.
    expect(new Set(tones.map((tone) => tone.pillClassName)).size).toBe(5);
  });
});

/**
 * The falsifiable security assertion for this layer.
 *
 * The hosted store holds no bearer token, DPoP proof, `ath`, `jti`, or relay
 * ticket — those never leave the session-credentials seam, the signer, and the
 * relay engine. This renders every hosted surface against an authenticated
 * session and proves the view models reintroduce none of it, and additionally
 * that they never expose an account id, session id, node id, or grant id: a
 * view model carries status and display names, nothing else.
 */
describe("no secret or identifying material reaches a hosted view model", () => {
  const SECRET_KEY_PATTERN =
    /token|proof|jwk|jws|jwt|\bath\b|\bjti\b|ticket|credential|secret|privatekey|challenge|csrf|cookie|bearer|dpop|authorization/i;
  const IDENTIFIER_VALUES = [
    "acct_01J8ZQ5V2N7X0000000000",
    "sess_01J8ZQ5V2N7X1111111111",
    "node_01J8ZQ5V2N7X2222222222",
    "grant_01J8ZQ5V2N7X3333333333",
  ];

  function everySurface(): ReadonlyArray<{ readonly name: string; readonly view: unknown }> {
    const authenticated = { ...AUTHENTICATED, ...ONLINE_NODE };
    return [
      { name: "signed-out", view: signInView() },
      { name: "first-run", view: signInView({ bootstrapAvailable: true }) },
      { name: "authenticating", view: signInView({ accountStatus: "authenticating" }) },
      { name: "session-expired", view: signInView({ accountStatus: "session-expired" }) },
      { name: "signing-out", view: signInView({ accountStatus: "signing-out" }) },
      { name: "hub-unreachable", view: signInView({ accountStatus: "unavailable" }) },
      {
        name: "unavailable",
        view: signInView(authenticated, { hostedModeAvailable: false }),
      },
      { name: "authenticated", view: signInView(authenticated) },
      {
        name: "recovery-codes",
        view: signInView({ ...authenticated, recoveryCodes: ["aaaa-bbbb"] }),
      },
      {
        name: "delivery-unknown",
        view: signInView({
          ...authenticated,
          sessionStatus: "delivery-unknown",
          sessionRecoveredAfterUnknown: true,
        }),
      },
      { name: "account signed-out", view: accountView() },
      { name: "account", view: accountView(authenticated) },
      {
        name: "account unavailable",
        view: accountView(authenticated, { hostedModeAvailable: false }),
      },
    ];
  }

  /** Every string a surface can render, and every key it exposes. */
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

  it("exposes no credential-shaped key on any surface", () => {
    for (const { name, view } of everySurface()) {
      const keys: string[] = [];
      walk(view, keys, []);
      const offenders = keys.filter((key) => SECRET_KEY_PATTERN.test(key));
      expect(offenders, `surface ${name}`).toEqual([]);
    }
  });

  it("leaks no account, session, node, or grant identifier into rendered text", () => {
    for (const { name, view } of everySurface()) {
      const strings: string[] = [];
      walk(view, [], strings);
      const rendered = strings.join("\u0000");
      for (const identifier of IDENTIFIER_VALUES) {
        expect(rendered.includes(identifier), `surface ${name} leaked ${identifier}`).toBe(false);
      }
      // Nothing that looks like a bearer/DPoP header or a base64url blob.
      expect(rendered).not.toMatch(/\bDPoP\b|\bBearer\b/);
      expect(rendered).not.toMatch(/eyJ[\w-]{6,}/);
      expect(rendered).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    }
  });

  /**
   * The TOTP enrolment secret is the other piece of key material the hosted
   * store can hold. It exists for exactly one screen — the enrolment prompt in
   * `hostedAccountModel.ts` — and neither of these two surfaces has any reason
   * to see it, so both are asserted blind to it even while it is in the store.
   */
  it("never projects the TOTP enrolment secret", () => {
    const enrolling: Partial<HostedHubState> = {
      ...AUTHENTICATED,
      ...ONLINE_NODE,
      totpEnrollment: {
        secretBase32: "JBSWY3DPEHPK3PXP",
        provisioningUri: "otpauth://totp/Ryco:ada?secret=JBSWY3DPEHPK3PXP&issuer=Ryco",
      },
    };
    for (const view of [signInView(enrolling), accountView(enrolling)]) {
      const keys: string[] = [];
      const strings: string[] = [];
      walk(view, keys, strings);
      expect(keys).not.toContain("secretBase32");
      expect(keys).not.toContain("provisioningUri");
      expect(strings.join(" ")).not.toContain("JBSWY3DPEHPK3PXP");
      expect(strings.join(" ")).not.toContain("otpauth");
    }
  });

  it("only ever emits status text from the runtime's bounded vocabulary", () => {
    for (const { name, view } of everySurface()) {
      const statusText = (view as { readonly statusText: string | null }).statusText;
      if (statusText === null) continue;
      expect(HOSTED_CONNECTION_STATUS_TEXTS, `surface ${name}`).toContain(statusText);
    }
  });
});
