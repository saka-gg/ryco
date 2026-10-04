import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";

import type { HostedHubNode, HostedHubSessionResponse } from "./types";

const originalDocument = globalThis.document;

// The lifecycle transition queue is injected as fakes: state.ts imports these
// directly, and mocking the module is how the controller's lifecycle
// dependency is stubbed. The relay-attempt reset is owned solely by the
// transition queue (see environment.test.ts for the ordered-teardown contract);
// the deactivate fake below mirrors that contract — deactivation resets the
// relay attempt — so state-level teardown can still assert the reset occurs.
const { activateHostedNode, deactivateHostedNode, suspendHostedNode, resetRelayAttemptFactory } =
  vi.hoisted(() => {
    const resetRelayAttemptFactory = vi.fn();
    return {
      activateHostedNode: vi.fn(
        async (
          _node?: HostedHubNode,
          _previousEnvironmentId?: EnvironmentId | null,
          _signal?: AbortSignal,
        ): Promise<void> => undefined,
      ),
      deactivateHostedNode: vi.fn(async (_environmentId?: EnvironmentId): Promise<void> => {
        resetRelayAttemptFactory();
      }),
      suspendHostedNode: vi.fn(async (_environmentId?: EnvironmentId): Promise<void> => undefined),
      resetRelayAttemptFactory,
    };
  });
vi.mock("./environment", () => ({ activateHostedNode, deactivateHostedNode, suspendHostedNode }));

import { HostedHubApiError, STEP_UP_REQUIRED_CODE, type HostedHubApi } from "./api";
import {
  configureHostedRuntime,
  type HostedNodeLifecycle,
  type HostedRuntimeConfiguration,
} from "./runtime";
import {
  DIRECTORY_PRESENCE_REFRESH_MS,
  DIRECTORY_PRESENCE_WINDOW_MS,
  HOSTED_ACCOUNT_BUSY_MESSAGE,
  HOSTED_ACCOUNT_SIGNED_OUT_MESSAGE,
  HOSTED_PASSKEY_UNCONFIRMED_MESSAGE,
  HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE,
  HOSTED_TOTP_ENROLLMENT_UNDISPLAYED_MESSAGE,
  hostedAccountRecoversOnConnectivity,
  hostedAccountStore,
  hostedHubController,
  hostedHubStore,
  hostedRecoveryCodeDisplayStore,
  markHostedSessionReady,
} from "./state";

const hasHostedRelayPendingRequests = vi.fn(() => false);

/** Configurable Hub API instance the controller reads through the runtime. */
const hostedHubApi = {
  restoreSession: vi.fn(),
  getBootstrapAvailability: vi.fn(),
  signIn: vi.fn(),
  signInWithExternalProvider: vi.fn(),
  signInWithRecoveryCode: vi.fn(),
  signOut: vi.fn(),
  bootstrapOwner: vi.fn(),
  redeemInvitation: vi.fn(),
  listNodes: vi.fn(),
  listPasskeys: vi.fn(),
  listE2eeDevices: vi.fn(),
  getAccountSecurity: vi.fn(),
  getExternalIdentityConfiguration: vi.fn(),
  connectExternalIdentity: vi.fn(),
  cancelExternalIdentityConnection: vi.fn(),
  finishBrowserExternalIdentityConnection: vi.fn(),
  disconnectExternalIdentity: vi.fn(),
  addPasskey: vi.fn(),
  revokePasskey: vi.fn(),
  renameE2eeDevice: vi.fn(),
  revokeE2eeDevice: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  setPassword: vi.fn(),
  removePassword: vi.fn(),
  beginTotpEnrollment: vi.fn(),
  confirmTotpEnrollment: vi.fn(),
  revokeTotp: vi.fn(),
  requestEmailVerification: vi.fn(),
  clearSessionMaterial: vi.fn(),
} as unknown as HostedHubApi;

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the hosted controller tests");
    },
  },
);

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

function fakeRuntime(): HostedRuntimeConfiguration {
  return {
    endpoint: unusedService as EndpointService,
    httpClient: unusedService as HttpClientService,
    passkeyCeremony: unusedService as PasskeyCeremonyService,
    sessionCredentials: unusedService as SessionCredentialsService,
    nodeLifecycle,
    timers: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
      queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
    },
    // Mirror the web AppLifecycle foreground signals so the visibility-gated
    // directory scheduling behaves as it does in the browser.
    isForeground: () =>
      (globalThis.document as { visibilityState?: string } | undefined)?.visibilityState !==
      "hidden",
    subscribeForeground: (listener) => {
      const doc = globalThis.document as
        | {
            visibilityState?: string;
            addEventListener: (type: string, handler: () => void, options?: unknown) => void;
            removeEventListener: (type: string, handler: () => void) => void;
          }
        | undefined;
      const onVisibility = () => {
        if (doc?.visibilityState === "visible") listener();
      };
      doc?.addEventListener("visibilitychange", onVisibility, { once: true });
      return () => doc?.removeEventListener("visibilitychange", onVisibility);
    },
    hasPendingRelayRequests: hasHostedRelayPendingRequests,
    resetRelayAttemptFactory,
    relayUrl: () => "wss://hub.example.test/v1/relay/client",
    createRelaySocket: () => ({}),
  };
}

const sessionResponse: HostedHubSessionResponse = {
  account: {
    id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Ada",
    role: "owner",
    createdAt: 1,
    disabledAt: null,
  },
  session: {
    id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
    accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    createdAt: 1,
    expiresAt: 2,
    lastSeenAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
  },
  csrfToken: "csrf-sensitive-canary",
};

const emptySecurity = {
  passwordConfigured: false,
  totpEnrolled: false,
  emailDeliveryConfigured: false,
  email: null,
  externalIdentities: [],
} as const;

function node(
  id = "node_aaaaaaaaaaaaaaaaaaaaaa",
  role: "viewer" | "operator" | "owner" = "operator",
): HostedHubNode {
  return {
    id,
    environmentId: EnvironmentId.make(`env_${id.slice(5).padEnd(22, "a").slice(0, 22)}`),
    label: `Node ${id.slice(-1)}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.slice(5)}`, role },
    effectiveRole: role,
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hostedHubApi.getAccountSecurity).mockResolvedValue(emptySecurity);
  hasHostedRelayPendingRequests.mockReturnValue(false);
  configureHostedRuntime(fakeRuntime(), hostedHubApi);
});

afterEach(() => {
  hostedHubController.resetForTests();
  activateHostedNode.mockClear();
  deactivateHostedNode.mockClear();
  suspendHostedNode.mockClear();
  hasHostedRelayPendingRequests.mockReset();
  hasHostedRelayPendingRequests.mockReturnValue(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
});

describe("hosted account state", () => {
  it("discovers bootstrap availability only after a signed-out session result", async () => {
    vi.spyOn(hostedHubApi, "restoreSession").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );
    vi.spyOn(hostedHubApi, "getBootstrapAvailability").mockResolvedValue(true);
    await hostedHubController.bootstrap();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "signed-out",
      bootstrapAvailable: true,
    });
  });

  it("fails closed when bootstrap availability cannot be loaded", async () => {
    vi.spyOn(hostedHubApi, "restoreSession").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );
    vi.spyOn(hostedHubApi, "getBootstrapAvailability").mockRejectedValue(
      new HostedHubApiError("unavailable", 0),
    );
    await hostedHubController.bootstrap();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "signed-out",
      bootstrapAvailable: false,
    });
  });

  it.each([
    ["an expired session", new HostedHubApiError("session_invalid", 401)],
    [
      "an invalidated native token",
      new HostedHubApiError(
        "session_invalid",
        401,
        undefined,
        undefined,
        undefined,
        "token-invalidated",
      ),
    ],
  ])("drops session material when bootstrap reports %s", async (_label, failure) => {
    vi.spyOn(hostedHubApi, "restoreSession").mockRejectedValue(failure);
    vi.spyOn(hostedHubApi, "getBootstrapAvailability").mockResolvedValue(false);

    await hostedHubController.bootstrap();

    expect(hostedHubApi.clearSessionMaterial).toHaveBeenCalledOnce();
    expect(hostedHubStore.getState().accountStatus).toBe("signed-out");
  });

  it.each([
    [
      "transport loss",
      new HostedHubApiError(
        "unavailable",
        0,
        undefined,
        undefined,
        undefined,
        "transport-unavailable",
      ),
    ],
    [
      "the request deadline",
      new HostedHubApiError("timeout", 0, undefined, undefined, undefined, "request-timeout"),
    ],
    [
      "a locked device that cannot sign a proof",
      new HostedHubApiError(
        "native_session_unavailable",
        0,
        undefined,
        undefined,
        undefined,
        "proof-signing-failed",
      ),
    ],
    ["a proxy error page", new HostedHubApiError("invalid_response", 502)],
    ["a captive portal page", new HostedHubApiError("invalid_response", 200)],
    ["a proxy's own 401 page", new HostedHubApiError("invalid_response", 401)],
    ["Hub rate limiting", new HostedHubApiError("rate_limited", 429, 5_000)],
    ["a failing Hub", new HostedHubApiError("unavailable", 503)],
  ])("keeps session material when bootstrap fails with %s", async (_label, failure) => {
    vi.useFakeTimers();
    vi.spyOn(hostedHubApi, "restoreSession").mockRejectedValue(failure);

    await hostedHubController.bootstrap();

    // The stored native token is the only copy of a DPoP-bound session the Hub
    // never rejected; discarding it here forced a full sign-in after every
    // offline launch.
    expect(hostedHubApi.clearSessionMaterial).not.toHaveBeenCalled();
    expect(hostedHubApi.getBootstrapAvailability).not.toHaveBeenCalled();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "unavailable",
      account: null,
      session: null,
      effectiveRole: null,
      accessRecoveryPending: true,
    });
  });

  it("re-runs a failed bootstrap on its own once the Hub answers again", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 0))
      .mockRejectedValueOnce(new HostedHubApiError("timeout", 0))
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    await hostedHubController.bootstrap();
    expect(hostedHubStore.getState().accountStatus).toBe("unavailable");

    await vi.advanceTimersByTimeAsync(999);
    expect(restoreSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(hostedHubStore.getState().accountStatus).toBe("unavailable");

    // Bounded exponential backoff: the second retry waits twice as long.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(hostedHubStore.getState().accessRecoveryPending).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(restoreSession).toHaveBeenCalledTimes(3);
    await vi.waitFor(() =>
      expect(hostedHubStore.getState()).toMatchObject({
        accountStatus: "authenticated",
        directoryStatus: "ready",
        accessRecoveryPending: false,
      }),
    );
    expect(hostedHubApi.clearSessionMaterial).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(restoreSession).toHaveBeenCalledTimes(3);
  });

  it("waits out a Hub retry-after before re-running bootstrap", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValueOnce(new HostedHubApiError("rate_limited", 429, 30_000))
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    await hostedHubController.bootstrap();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(restoreSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(restoreSession).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(hostedHubStore.getState().accountStatus).toBe("authenticated"));
  });

  it("leaves a definite Hub refusal to the next lifecycle signal instead of a timer", async () => {
    vi.useFakeTimers();
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValue(new HostedHubApiError("forbidden", 403));

    await hostedHubController.bootstrap();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(restoreSession).toHaveBeenCalledOnce();
    expect(hostedHubApi.clearSessionMaterial).not.toHaveBeenCalled();
    // Surfaces must not promise an automatic retry that is not coming.
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "unavailable",
      accessRecoveryPending: false,
    });
  });

  it("holds a bootstrap retry that comes due in the background until the next foreground", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const listeners = new Set<() => void>();
    let visibilityState: "hidden" | "visible" = "visible";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        get visibilityState() {
          return visibilityState;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      },
    });
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 0))
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    await hostedHubController.bootstrap();
    visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(1);

    visibilityState = "visible";
    for (const listener of Array.from(listeners)) listener();
    await vi.waitFor(() => expect(hostedHubStore.getState().accountStatus).toBe("authenticated"));
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(listeners).toHaveLength(0);
  });

  it("never lets a pending bootstrap retry interrupt a sign-in the user started", async () => {
    vi.useFakeTimers();
    vi.spyOn(hostedHubApi, "restoreSession").mockRejectedValue(
      new HostedHubApiError("unavailable", 0),
    );
    let signInSignal: AbortSignal | undefined;
    vi.spyOn(hostedHubApi, "signIn").mockImplementation((signal) => {
      signInSignal = signal;
      return new Promise(() => undefined);
    });

    await hostedHubController.bootstrap();
    void hostedHubController.signIn();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(hostedHubApi.restoreSession).toHaveBeenCalledOnce();
    expect(signInSignal?.aborted).toBe(false);
    expect(hostedHubStore.getState().accountStatus).toBe("authenticating");
  });

  it("starts a fresh access check after an account teardown ends the one in flight", async () => {
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    void hostedHubController.bootstrap();
    await hostedHubController.clearAccount("signed-out");
    await hostedHubController.bootstrap();

    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
  });

  it("keeps an adopted credential when the replaced session's check is rejected mid-commit", async () => {
    let rejectReplaced: (error: unknown) => void = () => undefined;
    let replacedSignal: AbortSignal | undefined;
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockImplementationOnce((signal) => {
        replacedSignal = signal;
        // The Hub's answer for the revoked credential is already on its way
        // and lands regardless of the abort.
        return new Promise((_resolve, reject) => {
          rejectReplaced = reject;
        });
      })
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    let finishCommit: (committed: boolean) => void = () => undefined;
    const commit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCommit = resolve;
        }),
    );

    const replaced = hostedHubController.bootstrap();
    const adopted = hostedHubController.adoptSessionCredential(commit);
    expect(replacedSignal?.aborted).toBe(true);

    // A lifecycle signal during the commit joins the adoption rather than
    // reading the credential mid-write.
    void hostedHubController.recoverAfterConnectivity();
    rejectReplaced(new HostedHubApiError("session_invalid", 401));
    await replaced;
    expect(hostedHubApi.clearSessionMaterial).not.toHaveBeenCalled();
    expect(restoreSession).toHaveBeenCalledOnce();

    finishCommit(true);

    await expect(adopted).resolves.toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(hostedHubApi.clearSessionMaterial).not.toHaveBeenCalled();
    expect(hostedHubApi.getBootstrapAvailability).not.toHaveBeenCalled();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      account: sessionResponse.account,
    });
  });

  it("does not wait out a stalled check of the replaced credential", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      // A dead route: the check only ends at the request deadline.
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            globalThis.setTimeout(
              () =>
                reject(
                  new HostedHubApiError(
                    "timeout",
                    0,
                    undefined,
                    undefined,
                    undefined,
                    "request-timeout",
                  ),
                ),
              30_000,
            );
          }),
      )
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    void hostedHubController.bootstrap();
    await expect(hostedHubController.adoptSessionCredential(async () => true)).resolves.toBe(true);
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");

    // The stalled check settles later and publishes nothing, nor re-arms a retry.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      errorMessage: null,
    });
  });

  it("re-checks the stored credential when an adopted one could not be committed", async () => {
    vi.useFakeTimers();
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 0))
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    await hostedHubController.bootstrap();
    await expect(hostedHubController.adoptSessionCredential(async () => false)).resolves.toBe(
      false,
    );

    // The adoption cancelled the pending retry, so it owes the account a check.
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
  });

  it("publishes nothing for the replaced credential when its check succeeds after an adoption", async () => {
    const replacedAccountId = "acct_bbbbbbbbbbbbbbbbbbbbbb";
    const replacedResponse: HostedHubSessionResponse = {
      ...sessionResponse,
      account: { ...sessionResponse.account, id: replacedAccountId, displayName: "Grace" },
      session: { ...sessionResponse.session, accountId: replacedAccountId },
    };
    let resolveReplaced: (response: HostedHubSessionResponse) => void = () => undefined;
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      // The Hub's answer for the replaced credential was already read and
      // lands regardless of the abort.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReplaced = resolve;
          }),
      )
      .mockResolvedValue(sessionResponse);
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    let finishCommit: (committed: boolean) => void = () => undefined;
    const publishedAccountIds = new Set<string>();
    const unsubscribe = hostedHubStore.subscribe(() => {
      const accountId = hostedHubStore.getState().account?.id;
      if (accountId) publishedAccountIds.add(accountId);
    });

    try {
      const replaced = hostedHubController.bootstrap();
      const adopted = hostedHubController.adoptSessionCredential(
        () =>
          new Promise<boolean>((resolve) => {
            finishCommit = resolve;
          }),
      );
      resolveReplaced(replacedResponse);
      await replaced;

      expect(hostedHubStore.getState()).toMatchObject({
        accountStatus: "signed-out",
        account: null,
      });
      expect(listNodes).not.toHaveBeenCalled();

      finishCommit(true);
      await expect(adopted).resolves.toBe(true);
    } finally {
      unsubscribe();
    }

    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(publishedAccountIds).toEqual(new Set([sessionResponse.account.id]));
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      account: sessionResponse.account,
    });
  });

  it("signs in with a recovery code without joining the replaced session's check", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let replacedSignal: AbortSignal | undefined;
    let rejectReplaced: (error: unknown) => void = () => undefined;
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      // The page loaded during a Hub deploy.
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 0))
      // The access-recovery retry, sent with the session the code replaces.
      .mockImplementationOnce((signal) => {
        replacedSignal = signal;
        return new Promise((_resolve, reject) => {
          rejectReplaced = reject;
        });
      })
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "getBootstrapAvailability").mockResolvedValue(false);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    let replacedCheckEndedBeforeSignIn: boolean | undefined;
    let finishSignIn: () => void = () => undefined;
    const signIn = vi.spyOn(hostedHubApi, "signInWithRecoveryCode").mockImplementation(() => {
      replacedCheckEndedBeforeSignIn = replacedSignal?.aborted;
      return new Promise((resolve) => {
        finishSignIn = () => resolve(sessionResponse);
      });
    });

    await hostedHubController.bootstrap();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(hostedHubStore.getState().accountStatus).toBe("unavailable");

    const signedIn = hostedHubController.signInWithRecoveryCode("recovery-code");
    expect(signIn).toHaveBeenCalledWith("recovery-code");
    // The Hub commits the new session, and only then answers the check of the
    // one it replaced.
    finishSignIn();
    await vi.advanceTimersByTimeAsync(0);
    rejectReplaced(new HostedHubApiError("session_invalid", 401));
    await signedIn;

    expect(replacedCheckEndedBeforeSignIn).toBe(true);
    expect(restoreSession).toHaveBeenCalledTimes(3);
    expect(hostedHubApi.clearSessionMaterial).not.toHaveBeenCalled();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      accessRecoveryPending: false,
    });
  });

  it("reports a refused recovery code once the session it left in place is re-checked", async () => {
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValue(new HostedHubApiError("session_invalid", 401));
    vi.spyOn(hostedHubApi, "getBootstrapAvailability").mockResolvedValue(false);
    const refused = new HostedHubApiError("forbidden", 403);
    vi.spyOn(hostedHubApi, "signInWithRecoveryCode").mockRejectedValue(refused);

    await expect(hostedHubController.signInWithRecoveryCode("spent-code")).rejects.toBe(refused);
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(hostedHubStore.getState().accountStatus).toBe("signed-out");
  });

  it("routes a connectivity signal to the recovery the account status calls for", async () => {
    const bootstrap = vi.spyOn(hostedHubController, "bootstrap").mockResolvedValue();
    const resumeBrowser = vi.spyOn(hostedHubController, "resumeBrowser").mockResolvedValue();

    for (const accountStatus of [
      "signed-out",
      "authenticating",
      "signing-out",
      "session-expired",
    ] as const) {
      hostedHubStore.setState({ accountStatus });
      await hostedHubController.recoverAfterConnectivity();
    }
    expect(bootstrap).not.toHaveBeenCalled();
    expect(resumeBrowser).not.toHaveBeenCalled();

    hostedHubStore.setState({ accountStatus: "unavailable" });
    await hostedHubController.recoverAfterConnectivity();
    expect(bootstrap).toHaveBeenCalledOnce();

    hostedHubStore.setState({ accountStatus: "authenticated" });
    await hostedHubController.recoverAfterConnectivity();
    expect(resumeBrowser).toHaveBeenCalledOnce();
  });

  it("subscribes lifecycle bindings for exactly the recoverable account statuses", () => {
    expect(
      (
        [
          "signed-out",
          "authenticating",
          "authenticated",
          "signing-out",
          "session-expired",
          "unavailable",
        ] as const
      ).filter(hostedAccountRecoversOnConnectivity),
    ).toEqual(["authenticated", "unavailable"]);
  });

  it("restores a session, signs in, signs out, and expires without exposing credentials", async () => {
    vi.useFakeTimers();
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    await hostedHubController.bootstrap();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      directoryStatus: "ready",
    });

    vi.spyOn(hostedHubApi, "signOut").mockResolvedValue();
    await hostedHubController.signOut();
    expect(hostedHubStore.getState().accountStatus).toBe("signed-out");
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("csrf-sensitive-canary");

    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
    });
    await hostedHubController.expireSession();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "session-expired",
      effectiveRole: null,
      selectedNode: null,
    });
  });

  it.each([
    ["Hub rejection", new HostedHubApiError("invalid_response", 502)],
    ["network loss", new HostedHubApiError("unavailable", 0)],
  ])("still clears this device when remote sign-out ends in %s", async (_label, failure) => {
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
    });
    vi.spyOn(hostedHubApi, "signOut").mockRejectedValue(failure);

    await hostedHubController.signOut();

    expect(hostedHubApi.clearSessionMaterial).toHaveBeenCalledTimes(1);
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "signed-out",
      account: null,
      session: null,
    });
  });

  it.each([
    ["denial", new HostedHubApiError("authentication_failed", 401)],
    ["malformed response", new HostedHubApiError("invalid_response", 502)],
    ["network loss", new HostedHubApiError("unavailable", 0)],
  ])("handles passkey %s with a bounded signed-out error", async (_label, failure) => {
    vi.spyOn(hostedHubApi, "signIn").mockRejectedValue(failure);
    await hostedHubController.signIn();
    const state = hostedHubStore.getState();
    expect(state.accountStatus).toBe("signed-out");
    expect(state.errorMessage).not.toContain("undefined");
  });

  it("cancels an in-flight passkey ceremony", async () => {
    vi.spyOn(hostedHubApi, "signIn").mockImplementation(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    const pending = hostedHubController.signIn();
    hostedHubController.cancelAuthentication();
    await pending;
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "signed-out",
      errorMessage: null,
    });
  });

  it("aborts a duplicate sign-in submission before accepting the replacement", async () => {
    let call = 0;
    vi.spyOn(hostedHubApi, "signIn").mockImplementation((signal) => {
      call += 1;
      if (call === 2) return Promise.resolve(sessionResponse);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("replaced", "AbortError")));
      });
    });
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    const first = hostedHubController.signIn();
    const replacement = hostedHubController.signIn();
    await Promise.all([first, replacement]);
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
  });

  it("loads one bounded external-provider policy for concurrent signed-out surfaces", async () => {
    const configuration = {
      version: 1,
      providers: [{ provider: "github", login: true, signup: true, link: true }],
    } as const;
    const read = vi
      .spyOn(hostedHubApi, "getExternalIdentityConfiguration")
      .mockResolvedValue(configuration);

    await Promise.all([
      hostedHubController.refreshExternalIdentityConfiguration(),
      hostedHubController.refreshExternalIdentityConfiguration(),
    ]);

    expect(read).toHaveBeenCalledOnce();
    expect(hostedAccountStore.getState()).toMatchObject({
      externalIdentityConfiguration: configuration,
      externalIdentityConfigurationStatus: "ready",
    });
  });

  it("signs in through the shared external-provider action without publishing provider secrets", async () => {
    vi.spyOn(hostedHubApi, "signInWithExternalProvider").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    await hostedHubController.signInWithExternalProvider("github");

    expect(hostedHubApi.signInWithExternalProvider).toHaveBeenCalledWith(
      "github",
      expect.any(AbortSignal),
    );
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("github-sensitive-canary");
  });
});

describe("hosted registration and directory state", () => {
  it("bootstraps the first owner and keeps credentials out of state", async () => {
    vi.useFakeTimers();
    vi.spyOn(hostedHubApi, "bootstrapOwner").mockResolvedValue({
      ...sessionResponse,
      recoveryCodes: ["recovery-sensitive-canary"],
    });
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    hostedHubStore.setState({ bootstrapAvailable: true });
    await hostedHubController.bootstrapOwner({
      credential: "bootstrap-sensitive-canary",
      displayName: "Ada",
      passkeyLabel: "Primary",
    });

    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      recoveryCodes: ["recovery-sensitive-canary"],
      bootstrapAvailable: false,
    });
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("bootstrap-sensitive-canary");
  });

  it("handles unavailable owner bootstrap without reflecting the credential", async () => {
    vi.spyOn(hostedHubApi, "bootstrapOwner").mockRejectedValue(
      new HostedHubApiError("registration_unavailable", 409),
    );

    await hostedHubController.bootstrapOwner({
      credential: "bootstrap-sensitive-canary",
      displayName: "Ada",
      passkeyLabel: null,
    });

    expect(hostedHubStore.getState()).toMatchObject({ accountStatus: "signed-out" });
    expect(hostedHubStore.getState().errorMessage).not.toContain("bootstrap-sensitive-canary");
  });

  it("redeems an invitation and keeps one-time recovery codes only in memory", async () => {
    vi.useFakeTimers();
    vi.spyOn(hostedHubApi, "redeemInvitation").mockResolvedValue({
      ...sessionResponse,
      recoveryCodes: ["recovery-sensitive-canary"],
    });
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    await hostedHubController.redeemInvitation({
      secret: "invitation-sensitive-canary",
      displayName: "Ada",
      passkeyLabel: null,
    });
    expect(hostedHubStore.getState().recoveryCodes).toEqual(["recovery-sensitive-canary"]);
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("invitation-sensitive-canary");
    hostedHubController.dismissRecoveryCodes();
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
  });

  it("adopts a decoded public signup identity and publishes recovery codes atomically", async () => {
    vi.useFakeTimers();
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    await hostedHubController.adoptPublicBrowserIdentity(
      {
        account: {
          id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
          username: "ada",
          displayName: "Ada",
          createdAt: 1,
          disabledAt: null,
        },
        session: {
          id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
          accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
          activeSpaceId: "space_aaaaaaaaaaaaaaaaaaaaaa",
          createdAt: 1,
          expiresAt: 2,
          lastSeenAt: 1,
          revokedAt: null,
          revocationReasonCode: null,
        },
        activeSpace: {
          id: "space_aaaaaaaaaaaaaaaaaaaaaa",
          kind: "personal",
          displayName: "Ada's space",
          role: "owner",
        },
        spaces: [
          {
            id: "space_aaaaaaaaaaaaaaaaaaaaaa",
            kind: "personal",
            displayName: "Ada's space",
            role: "owner",
          },
        ],
        csrfToken: "csrf-sensitive-canary",
      } as never,
      ["recovery-sensitive-canary"],
    );
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      account: { id: "acct_aaaaaaaaaaaaaaaaaaaaaa", role: "owner" },
      session: { id: "sess_aaaaaaaaaaaaaaaaaaaaaa" },
      recoveryCodes: ["recovery-sensitive-canary"],
      bootstrapAvailable: false,
    });
  });

  it.each([
    ["denial", new HostedHubApiError("forbidden", 403)],
    ["expiry", new HostedHubApiError("invalid_request", 400)],
    ["replay", new HostedHubApiError("conflict", 409)],
  ])("handles invitation %s without reflecting the secret", async (_label, failure) => {
    vi.spyOn(hostedHubApi, "redeemInvitation").mockRejectedValue(failure);
    await hostedHubController.redeemInvitation({
      secret: "invitation-sensitive-canary",
      displayName: "Ada",
      passkeyLabel: null,
    });
    expect(hostedHubStore.getState()).toMatchObject({ accountStatus: "signed-out" });
    expect(hostedHubStore.getState().errorMessage).not.toContain("invitation-sensitive-canary");
  });

  it("cancels invitation registration without retaining its secret", async () => {
    vi.spyOn(hostedHubApi, "redeemInvitation").mockImplementation(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    const pending = hostedHubController.redeemInvitation({
      secret: "invitation-sensitive-canary",
      displayName: "Ada",
      passkeyLabel: null,
    });
    hostedHubController.cancelAuthentication();
    await pending;
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("invitation-sensitive-canary");
  });

  it("preserves an identity-matched selection and clears it when authorization is removed", async () => {
    vi.useFakeTimers();
    const first = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [first],
      selectedNode: first,
      selectionStatus: "online",
      effectiveRole: first.effectiveRole,
      generation: 3,
    });
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([{ ...first, label: "Refreshed" }]);
    await hostedHubController.refreshDirectory();
    expect(hostedHubStore.getState().selectedNode?.label).toBe("Refreshed");

    vi.mocked(hostedHubApi.listNodes).mockResolvedValue([]);
    await hostedHubController.refreshDirectory();
    expect(deactivateHostedNode).toHaveBeenCalledWith(first.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: null,
      selectionStatus: "authorization-removed",
      effectiveRole: null,
    });
  });

  it("tears down a selected node as soon as the directory marks it revoked", async () => {
    vi.useFakeTimers();
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      generation: 3,
    });
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([
      { ...selected, revokedAt: 2, revocationReasonCode: "administrative" },
    ]);

    await hostedHubController.refreshDirectory();

    expect(deactivateHostedNode).toHaveBeenCalledWith(selected.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: null,
      selectionStatus: "revoked",
      effectiveRole: null,
      transportStatus: "idle",
      sessionStatus: "closed",
      generation: 4,
    });
  });

  it("marks retained directory data stale and fails role checks closed", async () => {
    vi.useFakeTimers();
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      effectiveRole: "operator",
    });
    vi.spyOn(hostedHubApi, "listNodes").mockRejectedValue(new HostedHubApiError("unavailable", 0));
    await hostedHubController.refreshDirectory();
    expect(hostedHubStore.getState()).toMatchObject({
      directoryStatus: "stale",
      effectiveRole: null,
      selectedNode: selected,
    });
  });

  it("publishes a typed transport explanation while retaining stale directory data", async () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      effectiveRole: "operator",
    });
    vi.spyOn(hostedHubApi, "listNodes").mockRejectedValue(
      new HostedHubApiError(
        "unavailable",
        0,
        undefined,
        undefined,
        undefined,
        "transport-unavailable",
      ),
    );

    await hostedHubController.refreshDirectory();

    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      directoryStatus: "stale",
      selectedNode: selected,
      errorReason: "transport-unavailable",
      errorMessage: "Ryco could not reach the Hub. Check your connection and try again.",
    });
  });

  it("refreshes the directory when a hidden tab becomes visible", async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    let visibilityState: "hidden" | "visible" = "hidden";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        get visibilityState() {
          return visibilityState;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      },
    });
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
    });
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    await hostedHubController.refreshDirectory();
    expect(listNodes).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(1);

    visibilityState = "visible";
    for (const listener of listeners) listener();
    await Promise.resolve();
    await Promise.resolve();
    expect(listNodes).toHaveBeenCalledTimes(2);
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  });

  it("polls presence faster only while a surface is waiting on an offline node", async () => {
    vi.useFakeTimers();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
    });
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    await hostedHubController.refreshDirectory();
    expect(listNodes).toHaveBeenCalledOnce();

    // A watch pulls the pending 20s refresh in to the presence cadence.
    const release = hostedHubController.watchDirectoryPresence();
    const second = hostedHubController.watchDirectoryPresence();
    await vi.advanceTimersByTimeAsync(DIRECTORY_PRESENCE_REFRESH_MS);
    expect(listNodes).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DIRECTORY_PRESENCE_REFRESH_MS);
    expect(listNodes).toHaveBeenCalledTimes(3);

    // Releases are per watch and idempotent: one live watch keeps the cadence.
    release();
    release();
    await vi.advanceTimersByTimeAsync(DIRECTORY_PRESENCE_REFRESH_MS);
    expect(listNodes).toHaveBeenCalledTimes(4);

    second();
    await vi.advanceTimersByTimeAsync(DIRECTORY_PRESENCE_REFRESH_MS);
    expect(listNodes).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(listNodes).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(listNodes).toHaveBeenCalledTimes(6);
  });

  it("falls back to the normal cadence once a presence watch outlives its window", async () => {
    vi.useFakeTimers();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
    });
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    await hostedHubController.refreshDirectory();
    hostedHubController.watchDirectoryPresence();
    await vi.advanceTimersByTimeAsync(DIRECTORY_PRESENCE_WINDOW_MS);
    expect(listNodes).toHaveBeenCalledTimes(1 + DIRECTORY_PRESENCE_WINDOW_MS / 5_000);

    // A node that stays offline for days is not polled at 4x for days.
    const atWindowEnd = listNodes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(listNodes).toHaveBeenCalledTimes(atWindowEnd);
    await vi.advanceTimersByTimeAsync(1);
    expect(listNodes).toHaveBeenCalledTimes(atWindowEnd + 1);

    // A fresh watch (the demand changed) gets its own window.
    const release = hostedHubController.watchDirectoryPresence();
    await vi.advanceTimersByTimeAsync(DIRECTORY_PRESENCE_REFRESH_MS);
    expect(listNodes).toHaveBeenCalledTimes(atWindowEnd + 2);
    release();
  });

  it("never shortens a directory failure backoff for a presence watch", async () => {
    vi.useFakeTimers();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
    });
    const listNodes = vi
      .spyOn(hostedHubApi, "listNodes")
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 503))
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 503))
      .mockResolvedValue([]);

    await hostedHubController.refreshDirectory();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listNodes).toHaveBeenCalledTimes(2);
    hostedHubController.watchDirectoryPresence();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(listNodes).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(listNodes).toHaveBeenCalledTimes(3);
  });

  it("keeps mutations stale until browser resume revalidates access and node state", async () => {
    const selected = node();
    const order: string[] = [];
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      generation: 4,
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockImplementation(async () => {
      order.push("session");
      return sessionResponse;
    });
    vi.spyOn(hostedHubApi, "listNodes").mockImplementation(async () => {
      order.push("directory");
      return [selected];
    });
    activateHostedNode.mockImplementationOnce(async () => {
      order.push("relay");
    });

    hostedHubController.suspendBrowser("hidden");
    await vi.waitFor(() => expect(suspendHostedNode).toHaveBeenCalledWith(selected.environmentId));
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "suspended",
      sessionStatus: "stale",
      generation: 5,
    });
    hostedHubController.markSessionReady(selected.environmentId);
    expect(hostedHubStore.getState().browserStatus).toBe("suspended");

    await hostedHubController.resumeBrowser();
    expect(order).toEqual(["session", "directory", "relay"]);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "synchronizing",
      sessionStatus: "synchronizing",
      generation: 6,
    });

    hostedHubController.markSessionReady(selected.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      sessionStatus: "ready",
    });
  });

  it("ignores readiness from a superseded hosted connection generation", () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      selectedNode: selected,
      transportStatus: "online",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      browserStatus: "synchronizing",
      generation: 5,
    });

    markHostedSessionReady(selected.environmentId, 4);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "synchronizing",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
    });

    markHostedSessionReady(selected.environmentId, 5);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      sessionStatus: "ready",
      sessionEstablished: true,
    });
  });

  it("preserves delivery uncertainty when resume replaces a relay with a pending mutation", async () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      generation: 4,
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selected]);
    hasHostedRelayPendingRequests.mockReturnValue(true);

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();

    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "synchronizing",
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
      generation: 6,
    });
    hostedHubController.markSessionReady(selected.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
  });

  it("preserves resumed delivery uncertainty when synchronization times out", async () => {
    vi.useFakeTimers();
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      generation: 4,
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selected]);
    hasHostedRelayPendingRequests.mockReturnValue(true);

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "terminal-failure",
      sessionStatus: "delivery-unknown",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
      errorMessage: "Ryco state could not be synchronized.",
    });
  });

  it("starts a fresh access check when suspension cancels an in-flight resume", async () => {
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      browserStatus: "current",
    });
    let restoreCalls = 0;
    vi.spyOn(hostedHubApi, "restoreSession").mockImplementation((signal) => {
      restoreCalls += 1;
      if (restoreCalls > 1) return Promise.resolve(sessionResponse);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("suspended", "AbortError")),
        );
      });
    });
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);

    const interrupted = hostedHubController.resumeBrowser();
    await Promise.resolve();
    hostedHubController.suspendBrowser("hidden");
    const resumed = hostedHubController.resumeBrowser();
    await Promise.all([interrupted, resumed]);

    expect(restoreCalls).toBe(2);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      directoryStatus: "ready",
      errorMessage: null,
    });
  });

  it("coalesces repeated browser resume events into one access check and relay activation", async () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      generation: 4,
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selected]);

    hostedHubController.suspendBrowser("hidden");
    const first = hostedHubController.resumeBrowser();
    const second = hostedHubController.resumeBrowser();
    const third = hostedHubController.resumeBrowser();

    expect(first).toBe(second);
    expect(second).toBe(third);
    await Promise.all([first, second, third]);
    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "synchronizing",
      sessionStatus: "synchronizing",
      generation: 6,
    });
  });

  it("expires authority during resume without opening another hosted connection", async () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      generation: 4,
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );

    hostedHubController.suspendBrowser("offline");
    await hostedHubController.resumeBrowser();

    expect(activateHostedNode).not.toHaveBeenCalled();
    // Account clear must reset the relay attempt via the deactivation path
    // (the deactivate fake mirrors the transition-queue reset contract; the
    // ordered teardown itself is proven in environment.test.ts).
    expect(deactivateHostedNode).toHaveBeenCalledWith(selected.environmentId);
    expect(resetRelayAttemptFactory).toHaveBeenCalledOnce();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "session-expired",
      selectedNode: null,
      effectiveRole: null,
      sessionEstablished: false,
    });
  });

  it("replaces an in-flight directory refresh with a post-resume access check", async () => {
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [],
      browserStatus: "current",
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    let firstSignal: AbortSignal | undefined;
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockImplementation((signal) => {
      if (listNodes.mock.calls.length > 1) return Promise.resolve([]);
      firstSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("suspended", "AbortError")),
        );
      });
    });

    const staleRefresh = hostedHubController.refreshDirectory();
    await vi.waitFor(() => expect(listNodes).toHaveBeenCalledOnce());
    hostedHubController.suspendBrowser("hidden");
    await staleRefresh;
    await hostedHubController.resumeBrowser();

    expect(firstSignal?.aborted).toBe(true);
    expect(listNodes).toHaveBeenCalledTimes(2);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      directoryStatus: "ready",
    });
  });

  it("aborts same-node activation when the browser is suspended again", async () => {
    vi.useFakeTimers();
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      generation: 4,
    });
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selected]);
    activateHostedNode.mockImplementationOnce(
      async (_node, _previousEnvironmentId, signal: AbortSignal | undefined) =>
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())),
    );

    hostedHubController.suspendBrowser("hidden");
    const interrupted = hostedHubController.resumeBrowser();
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
    const firstSignal = activateHostedNode.mock.calls[0]?.[2] as AbortSignal | undefined;
    hostedHubController.suspendBrowser("hidden");
    await interrupted;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(firstSignal?.aborted).toBe(true);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "suspended",
      sessionStatus: "stale",
      generation: 7,
    });
    expect(hostedHubStore.getState().transportStatus).not.toBe("terminal-failure");

    await hostedHubController.resumeBrowser();
    expect(activateHostedNode).toHaveBeenCalledTimes(2);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "synchronizing",
      sessionStatus: "synchronizing",
      generation: 8,
    });
  });

  it("restarts full resume after a stale directory retry recovers", async () => {
    vi.useFakeTimers();
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      generation: 4,
    });
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockResolvedValue(sessionResponse);
    const listNodes = vi
      .spyOn(hostedHubApi, "listNodes")
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 0))
      .mockResolvedValue([selected]);

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "stale",
      directoryStatus: "stale",
      effectiveRole: null,
    });

    await hostedHubController.refreshDirectory();
    await vi.waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());

    expect(listNodes).toHaveBeenCalledTimes(3);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "synchronizing",
      directoryStatus: "ready",
      sessionStatus: "synchronizing",
    });
    hostedHubController.markSessionReady(selected.environmentId);
    expect(hostedHubStore.getState().browserStatus).toBe("current");
  });

  function resumableSelection(): HostedHubNode {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      generation: 4,
    });
    return selected;
  }

  it.each([
    ["a failing Hub", new HostedHubApiError("unavailable", 503)],
    [
      "the request deadline",
      new HostedHubApiError("timeout", 0, undefined, undefined, undefined, "request-timeout"),
    ],
    [
      "a DNS or TLS failure while the OS reports connectivity",
      new HostedHubApiError(
        "unavailable",
        0,
        undefined,
        undefined,
        undefined,
        "transport-unavailable",
      ),
    ],
  ])(
    "retries a resume that failed with %s without another lifecycle event",
    async (_label, failure) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const selected = resumableSelection();
      const restoreSession = vi
        .spyOn(hostedHubApi, "restoreSession")
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(sessionResponse);
      vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selected]);

      hostedHubController.suspendBrowser("hidden");
      await hostedHubController.resumeBrowser();
      expect(hostedHubStore.getState()).toMatchObject({
        browserStatus: "stale",
        sessionStatus: "stale",
        accessRecoveryPending: true,
      });
      expect(activateHostedNode).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(restoreSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(restoreSession).toHaveBeenCalledTimes(2);
      // The retry is the full resume: session, then directory, then a fresh relay
      // attempt that still has to publish a current snapshot before mutation.
      await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());
      expect(hostedHubStore.getState()).toMatchObject({
        browserStatus: "synchronizing",
        directoryStatus: "ready",
        sessionStatus: "synchronizing",
        sessionEstablished: false,
        generation: 6,
      });
      hostedHubController.markSessionReady(selected.environmentId);
      expect(hostedHubStore.getState()).toMatchObject({
        browserStatus: "current",
        sessionStatus: "ready",
      });
    },
  );

  it("backs off between repeated resume failures and stops once access is restored", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const selected = resumableSelection();
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 0))
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 0))
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selected]);

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restoreSession).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(restoreSession).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(restoreSession).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(activateHostedNode).toHaveBeenCalledOnce());

    hostedHubController.markSessionReady(selected.environmentId);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(restoreSession).toHaveBeenCalledTimes(3);
    expect(hostedHubStore.getState().browserStatus).toBe("current");
  });

  it("drops a pending resume retry when the browser is suspended again", async () => {
    vi.useFakeTimers();
    resumableSelection();
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValue(new HostedHubApiError("unavailable", 503));

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    expect(hostedHubStore.getState().browserStatus).toBe("stale");
    hostedHubController.suspendBrowser("offline");
    await vi.advanceTimersByTimeAsync(300_000);

    expect(restoreSession).toHaveBeenCalledOnce();
    expect(hostedHubStore.getState().browserStatus).toBe("offline");
  });

  it("expires the account when a resume retry finds the session revoked", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const selected = resumableSelection();
    vi.spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 503))
      .mockRejectedValue(new HostedHubApiError("session_invalid", 401));

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() =>
      expect(hostedHubStore.getState()).toMatchObject({
        accountStatus: "session-expired",
        selectedNode: null,
        effectiveRole: null,
      }),
    );
    expect(deactivateHostedNode).toHaveBeenCalledWith(selected.environmentId);
    expect(activateHostedNode).not.toHaveBeenCalled();
  });

  it("does not put a resume the Hub refused on a timer", async () => {
    vi.useFakeTimers();
    resumableSelection();
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValue(new HostedHubApiError("forbidden", 403));

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(restoreSession).toHaveBeenCalledOnce();
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "stale",
      accessRecoveryPending: false,
    });
  });

  it("still recovers a stale browser after the user returns to the directory", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const selected = resumableSelection();
    vi.spyOn(hostedHubApi, "restoreSession")
      .mockRejectedValueOnce(new HostedHubApiError("unavailable", 0))
      .mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selected]);

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    await hostedHubController.returnToDirectory();
    expect(hostedHubStore.getState()).toMatchObject({ browserStatus: "stale", selectedNode: null });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(hostedHubStore.getState().browserStatus).toBe("current"));
    expect(activateHostedNode).not.toHaveBeenCalled();
  });

  it("revalidates access when the user leaves a node during an access check", async () => {
    const selected = resumableSelection();
    let finishCheck: (value: HostedHubSessionResponse) => void = () => undefined;
    const restoreSession = vi
      .spyOn(hostedHubApi, "restoreSession")
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCheck = resolve;
          }),
      );
    const listNodes = vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([selected]);

    hostedHubController.suspendBrowser("hidden");
    void hostedHubController.resumeBrowser();
    expect(hostedHubStore.getState().browserStatus).toBe("checking-access");

    await hostedHubController.returnToDirectory();

    // Back to the directory must not stand in for the session and directory
    // check the aborted resume never finished.
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: null,
      browserStatus: "checking-access",
    });
    expect(restoreSession).toHaveBeenCalledTimes(2);
    await hostedHubController.selectNode(selected.id);
    expect(activateHostedNode).not.toHaveBeenCalled();

    finishCheck(sessionResponse);
    await vi.waitFor(() => expect(hostedHubStore.getState().browserStatus).toBe("current"));
    expect(listNodes).toHaveBeenCalledOnce();
    expect(activateHostedNode).not.toHaveBeenCalled();
  });

  it("switches nodes through the ordered environment teardown boundary", async () => {
    const first = node();
    const second = node("node_bbbbbbbbbbbbbbbbbbbbbb", "owner");
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [first, second],
      selectedNode: first,
      effectiveRole: first.effectiveRole,
    });
    await hostedHubController.selectNode(second.id);
    expect(activateHostedNode).toHaveBeenCalledWith(second, first.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: second,
      sessionStatus: "synchronizing",
      generation: 1,
    });
    hostedHubController.markSessionReplaying(second.environmentId);
    expect(hostedHubStore.getState().sessionStatus).toBe("replaying");
    hostedHubController.markSessionReady(second.environmentId);
    expect(hostedHubStore.getState().sessionStatus).toBe("ready");
  });

  it("rejects node selection while browser access is being revalidated", async () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "checking-access",
      nodes: [selected],
    });

    await hostedHubController.selectNode(selected.id);

    expect(activateHostedNode).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().selectedNode).toBeNull();
  });

  it("ends browser synchronization after a terminal relay failure", () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "synchronizing",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "connecting",
      sessionStatus: "synchronizing",
      generation: 5,
    });

    hostedHubController.failure(5, { kind: "incompatible", retryable: false });

    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      selectionStatus: "incompatible",
      effectiveRole: null,
      transportStatus: "terminal-failure",
      sessionStatus: "stale",
    });
  });

  it("fails initial synchronization after exactly thirty seconds", async () => {
    vi.useFakeTimers();
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [selected],
    });

    await hostedHubController.selectNode(selected.id);
    hostedHubStore.setState({ browserStatus: "synchronizing" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(hostedHubStore.getState().transportStatus).not.toBe("terminal-failure");

    await vi.advanceTimersByTimeAsync(1);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      transportStatus: "terminal-failure",
      sessionStatus: "stale",
      sessionEstablished: false,
      errorMessage: "Ryco state could not be synchronized.",
    });
  });

  it("cancels the synchronization deadline after the matching snapshot is ready", async () => {
    vi.useFakeTimers();
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [selected],
    });

    await hostedHubController.selectNode(selected.id);
    hostedHubController.markSessionReady(selected.environmentId);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "idle",
      sessionStatus: "ready",
      sessionEstablished: true,
      errorMessage: null,
    });
  });

  it("isolates the synchronization deadline to the current selection generation", async () => {
    vi.useFakeTimers();
    const first = node("node_aaaaaaaaaaaaaaaaaaaaaa");
    const second = node("node_bbbbbbbbbbbbbbbbbbbbbb");
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [first, second],
    });

    await hostedHubController.selectNode(first.id);
    await vi.advanceTimersByTimeAsync(10_000);
    await hostedHubController.selectNode(second.id);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: second,
      sessionStatus: "synchronizing",
      errorMessage: null,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: second,
      transportStatus: "terminal-failure",
      errorMessage: "Ryco state could not be synchronized.",
    });
  });

  it("ignores a queued session-sync deadline from a superseded generation", async () => {
    vi.useFakeTimers();
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [selected],
    });

    // Arm the 30s synchronization deadline for generation 1.
    await hostedHubController.selectNode(selected.id);
    hostedHubStore.setState({ browserStatus: "synchronizing" });

    // A newer generation takes over and its session becomes healthy, but the
    // generation-1 deadline's callback is still queued (its timer was never
    // cleared through a controller path here).
    hostedHubStore.setState({
      generation: 99,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: false,
    });
    await vi.advanceTimersByTimeAsync(30_000);

    // The stale deadline must not terminal-fail the superseding session.
    expect(hostedHubStore.getState()).toMatchObject({
      generation: 99,
      transportStatus: "online",
      sessionStatus: "ready",
    });
    expect(hostedHubStore.getState().transportStatus).not.toBe("terminal-failure");
  });

  it("retries the selected node once with a fresh generation", async () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [selected],
      selectedNode: selected,
      selectionStatus: "online",
      effectiveRole: selected.effectiveRole,
      transportStatus: "terminal-failure",
      sessionStatus: "stale",
      sessionEstablished: false,
      errorMessage: "Ryco state could not be synchronized.",
      generation: 7,
    });

    await Promise.all([
      hostedHubController.retrySelectedNode(),
      hostedHubController.retrySelectedNode(),
    ]);

    expect(activateHostedNode).toHaveBeenCalledOnce();
    expect(activateHostedNode).toHaveBeenCalledWith(
      selected,
      selected.environmentId,
      expect.any(AbortSignal),
    );
    expect(hostedHubStore.getState()).toMatchObject({
      generation: 8,
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      errorMessage: null,
    });
  });

  it("fails before readiness and emits only a stable diagnostic after readiness", () => {
    const selected = node();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    hostedHubStore.setState({
      accountStatus: "authenticated",
      selectedNode: selected,
      browserStatus: "synchronizing",
      transportStatus: "online",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      generation: 3,
    });

    hostedHubController.reportShellSnapshotFailure(selected.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      transportStatus: "terminal-failure",
      errorMessage: "Ryco state could not be synchronized.",
    });

    hostedHubStore.setState({
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      errorMessage: null,
    });
    hostedHubController.reportShellSnapshotFailure(selected.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "online",
      sessionStatus: "ready",
      errorMessage: null,
    });
    expect(warning).toHaveBeenCalledWith("hosted_snapshot_reconciliation_failed");
  });

  it("keeps delivery uncertainty visible through replay until the user acknowledges it", () => {
    const selected = node();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      selectedNode: selected,
      transportStatus: "online",
      sessionStatus: "ready",
      generation: 7,
    });
    hostedHubController.markDeliveryUnknown(7);
    hostedHubController.sessionStatus(7, "synchronizing");
    hostedHubController.markSessionReplaying(selected.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
    });

    hostedHubController.markSessionReady(selected.environmentId);
    expect(hostedHubStore.getState()).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    hostedHubController.acknowledgeDeliveryUnknown();
    expect(hostedHubStore.getState()).toMatchObject({
      sessionStatus: "ready",
      sessionRecoveredAfterUnknown: false,
    });
  });
});

describe("hosted account management state", () => {
  const passkey = {
    id: "pkey_aaaaaaaaaaaaaaaaaaaaaa",
    label: "Studio laptop",
    createdAt: 10,
    lastUsedAt: null,
    backupEligible: true,
    backupState: false,
    revokedAt: null,
    revocationReasonCode: null,
  } as const;

  const e2eeDevice = {
    enrollmentId: `enr_${"e".repeat(22)}`,
    enrollmentRevision: 1,
    accountAuthEpoch: 3,
    deviceAuthEpoch: 2,
    platform: "ios",
    appVersion: "0.1.20",
    reportedKeyBacking: "secure-enclave",
    deviceLabel: "Ada's iPhone",
    identityFingerprint: "A".repeat(43),
    agreementFingerprint: "B".repeat(43),
    clientPrekeyCertificateDigest: "C".repeat(43),
    certificateExpiresAt: 1_788_537_600_000,
    status: "active",
    createdAt: 1_788_451_200_000,
    updatedAt: 1_788_451_200_000,
    lastUsedAt: null,
    revokedAt: null,
  } as const;

  /** Bring the controller to an authenticated, ready-directory state. */
  async function authenticate(): Promise<void> {
    vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    await hostedHubController.bootstrap();
  }

  let leases: Array<() => void> = [];
  afterEach(() => {
    for (const release of leases) release();
    leases = [];
  });

  /**
   * Stand in for a surface displaying the codes, and release it at the end of
   * the test. A rotation only publishes if one of these was live when it was
   * asked for.
   */
  function leaseRecoveryCodeDisplay(): () => void {
    const release = hostedHubController.leaseRecoveryCodeDisplay();
    leases.push(release);
    return release;
  }

  it("loads the account's passkeys and deduplicates concurrent reads", async () => {
    await authenticate();
    const listPasskeys = vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([passkey]);

    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [],
      passkeysStatus: "idle",
      actionStatus: "idle",
    });
    await Promise.all([
      hostedHubController.refreshPasskeys(),
      hostedHubController.refreshPasskeys(),
    ]);

    expect(listPasskeys).toHaveBeenCalledOnce();
    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [passkey],
      passkeysStatus: "ready",
      errorMessage: null,
    });
  });

  it("loads the native E2EE device directory and deduplicates concurrent reads", async () => {
    await authenticate();
    const listE2eeDevices = vi
      .spyOn(hostedHubApi, "listE2eeDevices")
      .mockResolvedValue([e2eeDevice]);

    await Promise.all([
      hostedHubController.refreshE2eeDevices(),
      hostedHubController.refreshE2eeDevices(),
    ]);

    expect(listE2eeDevices).toHaveBeenCalledOnce();
    expect(hostedAccountStore.getState()).toMatchObject({
      e2eeDevices: [e2eeDevice],
      e2eeDevicesStatus: "ready",
      errorMessage: null,
    });
  });

  it("drops a native E2EE directory response from a replaced session", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "listE2eeDevices").mockImplementation(async () => {
      hostedHubStore.setState({
        session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
      });
      return [e2eeDevice];
    });

    await hostedHubController.refreshE2eeDevices();

    expect(hostedAccountStore.getState()).toMatchObject({
      e2eeDevices: [],
      e2eeDevicesStatus: "idle",
    });
  });

  it("arms deduplication before publishing so a synchronous re-entry joins", async () => {
    await authenticate();
    const listPasskeys = vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([passkey]);
    // A consumer that re-reads on notification — the same shape as the relay
    // adapter bug found earlier in this codebase. If the "loading" publish
    // fires before the handle is armed, this starts a second request and the
    // two handles desynchronise.
    const unsubscribe = hostedAccountStore.subscribe(() => {
      void hostedHubController.refreshPasskeys();
    });

    try {
      await hostedHubController.refreshPasskeys();
    } finally {
      unsubscribe();
    }

    expect(listPasskeys).toHaveBeenCalledOnce();
  });

  it("does not read passkeys while signed out", async () => {
    const listPasskeys = vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([passkey]);
    await hostedHubController.refreshPasskeys();
    expect(listPasskeys).not.toHaveBeenCalled();
    expect(hostedAccountStore.getState().passkeysStatus).toBe("idle");
  });

  it("loads account security once for concurrent callers without inventing an empty posture", async () => {
    await authenticate();
    let resolveSecurity: ((value: typeof emptySecurity) => void) | null = null;
    const getAccountSecurity = vi.spyOn(hostedHubApi, "getAccountSecurity").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSecurity = resolve;
        }),
    );

    const first = hostedHubController.refreshAccountSecurity();
    const second = hostedHubController.refreshAccountSecurity();
    expect(hostedAccountStore.getState()).toMatchObject({
      security: null,
      securityStatus: "loading",
    });
    resolveSecurity?.(emptySecurity);
    await Promise.all([first, second]);

    expect(getAccountSecurity).toHaveBeenCalledOnce();
    expect(hostedAccountStore.getState()).toMatchObject({
      security: emptySecurity,
      securityStatus: "ready",
    });
  });

  it("marks a failed security refresh stale and retains only a prior known posture", async () => {
    await authenticate();
    const configured = {
      passwordConfigured: true,
      totpEnrolled: true,
      emailDeliveryConfigured: true,
      email: { address: "ada@example.test", verified: true },
      externalIdentities: [],
    } as const;
    vi.spyOn(hostedHubApi, "getAccountSecurity").mockResolvedValueOnce(configured);
    await hostedHubController.refreshAccountSecurity();

    vi.spyOn(hostedHubApi, "getAccountSecurity").mockRejectedValueOnce(
      new HostedHubApiError("unavailable", 0),
    );
    await hostedHubController.refreshAccountSecurity({ force: true });

    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
    expect(hostedAccountStore.getState()).toMatchObject({
      security: configured,
      securityStatus: "stale",
    });
  });

  it("connects and disconnects GitHub through the account mutex and refreshes its summary", async () => {
    await authenticate();
    const externalIdentity = {
      provider: "github",
      login: "octocat",
      displayName: "The Octocat",
      connectedAt: 10,
      lastUsedAt: null,
    } as const;
    vi.spyOn(hostedHubApi, "connectExternalIdentity").mockResolvedValue(externalIdentity);
    vi.spyOn(hostedHubApi, "disconnectExternalIdentity").mockResolvedValue({
      status: "disconnected",
      signedOut: false,
    });
    vi.spyOn(hostedHubApi, "getAccountSecurity")
      .mockResolvedValueOnce({ ...emptySecurity, externalIdentities: [externalIdentity] })
      .mockResolvedValueOnce(emptySecurity);

    await expect(
      hostedHubController.connectExternalIdentity("github", { totpCode: "123456" }),
    ).resolves.toEqual({ status: "committed" });
    expect(hostedHubApi.connectExternalIdentity).toHaveBeenCalledWith(
      "github",
      { totpCode: "123456" },
      expect.any(AbortSignal),
    );
    expect(hostedAccountStore.getState().security?.externalIdentities).toEqual([externalIdentity]);

    await expect(hostedHubController.disconnectExternalIdentity("github")).resolves.toEqual({
      status: "committed",
    });
    expect(hostedAccountStore.getState().security?.externalIdentities).toEqual([]);
  });

  it("keeps the existing step-up vocabulary for an external-identity connection", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "connectExternalIdentity").mockRejectedValue(
      new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403, undefined, "connect-external-identity"),
    );

    await expect(hostedHubController.connectExternalIdentity("github")).resolves.toMatchObject({
      status: "refused",
      errorCode: STEP_UP_REQUIRED_CODE,
    });
    expect(hostedAccountStore.getState()).toMatchObject({
      actionStatus: "idle",
      errorCode: STEP_UP_REQUIRED_CODE,
    });
  });

  it("explicitly discards a staged external identity when the user cancels step-up", async () => {
    await authenticate();
    const cancel = vi.spyOn(hostedHubApi, "cancelExternalIdentityConnection");

    hostedHubController.cancelExternalIdentityConnection("github");

    expect(cancel).toHaveBeenCalledWith("github");
    expect(hostedAccountStore.getState().actionStatus).toBe("idle");
  });

  it("expires the session when the account-security read is unauthenticated", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "getAccountSecurity").mockRejectedValue(
      new HostedHubApiError(
        "session_invalid",
        401,
        undefined,
        undefined,
        undefined,
        "token-invalidated",
      ),
    );

    await hostedHubController.refreshAccountSecurity();

    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "session-expired",
      errorReason: "token-invalidated",
      errorMessage: "Your secure Hub session is no longer valid. Sign in again to continue.",
    });
    expect(hostedAccountStore.getState()).toEqual(hostedAccountStore.getInitialState());
  });

  it("reports a bounded passkey read failure without dropping the session", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "listPasskeys").mockRejectedValue(
      new HostedHubApiError("unavailable", 0),
    );
    await hostedHubController.refreshPasskeys();
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
    expect(hostedAccountStore.getState()).toMatchObject({
      passkeysStatus: "stale",
      errorMessage: "Hub is temporarily unavailable.",
    });
  });

  it("expires the session when an account read is rejected as unauthenticated", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "listPasskeys").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );
    await hostedHubController.refreshPasskeys();
    expect(hostedHubStore.getState().accountStatus).toBe("session-expired");
    expect(hostedAccountStore.getState()).toEqual(hostedAccountStore.getInitialState());
  });

  it("adds a passkey and confirms it against a fresh Hub read", async () => {
    await authenticate();
    const addPasskey = vi
      .spyOn(hostedHubApi, "addPasskey")
      .mockResolvedValue({ passkey, confirmed: true });
    const listPasskeys = vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([passkey]);

    await hostedHubController.addPasskey({ passkeyLabel: "Studio laptop" });

    expect(addPasskey).toHaveBeenCalledWith({ passkeyLabel: "Studio laptop" }, expect.anything());
    expect(listPasskeys).toHaveBeenCalledOnce();
    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [passkey],
      passkeysStatus: "ready",
      actionStatus: "idle",
      errorMessage: null,
    });
  });

  it("does not confirm an enrolment against a read that predates it", async () => {
    await authenticate();
    // A refresh is already in flight when the enrolment lands. It was issued
    // against the pre-add state and cannot observe the new credential, so
    // joining it would settle the surface on evidence the add had failed.
    let releaseStaleRead: ((value: ReadonlyArray<typeof passkey>) => void) | null = null;
    const listPasskeys = vi
      .spyOn(hostedHubApi, "listPasskeys")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStaleRead = resolve;
          }),
      )
      .mockResolvedValue([passkey]);
    vi.spyOn(hostedHubApi, "addPasskey").mockResolvedValue({ passkey, confirmed: true });

    const stale = hostedHubController.refreshPasskeys();
    await hostedHubController.addPasskey({ passkeyLabel: "Studio laptop" });
    releaseStaleRead?.([]);
    await stale;

    expect(listPasskeys).toHaveBeenCalledTimes(2);
    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [passkey],
      passkeysStatus: "ready",
      errorMessage: null,
    });
  });

  it("reports an enrolment the Hub cannot confirm rather than presenting it as done", async () => {
    await authenticate();
    // A 2xx verify that describes nothing, and a list that did not grow: the
    // ceremony completed but there is no evidence a credential exists.
    vi.spyOn(hostedHubApi, "addPasskey").mockResolvedValue({ passkey: null, confirmed: false });
    vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([]);

    await hostedHubController.addPasskey({ passkeyLabel: null });

    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [],
      passkeysStatus: "ready",
      actionStatus: "idle",
      errorMessage: HOSTED_PASSKEY_UNCONFIRMED_MESSAGE,
    });
  });

  it("accepts an unconfirmed enrolment the list does vouch for", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "addPasskey").mockResolvedValue({ passkey: null, confirmed: false });
    vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([passkey]);

    await hostedHubController.addPasskey({ passkeyLabel: null });

    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [passkey],
      errorMessage: null,
    });
  });

  it("maps an add-passkey failure to a bounded message and stays authenticated", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "addPasskey").mockRejectedValue(
      new HostedHubApiError("browser_only_transport", 400),
    );
    const listPasskeys = vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([]);

    await hostedHubController.addPasskey({ passkeyLabel: null });

    expect(listPasskeys).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
    expect(hostedAccountStore.getState()).toMatchObject({
      actionStatus: "idle",
      errorMessage: "This action is only available in a browser.",
    });
  });

  it("runs one account action at a time and says so when it refuses", async () => {
    await authenticate();
    let release: ((value: { passkey: null; confirmed: false }) => void) | null = null;
    vi.spyOn(hostedHubApi, "addPasskey").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const regenerateRecoveryCodes = vi
      .spyOn(hostedHubApi, "regenerateRecoveryCodes")
      .mockResolvedValue(["code"]);
    vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([]);

    const pending = hostedHubController.addPasskey({ passkeyLabel: null });
    expect(hostedAccountStore.getState().actionStatus).toBe("adding-passkey");

    await hostedHubController.regenerateRecoveryCodes();
    expect(regenerateRecoveryCodes).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    // A refused action must never look like a no-op: without a message the
    // surface has taps that do nothing and state that never explains it.
    expect(hostedAccountStore.getState().errorMessage).toBe(HOSTED_ACCOUNT_BUSY_MESSAGE);

    release?.({ passkey: null, confirmed: false });
    await pending;
    expect(hostedAccountStore.getState().actionStatus).toBe("idle");
  });

  it("clears a concurrent refusal once the action it refused has succeeded", async () => {
    await authenticate();
    leaseRecoveryCodeDisplay();
    let release: ((value: ReadonlyArray<string>) => void) | null = null;
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.spyOn(hostedHubApi, "addPasskey").mockResolvedValue({ passkey: null, confirmed: false });
    vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([]);

    const pending = hostedHubController.regenerateRecoveryCodes();
    await hostedHubController.addPasskey({ passkeyLabel: null });
    expect(hostedAccountStore.getState().errorMessage).toBe(HOSTED_ACCOUNT_BUSY_MESSAGE);

    release?.(["fresh-code"]);
    await pending;

    // An idle surface must not still be showing a failure for an action that
    // then succeeded.
    expect(hostedAccountStore.getState()).toMatchObject({
      actionStatus: "idle",
      errorMessage: null,
    });
    expect(hostedHubStore.getState().recoveryCodes).toEqual(["fresh-code"]);
  });

  it("completes rather than rejects when lifecycle teardown fails on expiry", async () => {
    // Session expiry reaches deactivateHostedNode, which only runs when a node
    // is selected. A teardown failure there is not an authorization failure and
    // must not surface as a rejected account read (or an unhandled rejection
    // for a fire-and-forget caller).
    const selected = node();
    await authenticate();
    hostedHubStore.setState({ selectedNode: selected });
    deactivateHostedNode.mockRejectedValueOnce(new Error("lifecycle-teardown-canary"));
    vi.spyOn(hostedHubApi, "listPasskeys").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );

    await expect(hostedHubController.refreshPasskeys()).resolves.toBeUndefined();
    expect(deactivateHostedNode).toHaveBeenCalledWith(selected.environmentId);
    expect(hostedHubStore.getState().accountStatus).toBe("session-expired");

    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: sessionResponse.account,
      session: sessionResponse.session,
      selectedNode: selected,
    });
    deactivateHostedNode.mockRejectedValueOnce(new Error("lifecycle-teardown-canary"));
    vi.spyOn(hostedHubApi, "addPasskey").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );

    await expect(hostedHubController.addPasskey({ passkeyLabel: null })).resolves.toMatchObject({
      status: "refused",
      reason: "session-expired",
    });
    expect(hostedHubStore.getState().accountStatus).toBe("session-expired");
  });

  it("cancels an account ceremony that never returns", async () => {
    await authenticate();
    // A platform passkey sheet the user leaves open never resolves and never
    // rejects. Without a cancel path the surface stays busy for the session.
    vi.spyOn(hostedHubApi, "addPasskey").mockImplementation(() => new Promise(() => undefined));
    const regenerateRecoveryCodes = vi
      .spyOn(hostedHubApi, "regenerateRecoveryCodes")
      .mockResolvedValue(["code"]);
    vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([]);

    void hostedHubController.addPasskey({ passkeyLabel: null });
    expect(hostedAccountStore.getState().actionStatus).toBe("adding-passkey");

    hostedHubController.cancelAccountAction();
    expect(hostedAccountStore.getState()).toMatchObject({
      actionStatus: "idle",
      errorMessage: null,
    });

    // The surface is usable again.
    await hostedHubController.regenerateRecoveryCodes();
    expect(regenerateRecoveryCodes).toHaveBeenCalledOnce();
  });

  it("refuses an account action while signed out with a bounded message", async () => {
    const addPasskey = vi.spyOn(hostedHubApi, "addPasskey");
    await hostedHubController.addPasskey({ passkeyLabel: null });
    expect(addPasskey).not.toHaveBeenCalled();
    expect(hostedAccountStore.getState().errorMessage).toBe(HOSTED_ACCOUNT_SIGNED_OUT_MESSAGE);
  });

  it("surfaces regenerated recovery codes and keeps them out of the account store", async () => {
    await authenticate();
    leaseRecoveryCodeDisplay();
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockResolvedValue([
      "recovery-sensitive-canary",
    ]);

    await hostedHubController.regenerateRecoveryCodes();

    expect(hostedHubStore.getState().recoveryCodes).toEqual(["recovery-sensitive-canary"]);
    // Codes live only in the dedicated slot: never in the account surface,
    // never in an error message, never in a status.
    expect(JSON.stringify(hostedAccountStore.getState())).not.toContain(
      "recovery-sensitive-canary",
    );

    hostedHubController.dismissRecoveryCodes();
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
  });

  it("drops the account surface and any displayed codes when the account clears", async () => {
    await authenticate();
    leaseRecoveryCodeDisplay();
    vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([passkey]);
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockResolvedValue([
      "recovery-sensitive-canary",
    ]);
    await hostedHubController.refreshPasskeys();
    await hostedHubController.regenerateRecoveryCodes();
    vi.spyOn(hostedHubApi, "signOut").mockResolvedValue();

    await hostedHubController.signOut();

    expect(hostedAccountStore.getState()).toEqual(hostedAccountStore.getInitialState());
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    const persisted = `${JSON.stringify(hostedHubStore.getState())}${JSON.stringify(
      hostedAccountStore.getState(),
    )}`;
    expect(persisted).not.toContain("recovery-sensitive-canary");
    expect(persisted).not.toContain("csrf-sensitive-canary");
  });

  it("fails a read that outlived its session closed, without leaving a spinner", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "listPasskeys").mockImplementation(async () => {
      // A session-id rotation that keeps accountStatus "authenticated" — what
      // #resumeBrowser does — so no teardown runs to clean up after this read.
      hostedHubStore.setState({
        session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
      });
      return [passkey];
    });

    await hostedHubController.refreshPasskeys();

    // Never "loading" with nothing in flight: that is a spinner no retry clears.
    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [],
      passkeysStatus: "idle",
    });
  });

  it("fails a failed read that outlived its session closed too", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "listPasskeys").mockImplementation(async () => {
      hostedHubStore.setState({
        session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
      });
      throw new HostedHubApiError("unavailable", 0);
    });

    await hostedHubController.refreshPasskeys();

    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [],
      passkeysStatus: "idle",
    });
  });

  it("routes each credential change to its API method and clears the error on success", async () => {
    await authenticate();
    const setPassword = vi.spyOn(hostedHubApi, "setPassword").mockResolvedValue();
    const removePassword = vi.spyOn(hostedHubApi, "removePassword").mockResolvedValue();
    const confirmTotpEnrollment = vi
      .spyOn(hostedHubApi, "confirmTotpEnrollment")
      .mockResolvedValue();
    const revokeTotp = vi.spyOn(hostedHubApi, "revokeTotp").mockResolvedValue();
    const requestEmailVerification = vi
      .spyOn(hostedHubApi, "requestEmailVerification")
      .mockResolvedValue();
    hostedAccountStore.setState({ errorMessage: "a stale failure from an earlier attempt" });

    await hostedHubController.setPassword({ password: "pw", totpCode: "123456" });
    await hostedHubController.removePassword({ totpCode: "234567" });
    await hostedHubController.confirmTotpEnrollment({ code: "345678" });
    await hostedHubController.revokeTotp({ totpCode: "456789" });
    await hostedHubController.requestEmailVerification({
      email: "ada@example.test",
      totpCode: "567890",
    });

    // The step-up code is threaded through untouched; the runtime never decides
    // whether it is needed, only whether the caller supplied one.
    expect(setPassword).toHaveBeenCalledWith(
      { password: "pw", totpCode: "123456" },
      expect.anything(),
    );
    expect(removePassword).toHaveBeenCalledWith({ totpCode: "234567" }, expect.anything());
    expect(confirmTotpEnrollment).toHaveBeenCalledWith({ code: "345678" }, expect.anything());
    expect(revokeTotp).toHaveBeenCalledWith({ totpCode: "456789" }, expect.anything());
    expect(requestEmailVerification).toHaveBeenCalledWith(
      { email: "ada@example.test", totpCode: "567890" },
      expect.anything(),
    );
    expect(hostedAccountStore.getState()).toMatchObject({
      actionStatus: "idle",
      errorMessage: null,
    });
  });

  it("holds the TOTP enrolment secret in memory only and drops it on dismissal", async () => {
    await authenticate();
    const enrollment = {
      secretBase32: "TOTPSECRETSENSITIVECANARY",
      provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
    };
    vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockResolvedValue(enrollment);

    await hostedHubController.beginTotpEnrollment();

    expect(hostedHubStore.getState().totpEnrollment).toEqual(enrollment);
    // The secret lives in exactly ONE slot across both stores. Asserted by
    // blanking that slot and searching everything that is left — an error
    // message, a status, a label, the account surface — rather than by checking
    // the one place a leak was expected.
    const { totpEnrollment: _held, ...restOfHubState } = hostedHubStore.getState();
    expect(
      `${JSON.stringify(restOfHubState)}${JSON.stringify(hostedAccountStore.getState())}`,
    ).not.toContain("TOTPSECRETSENSITIVECANARY");

    hostedHubController.dismissTotpEnrollment();
    expect(hostedHubStore.getState().totpEnrollment).toBeNull();
  });

  it("drops the enrolment secret once the enrolment is confirmed or revoked", async () => {
    await authenticate();
    const enrollment = {
      secretBase32: "TOTPSECRETSENSITIVECANARY",
      provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
    };
    vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockResolvedValue(enrollment);
    vi.spyOn(hostedHubApi, "confirmTotpEnrollment").mockResolvedValue();
    vi.spyOn(hostedHubApi, "revokeTotp").mockResolvedValue();

    await hostedHubController.beginTotpEnrollment();
    await hostedHubController.confirmTotpEnrollment({ code: "123456" });
    expect(hostedHubStore.getState().totpEnrollment).toBeNull();

    await hostedHubController.beginTotpEnrollment();
    expect(hostedHubStore.getState().totpEnrollment).toEqual(enrollment);
    await hostedHubController.revokeTotp();
    expect(hostedHubStore.getState().totpEnrollment).toBeNull();
  });

  it("drops the enrolment secret when the account clears", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockResolvedValue({
      secretBase32: "TOTPSECRETSENSITIVECANARY",
      provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
    });
    vi.spyOn(hostedHubApi, "signOut").mockResolvedValue();

    await hostedHubController.beginTotpEnrollment();
    await hostedHubController.signOut();

    expect(hostedHubStore.getState().totpEnrollment).toBeNull();
    const persisted = `${JSON.stringify(hostedHubStore.getState())}${JSON.stringify(
      hostedAccountStore.getState(),
    )}`;
    expect(persisted).not.toContain("TOTPSECRETSENSITIVECANARY");
  });

  it("revokes a passkey and confirms the change against a forced fresh read", async () => {
    await authenticate();
    const revoked = { ...passkey, revokedAt: 40, revocationReasonCode: "owner_revoked" } as const;
    const revokePasskey = vi.spyOn(hostedHubApi, "revokePasskey").mockResolvedValue();

    // A read is ALREADY IN FLIGHT when the revoke lands. It was issued against
    // the pre-revoke state and resolves with the stale list. If the confirming
    // read joined it instead of forcing its own, the surface would settle on a
    // list that still shows the credential as active — evidence the revoke had
    // failed, for a revoke that succeeded. Asserting only the call count does
    // not catch that: the count is 2 either way.
    let releaseStaleRead: ((value: ReadonlyArray<typeof passkey>) => void) | null = null;
    const listPasskeys = vi
      .spyOn(hostedHubApi, "listPasskeys")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStaleRead = resolve;
          }),
      )
      .mockResolvedValue([revoked]);

    const stale = hostedHubController.refreshPasskeys();
    await hostedHubController.revokePasskey(passkey.id);
    releaseStaleRead?.([passkey]);
    await stale;

    expect(revokePasskey).toHaveBeenCalledWith(passkey.id, expect.anything());
    expect(listPasskeys).toHaveBeenCalledTimes(2);
    expect(hostedAccountStore.getState()).toMatchObject({
      passkeys: [revoked],
      passkeysStatus: "ready",
      actionStatus: "idle",
      errorMessage: null,
    });
  });

  it("renames and revokes native E2EE devices with forced confirming reads", async () => {
    await authenticate();
    const renamed = {
      ...e2eeDevice,
      enrollmentRevision: 2,
      deviceLabel: "Travel phone",
      updatedAt: e2eeDevice.updatedAt + 1,
    } as const;
    const revoked = {
      ...renamed,
      enrollmentRevision: 3,
      deviceAuthEpoch: 3,
      status: "revoked",
      updatedAt: renamed.updatedAt + 1,
      revokedAt: renamed.updatedAt + 1,
    } as const;
    const renameE2eeDevice = vi.spyOn(hostedHubApi, "renameE2eeDevice").mockResolvedValue(renamed);
    const revokeE2eeDevice = vi.spyOn(hostedHubApi, "revokeE2eeDevice").mockResolvedValue(revoked);
    const listE2eeDevices = vi
      .spyOn(hostedHubApi, "listE2eeDevices")
      .mockResolvedValueOnce([renamed])
      .mockResolvedValueOnce([revoked]);

    await expect(
      hostedHubController.renameE2eeDevice(e2eeDevice.enrollmentId, {
        expectedEnrollmentRevision: 1,
        deviceLabel: "Travel phone",
      }),
    ).resolves.toEqual({ status: "committed" });
    await expect(
      hostedHubController.revokeE2eeDevice(e2eeDevice.enrollmentId, {
        expectedEnrollmentRevision: 2,
        reasonCode: "owner_revoked",
      }),
    ).resolves.toEqual({ status: "committed" });

    expect(renameE2eeDevice).toHaveBeenCalledWith(
      e2eeDevice.enrollmentId,
      { expectedEnrollmentRevision: 1, deviceLabel: "Travel phone" },
      expect.anything(),
    );
    expect(revokeE2eeDevice).toHaveBeenCalledWith(
      e2eeDevice.enrollmentId,
      { expectedEnrollmentRevision: 2, reasonCode: "owner_revoked" },
      expect.anything(),
    );
    expect(listE2eeDevices).toHaveBeenCalledTimes(2);
    expect(hostedAccountStore.getState()).toMatchObject({
      e2eeDevices: [revoked],
      e2eeDevicesStatus: "ready",
      actionStatus: "idle",
    });
  });

  it("publishes an enrolment secret whose session rotated under it, to the same account", async () => {
    // A session rotation is not an account change. `restoreSession` re-mints
    // the id on every foreground and reconnect, so the ordinary session fence
    // would discard a secret the Hub has already issued — and this Hub refuses
    // to issue a second one, leaving the user with a half-enrolled
    // authenticator they can neither see nor replace. Backgrounding the app
    // mid-enrolment must not do that.
    await authenticate();
    vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockImplementation(async () => {
      hostedHubStore.setState({
        session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
      });
      return {
        secretBase32: "TOTPSECRETSENSITIVECANARY",
        provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
      };
    });

    await expect(hostedHubController.beginTotpEnrollment()).resolves.toEqual({
      status: "committed",
      displayed: true,
    });

    expect(hostedHubStore.getState().totpEnrollment).toEqual({
      secretBase32: "TOTPSECRETSENSITIVECANARY",
      provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
    });
    // Still only ever in its own slot.
    expect(JSON.stringify(hostedAccountStore.getState())).not.toContain(
      "TOTPSECRETSENSITIVECANARY",
    );
  });

  it("does not publish an enrolment secret once a different account holds the session", async () => {
    // The fence that does still apply: an account change is not a rotation, and
    // a secret minted for one account may never land in another's state.
    await authenticate();
    vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockImplementation(async () => {
      hostedHubStore.setState({
        account: { ...sessionResponse.account, id: "acct_bbbbbbbbbbbbbbbbbbbbbb" },
        session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
      });
      return {
        secretBase32: "TOTPSECRETSENSITIVECANARY",
        provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
      };
    });

    await hostedHubController.beginTotpEnrollment();

    expect(hostedHubStore.getState().totpEnrollment).toBeNull();
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("TOTPSECRETSENSITIVECANARY");
    // …and it is not silent: the Hub issued an enrolment nobody can see.
    expect(hostedAccountStore.getState().errorMessage).toBe(
      HOSTED_TOTP_ENROLLMENT_UNDISPLAYED_MESSAGE,
    );
  });

  it("does not publish a credential failure whose session rotated under it", async () => {
    // The same fence on the FAILURE path. An error belonging to a session that
    // is no longer current must not be pinned onto the one that replaced it.
    await authenticate();
    vi.spyOn(hostedHubApi, "setPassword").mockImplementation(async () => {
      hostedHubStore.setState({
        session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
      });
      throw new HostedHubApiError("unavailable", 0);
    });

    await hostedHubController.setPassword({ password: "pw" });

    expect(hostedAccountStore.getState()).toMatchObject({
      actionStatus: "idle",
      errorMessage: null,
    });
  });

  it("drops an enrolment secret that arrives after the screen was dismissed", async () => {
    // A user who backs out while the request is in flight must not have the
    // account's shared key pushed back into state when it lands.
    await authenticate();
    let release: ((value: { secretBase32: string; provisioningUri: string }) => void) | null = null;
    vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = hostedHubController.beginTotpEnrollment();
    hostedHubController.dismissTotpEnrollment();
    release?.({
      secretBase32: "TOTPSECRETSENSITIVECANARY",
      provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
    });
    await pending;

    expect(hostedHubStore.getState().totpEnrollment).toBeNull();
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("TOTPSECRETSENSITIVECANARY");
  });

  it("clears held secrets when sign-in is abandoned", async () => {
    await authenticate();
    leaseRecoveryCodeDisplay();
    vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockResolvedValue({
      secretBase32: "TOTPSECRETSENSITIVECANARY",
      provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
    });
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockResolvedValue([
      "recovery-sensitive-canary",
    ]);
    await hostedHubController.beginTotpEnrollment();
    await hostedHubController.regenerateRecoveryCodes();

    hostedHubController.cancelAuthentication();

    // A signed-out store still holding either would contradict the single rule
    // this state has about secret material.
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "signed-out",
      recoveryCodes: [],
      totpEnrollment: null,
    });
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("TOTPSECRETSENSITIVECANARY");
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("recovery-sensitive-canary");
  });

  it("does not re-read the passkey list when a revoke was refused", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "revokePasskey").mockRejectedValue(
      new HostedHubApiError("invalid_request", 400),
    );
    const listPasskeys = vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([passkey]);

    await hostedHubController.revokePasskey("pkey_not-a-valid-id");

    expect(listPasskeys).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().accountStatus).toBe("authenticated");
    expect(hostedAccountStore.getState()).toMatchObject({
      actionStatus: "idle",
      errorMessage: "The response was malformed or expired.",
    });
  });

  it("expires the session when a credential change is rejected as unauthenticated", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "revokeTotp").mockRejectedValue(
      new HostedHubApiError("session_invalid", 401),
    );

    await expect(hostedHubController.revokeTotp()).resolves.toMatchObject({
      status: "refused",
      reason: "session-expired",
      errorCode: "session_invalid",
    });

    expect(hostedHubStore.getState().accountStatus).toBe("session-expired");
    expect(hostedAccountStore.getState()).toEqual(hostedAccountStore.getInitialState());
  });

  it("forces a security-state refresh after every committed posture mutation", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "setPassword").mockResolvedValue();
    vi.spyOn(hostedHubApi, "removePassword").mockResolvedValue();
    vi.spyOn(hostedHubApi, "confirmTotpEnrollment").mockResolvedValue();
    vi.spyOn(hostedHubApi, "revokeTotp").mockResolvedValue();
    vi.spyOn(hostedHubApi, "requestEmailVerification").mockResolvedValue();
    const getAccountSecurity = vi.spyOn(hostedHubApi, "getAccountSecurity");

    await hostedHubController.setPassword({ password: "pw" });
    await hostedHubController.removePassword();
    await hostedHubController.confirmTotpEnrollment({ code: "123456" });
    await hostedHubController.revokeTotp();
    await hostedHubController.requestEmailVerification({ email: "ada@example.test" });

    expect(getAccountSecurity).toHaveBeenCalledTimes(5);
  });

  it("keeps a committed credential outcome when its confirming security read fails", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "setPassword").mockResolvedValue();
    vi.spyOn(hostedHubApi, "getAccountSecurity").mockRejectedValue(
      new HostedHubApiError("unavailable", 0),
    );

    await expect(hostedHubController.setPassword({ password: "pw" })).resolves.toEqual({
      status: "committed",
    });
    expect(hostedAccountStore.getState()).toMatchObject({
      security: null,
      securityStatus: "stale",
      actionStatus: "idle",
    });
  });

  it("runs one credential change at a time across the whole account surface", async () => {
    await authenticate();
    let release: (() => void) | null = null;
    vi.spyOn(hostedHubApi, "setPassword").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const revokePasskey = vi.spyOn(hostedHubApi, "revokePasskey").mockResolvedValue();
    const beginTotpEnrollment = vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockResolvedValue({
      secretBase32: "s",
      provisioningUri: "otpauth://totp/Ryco:ada?secret=s",
    });

    const pending = hostedHubController.setPassword({ password: "pw" });
    expect(hostedAccountStore.getState().actionStatus).toBe("setting-password");

    await hostedHubController.revokePasskey(passkey.id);
    await hostedHubController.beginTotpEnrollment();

    expect(revokePasskey).not.toHaveBeenCalled();
    expect(beginTotpEnrollment).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().totpEnrollment).toBeNull();
    expect(hostedAccountStore.getState().errorMessage).toBe(HOSTED_ACCOUNT_BUSY_MESSAGE);

    release?.();
    await pending;
    expect(hostedAccountStore.getState().actionStatus).toBe("idle");
  });

  it("cancels a credential change that never returns", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "beginTotpEnrollment").mockImplementation(
      () => new Promise(() => undefined),
    );
    const removePassword = vi.spyOn(hostedHubApi, "removePassword").mockResolvedValue();

    void hostedHubController.beginTotpEnrollment();
    expect(hostedAccountStore.getState().actionStatus).toBe("enrolling-totp");

    hostedHubController.cancelAccountAction();
    expect(hostedAccountStore.getState()).toMatchObject({
      actionStatus: "idle",
      errorMessage: null,
    });
    // Nothing was committed by the abandoned action.
    expect(hostedHubStore.getState().totpEnrollment).toBeNull();

    await hostedHubController.removePassword();
    expect(removePassword).toHaveBeenCalledOnce();
  });

  it("refuses every credential change while signed out with a bounded message", async () => {
    const calls = [
      vi.spyOn(hostedHubApi, "setPassword"),
      vi.spyOn(hostedHubApi, "removePassword"),
      vi.spyOn(hostedHubApi, "beginTotpEnrollment"),
      vi.spyOn(hostedHubApi, "confirmTotpEnrollment"),
      vi.spyOn(hostedHubApi, "revokeTotp"),
      vi.spyOn(hostedHubApi, "requestEmailVerification"),
      vi.spyOn(hostedHubApi, "revokePasskey"),
    ];

    await hostedHubController.setPassword({ password: "pw" });
    await hostedHubController.removePassword();
    await hostedHubController.beginTotpEnrollment();
    await hostedHubController.confirmTotpEnrollment({ code: "123456" });
    await hostedHubController.revokeTotp();
    await hostedHubController.requestEmailVerification({ email: "ada@example.test" });
    await hostedHubController.revokePasskey(passkey.id);

    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(hostedAccountStore.getState().errorMessage).toBe(HOSTED_ACCOUNT_SIGNED_OUT_MESSAGE);
  });

  it("threads the step-up code onto a recovery-code rotation", async () => {
    await authenticate();
    leaseRecoveryCodeDisplay();
    const regenerate = vi
      .spyOn(hostedHubApi, "regenerateRecoveryCodes")
      .mockResolvedValue(["fresh"]);

    await hostedHubController.regenerateRecoveryCodes({ totpCode: "123456" });

    expect(regenerate).toHaveBeenCalledWith({ totpCode: "123456" }, expect.anything());
    expect(hostedHubStore.getState().recoveryCodes).toEqual(["fresh"]);
  });

  // --- G1: the action's own outcome, not a re-read of shared state ------------

  it("reports a committed action on its own outcome", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "setPassword").mockResolvedValue();

    await expect(hostedHubController.setPassword({ password: "pw" })).resolves.toEqual({
      status: "committed",
    });
  });

  it("reports a cancelled action as refused, not as an absent error", async () => {
    await authenticate();
    // The bug this exists to stop: a surface that infers success from
    // `errorMessage === null` after the await reports an *abandoned* password
    // change as a completed one. The message is deliberately absent — a user
    // who cancelled did not fail at anything — so only the outcome can say.
    vi.spyOn(hostedHubApi, "setPassword").mockImplementation(
      (_input, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    const pending = hostedHubController.setPassword({ password: "pw" });
    hostedHubController.cancelAccountAction();
    const outcome = await pending;

    expect(hostedAccountStore.getState().errorMessage).toBeNull();
    expect(outcome).toEqual({
      status: "refused",
      reason: "cancelled",
      errorCode: null,
      wireErrorCode: null,
      inferredErrorCode: false,
      errorMessage: null,
    });
  });

  it("names the refusal when an action never reached the Hub", async () => {
    const signedOut = await hostedHubController.removePassword();
    expect(signedOut).toMatchObject({ status: "refused", reason: "signed-out", errorCode: null });

    await authenticate();
    let release: (() => void) | null = null;
    vi.spyOn(hostedHubApi, "setPassword").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    vi.spyOn(hostedHubApi, "removePassword").mockResolvedValue();

    const pending = hostedHubController.setPassword({ password: "pw" });
    const busy = await hostedHubController.removePassword();
    expect(busy).toMatchObject({ status: "refused", reason: "busy", errorCode: null });

    release?.();
    await pending;
  });

  it("reports an enrolment whose confirming read failed as committed", async () => {
    await authenticate();
    // The duplicate-credential bug: the credential *is* enrolled — the Hub
    // verified the ceremony — and only the confirming re-read failed. A surface
    // told "failed" leaves its dialog open and the user enrols a second one.
    vi.spyOn(hostedHubApi, "addPasskey").mockResolvedValue({ passkey, confirmed: true });
    vi.spyOn(hostedHubApi, "listPasskeys").mockRejectedValue(
      new HostedHubApiError("unavailable", 0),
    );

    const outcome = await hostedHubController.addPasskey({ passkeyLabel: null });

    expect(outcome).toEqual({ status: "committed", confirmation: "unverified", passkey });
    // Still distinguishable from a real failure, which never commits.
    expect(hostedAccountStore.getState().passkeysStatus).toBe("stale");
  });

  it("separates a confirmed enrolment, an unvouched one, and a refused one", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "addPasskey").mockResolvedValue({ passkey, confirmed: true });
    vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([passkey]);
    await expect(hostedHubController.addPasskey({ passkeyLabel: null })).resolves.toEqual({
      status: "committed",
      confirmation: "confirmed",
      passkey,
    });

    vi.spyOn(hostedHubApi, "addPasskey").mockResolvedValue({ passkey: null, confirmed: false });
    vi.spyOn(hostedHubApi, "listPasskeys").mockResolvedValue([]);
    await expect(hostedHubController.addPasskey({ passkeyLabel: null })).resolves.toEqual({
      status: "committed",
      confirmation: "missing",
      passkey: null,
    });
    expect(hostedAccountStore.getState().errorMessage).toBe(HOSTED_PASSKEY_UNCONFIRMED_MESSAGE);

    vi.spyOn(hostedHubApi, "addPasskey").mockRejectedValue(
      new HostedHubApiError("browser_only_transport", 400),
    );
    await expect(hostedHubController.addPasskey({ passkeyLabel: null })).resolves.toMatchObject({
      status: "refused",
      reason: "request-failed",
      errorCode: "browser_only_transport",
    });
  });

  // --- G2: the code, not the copy --------------------------------------------

  it("publishes the error code beside the message and marks an inferred one", async () => {
    await authenticate();
    // What the api layer produces for a bare 403 on a step-up route: a
    // synthesised code, with the wire code kept alongside it.
    vi.spyOn(hostedHubApi, "setPassword").mockRejectedValue(
      new HostedHubApiError(STEP_UP_REQUIRED_CODE, 403, undefined, "set-password", "forbidden"),
    );

    const outcome = await hostedHubController.setPassword({ password: "pw" });

    expect(outcome).toEqual({
      status: "refused",
      reason: "request-failed",
      errorCode: STEP_UP_REQUIRED_CODE,
      wireErrorCode: "forbidden",
      inferredErrorCode: true,
      errorMessage: "Enter a current code from your authenticator app to confirm this change.",
    });
    expect(hostedAccountStore.getState()).toMatchObject({
      errorCode: STEP_UP_REQUIRED_CODE,
      errorCodeInferred: true,
    });
  });

  it("keeps the code in step with the message, and never leaves one behind", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "removePassword").mockRejectedValue(
      new HostedHubApiError("rate_limited", 429),
    );
    await hostedHubController.removePassword();
    expect(hostedAccountStore.getState()).toMatchObject({
      errorMessage: "Too many attempts. Wait briefly and try again.",
      errorCode: "rate_limited",
      errorCodeInferred: false,
    });

    // A message the runtime authored itself has no Hub code behind it. Leaving
    // the previous code standing would point a branch at an error that is not
    // the one being shown — a stale `step_up_required` under a "still in
    // progress" message renders a TOTP prompt for nothing.
    //
    // The code has to be written by something *other* than the account action
    // that is holding the mutex, or starting that action would have cleared it
    // and the assertion would prove nothing. A concurrent passkey read is
    // exactly that.
    let release: (() => void) | null = null;
    vi.spyOn(hostedHubApi, "setPassword").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = hostedHubController.setPassword({ password: "pw" });
    vi.spyOn(hostedHubApi, "listPasskeys").mockRejectedValue(
      new HostedHubApiError("rate_limited", 429),
    );
    await hostedHubController.refreshPasskeys({ force: true });
    expect(hostedAccountStore.getState()).toMatchObject({
      passkeysStatus: "stale",
      errorCode: "rate_limited",
    });

    await hostedHubController.removePassword();
    expect(hostedAccountStore.getState()).toMatchObject({
      errorMessage: HOSTED_ACCOUNT_BUSY_MESSAGE,
      errorCode: null,
      errorCodeInferred: false,
    });

    release?.();
    await pending;
    expect(hostedAccountStore.getState()).toMatchObject({
      errorMessage: null,
      errorCode: null,
      errorCodeInferred: false,
    });
  });

  // --- G3: the runtime owns the one-shot secret's lifetime -------------------

  it("drops a rotation asked for with no display at all", async () => {
    await authenticate();
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockResolvedValue([
      "recovery-sensitive-canary",
    ]);

    // No lease: a client that simply forgot cannot strand live credentials.
    const outcome = await hostedHubController.regenerateRecoveryCodes();

    expect(outcome).toEqual({ status: "committed", displayed: false });
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("recovery-sensitive-canary");
    // The rotation still happened, so the user must be told their saved codes
    // are dead rather than left believing they still work.
    expect(hostedAccountStore.getState().errorMessage).toBe(
      HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE,
    );
  });

  it("publishes a rotation whose display went away while it was in flight", async () => {
    await authenticate();
    const release = leaseRecoveryCodeDisplay();
    let settle: ((value: ReadonlyArray<string>) => void) | null = null;
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );

    const pending = hostedHubController.regenerateRecoveryCodes();
    // The surface goes away before the Hub answers — a node switch closing the
    // settings dialog, a reparent, a back-swipe. None of that reaches the Hub:
    // the rotation commits, so the codes the user had saved are already dead.
    release();
    settle?.(["recovery-sensitive-canary"]);
    const outcome = await pending;

    // Dropping them here would leave the account with recovery codes nobody
    // has. They are published instead, and left unleased so the hosted root's
    // takeover puts them in front of the user.
    expect(outcome).toEqual({ status: "committed", displayed: true });
    expect(hostedHubStore.getState().recoveryCodes).toEqual(["recovery-sensitive-canary"]);
    await Promise.resolve();
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(false);
  });

  it("keeps displayed codes when the last display lease is released", async () => {
    await authenticate();
    const first = leaseRecoveryCodeDisplay();
    const second = leaseRecoveryCodeDisplay();
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockResolvedValue([
      "recovery-sensitive-canary",
    ]);

    await expect(hostedHubController.regenerateRecoveryCodes()).resolves.toEqual({
      status: "committed",
      displayed: true,
    });
    expect(hostedHubStore.getState().recoveryCodes).toEqual(["recovery-sensitive-canary"]);

    // Two live surfaces must not clear each other's display.
    first();
    first();
    expect(hostedHubStore.getState().recoveryCodes).toEqual(["recovery-sensitive-canary"]);

    // Nor may the last one out. A surface stops being mounted for reasons that
    // were never the user's decision — a hosted node deactivating and closing
    // the settings dialog, a reparent across the phone breakpoint — and by now
    // the rotation has already invalidated every code the user had saved.
    second();
    await Promise.resolve();
    expect(hostedHubStore.getState().recoveryCodes).toEqual(["recovery-sensitive-canary"]);
    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(false);

    // The acknowledgement is what clears them, and it still does.
    hostedHubController.dismissRecoveryCodes();
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("recovery-sensitive-canary");
  });

  it("never reports the display gone across a release and retake in one tick", async () => {
    // React runs a deleted subtree's cleanups before the replacement's mount
    // effects, so a remount looks exactly like a teardown at the moment the
    // release runs. Publishing `false` there hands the viewport to the hosted
    // root's takeover for a frame, mid-flow, on nothing but a reparent.
    const published: Array<boolean> = [];
    const unsubscribe = hostedRecoveryCodeDisplayStore.subscribe(() => {
      published.push(hostedRecoveryCodeDisplayStore.getState().leased);
    });
    try {
      const release = leaseRecoveryCodeDisplay();
      expect(published).toEqual([true]);

      release();
      leaseRecoveryCodeDisplay();
      await Promise.resolve();
      await Promise.resolve();

      expect(published, "a remount published an unleased display").toEqual([true]);
      expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("leaves post-bootstrap codes alone when a lease is released", async () => {
    // The legitimate publish-and-display flow: codes arrive with the new
    // account and the root surface shows them. A release from an unrelated
    // surface must not wipe them out from under it.
    vi.spyOn(hostedHubApi, "bootstrapOwner").mockResolvedValue({
      ...sessionResponse,
      recoveryCodes: ["bootstrap-code"],
    });
    vi.spyOn(hostedHubApi, "listNodes").mockResolvedValue([]);
    await hostedHubController.bootstrapOwner({
      credential: "c",
      displayName: "Ada",
      passkeyLabel: null,
    });
    expect(hostedHubStore.getState().recoveryCodes).toEqual(["bootstrap-code"]);

    leaseRecoveryCodeDisplay()();

    expect(hostedHubStore.getState().recoveryCodes).toEqual(["bootstrap-code"]);
  });

  it("publishes a rotation that lands after the user acknowledged the previous set", async () => {
    // The acknowledgement on screen while a rotation is in flight is about the
    // set being replaced — the new one does not exist yet, so nothing the user
    // taps can be an acknowledgement of it. Letting that tap fence the rotation
    // means one press invalidates the codes they just saved *and* discards the
    // replacement.
    await authenticate();
    leaseRecoveryCodeDisplay();
    hostedHubStore.setState({ recoveryCodes: ["stale-set"] });
    let settle: ((value: ReadonlyArray<string>) => void) | null = null;
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );

    const pending = hostedHubController.regenerateRecoveryCodes();
    hostedHubController.dismissRecoveryCodes();
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    settle?.(["recovery-sensitive-canary"]);
    await pending;

    expect(hostedHubStore.getState().recoveryCodes).toEqual(["recovery-sensitive-canary"]);
  });

  it("publishes a rotation whose session rotated under it, to the same account", async () => {
    // The ordinary session fence discards a result whose session was replaced.
    // `restoreSession` replaces it on every foreground and reconnect without
    // ending the account, so backgrounding a phone mid-rotation used to throw
    // away codes the Hub had already committed — with the user's previous set
    // already dead. A committed one-shot secret is not stale, it is
    // irreplaceable.
    await authenticate();
    leaseRecoveryCodeDisplay();
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockImplementation(async () => {
      hostedHubStore.setState({
        session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
      });
      return ["recovery-sensitive-canary"];
    });

    await expect(hostedHubController.regenerateRecoveryCodes()).resolves.toEqual({
      status: "committed",
      displayed: true,
    });

    expect(hostedHubStore.getState().recoveryCodes).toEqual(["recovery-sensitive-canary"]);
    expect(hostedAccountStore.getState().errorMessage).toBeNull();
  });

  it("does not publish a rotation once a different account holds the session", async () => {
    // The fence that does still apply. A rotation is not stale because the
    // session was re-minted, but codes minted for one account may never land in
    // another's state — and the user is still told the rotation happened.
    await authenticate();
    leaseRecoveryCodeDisplay();
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockImplementation(async () => {
      hostedHubStore.setState({
        account: { ...sessionResponse.account, id: "acct_bbbbbbbbbbbbbbbbbbbbbb" },
        session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
      });
      return ["recovery-sensitive-canary"];
    });

    const outcome = await hostedHubController.regenerateRecoveryCodes();

    expect(outcome.status).toBe("refused");
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("recovery-sensitive-canary");
    expect(hostedAccountStore.getState().errorMessage).toBe(
      HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE,
    );
  });

  it("never lets a committed rotation pass in silence", async () => {
    // The one outcome that must be impossible. Here the user abandons the
    // action — a hung passkey sheet, a closed prompt — after the Hub has
    // already minted the new set. The abandonment is honoured, and the codes it
    // costs are not passed over without a word: what the user saved is dead
    // either way, and only this message says so.
    await authenticate();
    leaseRecoveryCodeDisplay();
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockImplementation(async () => {
      hostedHubController.cancelAccountAction();
      return ["recovery-sensitive-canary"];
    });

    const outcome = await hostedHubController.regenerateRecoveryCodes();

    expect(outcome).toMatchObject({ status: "refused", reason: "cancelled" });
    expect(hostedHubStore.getState().recoveryCodes).toEqual([]);
    expect(JSON.stringify(hostedHubStore.getState())).not.toContain("recovery-sensitive-canary");
    expect(hostedAccountStore.getState().errorMessage).toBe(
      HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE,
    );
  });

  it("keeps a release from a dropped lease from unleasing a live display", async () => {
    // `resetForTests` drops every lease. A counter would then be driven
    // negative by the stale release that follows, and the next surface's lease
    // would only count back to zero — leaving a live display unleased and its
    // rotations undisplayable.
    const stale = leaseRecoveryCodeDisplay();
    hostedHubController.resetForTests();

    leaseRecoveryCodeDisplay();
    stale();
    await Promise.resolve();

    expect(hostedRecoveryCodeDisplayStore.getState().leased).toBe(true);

    await authenticate();
    vi.spyOn(hostedHubApi, "regenerateRecoveryCodes").mockResolvedValue(["fresh"]);
    await expect(hostedHubController.regenerateRecoveryCodes()).resolves.toEqual({
      status: "committed",
      displayed: true,
    });
  });
});
