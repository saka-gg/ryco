import type { EnvironmentId, RelayEffectiveRole } from "@ryco/contracts";
import type * as HostedIdentity from "@ryco/contracts/hosted-identity";
import type * as NativeE2ee from "@ryco/contracts/native-e2ee";

import { HostedReconnectPolicy } from "../relay/reconnectPolicy.ts";
import { HostedHubApiError, type HostedAccountStepUp, type HostedHubFailureReason } from "./api.ts";
import { activateHostedNode, deactivateHostedNode, suspendHostedNode } from "./environment.ts";
import { NativeHandoffClientError } from "./nativeHandoff.ts";
import { getHostedHubApi, getHostedRuntimeConfiguration } from "./runtime.ts";
import type {
  HostedAccountOutcome,
  HostedAccountRefusalReason,
  HostedAccountRefused,
  HostedAccountSecurity,
  HostedAccountStatus,
  HostedAccountE2eeDevice,
  HostedAddPasskeyOutcome,
  HostedAddPasskeyResult,
  HostedBrowserStatus,
  HostedDirectoryStatus,
  HostedHubAccount,
  HostedHubNode,
  HostedHubPasskey,
  HostedHubSession,
  HostedHubSessionResponse,
  HostedRecoveryCodesOutcome,
  HostedRelayFailure,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
  HostedSelectionStatus,
  HostedTotpEnrollment,
  HostedTotpEnrollmentOutcome,
} from "./types.ts";

export interface HostedHubState {
  readonly bootstrapAvailable: boolean;
  readonly accountStatus: HostedAccountStatus;
  readonly account: HostedHubAccount | null;
  readonly session: HostedHubSession | null;
  readonly directoryStatus: HostedDirectoryStatus;
  readonly nodes: ReadonlyArray<HostedHubNode>;
  readonly selectedNode: HostedHubNode | null;
  readonly selectionStatus: HostedSelectionStatus;
  readonly effectiveRole: RelayEffectiveRole | null;
  readonly transportStatus: HostedRelayTransportStatus;
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly sessionEstablished: boolean;
  readonly sessionRecoveredAfterUnknown: boolean;
  readonly browserStatus: HostedBrowserStatus;
  readonly recoveryCodes: ReadonlyArray<string>;
  /**
   * A started TOTP enrolment, held **in memory only** for the enrolment screen
   * to render its QR code and manual-entry secret.
   *
   * It sits beside `recoveryCodes` and carries the same contract: it is the one
   * other piece of secret material this runtime holds, it is never written to
   * the account store, an error message, a log, or any persisted store, and it
   * is cleared by `dismissTotpEnrollment`, by a successful confirm or revoke,
   * and by every account teardown.
   *
   * Declared optional purely so that adding a transient slot to this shared
   * shape does not force every consumer's state fixture to restate it. The
   * runtime's own store always carries the slot — `null` when no enrolment is in
   * progress — so `undefined` only ever appears in a hand-built snapshot, where
   * it means the same thing.
   */
  readonly totpEnrollment?: HostedTotpEnrollment | null;
  readonly errorMessage: string | null;
  /** Client-known failure category used by native/web presentation; never server detail. */
  readonly errorReason?: HostedHubFailureReason | null;
  readonly generation: number;
}

const initialState: HostedHubState = {
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
  totpEnrollment: null,
  errorMessage: null,
  errorReason: null,
  generation: 0,
};

export type HostedPasskeyDirectoryStatus = "idle" | "loading" | "ready" | "stale";
export type HostedE2eeDeviceDirectoryStatus = "idle" | "loading" | "ready" | "stale";
export type HostedAccountSecurityStatus = "idle" | "loading" | "ready" | "stale";
export type HostedExternalIdentityConfigurationStatus = "idle" | "loading" | "ready" | "stale";

export type HostedAccountActionStatus =
  | "idle"
  | "adding-passkey"
  | "revoking-passkey"
  | "renaming-e2ee-device"
  | "revoking-e2ee-device"
  | "regenerating-recovery-codes"
  | "setting-password"
  | "removing-password"
  | "enrolling-totp"
  | "confirming-totp"
  | "revoking-totp"
  | "requesting-email-verification"
  | "connecting-external-identity"
  | "disconnecting-external-identity";

/**
 * Account-management surface state. Kept in its own store rather than widened
 * into {@link HostedHubState} so the relay/session lifecycle state — republished
 * on every transport and session transition — is not perturbed by an account
 * screen, and so an account read never re-renders a relay consumer.
 *
 * No secret material lives here. A passkey `id` is a public credential
 * identifier; recovery codes and the TOTP enrolment secret are deliberately
 * *not* stored here — they go to the `hostedHubStore.recoveryCodes` and
 * `hostedHubStore.totpEnrollment` slots, which are in memory only and are
 * cleared by `dismissRecoveryCodes` / `dismissTotpEnrollment` and by any account
 * teardown. Showing them exactly once is the consuming UI's contract: the
 * runtime holds them until dismissed and cannot enforce a single display.
 */
export interface HostedAccountState {
  readonly externalIdentityConfiguration: HostedIdentity.ExternalIdentityConfigResponse | null;
  readonly externalIdentityConfigurationStatus: HostedExternalIdentityConfigurationStatus;
  readonly passkeys: ReadonlyArray<HostedHubPasskey>;
  readonly passkeysStatus: HostedPasskeyDirectoryStatus;
  readonly e2eeDevices?: ReadonlyArray<HostedAccountE2eeDevice>;
  readonly e2eeDevicesStatus?: HostedE2eeDeviceDirectoryStatus;
  readonly security: HostedAccountSecurity | null;
  readonly securityStatus: HostedAccountSecurityStatus;
  readonly actionStatus: HostedAccountActionStatus;
  readonly errorMessage: string | null;
  /**
   * The machine-readable reason the last account operation failed, in step with
   * {@link errorMessage} — `null` whenever there is no error.
   *
   * This is what a branch on a security outcome must read.
   * {@link errorMessage} is display copy: it is produced by this runtime's own
   * error constructor and may be reworded at any time, so string-comparing it
   * to detect `step_up_required` couples a security decision to a UI string.
   *
   * Declared optional for the same reason `totpEnrollment` is — see
   * {@link HostedHubState.totpEnrollment}. The runtime's own store always
   * carries the slot.
   */
  readonly errorCode?: string | null;
  /**
   * `true` when {@link errorCode} was synthesised client-side from the route
   * rather than received from the Hub — see `narrowCode` in `api.ts`. A surface
   * may act on an inferred code but must not present it as authoritative, and a
   * prompt built on one must stay escapable.
   */
  readonly errorCodeInferred?: boolean;
}

const initialAccountState: HostedAccountState = {
  externalIdentityConfiguration: null,
  externalIdentityConfigurationStatus: "idle",
  passkeys: [],
  passkeysStatus: "idle",
  e2eeDevices: [],
  e2eeDevicesStatus: "idle",
  security: null,
  securityStatus: "idle",
  actionStatus: "idle",
  errorMessage: null,
  errorCode: null,
  errorCodeInferred: false,
};

/**
 * What must still hold when an account action's result comes back, for that
 * result to be published.
 *
 * `"session"` is the default and the right answer for anything the surface can
 * simply ask for again: a result fetched under a session the app has since
 * replaced may describe state that no longer applies, and re-reading is free.
 *
 * `"account"` is for a result that **cannot be re-fetched** — a one-shot secret
 * the Hub has already committed. The session fence is wrong for those, and
 * dangerously so: `restoreSession` re-mints the session id on every
 * foreground and reconnect *without ending the account*, so backgrounding a
 * phone mid-rotation used to discard a set of recovery codes the Hub had
 * already made authoritative, with the user's previous set already dead. A
 * committed one-shot secret is not stale, it is irreplaceable; the account
 * still being the same account is the whole of what has to be true.
 */
type HostedAccountCommitFence = "session" | "account";

type HostedHubStoreListener = () => void;

/** Neutral external store; React binding remains in the web adapter. */
function createHostedStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<HostedHubStoreListener>();
  const publish = () => listeners.forEach((listener) => listener());
  return {
    getState: () => state,
    getInitialState: () => initial,
    setState: (patch: Partial<T> | T, replace = false) => {
      state = replace ? (patch as T) : { ...state, ...patch };
      publish();
    },
    subscribe: (listener: HostedHubStoreListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const hostedHubStore = createHostedStore(initialState);

export const hostedAccountStore = createHostedStore(initialAccountState);

/**
 * Whether any surface is currently displaying the one-time recovery codes.
 *
 * Deliberately its own store rather than a field of {@link HostedHubState}: a
 * lease belongs to the mounted *surfaces*, not to the account session, and the
 * session state is replaced wholesale on teardown — a lease field living there
 * would be reset out from under a surface that still holds one.
 *
 * Its one legitimate consumer is a surface deciding whether to display the
 * codes *itself*: the hosted root's full-screen "save your codes" takeover
 * steps in only when nothing else is showing them. **Nothing destructive may
 * key on this** — see {@link HostedHubController.leaseRecoveryCodeDisplay}.
 */
export interface HostedRecoveryCodeDisplayState {
  readonly leased: boolean;
}

export const hostedRecoveryCodeDisplayStore = createHostedStore<HostedRecoveryCodeDisplayState>({
  leased: false,
});

function patchState(patch: Partial<HostedHubState>): void {
  const clearsReason =
    Object.prototype.hasOwnProperty.call(patch, "errorMessage") &&
    !Object.prototype.hasOwnProperty.call(patch, "errorReason");
  hostedHubStore.setState(clearsReason ? { ...patch, errorReason: null } : patch);
}

function patchAccountState(patch: Partial<HostedAccountState>): void {
  hostedAccountStore.setState(patch);
}

function errorMessage(error: unknown): string {
  if (error instanceof HostedHubApiError) return error.message;
  if (error instanceof NativeHandoffClientError) {
    return error.code === "cancelled" || error.code === "superseded" ? "" : error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
  ) {
    return "The passkey request was cancelled or denied.";
  }
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
    return "";
  return "Hub is temporarily unavailable.";
}

function hostedErrorPatch(error: unknown): Pick<HostedHubState, "errorMessage" | "errorReason"> {
  return {
    errorMessage: errorMessage(error) || null,
    errorReason: error instanceof HostedHubApiError ? error.reason : null,
  };
}

/**
 * The three account-error slots as one patch, so a message can never be
 * published without the code that explains it (or left behind when the code is
 * cleared). Every account-store error write goes through this or
 * {@link NO_ACCOUNT_ERROR}.
 */
function accountErrorPatch(error: unknown): Partial<HostedAccountState> {
  const message = errorMessage(error) || null;
  if (error instanceof HostedHubApiError) {
    return {
      errorMessage: message,
      errorCode: error.code,
      errorCodeInferred: error.inferred,
    };
  }
  return { errorMessage: message, errorCode: null, errorCodeInferred: false };
}

/** A bounded, runtime-authored refusal that never came from the Hub. */
function localErrorPatch(message: string | null): Partial<HostedAccountState> {
  return { errorMessage: message, errorCode: null, errorCodeInferred: false };
}

const NO_ACCOUNT_ERROR: Partial<HostedAccountState> = {
  errorMessage: null,
  errorCode: null,
  errorCodeInferred: false,
};

/** Build the refusal outcome that matches what was just published to the store. */
function refused(reason: HostedAccountRefusalReason, error?: unknown): HostedAccountRefused {
  if (error instanceof HostedHubApiError) {
    return {
      status: "refused",
      reason,
      errorCode: error.code,
      wireErrorCode: error.wireCode,
      inferredErrorCode: error.inferred,
      errorMessage: error.message || null,
    };
  }
  return {
    status: "refused",
    reason,
    errorCode: null,
    wireErrorCode: null,
    inferredErrorCode: false,
    errorMessage: error === undefined ? null : errorMessage(error) || null,
  };
}

/** A refusal the runtime raised itself, carrying its own bounded message. */
function refusedLocally(
  reason: HostedAccountRefusalReason,
  message: string | null,
): HostedAccountRefused {
  return {
    status: "refused",
    reason,
    errorCode: null,
    wireErrorCode: null,
    inferredErrorCode: false,
    errorMessage: message,
  };
}

/**
 * Whether the Hub itself answered that this session is gone. A `401` whose body
 * is not the Hub's (a captive portal's or corporate proxy's own page decodes as
 * `invalid_response`) is not that answer, and must not end a session — in
 * bearer mode ending it deletes the only copy of the native token.
 */
function isSessionFailure(error: unknown): boolean {
  return (
    error instanceof HostedHubApiError &&
    error.code !== "invalid_response" &&
    (error.status === 401 || error.code === "session_invalid")
  );
}

/**
 * Whether a failed access check is one a later attempt can outlive: no answer
 * at all (transport loss, the request deadline, a proof a locked device could
 * not sign), a Hub that is busy or failing (408, 429, 5xx), or a body that is
 * not the Hub's (a captive portal or proxy page decodes as `invalid_response`).
 * A definite 4xx answer is not retried on a timer; the next lifecycle signal
 * still re-checks it.
 */
function isTransientAccessFailure(error: unknown): boolean {
  if (!(error instanceof HostedHubApiError)) return true;
  if (error.code === "invalid_response") return true;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * Whether a lifecycle binding must forward foreground and connectivity signals
 * to {@link HostedHubController.recoverAfterConnectivity}: an authenticated
 * account resumes on them, and one whose access check could not reach the Hub
 * re-runs it. Every other status has nothing a connectivity change can repair.
 */
export function hostedAccountRecoversOnConnectivity(status: HostedAccountStatus): boolean {
  return status === "authenticated" || status === "unavailable";
}

/**
 * The states the access-recovery backoff exists to leave: an account whose
 * bootstrap could not reach the Hub, and an authenticated browser whose resume
 * could not revalidate access and is therefore `stale` (no mutation authority).
 */
function awaitsAccessRecovery(state: HostedHubState): boolean {
  return (
    state.accountStatus === "unavailable" ||
    (state.accountStatus === "authenticated" && state.browserStatus === "stale")
  );
}

/**
 * A monotonic generation fence.
 *
 * `issue()` hands out a predicate that stays true until the next `bump()`. It is
 * the shared form of a pattern this controller had already grown twice by hand
 * (`generation` for relay selections, `#browserLifecycleGeneration` for browser
 * resume): an async result that lands after the state it was fetched for has
 * moved on must be dropped, not published. Anything that repopulates state a
 * user has explicitly dismissed needs one.
 */
function createFence(): {
  readonly bump: () => void;
  readonly issue: () => () => boolean;
} {
  let generation = 0;
  return {
    bump: () => {
      generation += 1;
    },
    issue: () => {
      const issued = generation;
      return () => issued === generation;
    },
  };
}

const DIRECTORY_REFRESH_MS = 20_000;
/** Directory cadence while a surface waits for an offline node to come back. */
export const DIRECTORY_PRESENCE_REFRESH_MS = 5_000;
const DIRECTORY_RETRY_MAX_MS = 60_000;
const HOSTED_SESSION_SYNC_DEADLINE_MS = 30_000;
export const HOSTED_SESSION_SYNC_FAILURE_MESSAGE = "Ryco state could not be synchronized.";
export const HOSTED_ACCOUNT_BUSY_MESSAGE = "Another account change is still in progress.";
export const HOSTED_ACCOUNT_SIGNED_OUT_MESSAGE = "Sign in to change your account settings.";
export const HOSTED_PASSKEY_UNCONFIRMED_MESSAGE =
  "The passkey could not be confirmed. Check your passkeys before relying on it.";
/**
 * A rotation the Hub committed whose codes never reached a display.
 *
 * The user must be told: the rotation *did* happen server-side, so any codes
 * they had saved are already dead. Silence here would leave them believing they
 * still have working recovery credentials. Every path that can swallow a
 * committed rotation publishes this — there is no route from "the Hub minted
 * codes" to "nothing said so".
 */
export const HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE =
  "Your recovery codes were replaced but could not be shown. Your previous codes no longer work — generate a new set and save them.";
/**
 * An enrolment the Hub issued whose secret never reached the enrolment screen.
 *
 * The same rule as the rotation above, for the other one-shot secret: the Hub
 * treats an enrolment as live from the moment it is issued and refuses to issue
 * a second one, so a user who is not told is left with a half-enrolled
 * authenticator they cannot see and cannot re-request. Removing two-factor
 * authentication is what clears it.
 */
export const HOSTED_TOTP_ENROLLMENT_UNDISPLAYED_MESSAGE =
  "Two-factor setup started but its key could not be shown. Remove two-factor authentication and set it up again.";

class HostedHubController {
  #operation: AbortController | null = null;
  #directoryTimer: ReturnType<typeof setTimeout> | null = null;
  #directoryRetry = 0;
  /** One token per surface waiting on node presence; see `watchDirectoryPresence`. */
  #directoryPresenceWatches = new Set<symbol>();
  #directoryOperation: AbortController | null = null;
  #directoryPromise: Promise<void> | null = null;
  #bootstrapPromise: Promise<void> | null = null;
  #sessionSyncTimer: ReturnType<typeof setTimeout> | null = null;
  #retrySelectedNodeOperation: AbortController | null = null;
  #retrySelectedNodePromise: Promise<void> | null = null;
  #browserResumeOperation: AbortController | null = null;
  #browserResumePromise: Promise<void> | null = null;
  #browserSuspendPromise: Promise<void> | null = null;
  #browserLifecycleGeneration = 0;
  /**
   * The bounded, jittered (1s to 60s) backoff that retries a failed access
   * check on its own — see {@link HostedHubController.recoverAfterConnectivity}.
   * The attempt count is reset only once the Hub has answered with a session.
   * Jitter reads `Math.random` per delay rather than capturing it here, so the
   * one controller instance follows whatever source is current.
   */
  #accessRetryPolicy = new HostedReconnectPolicy({ random: () => Math.random() });
  #accessRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #accessRetryForeground: (() => void) | null = null;
  #totpEnrollmentFence = createFence();
  #recoveryCodesFence = createFence();
  /**
   * The surfaces currently displaying the one-time recovery codes, one token
   * each.
   *
   * Tokens rather than a counter so a release is inert once the lease it
   * belongs to is gone: `resetForTests` drops every lease, and a counter would
   * then be driven negative by the stale cleanup that follows — after which the
   * next lease would count to zero and a live surface's rotation would find no
   * display.
   */
  #recoveryCodesLeases = new Set<symbol>();
  /** Whether the settle for an already-released lease is queued. */
  #recoveryCodesLeaseSettleQueued = false;
  #passkeysOperation: AbortController | null = null;
  #passkeysPromise: Promise<void> | null = null;
  #e2eeDevicesOperation: AbortController | null = null;
  #e2eeDevicesPromise: Promise<void> | null = null;
  #securityOperation: AbortController | null = null;
  #securityPromise: Promise<void> | null = null;
  #externalIdentityConfigurationOperation: AbortController | null = null;
  #externalIdentityConfigurationPromise: Promise<void> | null = null;
  #externalIdentityConfigurationGeneration = 0;
  #accountOperation: AbortController | null = null;

  bootstrap(): Promise<void> {
    if (this.#bootstrapPromise) return this.#bootstrapPromise;
    const operation = this.#replaceOperation();
    const promise = this.#restoreAccess(operation).finally(() => {
      if (this.#operation === operation) this.#operation = null;
      if (this.#bootstrapPromise === promise) this.#bootstrapPromise = null;
    });
    this.#bootstrapPromise = promise;
    return promise;
  }

  /**
   * Adopt a session credential committed outside this controller, then
   * re-check access with it.
   *
   * The native identity ceremonies (password, email, recovery code, and the
   * completion journal that survives a restart) mint their credential through
   * the API directly and commit it to the platform store themselves. While
   * they run, the access-recovery backoff and the lifecycle bindings keep
   * re-running {@link bootstrap} with the credential being replaced, and the
   * answer to such a check is about that old credential: a `401` would clear
   * the new one, a timeout would leave the account `unavailable` after a
   * successful sign-in, and a plain `bootstrap()` after the commit would only
   * join it. So the check in flight is aborted and the pending retry cancelled
   * before the commit starts, any `bootstrap()` requested while the commit
   * runs joins this adoption instead of reading a credential mid-write, and
   * the check that follows is always a fresh one.
   *
   * Access is re-checked whether or not the commit succeeded — against
   * whatever credential the store holds once it has settled — because the
   * check this aborted must be replaced by something. Resolves to the
   * commit's own result once that check has settled.
   */
  adoptSessionCredential(commit: () => Promise<boolean>): Promise<boolean> {
    const operation = this.#replaceOperation();
    this.#resetAccessRetry();
    let committed = false;
    const promise = commit()
      .catch(() => false)
      .then((result) => {
        committed = result;
        if (operation.signal.aborted) return undefined;
        return this.#restoreAccess(operation);
      })
      .finally(() => {
        if (this.#operation === operation) this.#operation = null;
        if (this.#bootstrapPromise === promise) this.#bootstrapPromise = null;
      });
    this.#bootstrapPromise = promise;
    return promise.then(() => committed);
  }

  /** The access check behind {@link bootstrap} and {@link adoptSessionCredential}. */
  #restoreAccess(operation: AbortController): Promise<void> {
    return getHostedHubApi()
      .restoreSession(operation.signal)
      .then(async (result) => {
        // An answer for a check that a newer account operation replaced is
        // about the credential that check was sent with, not the current one.
        if (operation.signal.aborted) return;
        this.#resetAccessRetry();
        patchState({
          accountStatus: "authenticated",
          account: result.account,
          session: result.session,
          errorMessage: null,
        });
        await this.refreshDirectory();
      })
      .catch((error) => {
        if (operation.signal.aborted) return undefined;
        if (isSessionFailure(error)) {
          // Only the Hub's own answer that this session is gone ends it.
          getHostedHubApi().clearSessionMaterial();
          return getHostedHubApi()
            .getBootstrapAvailability(operation.signal)
            .catch(() => false)
            .then((bootstrapAvailable) => {
              if (!operation.signal.aborted) patchState({ ...initialState, bootstrapAvailable });
            });
        }
        // No answer, the request deadline, a busy or failing Hub, or a captive
        // portal's page says nothing about the session. In bearer mode the
        // stored token is the only copy of a still-valid DPoP-bound session, so
        // clearing it here turned every offline launch into a forced sign-in.
        // The material is kept and the access check retried instead; the
        // account stays `unavailable`, which grants nothing.
        patchState({
          ...initialState,
          accountStatus: "unavailable",
          ...hostedErrorPatch(error),
        });
        this.#scheduleAccessRetry(error);
        return undefined;
      });
  }

  /**
   * Re-establish hosted access after a foreground or connectivity signal.
   *
   * The one entry point every platform lifecycle binding forwards those signals
   * to, so what "recovery" means stays with this owner rather than being
   * re-derived per app: an account whose access check could not reach the Hub
   * re-runs {@link bootstrap}, and an authenticated account runs the full
   * {@link resumeBrowser} (session, directory, fresh relay attempt, current
   * snapshot). The access-recovery backoff re-enters here too, so a timed retry
   * can never publish anything the ordinary resume would not. Every other
   * status has nothing a connectivity change can repair.
   */
  recoverAfterConnectivity(): Promise<void> {
    const state = hostedHubStore.getState();
    if (state.accountStatus === "unavailable") return this.bootstrap();
    if (state.accountStatus === "authenticated") return this.resumeBrowser();
    return Promise.resolve();
  }

  /**
   * Sign in with a passkey.
   *
   * The reset below clears both one-shot secret slots, which everywhere else in
   * this controller would be a lockout. It is safe *only* because sign-in,
   * registration, `cancelAuthentication` and the bootstrap failure path are
   * reachable from unauthenticated surfaces alone, where nothing can be holding
   * a secret that belongs to the account being signed in to. Nothing enforces
   * that precondition — recording it here so a future caller that wires one of
   * these to an authenticated surface has to reckon with it first.
   */
  async signIn(): Promise<void> {
    const operation = this.#replaceOperation();
    patchState({
      accountStatus: "authenticating",
      errorMessage: null,
      recoveryCodes: [],
      totpEnrollment: null,
    });
    try {
      const result = await getHostedHubApi().signIn(operation.signal);
      this.#resetAccessRetry();
      patchState({
        accountStatus: "authenticated",
        account: result.account,
        session: result.session,
      });
      await this.refreshDirectory();
    } catch (error) {
      if (operation.signal.aborted) return;
      patchState({ accountStatus: "signed-out", ...hostedErrorPatch(error) });
    } finally {
      if (this.#operation === operation) this.#operation = null;
    }
  }

  async signInWithExternalProvider(
    provider: HostedIdentity.ExternalIdentityProvider,
  ): Promise<void> {
    const operation = this.#replaceOperation();
    patchState({
      accountStatus: "authenticating",
      errorMessage: null,
      recoveryCodes: [],
      totpEnrollment: null,
    });
    try {
      const result = await getHostedHubApi().signInWithExternalProvider(provider, operation.signal);
      this.#resetAccessRetry();
      patchState({
        accountStatus: "authenticated",
        account: result.account,
        session: result.session,
      });
      await this.refreshDirectory();
    } catch (error) {
      if (operation.signal.aborted) return;
      patchState({ accountStatus: "signed-out", ...hostedErrorPatch(error) });
    } finally {
      if (this.#operation === operation) this.#operation = null;
    }
  }

  async redeemInvitation(input: {
    readonly secret: string;
    readonly displayName: string;
    readonly passkeyLabel: string | null;
  }): Promise<void> {
    return this.#registerAccount((signal) => getHostedHubApi().redeemInvitation(input, signal));
  }

  async bootstrapOwner(input: {
    readonly credential: string;
    readonly displayName: string;
    readonly passkeyLabel: string | null;
  }): Promise<void> {
    return this.#registerAccount((signal) => getHostedHubApi().bootstrapOwner(input, signal));
  }

  /**
   * Publish a canonical browser identity that one of the public account APIs
   * has already decoded and whose CSRF token that API has already committed to
   * the cookie-session credential holder.
   *
   * Public signup is the only caller with one-shot recovery codes. Accepting
   * them here, in the same patch as the authenticated account, guarantees the
   * existing full-screen recovery-code takeover cannot miss the first render.
   */
  async adoptPublicBrowserIdentity(
    identity: HostedIdentity.HubBrowserSessionResponse,
    recoveryCodes: ReadonlyArray<string> = [],
  ): Promise<void> {
    this.#operation?.abort();
    this.#operation = null;
    this.#totpEnrollmentFence.bump();
    this.#recoveryCodesFence.bump();
    this.#resetAccessRetry();
    patchState({
      accountStatus: "authenticated",
      account: {
        id: identity.account.id,
        displayName: identity.account.displayName,
        role: identity.activeSpace.role,
        createdAt: identity.account.createdAt,
        disabledAt: identity.account.disabledAt,
      },
      session: {
        id: identity.session.id,
        accountId: identity.session.accountId,
        createdAt: identity.session.createdAt,
        expiresAt: identity.session.expiresAt,
        lastSeenAt: identity.session.lastSeenAt,
        revokedAt: identity.session.revokedAt,
        revocationReasonCode: identity.session.revocationReasonCode,
      },
      recoveryCodes: [...recoveryCodes],
      totpEnrollment: null,
      bootstrapAvailable: false,
      errorMessage: null,
    });
    await this.refreshDirectory();
  }

  async #registerAccount(
    register: (signal: AbortSignal) => Promise<HostedHubSessionResponse>,
  ): Promise<void> {
    const operation = this.#replaceOperation();
    patchState({
      accountStatus: "authenticating",
      errorMessage: null,
      recoveryCodes: [],
      totpEnrollment: null,
    });
    try {
      const result = await register(operation.signal);
      this.#resetAccessRetry();
      patchState({
        accountStatus: "authenticated",
        account: result.account,
        session: result.session,
        recoveryCodes: result.recoveryCodes ?? [],
        bootstrapAvailable: false,
      });
      await this.refreshDirectory();
    } catch (error) {
      if (operation.signal.aborted) return;
      patchState({ accountStatus: "signed-out", ...hostedErrorPatch(error) });
    } finally {
      if (this.#operation === operation) this.#operation = null;
    }
  }

  cancelAuthentication(): void {
    this.#operation?.abort();
    this.#operation = null;
    // Abandoning sign-in leaves the surface signed out, so nothing may still be
    // holding recovery codes or an enrolment secret: a signed-out store that
    // still carries either contradicts the one rule this state has about
    // secret material.
    this.#totpEnrollmentFence.bump();
    this.#recoveryCodesFence.bump();
    patchState({
      accountStatus: "signed-out",
      errorMessage: null,
      recoveryCodes: [],
      totpEnrollment: null,
    });
  }

  /**
   * Declare that a surface is displaying the one-time recovery codes, for as
   * long as it is. Returns the release; call it when the surface goes away (a
   * `useEffect` cleanup, an unmount, a dismissed sheet). The release is
   * idempotent, and leases are held one per surface, so two live surfaces
   * coexist.
   *
   * **A lease says "I am showing this". It does not own the codes' destruction,
   * and releasing one destroys nothing.** That is the point of it: a lifetime
   * tied to the last surface leaving made every reason a surface stops being
   * mounted a reason to destroy a set of codes the Hub had already made
   * authoritative — a hosted node deactivating
   * and closing the settings dialog underneath the user, a React reparent
   * across the phone breakpoint, a lazily-loaded presentation swapping in.
   * None of those is the user's decision, and each one left the account holding
   * recovery codes nobody has, which with a lost passkey is a lockout.
   *
   * So the codes outlive the lease. They are destroyed by
   * {@link dismissRecoveryCodes} — an explicit acknowledgement — or by the
   * account going away, and by nothing else.
   *
   * What a lease does still decide:
   *
   * - **A rotation publishes only if a lease was live when it was asked for.**
   *   A caller with no display at all cannot rotate codes into a slot nothing
   *   will ever render: it fails closed, reports `displayed: false`, and says
   *   so in a bounded message. Omitting the lease is therefore safe — which is
   *   the only kind of omission this API can afford.
   * - **Which surface displays them.** While a lease is live the hosted root
   *   leaves its full-screen takeover alone; once none is, that takeover is
   *   what puts an orphaned set in front of the user instead of leaving it
   *   unseen in memory.
   *
   * "No lease left" is settled a microtask after the release rather than at the
   * moment of it: React runs the deleted subtree's cleanups *before* the
   * replacement's mount effects, so at the instant a cleanup runs a remount is
   * indistinguishable from a teardown.
   */
  leaseRecoveryCodeDisplay(): () => void {
    const lease = Symbol("hosted-recovery-code-display-lease");
    this.#recoveryCodesLeases.add(lease);
    this.#publishRecoveryCodeDisplayLease();
    return () => {
      // Idempotent, and inert for a lease that has already been dropped
      // wholesale — a release can only ever end its own lease.
      if (!this.#recoveryCodesLeases.delete(lease)) return;
      this.#queueRecoveryCodeDisplayLeaseSettle();
    };
  }

  #publishRecoveryCodeDisplayLease(): void {
    const leased = this.#recoveryCodesLeases.size > 0;
    if (hostedRecoveryCodeDisplayStore.getState().leased === leased) return;
    hostedRecoveryCodeDisplayStore.setState({ leased });
  }

  /**
   * Settle "nothing is displaying the codes" one microtask after the release
   * that suggested it, so a remount — old cleanup then new mount, in the same
   * commit — never publishes an unleased display and the hosted root's takeover
   * never gets a frame in which to steal the viewport.
   *
   * A resolved promise rather than the runtime's injected timers, on purpose: a
   * surface can mount before the app has configured the runtime, and reading
   * that configuration here would make mounting a component force it. All this
   * schedules is a store publish, and nothing destructive is behind it — a
   * settle that concludes wrongly costs a takeover, never a secret.
   */
  #queueRecoveryCodeDisplayLeaseSettle(): void {
    if (this.#recoveryCodesLeaseSettleQueued) return;
    this.#recoveryCodesLeaseSettleQueued = true;
    void Promise.resolve().then(() => {
      this.#recoveryCodesLeaseSettleQueued = false;
      this.#publishRecoveryCodeDisplayLease();
    });
  }

  /**
   * The user's acknowledgement that they have saved the displayed codes, and
   * the only thing short of the account going away that drops them.
   *
   * **Never call this from a teardown path** — an unmount, a cleanup, a dialog
   * close driven by anything other than the user pressing the acknowledgement.
   * By the time codes are in this slot the rotation has already invalidated
   * every code the user had saved, so clearing them for any reason that was not
   * the user's decision leaves the account with recovery codes its owner never
   * saw. Ending a display is what {@link leaseRecoveryCodeDisplay}'s release is
   * for, and it deliberately destroys nothing.
   *
   * It clears the set that is **on screen now**, and deliberately does not
   * fence a rotation that is still in flight. Those codes do not exist yet, so
   * this cannot be an acknowledgement of them — and a surface that leaves the
   * acknowledgement live while a rotation runs (mobile's account screen did)
   * would otherwise let one tap invalidate the saved set *and* discard its
   * replacement. The user is acknowledging the old codes; the new ones still
   * have to arrive somewhere.
   */
  dismissRecoveryCodes(): void {
    patchState({ recoveryCodes: [] });
  }

  /**
   * Drop a displayed TOTP enrolment secret. The mirror of
   * {@link dismissRecoveryCodes}, and it carries the same rule: this is the
   * user abandoning the enrolment (or the flow finishing), never a teardown.
   * The enrolment is live on the Hub the moment the secret is issued and this
   * Hub refuses a second one, so a cleanup that clears the slot destroys the
   * only copy of a key the account is already expecting — the surface's own
   * copy says "this is the only time the key is displayed", and it is right.
   */
  dismissTotpEnrollment(): void {
    this.#totpEnrollmentFence.bump();
    patchState({ totpEnrollment: null });
  }

  /**
   * Synchronously withdraw native account-grant authority without signing the account out. Platform
   * adapters call this before asynchronous channel teardown on enrollment revocation or account-epoch
   * change, so stale generations cannot retain read or mutation readiness.
   */
  invalidateNativeE2eeAuthorization(): void {
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") return;
    getHostedRuntimeConfiguration().resetRelayAttemptFactory();
    patchState({
      generation: state.generation + 1,
      effectiveRole: null,
      transportStatus: "reconnecting",
      sessionStatus: "closed",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
    });
  }

  /**
   * Load the account's passkeys.
   *
   * Deduplicated like the node directory: a second caller joins the in-flight
   * read. `force` opts out of that — a read already in flight when a mutation
   * committed was issued against the pre-mutation state and cannot observe the
   * change, so joining it would settle the surface on a list that contradicts
   * what just happened.
   */
  refreshPasskeys(options?: { readonly force?: boolean }): Promise<void> {
    const force = options?.force === true;
    if (this.#passkeysPromise && !force) return this.#passkeysPromise;
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") return Promise.resolve();
    if (force) {
      this.#passkeysOperation?.abort();
      this.#passkeysPromise = null;
    }
    const operation = new AbortController();
    this.#passkeysOperation = operation;
    const promise = this.#refreshPasskeys(operation, state.session?.id ?? null).finally(() => {
      if (this.#passkeysOperation === operation) this.#passkeysOperation = null;
      if (this.#passkeysPromise === promise) this.#passkeysPromise = null;
    });
    // Arm the deduplication handle *before* publishing: a listener that
    // re-enters synchronously from the "loading" notification must join this
    // read rather than start a second one and desynchronise the two handles.
    this.#passkeysPromise = promise;
    if (hostedAccountStore.getState().passkeys.length === 0) {
      patchAccountState({ passkeysStatus: "loading" });
    }
    return promise;
  }

  async #refreshPasskeys(operation: AbortController, sessionId: string | null): Promise<void> {
    try {
      const passkeys = await getHostedHubApi().listPasskeys(operation.signal);
      if (operation.signal.aborted) return;
      if (!this.#isCurrentAccountSession(operation.signal, sessionId)) {
        this.#discardStalePasskeys();
        return;
      }
      patchAccountState({ passkeys, passkeysStatus: "ready", ...NO_ACCOUNT_ERROR });
    } catch (error) {
      if (operation.signal.aborted) return;
      if (isSessionFailure(error)) {
        await this.#expireSessionHandled(error);
        return;
      }
      if (!this.#isCurrentAccountSession(operation.signal, sessionId)) {
        this.#discardStalePasskeys();
        return;
      }
      patchAccountState({ passkeysStatus: "stale", ...accountErrorPatch(error) });
    }
  }

  /**
   * Expire the session as a *handled* outcome.
   *
   * `expireSession` reaches `clearAccount`, which awaits `deactivateHostedNode`
   * — a lifecycle teardown whose rejection is not an authorization failure.
   * State is already cleared before that await, so authorization still fails
   * closed either way; letting the rejection escape would turn a handled
   * session failure into a rejected account read, and hand a fire-and-forget
   * caller an unhandled rejection.
   */
  async #expireSessionHandled(error?: unknown): Promise<void> {
    await this.expireSession(error).catch(() => undefined);
  }

  /**
   * A read whose session changed under it must not leave a spinner behind. The
   * surface reverts to "nothing loaded" — never `"loading"` with nothing in
   * flight — so the next read starts cleanly, and any list carried over from
   * the previous session is dropped rather than shown as current.
   */
  #discardStalePasskeys(): void {
    patchAccountState({ passkeys: [], passkeysStatus: "idle" });
  }

  /** Load the account's native E2EE device directory behind the active session fence. */
  refreshE2eeDevices(options?: { readonly force?: boolean }): Promise<void> {
    const force = options?.force === true;
    if (this.#e2eeDevicesPromise && !force) return this.#e2eeDevicesPromise;
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") return Promise.resolve();
    if (force) {
      this.#e2eeDevicesOperation?.abort();
      this.#e2eeDevicesPromise = null;
    }
    const operation = new AbortController();
    this.#e2eeDevicesOperation = operation;
    const promise = this.#refreshE2eeDevices(operation, state.session?.id ?? null).finally(() => {
      if (this.#e2eeDevicesOperation === operation) this.#e2eeDevicesOperation = null;
      if (this.#e2eeDevicesPromise === promise) this.#e2eeDevicesPromise = null;
    });
    this.#e2eeDevicesPromise = promise;
    if ((hostedAccountStore.getState().e2eeDevices?.length ?? 0) === 0) {
      patchAccountState({ e2eeDevicesStatus: "loading" });
    }
    return promise;
  }

  async #refreshE2eeDevices(operation: AbortController, sessionId: string | null): Promise<void> {
    try {
      const e2eeDevices = await getHostedHubApi().listE2eeDevices(operation.signal);
      if (operation.signal.aborted) return;
      if (!this.#isCurrentAccountSession(operation.signal, sessionId)) {
        this.#discardStaleE2eeDevices();
        return;
      }
      patchAccountState({
        e2eeDevices,
        e2eeDevicesStatus: "ready",
        ...NO_ACCOUNT_ERROR,
      });
    } catch (error) {
      if (operation.signal.aborted) return;
      if (isSessionFailure(error)) {
        await this.#expireSessionHandled(error);
        return;
      }
      if (!this.#isCurrentAccountSession(operation.signal, sessionId)) {
        this.#discardStaleE2eeDevices();
        return;
      }
      patchAccountState({ e2eeDevicesStatus: "stale", ...accountErrorPatch(error) });
    }
  }

  #discardStaleE2eeDevices(): void {
    patchAccountState({ e2eeDevices: [], e2eeDevicesStatus: "idle" });
  }

  refreshExternalIdentityConfiguration(options?: { readonly force?: boolean }): Promise<void> {
    const force = options?.force === true;
    if (this.#externalIdentityConfigurationPromise && !force) {
      return this.#externalIdentityConfigurationPromise;
    }
    if (force) {
      this.#externalIdentityConfigurationOperation?.abort();
      this.#externalIdentityConfigurationPromise = null;
    }
    const generation = this.#externalIdentityConfigurationGeneration;
    const operation = new AbortController();
    this.#externalIdentityConfigurationOperation = operation;
    if (hostedAccountStore.getState().externalIdentityConfiguration === null) {
      patchAccountState({ externalIdentityConfigurationStatus: "loading" });
    }
    const promise = getHostedHubApi()
      .getExternalIdentityConfiguration(operation.signal)
      .then((configuration) => {
        if (
          operation.signal.aborted ||
          generation !== this.#externalIdentityConfigurationGeneration
        ) {
          return;
        }
        patchAccountState({
          externalIdentityConfiguration: configuration,
          externalIdentityConfigurationStatus: "ready",
        });
      })
      .catch(() => {
        if (
          operation.signal.aborted ||
          generation !== this.#externalIdentityConfigurationGeneration
        ) {
          return;
        }
        patchAccountState({ externalIdentityConfigurationStatus: "stale" });
      })
      .finally(() => {
        if (this.#externalIdentityConfigurationOperation === operation) {
          this.#externalIdentityConfigurationOperation = null;
        }
        if (this.#externalIdentityConfigurationPromise === promise) {
          this.#externalIdentityConfigurationPromise = null;
        }
      });
    this.#externalIdentityConfigurationPromise = promise;
    return promise;
  }

  /**
   * Load the signed-in account's bounded password, TOTP, and email posture.
   *
   * Unknown is represented by `security:null`, never by an all-false value.
   * A failed refresh retains the last known posture but marks it stale, so a
   * surface can remain useful without presenting cached state as current.
   */
  refreshAccountSecurity(options?: { readonly force?: boolean }): Promise<void> {
    const force = options?.force === true;
    if (this.#securityPromise && !force) return this.#securityPromise;
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") return Promise.resolve();
    if (force) {
      this.#securityOperation?.abort();
      this.#securityPromise = null;
    }
    const operation = new AbortController();
    this.#securityOperation = operation;
    const promise = this.#refreshAccountSecurity(operation, state.session?.id ?? null).finally(
      () => {
        if (this.#securityOperation === operation) this.#securityOperation = null;
        if (this.#securityPromise === promise) this.#securityPromise = null;
      },
    );
    this.#securityPromise = promise;
    if (hostedAccountStore.getState().security === null) {
      patchAccountState({ securityStatus: "loading" });
    }
    return promise;
  }

  async #refreshAccountSecurity(
    operation: AbortController,
    sessionId: string | null,
  ): Promise<void> {
    try {
      const security = await getHostedHubApi().getAccountSecurity(operation.signal);
      if (operation.signal.aborted) return;
      if (!this.#isCurrentAccountSession(operation.signal, sessionId)) {
        this.#discardStaleSecurity();
        return;
      }
      patchAccountState({ security, securityStatus: "ready" });
    } catch (error) {
      if (operation.signal.aborted) return;
      if (isSessionFailure(error)) {
        await this.#expireSessionHandled(error);
        return;
      }
      if (!this.#isCurrentAccountSession(operation.signal, sessionId)) {
        this.#discardStaleSecurity();
        return;
      }
      patchAccountState({ securityStatus: "stale" });
    }
  }

  #discardStaleSecurity(): void {
    patchAccountState({ security: null, securityStatus: "idle" });
  }

  /**
   * Enrol an additional passkey on the signed-in account ("add this device").
   *
   * Success is confirmed against the Hub, not against the ceremony: the Hub's
   * verify response is not required to describe what it enrolled, so a forced
   * (never joined) read is the only authority on whether the credential exists.
   * An unconfirmed enrolment reports a bounded message rather than presenting
   * the ceremony's completion as proof.
   *
   * `totpCode` is the optional fallback-session step-up; a passkey session
   * neither needs nor sees it.
   */
  async addPasskey(
    input: { readonly passkeyLabel: string | null } & HostedAccountStepUp,
  ): Promise<HostedAddPasskeyOutcome> {
    const captured: { result: HostedAddPasskeyResult | null } = { result: null };
    const before = hostedAccountStore.getState().passkeys.length;
    const outcome = await this.#accountAction("adding-passkey", async (signal) => {
      const added = await getHostedHubApi().addPasskey(input, signal);
      return () => {
        captured.result = added;
      };
    });
    if (outcome.status !== "committed") return outcome;
    // Past this point the Hub verified the ceremony: a credential *was*
    // enrolled. Everything below only decides how well that can be confirmed —
    // never whether it happened. Reporting any of it as "not committed" is what
    // makes a surface re-run the ceremony and enrol a second credential.
    const enrolledPasskey = captured.result?.passkey ?? null;
    await this.refreshPasskeys({ force: true });
    const state = hostedAccountStore.getState();
    // A failed confirming read publishes its own bounded message; do not
    // overwrite it with a weaker one.
    if (state.passkeysStatus !== "ready") {
      return { status: "committed", confirmation: "unverified", passkey: enrolledPasskey };
    }
    const enrolled = enrolledPasskey
      ? state.passkeys.some((candidate) => candidate.id === enrolledPasskey.id)
      : state.passkeys.length > before;
    if (!enrolled) {
      patchAccountState(localErrorPatch(HOSTED_PASSKEY_UNCONFIRMED_MESSAGE));
      return { status: "committed", confirmation: "missing", passkey: enrolledPasskey };
    }
    return { status: "committed", confirmation: "confirmed", passkey: enrolledPasskey };
  }

  /**
   * **Rotate** the account's recovery codes, invalidating any the user has
   * already saved, and place the new set in the existing `recoveryCodes` slot —
   * in memory only, never written to the account store, an error message, or a
   * log.
   *
   * This is a mutation. Call it only from an explicit, confirmed user action —
   * never on mount, focus, retry, or reconnect.
   *
   * **The codes only reach the store if a {@link leaseRecoveryCodeDisplay}
   * lease was live when the rotation was asked for.** With no lease at all the
   * rotation still happens — it is a server-side mutation and there is no
   * taking it back — but its result is dropped rather than left sitting in a
   * shared slot with nothing on screen to show it, and the outcome reports
   * `displayed: false` alongside a bounded message saying the previous codes
   * are dead.
   *
   * The lease is read when the user asks, not when the Hub answers. A display
   * that went away in between does **not** withhold the codes: the rotation has
   * already invalidated everything the user had saved, so the new set is the
   * only thing that still opens this account, and dropping it because a dialog
   * closed is the lockout rather than the safe default. An orphaned set stays
   * in the slot for the hosted root's takeover to show, until it is
   * acknowledged or the account goes away.
   *
   * The result publishes across a **session rotation** for the same reason —
   * see the `"account"` fence on {@link #accountAction}. Backgrounding an app
   * mid-rotation re-mints the session without ending the account, and the
   * ordinary session fence would have discarded a set of codes the Hub had
   * already committed.
   *
   * And if it still cannot be published, the user is told. There is no route
   * from "the Hub minted codes" to silence.
   */
  async regenerateRecoveryCodes(input?: HostedAccountStepUp): Promise<HostedRecoveryCodesOutcome> {
    const live = this.#recoveryCodesFence.issue();
    const leased = this.#recoveryCodesLeases.size > 0;
    let rotated = false;
    let displayed = false;
    const outcome = await this.#accountAction(
      "regenerating-recovery-codes",
      async (signal) => {
        const recoveryCodes = await getHostedHubApi().regenerateRecoveryCodes(input, signal);
        // Past this point the previous codes are dead whatever happens next.
        rotated = true;
        return () => {
          // The lease catches a caller that never had a display at all; the
          // fence catches the account itself going away underneath.
          if (!leased || !live()) return;
          displayed = true;
          patchState({ recoveryCodes });
        };
      },
      "account",
    );
    if (rotated && !displayed) this.#warnUndisplayed(HOSTED_RECOVERY_CODES_UNDISPLAYED_MESSAGE);
    if (outcome.status !== "committed") return outcome;
    return { status: "committed", displayed };
  }

  /**
   * Report a one-shot secret the Hub committed that no surface received.
   *
   * Written after the action has settled, not inside its commit thunk: the
   * thunk's caller clears the account error slots on success, so a message
   * published there would be wiped by the very action it describes. Suppressed
   * once the account is gone — the account surface is reset with it, and a
   * warning about a signed-out account's credentials explains nothing.
   */
  #warnUndisplayed(message: string): void {
    if (hostedHubStore.getState().accountStatus !== "authenticated") return;
    patchAccountState(localErrorPatch(message));
  }

  /**
   * Revoke one of the account's passkeys and re-read the list.
   *
   * The forced refresh is not cosmetic and is the same discipline
   * {@link addPasskey} follows: a revoke changes the list, and a read already in
   * flight was issued against the pre-revoke state, so joining it would leave
   * the surface showing a credential that no longer works.
   */
  async revokePasskey(credentialId: string): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("revoking-passkey", async (signal) => {
      await getHostedHubApi().revokePasskey(credentialId, signal);
      return () => undefined;
    });
    if (outcome.status !== "committed") return outcome;
    await this.refreshPasskeys({ force: true });
    return outcome;
  }

  /** Rename one enrolled native E2EE device and confirm the authoritative directory. */
  async renameE2eeDevice(
    enrollmentId: string,
    input: NativeE2ee.AccountE2eeDeviceRenameRequest,
  ): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("renaming-e2ee-device", async (signal) => {
      await getHostedHubApi().renameE2eeDevice(enrollmentId, input, signal);
      return () => undefined;
    });
    if (outcome.status !== "committed") return outcome;
    await this.refreshE2eeDevices({ force: true });
    return outcome;
  }

  /** Revoke one enrolled native E2EE device and confirm the authoritative directory. */
  async revokeE2eeDevice(
    enrollmentId: string,
    input: NativeE2ee.AccountE2eeDeviceRevokeRequest,
  ): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("revoking-e2ee-device", async (signal) => {
      await getHostedHubApi().revokeE2eeDevice(enrollmentId, input, signal);
      return () => undefined;
    });
    if (outcome.status !== "committed") return outcome;
    await this.refreshE2eeDevices({ force: true });
    return outcome;
  }

  /**
   * Set (or replace) the account's fallback password.
   *
   * A password is a *fallback* credential and is strictly weaker than a passkey.
   * No copy built on this may present the two as equivalent. The password is
   * passed straight through to the request and is never stored, logged, or
   * placed in an error by the runtime.
   */
  async setPassword(
    input: { readonly password: string } & HostedAccountStepUp,
  ): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("setting-password", async (signal) => {
      await getHostedHubApi().setPassword(input, signal);
      return () => undefined;
    });
    if (outcome.status === "committed") {
      await this.refreshAccountSecurity({ force: true });
    }
    return outcome;
  }

  /** Remove the account's fallback password. */
  async removePassword(input?: HostedAccountStepUp): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("removing-password", async (signal) => {
      await getHostedHubApi().removePassword(input, signal);
      return () => undefined;
    });
    if (outcome.status === "committed") {
      await this.refreshAccountSecurity({ force: true });
    }
    return outcome;
  }

  /**
   * Begin TOTP enrolment and hold the secret for the enrolment screen.
   *
   * The result is **secret key material**. It lands in the in-memory
   * `totpEnrollment` slot only — never the account store, never an error
   * message, never a log — and is dropped by `dismissTotpEnrollment`, by a
   * successful confirm or revoke, and by any account teardown.
   *
   * Enrolment requires a passkey-authenticated session; that is the Hub's rule
   * to enforce, and this action does not offer a step-up field that would let a
   * fallback session look like it qualifies.
   */
  async beginTotpEnrollment(): Promise<HostedTotpEnrollmentOutcome> {
    // Fenced against dismissal: a user who backs out of the enrolment screen
    // while the request is in flight must not have the secret pushed back into
    // state when it lands. The abort signal alone does not cover this — the
    // response may already be decoded by then.
    //
    // Unlike a recovery-code rotation, that dismissal is unambiguous: there is
    // exactly one enrolment in play and backing out is about *this* one. What
    // it is not is silent — an enrolment the Hub issued and nobody saw is
    // reported below, because the Hub will not issue a second.
    const current = this.#totpEnrollmentFence.issue();
    let issued = false;
    let displayed = false;
    const outcome = await this.#accountAction(
      "enrolling-totp",
      async (signal) => {
        const totpEnrollment = await getHostedHubApi().beginTotpEnrollment(signal);
        // Past this point the Hub holds a live enrolment for this account.
        issued = true;
        return () => {
          if (!current()) return;
          displayed = true;
          patchState({ totpEnrollment });
        };
      },
      // Same rule as the rotation: a foreground/reconnect re-mints the session
      // without ending the account, and the secret it would discard cannot be
      // re-requested.
      "account",
    );
    if (issued && !displayed) this.#warnUndisplayed(HOSTED_TOTP_ENROLLMENT_UNDISPLAYED_MESSAGE);
    if (outcome.status !== "committed") return outcome;
    return { status: "committed", displayed };
  }

  /**
   * Confirm TOTP enrolment with a code from the authenticator app, and drop the
   * secret: once the enrolment is confirmed the app holds it and the runtime has
   * no further reason to.
   */
  async confirmTotpEnrollment(input: { readonly code: string }): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("confirming-totp", async (signal) => {
      await getHostedHubApi().confirmTotpEnrollment(input, signal);
      return () => {
        this.#totpEnrollmentFence.bump();
        patchState({ totpEnrollment: null });
      };
    });
    if (outcome.status === "committed") {
      await this.refreshAccountSecurity({ force: true });
    }
    return outcome;
  }

  /** Remove TOTP from the account, dropping any half-finished enrolment with it. */
  async revokeTotp(input?: HostedAccountStepUp): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("revoking-totp", async (signal) => {
      await getHostedHubApi().revokeTotp(input, signal);
      return () => {
        this.#totpEnrollmentFence.bump();
        patchState({ totpEnrollment: null });
      };
    });
    if (outcome.status === "committed") {
      await this.refreshAccountSecurity({ force: true });
    }
    return outcome;
  }

  /**
   * Ask the Hub to send a verification mail for an address.
   *
   * The Hub answers 202 uniformly, so a committed action means "the request was
   * accepted" and never "this address is known" — surfaces must say the former.
   */
  async requestEmailVerification(
    input: { readonly email: string } & HostedAccountStepUp,
  ): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("requesting-email-verification", async (signal) => {
      await getHostedHubApi().requestEmailVerification(input, signal);
      return () => undefined;
    });
    if (outcome.status === "committed") {
      await this.refreshAccountSecurity({ force: true });
    }
    return outcome;
  }

  async connectExternalIdentity(
    provider: HostedIdentity.ExternalIdentityProvider,
    input?: HostedAccountStepUp,
  ): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("connecting-external-identity", async (signal) => {
      await getHostedHubApi().connectExternalIdentity(provider, input, signal);
      return () => undefined;
    });
    if (outcome.status === "committed") {
      await this.refreshAccountSecurity({ force: true });
    }
    return outcome;
  }

  cancelExternalIdentityConnection(provider: HostedIdentity.ExternalIdentityProvider): void {
    this.cancelAccountAction();
    getHostedHubApi().cancelExternalIdentityConnection(provider);
  }

  async finishBrowserExternalIdentityConnection(
    provider: HostedIdentity.ExternalIdentityProvider,
    input?: HostedAccountStepUp,
  ): Promise<HostedAccountOutcome> {
    const outcome = await this.#accountAction("connecting-external-identity", async (signal) => {
      await getHostedHubApi().finishBrowserExternalIdentityConnection(provider, input, signal);
      return () => undefined;
    });
    if (outcome.status === "committed") {
      await this.refreshAccountSecurity({ force: true });
    }
    return outcome;
  }

  async disconnectExternalIdentity(
    provider: HostedIdentity.ExternalIdentityProvider,
    input?: HostedAccountStepUp,
  ): Promise<HostedAccountOutcome> {
    let signedOut = false;
    const outcome = await this.#accountAction("disconnecting-external-identity", async (signal) => {
      const result = await getHostedHubApi().disconnectExternalIdentity(provider, input, signal);
      return () => {
        signedOut = result.signedOut;
      };
    });
    if (outcome.status !== "committed") return outcome;
    if (signedOut) {
      await this.clearAccount("signed-out");
    } else {
      await this.refreshAccountSecurity({ force: true });
    }
    return outcome;
  }

  /**
   * Abandon an account action that will not finish on its own. A platform
   * passkey sheet the user leaves open never returns and never rejects, so
   * without this the surface stays busy for the life of the session and every
   * later action is refused. `cancelAuthentication` does not cover this: it
   * aborts the sign-in operation, not the account one.
   */
  cancelAccountAction(): void {
    if (!this.#accountOperation) return;
    this.#accountOperation.abort();
    this.#accountOperation = null;
    patchAccountState({ actionStatus: "idle", ...NO_ACCOUNT_ERROR });
  }

  /**
   * Run one account-surface mutation at a time, publishing its result only
   * behind the {@link HostedAccountCommitFence} the caller asks for. `run`
   * returns the commit thunk so nothing reaches a store before that fence
   * passes.
   *
   * Resolves a discriminated {@link HostedAccountOutcome} rather than writing a
   * result a caller has to go and re-read. Re-reading `errorMessage` after the
   * await is both racy — a concurrent action or a post-commit confirming
   * refresh writes the same slot — and ambiguous: a cancelled action
   * deliberately leaves no message, so "no message" is not success.
   */
  async #accountAction(
    status: Exclude<HostedAccountActionStatus, "idle">,
    run: (signal: AbortSignal) => Promise<() => void>,
    fence: HostedAccountCommitFence = "session",
  ): Promise<HostedAccountOutcome> {
    // A refusal must always say why. Silently resolving leaves a surface whose
    // taps do nothing and whose state never explains it.
    if (hostedAccountStore.getState().actionStatus !== "idle") {
      patchAccountState(localErrorPatch(HOSTED_ACCOUNT_BUSY_MESSAGE));
      return refusedLocally("busy", HOSTED_ACCOUNT_BUSY_MESSAGE);
    }
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") {
      patchAccountState(localErrorPatch(HOSTED_ACCOUNT_SIGNED_OUT_MESSAGE));
      return refusedLocally("signed-out", HOSTED_ACCOUNT_SIGNED_OUT_MESSAGE);
    }
    const sessionId = state.session?.id ?? null;
    const accountId = state.account?.id ?? null;
    const operation = new AbortController();
    this.#accountOperation = operation;
    patchAccountState({ actionStatus: status, ...NO_ACCOUNT_ERROR });
    try {
      const commit = await run(operation.signal);
      const mayCommit =
        fence === "account"
          ? this.#isCurrentAccount(operation.signal, accountId)
          : this.#isCurrentAccountSession(operation.signal, sessionId);
      if (!mayCommit) {
        return refusedLocally(operation.signal.aborted ? "cancelled" : "superseded", null);
      }
      commit();
      // A concurrent caller refused by the busy guard above recorded its
      // message against an action that has now succeeded. Leaving it would show
      // a failure on an idle surface that did exactly what was asked.
      patchAccountState(NO_ACCOUNT_ERROR);
      return { status: "committed" };
    } catch (error) {
      if (operation.signal.aborted) return refusedLocally("cancelled", null);
      if (isSessionFailure(error)) {
        await this.#expireSessionHandled(error);
        return refused("session-expired", error);
      }
      if (!this.#isCurrentAccountSession(operation.signal, sessionId)) {
        return refused("superseded", error);
      }
      patchAccountState(accountErrorPatch(error));
      return refused("request-failed", error);
    } finally {
      if (this.#accountOperation === operation) {
        this.#accountOperation = null;
        if (hostedAccountStore.getState().actionStatus === status) {
          patchAccountState({ actionStatus: "idle" });
        }
      }
    }
  }

  /**
   * Fence an account-surface result: a result may only publish while the same
   * Hub session that issued the request is still the authenticated one.
   */
  #isCurrentAccountSession(signal: AbortSignal, sessionId: string | null): boolean {
    const active = hostedHubStore.getState();
    return (
      !signal.aborted &&
      active.accountStatus === "authenticated" &&
      (active.session?.id ?? null) === sessionId
    );
  }

  /**
   * The weaker fence: the same *account* is still signed in, whatever session
   * is now carrying it. See {@link HostedAccountCommitFence}.
   */
  #isCurrentAccount(signal: AbortSignal, accountId: string | null): boolean {
    const active = hostedHubStore.getState();
    return (
      !signal.aborted &&
      active.accountStatus === "authenticated" &&
      (active.account?.id ?? null) === accountId
    );
  }

  #clearAccountSurface(): void {
    this.#externalIdentityConfigurationGeneration += 1;
    this.#externalIdentityConfigurationOperation?.abort();
    this.#externalIdentityConfigurationOperation = null;
    this.#externalIdentityConfigurationPromise = null;
    this.#totpEnrollmentFence.bump();
    // The account is going away and `initialState` takes the codes with it, so
    // a rotation still in flight must not repopulate the slot behind the
    // teardown. Leases are left alone: they belong to whatever is mounted, and
    // a surface that is still on screen still holds one.
    this.#recoveryCodesFence.bump();
    this.#passkeysOperation?.abort();
    this.#passkeysOperation = null;
    this.#passkeysPromise = null;
    this.#e2eeDevicesOperation?.abort();
    this.#e2eeDevicesOperation = null;
    this.#e2eeDevicesPromise = null;
    this.#securityOperation?.abort();
    this.#securityOperation = null;
    this.#securityPromise = null;
    this.#accountOperation?.abort();
    this.#accountOperation = null;
    hostedAccountStore.setState(initialAccountState, true);
  }

  resetForTests(): void {
    this.#operation?.abort();
    this.#operation = null;
    this.#clearDirectoryTimer();
    this.#directoryRetry = 0;
    this.#directoryPresenceWatches.clear();
    this.#directoryOperation?.abort();
    this.#directoryOperation = null;
    this.#directoryPromise = null;
    this.#bootstrapPromise = null;
    this.#clearSessionSyncTimer();
    this.#retrySelectedNodeOperation?.abort();
    this.#retrySelectedNodeOperation = null;
    this.#retrySelectedNodePromise = null;
    this.#browserResumeOperation?.abort();
    this.#browserResumeOperation = null;
    this.#browserResumePromise = null;
    this.#browserSuspendPromise = null;
    this.#browserLifecycleGeneration += 1;
    this.#resetAccessRetry();
    this.#clearAccountSurface();
    // Leases are held by surfaces, not by the session, so only a full reset
    // drops them — otherwise a test's leftover lease would keep the next test's
    // rotation "displayed". Releases issued for the dropped leases stay safe:
    // each one can only remove its own token, which is already gone.
    this.#recoveryCodesLeases.clear();
    this.#publishRecoveryCodeDisplayLease();
    getHostedHubApi().clearSessionMaterial();
    hostedHubStore.setState(initialState, true);
  }

  async signOut(): Promise<void> {
    const operation = this.#replaceOperation();
    patchState({ accountStatus: "signing-out", errorMessage: null });
    try {
      await getHostedHubApi().signOut(operation.signal);
    } catch {
      if (operation.signal.aborted) return;
      // Remote revocation is best effort, but leaving this device must never be.
      // A Hub outage, CSRF-policy mismatch, or malformed response used to put
      // the controller back into `authenticated` and made the Sign out row a
      // dead end. Drop the local authority explicitly on every settled remote
      // failure; a DPoP-bound server session that could not be revoked is still
      // unusable once this device has discarded its bearer material.
      getHostedHubApi().clearSessionMaterial();
    } finally {
      if (this.#operation === operation) this.#operation = null;
    }
    await this.clearAccount("signed-out");
  }

  async expireSession(error?: unknown): Promise<void> {
    getHostedHubApi().clearSessionMaterial();
    await this.clearAccount("session-expired");
    if (error instanceof HostedHubApiError && error.reason !== null) {
      patchState(hostedErrorPatch(error));
    }
  }

  suspendBrowser(reason: "hidden" | "offline"): void {
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") return;
    this.#browserLifecycleGeneration += 1;
    this.#browserResumeOperation?.abort();
    this.#browserResumeOperation = null;
    this.#browserResumePromise = null;
    // The next resume is driven by the foreground/online signal that ends this
    // suspension, not by a retry armed for the access check it supersedes.
    this.#cancelAccessRetry();
    this.#retrySelectedNodeOperation?.abort();
    this.#clearSessionSyncTimer();
    this.#clearDirectoryTimer();
    this.#directoryOperation?.abort();
    this.#directoryOperation = null;
    this.#directoryPromise = null;
    patchState({
      browserStatus: reason === "offline" ? "offline" : "suspended",
      sessionStatus: state.sessionStatus === "delivery-unknown" ? "delivery-unknown" : "stale",
      sessionRecoveredAfterUnknown: false,
      generation: state.generation + 1,
    });
    if (state.selectedNode && !this.#browserSuspendPromise) {
      const environmentId = state.selectedNode.environmentId;
      const promise = suspendHostedNode(environmentId)
        .catch(() => undefined)
        .finally(() => {
          if (this.#browserSuspendPromise === promise) this.#browserSuspendPromise = null;
        });
      this.#browserSuspendPromise = promise;
    }
  }

  resumeBrowser(): Promise<void> {
    if (this.#browserResumePromise) return this.#browserResumePromise;
    const operation = new AbortController();
    this.#browserResumeOperation = operation;
    const promise = this.#resumeBrowser(operation).finally(() => {
      if (this.#browserResumePromise === promise) this.#browserResumePromise = null;
      if (this.#browserResumeOperation === operation) this.#browserResumeOperation = null;
    });
    this.#browserResumePromise = promise;
    return promise;
  }

  async #resumeBrowser(operation: AbortController): Promise<void> {
    const initial = hostedHubStore.getState();
    if (initial.accountStatus !== "authenticated") return;
    const browserGeneration = this.#browserLifecycleGeneration + 1;
    this.#browserLifecycleGeneration = browserGeneration;
    const expectedAccountId = initial.account?.id ?? null;
    patchState({ browserStatus: "checking-access", errorMessage: null });
    try {
      const restored = await getHostedHubApi().restoreSession(operation.signal);
      if (operation.signal.aborted || this.#browserLifecycleGeneration !== browserGeneration)
        return;
      const active = hostedHubStore.getState();
      if (active.accountStatus !== "authenticated" || restored.account.id !== expectedAccountId) {
        await this.expireSession();
        return;
      }
      this.#resetAccessRetry();
      patchState({ account: restored.account, session: restored.session });
      await this.refreshDirectory();
      if (this.#browserLifecycleGeneration !== browserGeneration) return;
      const refreshed = hostedHubStore.getState();
      if (refreshed.accountStatus !== "authenticated") return;
      if (refreshed.directoryStatus !== "ready") {
        patchState({ browserStatus: "stale" });
        return;
      }
      if (!refreshed.selectedNode) {
        patchState({ browserStatus: "current" });
        return;
      }
      patchState({ browserStatus: "synchronizing" });
      await this.#retrySelectedNode(operation.signal);
    } catch (error) {
      if (operation.signal.aborted || this.#browserLifecycleGeneration !== browserGeneration)
        return;
      if (isSessionFailure(error)) {
        await this.expireSession(error);
        return;
      }
      patchState({ browserStatus: "stale", ...hostedErrorPatch(error) });
      // Suspension already cleared the directory timer and this failure came
      // before `refreshDirectory`, so nothing else would ever resume a `stale`
      // browser short of another visibility/online event or a manual refresh.
      // The retry re-runs the whole resume, never a shortcut to `current`.
      this.#scheduleAccessRetry(error);
    }
  }

  async clearAccount(status: "signed-out" | "session-expired"): Promise<void> {
    this.#browserLifecycleGeneration += 1;
    this.#resetAccessRetry();
    this.#browserResumeOperation?.abort();
    this.#browserResumeOperation = null;
    this.#browserResumePromise = null;
    this.#retrySelectedNodeOperation?.abort();
    this.#retrySelectedNodeOperation = null;
    this.#retrySelectedNodePromise = null;
    this.#clearDirectoryTimer();
    this.#clearSessionSyncTimer();
    this.#directoryOperation?.abort();
    this.#directoryOperation = null;
    this.#directoryPromise = null;
    this.#operation?.abort();
    this.#operation = null;
    this.#clearAccountSurface();
    const previousEnvironmentId = hostedHubStore.getState().selectedNode?.environmentId ?? null;
    patchState({
      ...initialState,
      accountStatus: status,
      generation: hostedHubStore.getState().generation + 1,
    });
    if (previousEnvironmentId) {
      await deactivateHostedNode(previousEnvironmentId);
    }
  }

  refreshDirectory(): Promise<void> {
    if (this.#directoryPromise) return this.#directoryPromise;
    const operation = new AbortController();
    this.#directoryOperation = operation;
    const promise = this.#refreshDirectory(operation).finally(() => {
      if (this.#directoryOperation === operation) this.#directoryOperation = null;
      if (this.#directoryPromise === promise) this.#directoryPromise = null;
    });
    this.#directoryPromise = promise;
    return promise;
  }

  /**
   * Poll the node directory at {@link DIRECTORY_PRESENCE_REFRESH_MS} instead of
   * the 20s cadence for as long as the returned release has not been called.
   *
   * For a surface holding connection demand for a node the directory reports
   * offline: presence is only learned from this poll, so at the normal cadence
   * a node that came back could wait 20s to be seen. Watches are tokens, one
   * per caller, and the release is idempotent. The poll stays foreground-only
   * and a failure backoff is never shortened; a pending normal-cadence refresh
   * is pulled in when the first watch starts.
   */
  watchDirectoryPresence(): () => void {
    const watch = Symbol("hosted-directory-presence-watch");
    const first = this.#directoryPresenceWatches.size === 0;
    this.#directoryPresenceWatches.add(watch);
    if (first && this.#directoryTimer !== null && this.#directoryRetry === 0) {
      this.#scheduleDirectory(DIRECTORY_PRESENCE_REFRESH_MS);
    }
    return () => {
      this.#directoryPresenceWatches.delete(watch);
    };
  }

  async #refreshDirectory(operation: AbortController): Promise<void> {
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") return;
    const sessionId = state.session?.id ?? null;
    this.#clearDirectoryTimer();
    patchState({ directoryStatus: state.nodes.length === 0 ? "loading" : state.directoryStatus });
    try {
      const nodes = await getHostedHubApi().listNodes(operation.signal);
      const active = hostedHubStore.getState();
      if (
        operation.signal.aborted ||
        active.accountStatus !== "authenticated" ||
        active.session?.id !== sessionId
      ) {
        return;
      }
      this.#directoryRetry = 0;
      const current = hostedHubStore.getState();
      const resumeStaleBrowser = current.browserStatus === "stale";
      const selected = current.selectedNode;
      const refreshedSelection = selected
        ? (nodes.find(
            (node) => node.id === selected.id && node.environmentId === selected.environmentId,
          ) ?? null)
        : null;
      if (selected && (!refreshedSelection || refreshedSelection.revokedAt !== null)) {
        const generation = current.generation + 1;
        patchState({
          nodes,
          directoryStatus: "ready",
          selectionStatus:
            refreshedSelection && refreshedSelection.revokedAt !== null
              ? "revoked"
              : "authorization-removed",
          effectiveRole: null,
          generation,
        });
        await this.#deactivateSelection(selected.environmentId, generation);
      } else {
        patchState({
          nodes,
          directoryStatus: "ready",
          ...(refreshedSelection
            ? {
                selectedNode: refreshedSelection,
                selectionStatus: refreshedSelection.presence.online ? "online" : "offline",
                effectiveRole: refreshedSelection.effectiveRole,
              }
            : {}),
        });
      }
      this.#scheduleDirectory(
        this.#directoryPresenceWatches.size > 0
          ? DIRECTORY_PRESENCE_REFRESH_MS
          : DIRECTORY_REFRESH_MS,
      );
      if (resumeStaleBrowser) {
        getHostedRuntimeConfiguration().timers.queueMicrotask(() => {
          const recovered = hostedHubStore.getState();
          if (
            recovered.accountStatus === "authenticated" &&
            recovered.directoryStatus === "ready" &&
            recovered.browserStatus === "stale"
          ) {
            void this.resumeBrowser();
          }
        });
      }
    } catch (error) {
      if (operation.signal.aborted) return;
      if (isSessionFailure(error)) {
        await this.expireSession(error);
        return;
      }
      this.#directoryRetry += 1;
      patchState({
        directoryStatus: "stale",
        effectiveRole: null,
        ...hostedErrorPatch(error),
      });
      const delay = Math.min(
        DIRECTORY_RETRY_MAX_MS,
        1_000 * 2 ** Math.min(this.#directoryRetry, 6),
      );
      this.#scheduleDirectory(delay);
    }
  }

  async selectNode(nodeId: string): Promise<void> {
    const state = hostedHubStore.getState();
    if (state.directoryStatus !== "ready" || state.browserStatus !== "current") return;
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.revokedAt) return;
    if (
      state.selectedNode?.id === node.id &&
      state.selectedNode.environmentId === node.environmentId
    )
      return;
    const generation = state.generation + 1;
    patchState({
      selectedNode: node,
      selectionStatus: node.presence.online ? "online" : "offline",
      effectiveRole: node.effectiveRole,
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
      errorMessage: null,
      generation,
    });
    this.#startSessionSyncTimer(generation);
    try {
      await activateHostedNode(node, state.selectedNode?.environmentId ?? null);
    } catch {
      this.#failSessionSync(generation);
    }
  }

  /**
   * Deactivate the selected node and return to the node directory without
   * touching the Hub session. Used by history navigation (Back to the
   * directory) and by fail-closed route fallbacks. Follows the documented
   * switching-nodes teardown order via `deactivateHostedNode`; the generation
   * bump prevents stale relay attempts from publishing readiness or role.
   * `preserveTerminalSelection` keeps a terminal selection status (revoked,
   * authorization removed, incompatible) and its bounded message so the
   * directory renders the existing explanation.
   */
  async returnToDirectory(options?: {
    readonly preserveTerminalSelection?: boolean;
  }): Promise<void> {
    const state = hostedHubStore.getState();
    const node = state.selectedNode;
    if (!node) return;
    const preserve = options?.preserveTerminalSelection === true;
    // Mirror clearAccount: an in-flight browser resume belongs to the
    // selection being torn down. Abort it and invalidate its lifecycle
    // generation so it can neither publish stale state nor leave
    // browserStatus stuck in a node-scoped phase that would gate every
    // subsequent selection. A pending access retry is deliberately left armed:
    // it is account-scoped, a `stale` browser keeps `selectNode` closed until
    // a resume succeeds, and the retry re-checks the state and opens a fresh
    // lifecycle generation when it fires.
    this.#browserLifecycleGeneration += 1;
    this.#browserResumeOperation?.abort();
    this.#browserResumeOperation = null;
    this.#browserResumePromise = null;
    this.#retrySelectedNodeOperation?.abort();
    this.#retrySelectedNodeOperation = null;
    this.#retrySelectedNodePromise = null;
    this.#clearSessionSyncTimer();
    // A `synchronizing` resume had already revalidated the session and the
    // directory and was only waiting on the node's snapshot, so the directory
    // it returns to is current. A `checking-access` one had not: the browser
    // goes `stale` and a fresh resume, with no selection left to reconnect,
    // re-runs that check rather than handing back `current` unverified.
    const accessUnchecked = state.browserStatus === "checking-access";
    patchState({
      selectedNode: null,
      selectionStatus: preserve ? state.selectionStatus : "none",
      effectiveRole: null,
      transportStatus: "idle",
      sessionStatus: "closed",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
      browserStatus:
        state.browserStatus === "synchronizing"
          ? "current"
          : accessUnchecked
            ? "stale"
            : state.browserStatus,
      errorMessage: preserve ? state.errorMessage : null,
      errorReason: preserve ? (state.errorReason ?? null) : null,
      generation: state.generation + 1,
    });
    if (accessUnchecked) void this.resumeBrowser();
    await deactivateHostedNode(node.environmentId);
  }

  retrySelectedNode(): Promise<void> {
    if (this.#retrySelectedNodePromise) return this.#retrySelectedNodePromise;
    const operation = new AbortController();
    this.#retrySelectedNodeOperation = operation;
    const promise = this.#retrySelectedNode(operation.signal).finally(() => {
      if (this.#retrySelectedNodeOperation === operation) {
        this.#retrySelectedNodeOperation = null;
      }
      if (this.#retrySelectedNodePromise === promise) this.#retrySelectedNodePromise = null;
    });
    this.#retrySelectedNodePromise = promise;
    return promise;
  }

  async #retrySelectedNode(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.#browserSuspendPromise;
    if (signal.aborted) return;
    let state = hostedHubStore.getState();
    const node = state.selectedNode;
    if (
      !node ||
      node.revokedAt !== null ||
      state.accountStatus !== "authenticated" ||
      state.directoryStatus !== "ready"
    ) {
      return;
    }
    state = hostedHubStore.getState();
    if (
      signal.aborted ||
      state.selectedNode?.id !== node.id ||
      state.selectedNode.environmentId !== node.environmentId ||
      state.selectedNode.revokedAt !== null ||
      state.accountStatus !== "authenticated" ||
      state.directoryStatus !== "ready"
    ) {
      return;
    }
    const deliveryUnknown =
      state.sessionStatus === "delivery-unknown" ||
      getHostedRuntimeConfiguration().hasPendingRelayRequests();
    const generation = state.generation + 1;
    this.#clearSessionSyncTimer();
    patchState({
      selectionStatus: node.presence.online ? "online" : "offline",
      effectiveRole: node.effectiveRole,
      transportStatus: "idle",
      sessionStatus: deliveryUnknown ? "delivery-unknown" : "synchronizing",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
      errorMessage: null,
      generation,
    });
    this.#startSessionSyncTimer(generation);
    try {
      await activateHostedNode(node, node.environmentId, signal);
    } catch {
      if (signal.aborted) return;
      this.#failSessionSync(generation);
    }
  }

  transportStatus(generation: number, status: HostedRelayTransportStatus): void {
    if (hostedHubStore.getState().generation !== generation) return;
    patchState({ transportStatus: status });
  }

  sessionStatus(generation: number, status: HostedRycoSessionStatus): void {
    const state = hostedHubStore.getState();
    if (state.generation !== generation) return;
    if (state.sessionStatus === "delivery-unknown" && status !== "closed") {
      patchState({ sessionRecoveredAfterUnknown: false });
      return;
    }
    patchState({ sessionStatus: status, sessionRecoveredAfterUnknown: false });
  }

  role(generation: number, role: RelayEffectiveRole | null): void {
    const state = hostedHubStore.getState();
    if (state.generation !== generation) return;
    patchState({ effectiveRole: state.directoryStatus === "ready" ? role : null });
  }

  failure(generation: number, failure: HostedRelayFailure): void {
    const state = hostedHubStore.getState();
    if (state.generation !== generation) return;
    const selectionStatus: HostedSelectionStatus =
      failure.kind === "revoked"
        ? "revoked"
        : failure.kind === "authorization-removed"
          ? "authorization-removed"
          : failure.kind === "incompatible"
            ? "incompatible"
            : state.selectedNode?.presence.online
              ? state.selectionStatus
              : "offline";
    if (!failure.retryable) this.#clearSessionSyncTimer();
    patchState({
      selectionStatus,
      effectiveRole: failure.retryable ? state.effectiveRole : null,
      transportStatus: failure.retryable ? "reconnecting" : "terminal-failure",
      sessionStatus: state.sessionStatus === "delivery-unknown" ? "delivery-unknown" : "stale",
      browserStatus:
        !failure.retryable && state.browserStatus === "synchronizing"
          ? "current"
          : state.browserStatus,
      errorMessage: failureMessage(failure),
    });
  }

  markDeliveryUnknown(generation: number): void {
    if (hostedHubStore.getState().generation !== generation) return;
    patchState({ sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false });
  }

  connectionClosed(generation: number): void {
    const state = hostedHubStore.getState();
    if (state.generation !== generation || state.transportStatus === "terminal-failure") return;
    patchState({
      // Keep the directory-validated role while this retryable transport gap is
      // stale. Freshness still denies every mutation, but the shell and other
      // session-sync streams need the role in order to resubscribe and publish
      // the snapshot that makes the replacement session ready. Terminal
      // failures, directory staleness, revocation, and selection teardown all
      // clear authority through their existing fail-closed paths.
      transportStatus: "reconnecting",
      sessionStatus: state.sessionStatus === "delivery-unknown" ? "delivery-unknown" : "stale",
      sessionRecoveredAfterUnknown: false,
    });
  }

  markSessionReady(environmentId: EnvironmentId): void {
    const state = hostedHubStore.getState();
    if (state.selectedNode?.environmentId !== environmentId) return;
    this.#clearSessionSyncTimer();
    if (state.sessionStatus === "delivery-unknown") {
      patchState({
        sessionEstablished: true,
        sessionRecoveredAfterUnknown: true,
        browserStatus: state.browserStatus === "synchronizing" ? "current" : state.browserStatus,
      });
      return;
    }
    patchState({
      sessionStatus: "ready",
      sessionEstablished: true,
      sessionRecoveredAfterUnknown: false,
      browserStatus: state.browserStatus === "synchronizing" ? "current" : state.browserStatus,
    });
  }

  markSessionReplaying(environmentId: EnvironmentId): void {
    const state = hostedHubStore.getState();
    if (state.selectedNode?.environmentId !== environmentId) return;
    if (state.sessionStatus === "delivery-unknown") {
      patchState({ sessionRecoveredAfterUnknown: false });
      return;
    }
    patchState({
      sessionStatus: "replaying",
      browserStatus:
        state.browserStatus === "current" || state.browserStatus === "synchronizing"
          ? "synchronizing"
          : state.browserStatus,
    });
  }

  reportShellSnapshotFailure(environmentId: EnvironmentId): void {
    const state = hostedHubStore.getState();
    if (state.selectedNode?.environmentId !== environmentId) return;
    if (state.sessionEstablished) {
      console.warn("hosted_snapshot_reconciliation_failed");
      return;
    }
    this.#failSessionSync(state.generation);
  }

  acknowledgeDeliveryUnknown(): void {
    const state = hostedHubStore.getState();
    if (state.sessionStatus !== "delivery-unknown" || !state.sessionRecoveredAfterUnknown) return;
    patchState({ sessionStatus: "ready", sessionRecoveredAfterUnknown: false });
  }

  #replaceOperation(): AbortController {
    this.#operation?.abort();
    // A new account operation owns access from here; a timed retry armed for
    // the state it replaces must not fire into it.
    this.#cancelAccessRetry();
    const operation = new AbortController();
    this.#operation = operation;
    return operation;
  }

  /**
   * Arm the access-recovery backoff after a failed access check.
   *
   * Without it a failed check is retried only by the next lifecycle signal
   * (visibility, foreground, online). A Hub deploy, a timeout, or a DNS/TLS
   * failure while the OS still reports connectivity produces none of those, so
   * the surface stayed unavailable until the user found a manual repair. Only
   * transient failures are retried, the delay honors a Hub `retryAfterMs`, and
   * the retry re-enters through {@link recoverAfterConnectivity} after
   * re-checking the state it was armed for.
   */
  #scheduleAccessRetry(error: unknown): void {
    this.#cancelAccessRetry();
    if (!isTransientAccessFailure(error)) return;
    const delay = this.#accessRetryPolicy.nextDelay(
      error instanceof HostedHubApiError ? error.retryAfterMs : undefined,
    );
    this.#accessRetryTimer = getHostedRuntimeConfiguration().timers.setTimeout(() => {
      this.#accessRetryTimer = null;
      this.#runAccessRetry();
    }, delay);
  }

  #runAccessRetry(): void {
    if (!awaitsAccessRecovery(hostedHubStore.getState())) return;
    const runtime = getHostedRuntimeConfiguration();
    if (!runtime.isForeground()) {
      // A background surface retries on its next foreground, not on a timer.
      let release: (() => void) | null = null;
      const onForeground = () => {
        if (this.#accessRetryForeground !== release) return;
        this.#cancelAccessRetry();
        this.#runAccessRetry();
      };
      release = runtime.subscribeForeground(onForeground);
      this.#accessRetryForeground = release;
      return;
    }
    void this.recoverAfterConnectivity();
  }

  #cancelAccessRetry(): void {
    if (this.#accessRetryTimer)
      getHostedRuntimeConfiguration().timers.clearTimeout(this.#accessRetryTimer);
    this.#accessRetryTimer = null;
    const release = this.#accessRetryForeground;
    this.#accessRetryForeground = null;
    release?.();
  }

  /**
   * Drop any pending retry and start the backoff over. Called once the Hub has
   * answered with a session, and when the account it belonged to goes away.
   */
  #resetAccessRetry(): void {
    this.#cancelAccessRetry();
    this.#accessRetryPolicy.reset();
  }

  #scheduleDirectory(delay: number): void {
    this.#clearDirectoryTimer();
    const runtime = getHostedRuntimeConfiguration();
    if (!runtime.isForeground()) {
      const onVisibilityChange = () => {
        if (!runtime.isForeground()) return;
        this.#clearDirectoryTimer();
        void this.refreshDirectory();
      };
      runtime.subscribeForeground(onVisibilityChange);
      return;
    }
    this.#directoryTimer = runtime.timers.setTimeout(() => void this.refreshDirectory(), delay);
  }

  #clearDirectoryTimer(): void {
    if (this.#directoryTimer)
      getHostedRuntimeConfiguration().timers.clearTimeout(this.#directoryTimer);
    this.#directoryTimer = null;
  }

  #startSessionSyncTimer(generation: number): void {
    this.#clearSessionSyncTimer();
    const state = hostedHubStore.getState();
    if (state.generation !== generation || state.sessionEstablished) return;
    this.#sessionSyncTimer = getHostedRuntimeConfiguration().timers.setTimeout(
      () => this.#failSessionSync(generation),
      HOSTED_SESSION_SYNC_DEADLINE_MS,
    );
  }

  #clearSessionSyncTimer(): void {
    if (this.#sessionSyncTimer)
      getHostedRuntimeConfiguration().timers.clearTimeout(this.#sessionSyncTimer);
    this.#sessionSyncTimer = null;
  }

  #failSessionSync(generation: number): void {
    const state = hostedHubStore.getState();
    // Generation fence: a stale deadline whose callback already queued before
    // its timer was cleared must not terminal-fail a newer selection/session.
    if (state.generation !== generation || state.sessionEstablished) return;
    this.#clearSessionSyncTimer();
    patchState({
      transportStatus: "terminal-failure",
      sessionStatus: state.sessionStatus === "delivery-unknown" ? "delivery-unknown" : "stale",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
      browserStatus: state.browserStatus === "synchronizing" ? "current" : state.browserStatus,
      errorMessage: HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
    });
  }

  async #deactivateSelection(environmentId: EnvironmentId, generation: number): Promise<void> {
    this.#clearSessionSyncTimer();
    await deactivateHostedNode(environmentId);
    if (hostedHubStore.getState().generation !== generation) return;
    patchState({
      selectedNode: null,
      transportStatus: "idle",
      sessionStatus: "closed",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
    });
  }
}

function failureMessage(failure: HostedRelayFailure): string {
  switch (failure.kind) {
    case "offline":
      return "The selected node is offline. Ryco will reconnect when it becomes available.";
    case "revoked":
      return "Access to the selected node was revoked.";
    case "authorization-removed":
      return "Your authorization for the selected node was removed.";
    case "incompatible":
      return "The selected node uses an incompatible relay protocol version.";
    case "draining":
      return "Hub is draining connections. Ryco will retry shortly.";
    case "slow-consumer":
      return "The relay closed a slow connection. Ryco will reconnect.";
    case "authentication":
      return "The relay authentication attempt expired or was rejected.";
    case "rate-limited":
      return "Relay attempts are temporarily rate limited.";
    default:
      return failure.retryable
        ? "The relay connection was interrupted. Ryco is reconnecting."
        : "The relay connection could not be established.";
  }
}

export const hostedHubController = new HostedHubController();

export function markHostedSessionReady(environmentId: EnvironmentId, generation: number): void {
  if (hostedHubStore.getState().generation !== generation) return;
  hostedHubController.markSessionReady(environmentId);
}

export function markHostedSessionReplaying(environmentId: EnvironmentId, generation: number): void {
  if (hostedHubStore.getState().generation !== generation) return;
  hostedHubController.markSessionReplaying(environmentId);
}

export function reportHostedShellSnapshotFailure(
  environmentId: EnvironmentId,
  generation: number,
): void {
  if (hostedHubStore.getState().generation !== generation) return;
  hostedHubController.reportShellSnapshotFailure(environmentId);
}
