import type { EnvironmentId, RelayEffectiveRole } from "@ryco/contracts";
import type * as HostedIdentity from "@ryco/contracts/hosted-identity";
import type * as NativeE2ee from "@ryco/contracts/native-e2ee";

import { HostedReconnectPolicy } from "../relay/reconnectPolicy.ts";
import { HostedHubApiError, type HostedAccountStepUp, type HostedHubFailureReason } from "./api.ts";
import {
  activateHostedNode,
  connectHostedEnvironment,
  deactivateHostedNode,
  releaseHostedEnvironment,
  requestHostedEnvironmentReconcile,
  retainedHostedNodeLifecycle,
  setActiveHostedEnvironment,
  suspendHostedEnvironment,
  suspendHostedNode,
} from "./environment.ts";
import {
  canAdoptHostedEnvironmentSession,
  getHostedEnvironmentSessions,
  HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS,
  hostedBrowserRevalidated,
  isHostedEnvironmentConnectBlocked,
  isJoinableHostedEnvironmentSession,
  selectedProjectionFields,
  type HostedEnvironmentSessions,
} from "./hostedEnvironmentSessions.ts";
import { getHostedDispatchReplay } from "../relay/dispatchReplay.ts";
import { NativeHandoffClientError } from "./nativeHandoff.ts";
import {
  getHostedHubApi,
  getHostedRuntimeConfiguration,
  hostedEnvironmentSessionsMode,
} from "./runtime.ts";
import {
  createHostedStore,
  INITIAL_HOSTED_ACCOUNT_STATE,
  INITIAL_HOSTED_HUB_STATE,
  INITIAL_HOSTED_RECOVERY_CODE_DISPLAY_STATE,
} from "./hostedStores.ts";
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
  /**
   * Whether the runtime re-runs a failed access check on its own — on its
   * backoff timer, or on the next foreground when it came due in the
   * background — so a surface may promise that it "keeps trying". `false` for
   * a definite Hub answer, which only a lifecycle signal or the user re-checks.
   * Published with every `unavailable` account and `stale` browser; it means
   * nothing alongside any other status. Optional for the same fixture reason
   * as `totpEnrollment`.
   */
  readonly accessRecoveryPending?: boolean;
  readonly generation: number;
}

const initialState = INITIAL_HOSTED_HUB_STATE;

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

const initialAccountState = INITIAL_HOSTED_ACCOUNT_STATE;

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

export const hostedRecoveryCodeDisplayStore = createHostedStore(
  INITIAL_HOSTED_RECOVERY_CODE_DISPLAY_STATE,
);

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
 * Exported for platform work deferred until such a recovery has landed.
 */
export function hostedAccessAwaitsRecovery(
  state: Pick<HostedHubState, "accountStatus" | "browserStatus">,
): boolean {
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

/** A one-shot completion signal: the first `settle` resolves it, later ones do nothing. */
function settledSignal(): { readonly promise: Promise<void>; readonly settle: () => void } {
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** Structural equality over the plain JSON-shaped values the Hub directory decodes to. */
function sameDirectoryValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (
      !sameDirectoryValue(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      )
    )
      return false;
  }
  return true;
}

/**
 * The directory read, with every node that did not change kept as the object
 * already published — and the whole previous array when none did.
 *
 * A directory poll, a push invalidation and the reconnect re-read usually
 * return what the store already holds. Publishing fresh objects for them fails
 * every identity check downstream (selectors, the read cache, the workspace
 * catalog) and re-renders each `nodes` consumer for no change.
 */
function reconcileDirectoryNodes(
  previous: ReadonlyArray<HostedHubNode>,
  next: ReadonlyArray<HostedHubNode>,
): ReadonlyArray<HostedHubNode> {
  let changed = previous.length !== next.length;
  const reconciled = next.map((node, index) => {
    const candidate =
      previous[index]?.id === node.id
        ? previous[index]
        : previous.find((entry) => entry.id === node.id);
    if (candidate !== undefined && sameDirectoryValue(candidate, node)) {
      if (candidate !== previous[index]) changed = true;
      return candidate;
    }
    changed = true;
    return node;
  });
  return changed ? reconciled : previous;
}

/**
 * A directory read sent beside a session restore.
 *
 * Both requests carry the same credential — the ambient cookie, or the stored
 * DPoP-bound token with a proof of its own — and the read needs nothing from
 * the restore's answer, so overlapping them takes a Hub round trip off every
 * cold start and resume. In bearer mode this relies on the Hub never rotating
 * the token on `GET /api/auth/session` (it answers the account and session
 * only); a read failing on a token the restore did rotate would still be
 * non-authoritative below, and a bearer `401` on this read clears nothing. Its answer is held, never published by itself: only
 * after the restore has validated the session does `#refreshDirectory` commit
 * it, under the same session fence an ordinary read has. `null` — the read
 * failed, was abandoned, or answered for a check that was replaced — is never
 * authoritative (a `401` beside a restore that rotated the session says nothing
 * about the new one), so the ordinary read runs instead.
 */
interface HostedDirectoryPrefetch {
  readonly nodes: Promise<ReadonlyArray<HostedHubNode> | null>;
  readonly abandon: () => void;
}

function prefetchHostedDirectory(signal: AbortSignal): HostedDirectoryPrefetch {
  const read = new AbortController();
  const abandon = () => read.abort();
  if (signal.aborted) abandon();
  else signal.addEventListener("abort", abandon, { once: true });
  // The default request deadline, not the access check's short one: no gate
  // waits on the directory (see `bootstrapAccess`), and a held read cut short
  // would only be replaced by a second, full-length read of the same thing.
  const nodes = getHostedHubApi()
    .listNodes(read.signal)
    .then(
      (result) => (read.signal.aborted ? null : result),
      () => null,
    )
    .finally(() => signal.removeEventListener("abort", abandon));
  return { nodes, abandon };
}

export const DIRECTORY_REFRESH_MS = 20_000;
export const DIRECTORY_SUBSCRIBED_REFRESH_MS = 120_000;
/** Directory cadence while a surface waits for an offline node to come back. */
export const DIRECTORY_PRESENCE_REFRESH_MS = 5_000;
/**
 * How long one presence watch keeps the faster cadence. A node that is back
 * within minutes is seen within seconds; one shut down for the weekend is
 * polled at the normal cadence after this rather than at 4x for days.
 */
export const DIRECTORY_PRESENCE_WINDOW_MS = 5 * 60_000;
const DIRECTORY_RETRY_MAX_MS = 60_000;

/** One token per surface showing node presence; see {@link retainHostedDirectoryPresenceDemand}. */
const directoryPresenceDemand = new Set<symbol>();
/** Set by the controller; called when presence demand starts or ends. */
let directoryPresenceDemandChanged: () => void = () => undefined;

/**
 * Hold directory presence demand until the returned release is called.
 *
 * For a client that opts into `demandDrivenDirectoryRefresh`: without a live
 * account subscription the directory is polled at {@link DIRECTORY_REFRESH_MS}
 * only while a surface showing node presence holds demand, and at
 * {@link DIRECTORY_SUBSCRIBED_REFRESH_MS} otherwise. Demand is a token per
 * caller and the release is idempotent. When demand starts, a pending poll is
 * moved to the normal cadence after the last read (or runs now when that read
 * is already older); when it ends, the poll moves to the backstop after the
 * last read. A client that did not opt in keeps the normal cadence regardless.
 */
export function retainHostedDirectoryPresenceDemand(): () => void {
  const token = Symbol("hosted-directory-presence-demand");
  directoryPresenceDemand.add(token);
  if (directoryPresenceDemand.size === 1) directoryPresenceDemandChanged();
  return () => {
    if (!directoryPresenceDemand.delete(token)) return;
    if (directoryPresenceDemand.size === 0) directoryPresenceDemandChanged();
  };
}

/** The selected session's synchronization deadline; every environment session has the same one. */
export const HOSTED_SESSION_SYNC_DEADLINE_MS = HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS;
/**
 * The bound on a cookie-mode access check (the session restore) while
 * nothing has timed out yet.
 *
 * A boot gate and a foreground resume both wait on that check, and on a
 * black-holed network (dead Wi-Fi, a captive portal that never answers) the
 * default 30-second request deadline held them on a loading surface for that
 * long. A check that times out under it reaches the access-retry path in
 * seconds; the retries that follow use the full deadline, so a slow but
 * working link still gets through on the next attempt.
 *
 * Bearer mode bounds the *decision*, not the request: a restore there may
 * rotate the only copy of the token, and abandoning its answer could strand
 * the session. Its request keeps the full deadline, and a check still
 * unanswered at this bound publishes the account `unavailable` with the access
 * retry armed, exactly as a timeout would, while the answer is still adopted
 * if it arrives; see `#armAccessDecisionDeadline`.
 */
export const HOSTED_ACCESS_CHECK_DEADLINE_MS = 8_000;
/**
 * At most one relay-triggered session revalidation per session in this window (see
 * `HostedHubController.revalidateSession`). A refusal that keeps recurring under a session the
 * Hub still accepts is then retried on the relay transport's own backoff, not at round-trip speed.
 */
export const HOSTED_SESSION_REVALIDATION_INTERVAL_MS = 30_000;
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

/** How {@link HostedHubController.acquireEnvironment} answered. */
export type HostedEnvironmentAcquisition = "adopted" | "joined" | "connecting" | "refused";

/** The fields of `patch` whose values differ from `state`. */
function changedFields(
  state: HostedHubState,
  patch: Partial<HostedHubState>,
): Partial<HostedHubState> {
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) => !Object.is(state[key as keyof HostedHubState], value),
    ),
  ) as Partial<HostedHubState>;
}

/**
 * The shared fields that leave the selection: nothing is selected, connected
 * or established any more. A `synchronizing` browser had already revalidated
 * the session and the directory and was only waiting on the selected node's
 * snapshot, so the directory it returns to is current.
 */
function clearedSelection(
  state: HostedHubState,
  kept: Pick<HostedHubState, "selectionStatus" | "errorMessage"> & {
    readonly errorReason: HostedHubFailureReason | null;
  },
): Partial<HostedHubState> {
  return {
    selectedNode: null,
    selectionStatus: kept.selectionStatus,
    effectiveRole: null,
    transportStatus: "idle",
    sessionStatus: "closed",
    sessionEstablished: false,
    sessionRecoveredAfterUnknown: false,
    browserStatus: state.browserStatus === "synchronizing" ? "current" : state.browserStatus,
    errorMessage: kept.errorMessage,
    errorReason: kept.errorReason,
    generation: state.generation + 1,
  };
}

/**
 * Whether this client may not connect to the node at all: a node that requires
 * a native client is locked for the browser, whose session is its ambient
 * cookie.
 */
function lockedForThisClient(node: HostedHubNode): boolean {
  return (
    node.capabilities?.nativeClientRequired === true &&
    getHostedHubApi().credentialMode === "cookie"
  );
}

/** The application's environment session registry when sessions are retained. */
function retainedEnvironmentSessions(): HostedEnvironmentSessions | null {
  return hostedEnvironmentSessionsMode() === "retained" ? getHostedEnvironmentSessions() : null;
}

class HostedHubController {
  #operation: AbortController | null = null;
  #directoryTimer: ReturnType<typeof setTimeout> | null = null;
  #directoryForeground: (() => void) | null = null;
  #directoryInvalidationFollowup: Promise<void> | null = null;
  #directoryRetry = 0;
  /**
   * One token per surface waiting on node presence, mapped to when it started;
   * see `watchDirectoryPresence`.
   */
  #directoryPresenceWatches = new Map<symbol, number>();
  /** When the last directory read succeeded, on the runtime clock. */
  #directoryRefreshedAt: number | null = null;
  #directoryOperation: AbortController | null = null;
  #directoryPromise: Promise<void> | null = null;
  #bootstrapPromise: Promise<void> | null = null;
  /** Settles once the access check behind `#bootstrapPromise` has published its answer. */
  #bootstrapAccessPromise: Promise<void> | null = null;
  /**
   * An access check timed out under {@link HOSTED_ACCESS_CHECK_DEADLINE_MS};
   * the next ones use the full request deadline until the Hub answers again.
   */
  #accessCheckTimedOut = false;
  #sessionSyncTimer: ReturnType<typeof setTimeout> | null = null;
  #retrySelectedNodeOperation: AbortController | null = null;
  /**
   * The generation whose relay channel closed unintentionally and has not yet
   * been replaced. While it is current, no shell snapshot may make the session
   * ready: a snapshot can only belong to the lost channel.
   */
  #relayGapGeneration: number | null = null;
  /** The plain bootstrap access check still waiting for its answer; see {@link accessCheckPending}. */
  #accessCheckOperation: AbortController | null = null;
  #retrySelectedNodePromise: Promise<void> | null = null;
  #browserResumeOperation: AbortController | null = null;
  #browserResumePromise: Promise<void> | null = null;
  #browserSuspendPromise: Promise<void> | null = null;
  #browserLifecycleGeneration = 0;
  /** The last relay-triggered session revalidation, for {@link HOSTED_SESSION_REVALIDATION_INTERVAL_MS}. */
  #sessionRevalidation: {
    readonly sessionId: string;
    readonly until: number;
    readonly promise: Promise<void>;
  } | null = null;
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
  /**
   * Retained mode's projection of the selected record onto the shared state,
   * installed on first retained use; see {@link #projectionPatch}.
   */
  #projection: {
    readonly sessions: HostedEnvironmentSessions;
    readonly unsubscribe: () => void;
  } | null = null;
  #projecting = false;
  #projectAgain = false;
  #projectionPaused = 0;
  /**
   * The session error the projection last published, so a message another
   * writer published since (a directory or access failure) stays until the
   * selected record's own error changes.
   */
  #projectedError: {
    readonly environmentId: EnvironmentId;
    readonly message: string | null;
  } | null = null;
  /** Environments whose fresh record {@link acquireEnvironment} is publishing right now. */
  #startingEnvironments = new Set<EnvironmentId>();
  /**
   * Nodes whose last acquisition was refused for a cause that passes — no
   * account authenticated yet, the browser not revalidated, the directory not
   * current (its first load included, before any node is known), or a
   * generation replaced during the call — with the account they were refused
   * for, `null` before one authenticated. Keyed by the node id the acquisition
   * named, since the directory may not know the node yet. The platform's demand
   * executor holds a refused environment back, so the next recovery asks it to
   * re-plan each one; see {@link #replanRefusedEnvironments}.
   */
  #refusedUntilRecovery = new Map<string, string | null>();
  /** Each record's readiness as last observed, so the dispatch replay hears every ready edge once. */
  #recordReadiness = new Map<
    EnvironmentId,
    { readonly generation: number; readonly ready: boolean }
  >();

  constructor() {
    // The application's one controller hears presence demand edges.
    directoryPresenceDemandChanged = () => this.#directoryDemandChanged();
  }

  bootstrap(): Promise<void> {
    if (this.#bootstrapPromise) return this.#bootstrapPromise;
    // A platform that opted into retained sessions without their lifecycle
    // ports learns it here, at first use and before anything changed, rather
    // than from an access check or directory read reporting a Hub failure.
    this.#retainedSessions();
    const operation = this.#replaceOperation();
    const access = settledSignal();
    this.#accessCheckOperation = operation;
    const settle = () => {
      if (this.#accessCheckOperation === operation) this.#accessCheckOperation = null;
      access.settle();
    };
    const promise = this.#restoreAccess(operation, settle).finally(() => {
      settle();
      if (this.#operation === operation) this.#operation = null;
      if (this.#bootstrapPromise === promise) this.#bootstrapPromise = null;
      if (this.#bootstrapAccessPromise === access.promise) this.#bootstrapAccessPromise = null;
    });
    this.#bootstrapPromise = promise;
    this.#bootstrapAccessPromise = access.promise;
    return promise;
  }

  /**
   * Whether a {@link bootstrap} access check is in flight and has not answered
   * yet. Display-only readers use it to send a read beside the check and hold
   * the answer until the session validates. A credential adoption is not such
   * a check: reads sent during it could carry the credential being replaced.
   */
  accessCheckPending(): boolean {
    return this.#accessCheckOperation !== null && !this.#accessCheckOperation.signal.aborted;
  }

  /**
   * Start or join {@link bootstrap}, but settle as soon as its access check has
   * published an answer — the account `authenticated`, signed out, or
   * `unavailable` — rather than after the directory read that follows.
   *
   * For a boot gate: the directory has its own `loading` and `stale` states, so
   * a gate that waited for it held the whole app on a loading surface for as
   * long as `/api/nodes` took (or stalled). The read itself is unchanged and
   * still owned here.
   */
  bootstrapAccess(): Promise<void> {
    const settled = this.bootstrap();
    return this.#bootstrapAccessPromise ?? settled;
  }

  /**
   * Adopt a session credential committed outside this controller, then
   * re-check access with it.
   *
   * The native identity ceremonies (password, email, recovery code, and the
   * completion journal that survives a restart) mint their credential through
   * the API directly and commit it to the platform store themselves, and a
   * browser recovery-code sign-in has the Hub commit it as a cookie with its
   * answer (see {@link signInWithRecoveryCode}). While
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
    // A new credential starts its backoff over. The published pending flag is
    // left alone: a check is still coming, and its outcome replaces it.
    this.#accessRetryPolicy.reset();
    this.#accessCheckTimedOut = false;
    let committed = false;
    const access = settledSignal();
    const promise = commit()
      .catch(() => false)
      .then((result) => {
        committed = result;
        if (operation.signal.aborted) return undefined;
        return this.#restoreAccess(operation, access.settle);
      })
      .finally(() => {
        access.settle();
        if (this.#operation === operation) this.#operation = null;
        if (this.#bootstrapPromise === promise) this.#bootstrapPromise = null;
        if (this.#bootstrapAccessPromise === access.promise) this.#bootstrapAccessPromise = null;
      });
    this.#bootstrapPromise = promise;
    this.#bootstrapAccessPromise = access.promise;
    return promise.then(() => committed);
  }

  /**
   * Sign in with a single-use recovery code on the browser transport.
   *
   * The Hub commits the new session with its answer, so the sign-in itself is
   * the commit an adoption fences. While the account is `unavailable` the
   * access-recovery backoff routinely has a check of the replaced session in
   * flight, and joining it after the sign-in let its `401` clear the new
   * session and publish `signed-out` for a code already spent. Running the
   * sign-in inside {@link adoptSessionCredential} aborts that check before the
   * code is sent, so its answer publishes nothing, and access is re-checked
   * with the new session afterwards.
   *
   * Rejects with the sign-in's own failure, once access has been re-checked,
   * for the form to show.
   */
  async signInWithRecoveryCode(code: string): Promise<void> {
    let signInFailure: unknown = null;
    const signedIn = await this.adoptSessionCredential(async () => {
      try {
        await getHostedHubApi().signInWithRecoveryCode(code);
        return true;
      } catch (error) {
        signInFailure = error;
        return false;
      }
    });
    if (!signedIn) throw signInFailure;
  }

  /**
   * The access check behind {@link bootstrap} and {@link adoptSessionCredential}.
   *
   * `accessSettled` runs once the account answer is published, before the
   * directory read that follows it; see {@link bootstrapAccess}.
   */
  #restoreAccess(operation: AbortController, accessSettled?: () => void): Promise<void> {
    // Missing retained lifecycle ports fail a credential adoption here too.
    this.#retainedSessions();
    const options = this.#accessCheckOptions();
    // The session request goes out first; the directory read rides beside it.
    const restored = getHostedHubApi().restoreSession(operation.signal, options);
    const check = { directory: this.#prefetchDirectory(operation.signal) };
    const cancelDecisionDeadline = this.#armAccessDecisionDeadline(operation, accessSettled);
    return restored
      .then(async (result) => {
        cancelDecisionDeadline();
        // An answer for a check that a newer account operation replaced is
        // about the credential that check was sent with, not the current one.
        if (operation.signal.aborted) {
          check.directory?.abandon();
          return;
        }
        this.#accessCheckTimedOut = false;
        this.#resetAccessRetry();
        patchState({
          accountStatus: "authenticated",
          account: result.account,
          session: result.session,
          errorMessage: null,
        });
        accessSettled?.();
        await this.#refreshDirectoryWith(check.directory);
      })
      .catch((error) => {
        cancelDecisionDeadline();
        check.directory?.abandon();
        if (operation.signal.aborted) return undefined;
        this.#noteAccessCheckFailure(error);
        if (isSessionFailure(error)) {
          // Only the Hub's own answer that this session is gone ends it.
          getHostedHubApi().clearSessionMaterial();
          // A boot gate waits for this answer too, so it gets the access
          // check's short bound — in bearer mode as well, whose decision
          // deadline the session answer just cancelled — and a stalled probe
          // falls back to sign-in. A link that has already timed out once gets
          // the full deadline, as the access check itself does, so an unclaimed
          // Hub on a slow link still offers its owner bootstrap.
          return getHostedHubApi()
            .getBootstrapAvailability(
              operation.signal,
              this.#accessCheckTimedOut
                ? undefined
                : { deadlineMs: HOSTED_ACCESS_CHECK_DEADLINE_MS },
            )
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
        this.#publishAccessUnavailable(error);
        return undefined;
      });
  }

  /** The account answer for a check that reached no session verdict; arms the access retry. */
  #publishAccessUnavailable(error: unknown): void {
    const retrying = this.#scheduleAccessRetry(error);
    patchState({
      ...initialState,
      accountStatus: "unavailable",
      ...hostedErrorPatch(error),
      accessRecoveryPending: retrying,
    });
  }

  /**
   * Bearer mode's bound on how long an access check may leave the account
   * undecided; returns the cancel for its timer.
   *
   * The restore request keeps the full deadline (see
   * {@link HOSTED_ACCESS_CHECK_DEADLINE_MS}), so a launch on a stalled network
   * would otherwise sit at "checking" for the whole of it before the account
   * became `unavailable` and the retry backoff started. At this bound the
   * account is published `unavailable` with the retry armed, as a timeout
   * would publish it, and the boot gate waiting on the answer is released. The
   * request is NOT abandoned: its answer is still the authority, a rotated
   * token in it is still persisted by the API, a late session publishes
   * `authenticated`, and a late `401` still signs out. A retry or lifecycle
   * signal that fires meanwhile joins this check through {@link bootstrap}
   * instead of sending a second restore with a token the first may be
   * rotating. Like the cookie bound, it applies until a check has timed out.
   */
  #armAccessDecisionDeadline(operation: AbortController, accessSettled?: () => void): () => void {
    if (getHostedHubApi().credentialMode !== "bearer" || this.#accessCheckTimedOut) {
      return () => undefined;
    }
    const timers = getHostedRuntimeConfiguration().timers;
    const timer = timers.setTimeout(() => {
      if (operation.signal.aborted) return;
      this.#accessCheckTimedOut = true;
      this.#publishAccessUnavailable(
        new HostedHubApiError("timeout", 0, undefined, undefined, undefined, "request-timeout"),
      );
      accessSettled?.();
    }, HOSTED_ACCESS_CHECK_DEADLINE_MS);
    return () => timers.clearTimeout(timer);
  }

  /**
   * The request bound for one access check: in cookie mode the short
   * {@link HOSTED_ACCESS_CHECK_DEADLINE_MS} until a check has timed out, and
   * otherwise the default deadline.
   */
  #accessCheckOptions(): { readonly deadlineMs: number } | undefined {
    if (getHostedHubApi().credentialMode !== "cookie" || this.#accessCheckTimedOut) {
      return undefined;
    }
    return { deadlineMs: HOSTED_ACCESS_CHECK_DEADLINE_MS };
  }

  /** The directory read sent beside an access check; see {@link HostedDirectoryPrefetch}. */
  #prefetchDirectory(signal: AbortSignal): HostedDirectoryPrefetch {
    return prefetchHostedDirectory(signal);
  }

  #noteAccessCheckFailure(error: unknown): void {
    if (error instanceof HostedHubApiError && error.code === "timeout") {
      this.#accessCheckTimedOut = true;
    }
  }

  /**
   * Re-establish hosted access after a foreground or connectivity signal.
   *
   * The one entry point every platform lifecycle binding forwards those signals
   * to, so what "recovery" means stays with this owner rather than being
   * re-derived per app: an account whose access check could not reach the Hub
   * re-runs {@link bootstrap}, and a suspended or unhealthy authenticated
   * account runs {@link resumeBrowser} (session, directory, fresh relay attempt,
   * current snapshot). A foreground signal does not replace a healthy live
   * connection or interrupt the initial synchronization. The access-recovery
   * backoff re-enters here too, so a timed retry
   * can never publish anything the ordinary resume would not. Every other
   * status has nothing a connectivity change can repair.
   */
  recoverAfterConnectivity(): Promise<void> {
    const state = hostedHubStore.getState();
    if (state.accountStatus === "unavailable") return this.bootstrap();
    if (state.accountStatus === "authenticated" && this.#retainedSessions()) {
      // Every environment's transport recovers on its own and the platform
      // re-plans the connections, so only a browser whose access is not
      // revalidated needs the resume. A slow or offline selection must not
      // re-check access, and pause every other environment's admission, on
      // each signal.
      return state.directoryStatus === "ready" && this.#browserRevalidated(state)
        ? Promise.resolve()
        : this.resumeBrowser();
    }
    if (state.accountStatus === "authenticated") {
      const healthy =
        state.directoryStatus === "ready" &&
        (state.browserStatus === "current" || state.browserStatus === "synchronizing") &&
        (state.selectedNode === null ||
          (state.selectedNode.presence.online &&
            state.transportStatus !== "idle" &&
            state.transportStatus !== "reconnecting" &&
            state.transportStatus !== "draining" &&
            state.transportStatus !== "terminal-failure" &&
            (state.sessionStatus === "ready" || state.sessionStatus === "synchronizing")));
      return healthy ? Promise.resolve() : this.resumeBrowser();
    }
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
        activeSpaceId: identity.session.activeSpaceId,
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
   * change, so stale generations cannot retain read or mutation readiness. It covers every
   * environment session: with retained sessions each one takes a fresh generation and loses its
   * role and session before this returns, selected or not.
   */
  invalidateNativeE2eeAuthorization(): void {
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") return;
    getHostedRuntimeConfiguration().resetRelayAttemptFactory();
    const withdrawn: Partial<HostedHubState> = {
      generation: state.generation + 1,
      effectiveRole: null,
      transportStatus: "reconnecting",
      sessionStatus: "closed",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
    };
    const sessions = this.#retainedSessions();
    if (sessions) {
      this.#pauseProjection(() => sessions.withdrawAll());
      this.#publishProjected(sessions, withdrawn);
      return;
    }
    patchState(withdrawn);
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
    // Demand lives at module scope beside the one controller: a test's leftover
    // token must not change the next test's cadence.
    directoryPresenceDemand.clear();
    this.#directoryRefreshedAt = null;
    this.#directoryOperation?.abort();
    this.#directoryOperation = null;
    this.#directoryPromise = null;
    this.#directoryInvalidationFollowup = null;
    this.#bootstrapPromise = null;
    this.#bootstrapAccessPromise = null;
    this.#accessCheckTimedOut = false;
    this.#clearSessionSyncTimer();
    this.#relayGapGeneration = null;
    this.#retrySelectedNodeOperation?.abort();
    this.#retrySelectedNodeOperation = null;
    this.#retrySelectedNodePromise = null;
    this.#browserResumeOperation?.abort();
    this.#browserResumeOperation = null;
    this.#browserResumePromise = null;
    this.#browserSuspendPromise = null;
    this.#browserLifecycleGeneration += 1;
    this.#sessionRevalidation = null;
    this.#resetAccessRetry();
    this.#clearAccountSurface();
    // Leases are held by surfaces, not by the session, so only a full reset
    // drops them — otherwise a test's leftover lease would keep the next test's
    // rotation "displayed". Releases issued for the dropped leases stay safe:
    // each one can only remove its own token, which is already gone.
    this.#recoveryCodesLeases.clear();
    this.#publishRecoveryCodeDisplayLease();
    this.#projection?.unsubscribe();
    this.#projection = null;
    this.#projecting = false;
    this.#projectAgain = false;
    this.#projectionPaused = 0;
    this.#projectedError = null;
    this.#recordReadiness.clear();
    this.#startingEnvironments.clear();
    this.#refusedUntilRecovery.clear();
    getHostedDispatchReplay().resetForTests();
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
    // Only onto the expired session's own surface: a newer session that signed
    // in while the teardown ran is not this error's to explain.
    if (
      error instanceof HostedHubApiError &&
      error.reason !== null &&
      hostedHubStore.getState().accountStatus === "session-expired"
    ) {
      patchState(hostedErrorPatch(error));
    }
  }

  /**
   * A path the Hub authenticates itself refused this session, or named another identity for it:
   * a server-authenticated relay channel closed with `authentication_failed` (the counterpart of
   * an HTTP ticket request's 401), or the account socket's `ready` named another account or
   * session.
   *
   * Asks the Hub who this cookie is, at most once per
   * {@link HOSTED_SESSION_REVALIDATION_INTERVAL_MS} per session, so a refusal that is not really
   * about the session cannot loop. A dead session expires, exactly as after a 401. A different
   * account expires this one. A different session of the same account runs the full
   * {@link resumeBrowser}. An unchanged session changes nothing: no new generation, no forced
   * reconnect, so the relay transport keeps its own backoff. A transient failure is left to that
   * backoff as well.
   */
  revalidateSession(): Promise<void> {
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated" || !state.account || !state.session) {
      return Promise.resolve();
    }
    const now = getHostedRuntimeConfiguration().timers.now();
    const last = this.#sessionRevalidation;
    if (last !== null && last.sessionId === state.session.id && now < last.until) {
      return last.promise;
    }
    const promise = this.#revalidateSession(
      state.account.id,
      state.session.id,
      this.#browserLifecycleGeneration,
    );
    this.#sessionRevalidation = {
      sessionId: state.session.id,
      until: now + HOSTED_SESSION_REVALIDATION_INTERVAL_MS,
      promise,
    };
    return promise;
  }

  async #revalidateSession(
    accountId: string,
    sessionId: string,
    browserGeneration: number,
  ): Promise<void> {
    const stillCurrent = () => {
      const current = hostedHubStore.getState();
      return (
        this.#browserLifecycleGeneration === browserGeneration &&
        current.accountStatus === "authenticated" &&
        current.session?.id === sessionId
      );
    };
    try {
      const restored = await getHostedHubApi().restoreSession(
        undefined,
        this.#accessCheckOptions(),
      );
      if (!stillCurrent()) return;
      if (restored.account.id !== accountId) {
        await this.expireSession();
        return;
      }
      if (restored.session.id !== sessionId) await this.resumeBrowser();
    } catch (error) {
      if (stillCurrent() && isSessionFailure(error)) await this.expireSession(error);
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
    this.#directoryInvalidationFollowup = null;
    const suspension: Partial<HostedHubState> = {
      browserStatus: reason === "offline" ? "offline" : "suspended",
      sessionStatus: state.sessionStatus === "delivery-unknown" ? "delivery-unknown" : "stale",
      sessionRecoveredAfterUnknown: false,
      generation: state.generation + 1,
    };
    const sessions = this.#retainedSessions();
    if (sessions) {
      // Every environment session is suspended, not only the selected one. One
      // an earlier suspension already reached (hidden, then offline) keeps its
      // generation, and its transport is not suspended a second time.
      this.#suspendRetained(sessions, suspension, true);
      return;
    }
    patchState(suspension);
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

  /**
   * Suspend the environment sessions and publish `patch` with the projection:
   * each takes a fresh generation, so nothing still in flight can publish into
   * it and none stays adoptable. The replaced generations' transports are
   * suspended on their own environments' queues, so no environment's next
   * connect waits for another's suspension. `exceptSuspended` skips the ones
   * a suspension already reached.
   *
   * Nothing awaits these suspensions, a resume included: each environment's
   * next connect queues behind its own suspension, so the
   * `#browserSuspendPromise` a single-session resume awaits is not used here.
   */
  #suspendRetained(
    sessions: HostedEnvironmentSessions,
    patch: Partial<HostedHubState>,
    exceptSuspended: boolean,
  ): void {
    const suspended = this.#pauseProjection(() => sessions.suspendAll({ exceptSuspended }));
    this.#publishProjected(sessions, patch);
    for (const { environmentId, previousGeneration } of suspended) {
      void suspendHostedEnvironment(environmentId, previousGeneration).catch(() => undefined);
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
    const checking: Partial<HostedHubState> = {
      browserStatus: "checking-access",
      errorMessage: null,
    };
    const sessions = this.#retainedSessions();
    if (sessions) {
      // No environment session keeps its authority across a resume. One that
      // no suspension reached — a rotated session, a stale directory — is
      // suspended now like the rest, so each regains it only through its own
      // fresh relay attempt and accepted snapshot after this revalidation.
      this.#suspendRetained(sessions, checking, true);
    } else {
      patchState(checking);
    }
    const options = this.#accessCheckOptions();
    const restoring = getHostedHubApi().restoreSession(operation.signal, options);
    const check = { directory: this.#prefetchDirectory(operation.signal) };
    try {
      const restored = await restoring;
      if (operation.signal.aborted || this.#browserLifecycleGeneration !== browserGeneration) {
        check.directory?.abandon();
        return;
      }
      const active = hostedHubStore.getState();
      if (active.accountStatus !== "authenticated" || restored.account.id !== expectedAccountId) {
        check.directory?.abandon();
        await this.expireSession();
        return;
      }
      this.#accessCheckTimedOut = false;
      this.#resetAccessRetry();
      patchState({ account: restored.account, session: restored.session });
      await this.#refreshDirectoryWith(check.directory);
      if (this.#browserLifecycleGeneration !== browserGeneration) return;
      const refreshed = hostedHubStore.getState();
      if (refreshed.accountStatus !== "authenticated") return;
      if (refreshed.directoryStatus !== "ready") {
        patchState({ browserStatus: "stale" });
        return;
      }
      if (sessions) {
        // Revalidated. Every record was suspended and regains authority only
        // through its own fresh attempt and accepted snapshot, which the
        // platform starts when it re-plans (the selection first). Until its
        // record is established the selection synchronizes. Each environment's
        // connect queues behind its own suspension, so none waits for another.
        // An acquisition refused while the browser was not revalidated is
        // re-planned with it.
        this.#publishProjected(sessions, { browserStatus: "current" });
        requestHostedEnvironmentReconcile({ reason: "resume" });
        this.#replanRefusedEnvironments(sessions);
        return;
      }
      if (!refreshed.selectedNode) {
        patchState({ browserStatus: "current" });
        return;
      }
      patchState({ browserStatus: "synchronizing" });
      await this.#retrySelectedNode(operation.signal);
    } catch (error) {
      check.directory?.abandon();
      if (operation.signal.aborted || this.#browserLifecycleGeneration !== browserGeneration)
        return;
      this.#noteAccessCheckFailure(error);
      if (isSessionFailure(error)) {
        await this.expireSession(error);
        return;
      }
      // Suspension already cleared the directory timer and this failure came
      // before `refreshDirectory`, so nothing else would ever resume a `stale`
      // browser short of another visibility/online event or a manual refresh.
      // The retry re-runs the whole resume, never a shortcut to `current`.
      const retrying = this.#scheduleAccessRetry(error);
      patchState({
        browserStatus: "stale",
        ...hostedErrorPatch(error),
        accessRecoveryPending: retrying,
      });
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
    this.#directoryInvalidationFollowup = null;
    this.#operation?.abort();
    this.#operation = null;
    // The access check that abort just ended can publish nothing, so the next
    // `bootstrap()` must start a fresh one rather than join it.
    this.#bootstrapPromise = null;
    this.#bootstrapAccessPromise = null;
    // Nothing refused for this account session is re-planned for the next one.
    this.#refusedUntilRecovery.clear();
    this.#clearAccountSurface();
    // No orchestration command replays into whatever account signs in next.
    getHostedDispatchReplay().endAccountSession();
    const previousEnvironmentId = hostedHubStore.getState().selectedNode?.environmentId ?? null;
    patchState({
      ...initialState,
      accountStatus: status,
      generation: hostedHubStore.getState().generation + 1,
    });
    const sessions = this.#retainedSessions();
    if (sessions) {
      this.#projectedError = null;
      if (previousEnvironmentId) setActiveHostedEnvironment(null);
      // Whoever signs in next starts without this session's node-scoped state,
      // even on an environment it acquires before these releases finish. The
      // records are gone at once; the releases run on their own environments'
      // queues, and signing out never waits for a lifecycle port. A release
      // port that fails has still forgotten its record.
      for (const record of sessions.list()) {
        void this.#releaseRecord(sessions, record.environmentId, false).catch(() => undefined);
      }
      sessions.clear();
      return;
    }
    if (previousEnvironmentId) {
      await deactivateHostedNode(previousEnvironmentId);
    }
  }

  refreshDirectory(): Promise<void> {
    return this.#refreshDirectoryWith(null);
  }

  /** {@link refreshDirectory}, committing an access check's held read if it has one. */
  #refreshDirectoryWith(prefetch: HostedDirectoryPrefetch | null): Promise<void> {
    if (this.#directoryPromise) {
      // A read already in flight answers for this one; the held read is dropped.
      prefetch?.abandon();
      return this.#directoryPromise;
    }
    const operation = new AbortController();
    this.#directoryOperation = operation;
    const promise = this.#refreshDirectory(operation, prefetch).finally(() => {
      if (this.#directoryOperation === operation) this.#directoryOperation = null;
      if (this.#directoryPromise === promise) this.#directoryPromise = null;
    });
    this.#directoryPromise = promise;
    return promise;
  }

  /** A push received during a directory read needs one read after that snapshot. */
  notifyDirectoryInvalidated(): void {
    const state = hostedHubStore.getState();
    if (
      state.accountStatus !== "authenticated" ||
      this.#directoryRetry > 0 ||
      state.browserStatus === "offline" ||
      state.browserStatus === "suspended"
    )
      return;
    const pending = this.#directoryPromise;
    if (!pending) {
      void this.refreshDirectory();
      return;
    }
    if (this.#directoryInvalidationFollowup === pending) return;
    this.#directoryInvalidationFollowup = pending;
    const accountId = state.account?.id;
    const sessionId = state.session?.id;
    void pending.then(() => {
      if (this.#directoryInvalidationFollowup !== pending) return;
      this.#directoryInvalidationFollowup = null;
      const current = hostedHubStore.getState();
      if (
        current.accountStatus !== "authenticated" ||
        current.account?.id !== accountId ||
        current.session?.id !== sessionId ||
        this.#directoryRetry > 0 ||
        current.browserStatus === "offline" ||
        current.browserStatus === "suspended"
      )
        return;
      void this.refreshDirectory();
    });
  }

  /**
   * Poll the node directory at {@link DIRECTORY_PRESENCE_REFRESH_MS} instead of
   * the 20s cadence for as long as the returned release has not been called.
   *
   * For a surface holding connection demand for a node the directory reports
   * offline: presence is only learned from this poll, so at the normal cadence
   * a node that came back could wait 20s to be seen. Watches are tokens, one
   * per caller, and the release is idempotent. Each watch keeps the faster
   * cadence for {@link DIRECTORY_PRESENCE_WINDOW_MS} only, after which the poll
   * falls back to 20s even while it is held. The poll stays foreground-only
   * and a failure backoff is never shortened; a pending normal-cadence refresh
   * is pulled in when a watch starts the faster cadence.
   */
  watchDirectoryPresence(): () => void {
    const watch = Symbol("hosted-directory-presence-watch");
    const wasFast = this.#directoryPresenceCadenceActive();
    this.#directoryPresenceWatches.set(watch, getHostedRuntimeConfiguration().timers.now());
    if (
      !wasFast &&
      this.#directoryTimer !== null &&
      this.#directoryRetry === 0 &&
      !getHostedRuntimeConfiguration().hasLiveHubSubscription?.()
    ) {
      this.#scheduleDirectory(DIRECTORY_PRESENCE_REFRESH_MS);
    }
    return () => {
      this.#directoryPresenceWatches.delete(watch);
    };
  }

  #directoryPresenceCadenceActive(): boolean {
    if (this.#directoryPresenceWatches.size === 0) return false;
    const now = getHostedRuntimeConfiguration().timers.now();
    for (const startedAt of this.#directoryPresenceWatches.values()) {
      if (now - startedAt < DIRECTORY_PRESENCE_WINDOW_MS) return true;
    }
    return false;
  }

  /** How long after a successful read the next poll runs. */
  #directoryCadence(): number {
    const runtime = getHostedRuntimeConfiguration();
    if (runtime.hasLiveHubSubscription?.()) return DIRECTORY_SUBSCRIBED_REFRESH_MS;
    if (this.#directoryPresenceCadenceActive()) return DIRECTORY_PRESENCE_REFRESH_MS;
    if (runtime.demandDrivenDirectoryRefresh && directoryPresenceDemand.size === 0) {
      return DIRECTORY_SUBSCRIBED_REFRESH_MS;
    }
    return DIRECTORY_REFRESH_MS;
  }

  /**
   * Presence demand started or ended: move the pending poll to the cadence that
   * now applies, counted from the last successful read, or read now when that
   * read is already older.
   *
   * Only a pending normal-cadence timer moves. In the background the foreground
   * listener already refreshes on return, a read in flight schedules the next
   * one when it ends, a failure backoff is never shortened, and a signed-out
   * controller has no timer.
   */
  #directoryDemandChanged(): void {
    if (this.#directoryTimer === null || this.#directoryRetry !== 0) return;
    const runtime = getHostedRuntimeConfiguration();
    if (!runtime.demandDrivenDirectoryRefresh) return;
    const elapsed =
      this.#directoryRefreshedAt === null
        ? Number.POSITIVE_INFINITY
        : runtime.timers.now() - this.#directoryRefreshedAt;
    const remaining = this.#directoryCadence() - elapsed;
    if (remaining <= 0) {
      void this.refreshDirectory();
      return;
    }
    this.#scheduleDirectory(remaining);
  }

  async #refreshDirectory(
    operation: AbortController,
    prefetch: HostedDirectoryPrefetch | null,
  ): Promise<void> {
    const state = hostedHubStore.getState();
    if (state.accountStatus !== "authenticated") {
      prefetch?.abandon();
      return;
    }
    // Resolved before the read, outside its failure handling: missing retained
    // lifecycle ports are a configuration error, never a stale directory.
    let sessions: HostedEnvironmentSessions | null;
    try {
      sessions = this.#retainedSessions();
    } catch (error) {
      prefetch?.abandon();
      throw error;
    }
    const sessionId = state.session?.id ?? null;
    this.#clearDirectoryTimer();
    if (state.nodes.length === 0 && state.directoryStatus !== "loading") {
      patchState({ directoryStatus: "loading" });
    }
    const abandonPrefetch = () => prefetch?.abandon();
    operation.signal.addEventListener("abort", abandonPrefetch, { once: true });
    try {
      const held = prefetch === null ? null : await prefetch.nodes;
      if (held === null && operation.signal.aborted) return;
      const nodes = held ?? (await getHostedHubApi().listNodes(operation.signal));
      const active = hostedHubStore.getState();
      if (
        operation.signal.aborted ||
        active.accountStatus !== "authenticated" ||
        active.session?.id !== sessionId
      ) {
        return;
      }
      this.#directoryRetry = 0;
      this.#directoryRefreshedAt = getHostedRuntimeConfiguration().timers.now();
      const current = hostedHubStore.getState();
      const resumeStaleBrowser = current.browserStatus === "stale";
      const selected = current.selectedNode;
      const nextNodes = reconcileDirectoryNodes(current.nodes, nodes);
      const refreshedNode = selected
        ? (nextNodes.find(
            (node) => node.id === selected.id && node.environmentId === selected.environmentId,
          ) ?? null)
        : null;
      const refreshedSelection =
        refreshedNode !== null && selected !== null && sameDirectoryValue(selected, refreshedNode)
          ? selected
          : refreshedNode;
      if (sessions) {
        this.#publishRetainedDirectory(sessions, current, nextNodes, refreshedSelection);
      } else if (selected && (!refreshedSelection || refreshedSelection.revokedAt !== null)) {
        const generation = current.generation + 1;
        patchState({
          nodes: nextNodes,
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
        const patch: Partial<HostedHubState> = {
          nodes: nextNodes,
          directoryStatus: "ready",
          ...(refreshedSelection
            ? {
                selectedNode: refreshedSelection,
                selectionStatus: refreshedSelection.presence.online ? "online" : "offline",
                effectiveRole: refreshedSelection.effectiveRole,
              }
            : {}),
        };
        // An unchanged directory publishes nothing: every hosted store
        // subscriber (route orchestrator, coordinator, read cache, thread cache)
        // would otherwise re-run for a read that changed nothing.
        if (
          (Object.keys(patch) as Array<keyof HostedHubState>).some(
            (key) => !Object.is(current[key], patch[key]),
          )
        ) {
          patchState(patch);
        }
      }
      this.#scheduleDirectory(this.#directoryCadence());
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
    } finally {
      operation.signal.removeEventListener("abort", abandonPrefetch);
    }
  }

  async selectNode(nodeId: string): Promise<void> {
    const state = hostedHubStore.getState();
    if (
      state.accountStatus !== "authenticated" ||
      state.directoryStatus !== "ready" ||
      (state.browserStatus !== "current" && state.browserStatus !== "synchronizing")
    )
      return;
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.revokedAt) return;
    // With retained sessions a node locked to native clients is never selected,
    // as the directory leaves it and no acquisition connects it: it could only
    // show as synchronizing for good.
    if (hostedEnvironmentSessionsMode() === "retained" && lockedForThisClient(node)) return;
    if (
      state.selectedNode?.id === node.id &&
      state.selectedNode.environmentId === node.environmentId
    )
      return;
    // Synchronizing means account and directory checks already succeeded; the
    // old node's snapshot must not block navigation to another authorized node.
    // Supersede its recovery operation before starting the new generation.
    this.#browserLifecycleGeneration += 1;
    this.#browserResumeOperation?.abort();
    this.#browserResumeOperation = null;
    this.#browserResumePromise = null;
    this.#retrySelectedNodeOperation?.abort();
    this.#retrySelectedNodeOperation = null;
    this.#retrySelectedNodePromise = null;
    const sessions = this.#retainedSessions();
    if (sessions) {
      this.#selectRetained(sessions, state, node);
      return;
    }
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
   * Retained mode: move the selection and its projection, nothing else.
   * Selecting never connects; the platform's demand executor connects through
   * {@link acquireEnvironment}, so its cap is the only place connection slots
   * are granted. A record that can be neither adopted nor joined (suspended,
   * failed, or idle after a renew) starts over instead, as selecting a node
   * always did, and the platform is asked to re-plan it.
   */
  #selectRetained(
    sessions: HostedEnvironmentSessions,
    state: HostedHubState,
    node: HostedHubNode,
  ): void {
    const { environmentId } = node;
    const record = sessions.read(environmentId);
    const restart =
      record !== undefined &&
      !canAdoptHostedEnvironmentSession(record) &&
      !isJoinableHostedEnvironmentSession(record);
    if (restart) sessions.renew(environmentId);
    this.#publishProjected(sessions, { selectedNode: node, generation: state.generation + 1 });
    setActiveHostedEnvironment(node);
    if (restart) requestHostedEnvironmentReconcile({ reason: "retry", environmentId });
  }

  /**
   * Connect an environment, in retained mode the only way any connection is
   * created. The platform's demand executor alone calls it, and decides when;
   * this controller stays the lifecycle owner and decides how:
   *
   * - `adopted`: the environment's session completed its own fresh relay
   *   attempt and accepted its own current snapshot, and has not been
   *   suspended or interrupted since (`canAdoptHostedEnvironmentSession`, the
   *   one adoption rule), so it is used as it is;
   * - `joined`: a connection was already requested for its generation and is
   *   still on its way, or another acquisition is opening it right now;
   * - `refused`: the browser is not revalidated, the directory is not current,
   *   the node is gone, revoked or locked for this client, a terminal failure
   *   (an incompatible relay among them) blocks it until its directory entry
   *   changes or the user retries, or a release, suspension or restart that
   *   ran meanwhile replaced the generation this call started. The platform
   *   holds a refused environment back, so one refused for a cause that passes
   *   (no account yet, the browser, the directory or a replaced generation) is
   *   re-planned once at the next recovery; see {@link #replanRefusedEnvironments};
   * - `connecting`: anything else starts over with a fresh generation, relay
   *   attempt and snapshot, after the environment's own pending release or
   *   suspension.
   *
   * It never moves the selection. In single mode it selects the node, the one
   * way that mode connects.
   */
  async acquireEnvironment(nodeId: string): Promise<HostedEnvironmentAcquisition> {
    const sessions = this.#retainedSessions();
    if (!sessions) {
      await this.selectNode(nodeId);
      return "connecting";
    }
    return this.#acquireRetained(sessions, nodeId);
  }

  #acquireRetained(
    sessions: HostedEnvironmentSessions,
    nodeId: string,
  ): HostedEnvironmentAcquisition {
    const state = hostedHubStore.getState();
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    if (node !== undefined && (node.revokedAt !== null || lockedForThisClient(node))) {
      // Refused for good: no recovery re-plans it.
      this.#refusedUntilRecovery.delete(nodeId);
      return "refused";
    }
    // Before the account is restored, the browser revalidated and the
    // directory current, the refusal passes, even for a node the directory
    // does not know yet: before its first load it knows none.
    if (!this.#browserRevalidated(state) || state.directoryStatus !== "ready") {
      return this.#refuseUntilRecovery(nodeId);
    }
    if (node === undefined) {
      // Gone from a current directory: refused for good.
      this.#refusedUntilRecovery.delete(nodeId);
      return "refused";
    }
    const { environmentId } = node;
    // A registry listener that acquires the environment again while this call
    // publishes its fresh record joins the connection this call opens.
    if (this.#startingEnvironments.has(environmentId)) return "joined";
    // This answer replaces whatever an earlier refusal left to re-plan.
    this.#refusedUntilRecovery.delete(nodeId);
    const record = sessions.read(environmentId);
    if (record !== undefined) {
      if (canAdoptHostedEnvironmentSession(record)) {
        sessions.ensureRecord(node);
        return "adopted";
      }
      if (isJoinableHostedEnvironmentSession(record)) return "joined";
      if (isHostedEnvironmentConnectBlocked(record)) return "refused";
    }
    this.#startingEnvironments.add(environmentId);
    let generation: number;
    try {
      generation = sessions.ensureRecord(node).generation;
      if (record !== undefined) {
        generation = sessions.renew(environmentId)?.generation ?? generation;
      }
      sessions.markConnectRequested(environmentId, generation);
    } finally {
      this.#startingEnvironments.delete(environmentId);
    }
    // Something a listener ran while the record was published — a release, a
    // suspension, a selection that started it over — replaced this generation,
    // and whatever did so owns what comes next: a connection for it would only
    // be dropped. That cause passes, so the next recovery re-plans the
    // environment.
    if (!sessions.isCurrentGeneration(environmentId, generation)) {
      return this.#refuseUntilRecovery(nodeId);
    }
    // A connect queued behind the environment's pending release or suspension
    // opens nothing for a generation that a withdrawal, a sign-out or anything
    // else replaced by the time its turn comes.
    const current = () => sessions.isCurrentGeneration(environmentId, generation);
    void connectHostedEnvironment(node, generation, current).catch(() => {
      // The connection could not even be opened: this generation's
      // synchronization fails now instead of at its deadline.
      sessions.reportShellSnapshotFailure(environmentId, generation);
    });
    return "connecting";
  }

  /**
   * Retained mode: close an environment's session and connection — the
   * platform's demand executor decides when. Requests the connection still had
   * in flight leave the environment's delivery uncertain for its next session.
   * Releasing the selected environment also returns to the node directory, as
   * {@link returnToDirectory} does. In single mode only the selected
   * environment has a connection, and releasing it returns to the directory.
   */
  async releaseEnvironment(environmentId: EnvironmentId): Promise<void> {
    const sessions = this.#retainedSessions();
    const state = hostedHubStore.getState();
    const selected = state.selectedNode?.environmentId === environmentId;
    if (!sessions) {
      if (selected) await this.returnToDirectory();
      return;
    }
    // Leave the selection first, so nothing ever shows it without its session.
    if (selected) {
      this.#leaveSelection(state, false);
      setActiveHostedEnvironment(null);
    }
    await this.#releaseRecord(sessions, environmentId);
  }

  /**
   * Release an environment's record and connection. Its node-scoped state is
   * kept for a newer session of the environment that started meanwhile only
   * when `keepStateForNewerSession`; ending the account session never hands
   * one account's cached state to the next session.
   */
  #releaseRecord(
    sessions: HostedEnvironmentSessions,
    environmentId: EnvironmentId,
    keepStateForNewerSession = true,
  ): Promise<void> {
    const record = sessions.read(environmentId);
    if (record === undefined) return Promise.resolve();
    sessions.release(environmentId);
    return releaseHostedEnvironment(
      environmentId,
      record.generation,
      keepStateForNewerSession ? () => sessions.read(environmentId) !== undefined : () => false,
    );
  }

  /**
   * Leave the selected node for the node directory without touching the Hub
   * session. Used by history navigation (Back to the directory) and by
   * fail-closed route fallbacks. In single mode it deactivates the node through
   * the documented switching-nodes teardown order (`deactivateHostedNode`); in
   * retained mode it releases nothing, since connections belong to the
   * platform's demand executor. Either way the generation bump prevents stale
   * relay attempts from publishing readiness or role into the directory.
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
    const sessions = this.#retainedSessions();
    this.#leaveSelection(state, options?.preserveTerminalSelection === true);
    if (sessions) {
      setActiveHostedEnvironment(null);
      return;
    }
    await deactivateHostedNode(node.environmentId);
  }

  #leaveSelection(state: HostedHubState, preserve: boolean): void {
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
    // A `checking-access` resume had not revalidated anything yet: the browser
    // goes `stale` and a fresh resume, with no selection left to reconnect,
    // re-runs that check rather than handing back `current` unverified.
    const accessUnchecked = state.browserStatus === "checking-access";
    patchState({
      ...clearedSelection(
        state,
        preserve
          ? {
              selectionStatus: state.selectionStatus,
              errorMessage: state.errorMessage,
              errorReason: state.errorReason ?? null,
            }
          : { selectionStatus: "none", errorMessage: null, errorReason: null },
      ),
      ...(accessUnchecked ? { browserStatus: "stale" } : {}),
    });
    this.#projectedError = null;
    if (accessUnchecked) void this.resumeBrowser();
  }

  /**
   * Start the selected node over with a fresh generation. In retained mode its
   * record is renewed and the platform asked to re-plan it; the demand
   * executor reconnects it through {@link acquireEnvironment}.
   */
  retrySelectedNode(): Promise<void> {
    const sessions = this.#retainedSessions();
    if (sessions) {
      this.#retryRetained(sessions);
      return Promise.resolve();
    }
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

  #retryRetained(sessions: HostedEnvironmentSessions): void {
    const state = hostedHubStore.getState();
    const node = state.selectedNode;
    if (
      !node ||
      node.revokedAt !== null ||
      state.accountStatus !== "authenticated" ||
      state.directoryStatus !== "ready"
    ) {
      return;
    }
    sessions.renew(node.environmentId);
    requestHostedEnvironmentReconcile({ reason: "retry", environmentId: node.environmentId });
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
      // A spent transfer budget is a routine rotation: the reconnect that
      // follows is the whole story, so it shows no error.
      errorMessage: failure.kind === "budget" ? null : failureMessage(failure),
    });
  }

  markDeliveryUnknown(generation: number): void {
    if (hostedHubStore.getState().generation !== generation) return;
    patchState({ sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false });
  }

  /**
   * A replayed orchestration command could not be confirmed on this
   * environment. Unlike a drop, this can land on a session that is already
   * current again; that one only needs the user's acknowledgement, while any
   * other still waits for its snapshot first.
   */
  markEnvironmentDeliveryUnknown(environmentId: EnvironmentId): void {
    const sessions = this.#retainedSessions();
    if (sessions) {
      sessions.markEnvironmentDeliveryUnknown(environmentId);
      return;
    }
    const state = hostedHubStore.getState();
    if (state.selectedNode?.environmentId !== environmentId) return;
    if (state.sessionStatus === "delivery-unknown") return;
    patchState({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: state.sessionStatus === "ready",
    });
  }

  connectionClosed(generation: number): void {
    const state = hostedHubStore.getState();
    if (state.generation !== generation || state.transportStatus === "terminal-failure") return;
    this.#relayGapGeneration = generation;
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

  /**
   * The transport authenticated a replacement for a channel that closed
   * unintentionally in this generation, and the client's subscriptions are
   * resubscribing on it. The controller adopts that channel as the new session
   * instead of rebuilding the client: one drop costs one ticket, one stream, one
   * handshake and one shell snapshot. The session is not established again
   * until the replacement's own shell snapshot is accepted
   * ({@link markSessionReady}), under the same synchronization deadline as a
   * fresh selection; until then `sessionStatus` stays stale or replaying, which
   * admits no mutation.
   */
  connectionRecovered(generation: number): void {
    const state = hostedHubStore.getState();
    if (
      state.generation !== generation ||
      this.#relayGapGeneration !== generation ||
      state.selectedNode === null ||
      state.transportStatus === "terminal-failure"
    ) {
      return;
    }
    this.#relayGapGeneration = null;
    patchState({ sessionEstablished: false, sessionRecoveredAfterUnknown: false });
    this.#startSessionSyncTimer(generation);
  }

  markSessionReady(environmentId: EnvironmentId): void {
    const state = hostedHubStore.getState();
    if (state.selectedNode?.environmentId !== environmentId) return;
    // A snapshot that lands between an unintentional close and its replacement
    // channel can only have come from the lost channel.
    if (this.#relayGapGeneration === state.generation) return;
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
    getHostedDispatchReplay().markReady(environmentId);
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

  /**
   * The user has seen that an action could not be confirmed and continues; the
   * selected environment's by default. In retained mode any environment's
   * session can be acknowledged, and its readiness reaches the dispatch replay
   * like any other.
   */
  acknowledgeDeliveryUnknown(environmentId?: EnvironmentId): void {
    const state = hostedHubStore.getState();
    const sessions = this.#retainedSessions();
    if (sessions) {
      const acknowledged = environmentId ?? state.selectedNode?.environmentId;
      if (acknowledged !== undefined) sessions.acknowledgeDeliveryUnknown(acknowledged);
      return;
    }
    if (environmentId !== undefined && state.selectedNode?.environmentId !== environmentId) return;
    if (state.sessionStatus !== "delivery-unknown" || !state.sessionRecoveredAfterUnknown) return;
    patchState({ sessionStatus: "ready", sessionRecoveredAfterUnknown: false });
    if (state.selectedNode) getHostedDispatchReplay().markReady(state.selectedNode.environmentId);
  }

  /**
   * A terminal failure of the account's Hub session, which every node channel
   * depends on. In single mode it fails the selected node's session; in
   * retained mode it reaches every environment session, each under its own
   * generation.
   */
  reportHubSessionFailure(failure: HostedRelayFailure): void {
    const sessions = this.#retainedSessions();
    if (!sessions) {
      this.failure(hostedHubStore.getState().generation, failure);
      return;
    }
    for (const record of sessions.list()) {
      sessions.failure(record.environmentId, record.generation, failure);
    }
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
   * re-checking the state it was armed for. Returns whether a retry is now
   * pending, for the failure patch to publish as `accessRecoveryPending`.
   */
  #scheduleAccessRetry(error: unknown): boolean {
    this.#cancelAccessRetry();
    if (!isTransientAccessFailure(error)) return false;
    const delay = this.#accessRetryPolicy.nextDelay(
      error instanceof HostedHubApiError ? error.retryAfterMs : undefined,
    );
    this.#accessRetryTimer = getHostedRuntimeConfiguration().timers.setTimeout(() => {
      this.#accessRetryTimer = null;
      this.#runAccessRetry();
    }, delay);
    return true;
  }

  #runAccessRetry(): void {
    if (!hostedAccessAwaitsRecovery(hostedHubStore.getState())) return;
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
    if (hostedHubStore.getState().accessRecoveryPending) {
      patchState({ accessRecoveryPending: false });
    }
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
      this.#directoryForeground = runtime.subscribeForeground(onVisibilityChange);
      return;
    }
    this.#directoryTimer = runtime.timers.setTimeout(() => void this.refreshDirectory(), delay);
  }

  #clearDirectoryTimer(): void {
    const unsubscribe = this.#directoryForeground;
    this.#directoryForeground = null;
    unsubscribe?.();
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

  /**
   * The environment session registry when sessions are retained, with the
   * selected record's projection installed; `null` in single mode.
   *
   * Retained mode keeps this controller the only hosted lifecycle owner. The
   * platform's demand executor only decides when to call
   * {@link acquireEnvironment} and {@link releaseEnvironment}; every connection
   * is created there. Every record that admits mutations earned it with its
   * own fresh relay attempt and accepted snapshot, and every relay callback is
   * fenced per environment by the record generation it names, so a stale
   * generation can publish neither readiness, role, a snapshot nor mutation
   * authority.
   */
  #retainedSessions(): HostedEnvironmentSessions | null {
    const sessions = retainedEnvironmentSessions();
    if (sessions === null) return null;
    retainedHostedNodeLifecycle();
    if (this.#projection?.sessions !== sessions) this.#installProjection(sessions);
    return sessions;
  }

  #installProjection(sessions: HostedEnvironmentSessions): void {
    this.#projection?.unsubscribe();
    this.#recordReadiness.clear();
    this.#observeRecordReadiness(sessions, false);
    const unsubscribeSessions = sessions.subscribe(() => {
      this.#observeRecordReadiness(sessions, true);
      this.#projectSelection();
    });
    const unsubscribeStore = hostedHubStore.subscribe(() => this.#projectSelection());
    this.#projection = {
      sessions,
      unsubscribe: () => {
        unsubscribeSessions();
        unsubscribeStore();
      },
    };
    this.#projectSelection();
  }

  /**
   * Hand each environment's readiness to the dispatch replay once per ready
   * edge: when its session has accepted a current snapshot and admits commands
   * again (a delivery-unknown session once the user has acknowledged it).
   */
  #observeRecordReadiness(sessions: HostedEnvironmentSessions, notify: boolean): void {
    const { records } = sessions.getSnapshot();
    for (const environmentId of Array.from(this.#recordReadiness.keys())) {
      if (!records.has(environmentId)) this.#recordReadiness.delete(environmentId);
    }
    for (const record of records.values()) {
      const ready = record.sessionEstablished && record.sessionStatus === "ready";
      const previous = this.#recordReadiness.get(record.environmentId);
      if (previous?.generation === record.generation && previous.ready === ready) continue;
      this.#recordReadiness.set(record.environmentId, { generation: record.generation, ready });
      if (notify && ready) getHostedDispatchReplay().markReady(record.environmentId);
    }
  }

  /** Re-publish the projection after the registry or the shared state changed. */
  #projectSelection(): void {
    const projection = this.#projection;
    if (projection === null || this.#projectionPaused > 0) return;
    if (this.#projecting) {
      this.#projectAgain = true;
      return;
    }
    if (hostedEnvironmentSessionsMode() !== "retained") return;
    this.#projecting = true;
    try {
      do {
        this.#projectAgain = false;
        const patch = this.#projectionPatch(projection.sessions, hostedHubStore.getState());
        if (Object.keys(patch).length > 0) patchState(patch);
      } while (this.#projectAgain);
    } finally {
      this.#projecting = false;
    }
  }

  /**
   * Hold the projection while `change` rewrites records, for the caller to
   * publish it together with its own shared patch.
   */
  #pauseProjection<T>(change: () => T): T {
    this.#projectionPaused += 1;
    try {
      return change();
    } finally {
      this.#projectionPaused -= 1;
    }
  }

  /** Publish `patch` and the projection it leads to as one update. */
  #publishProjected(sessions: HostedEnvironmentSessions, patch: Partial<HostedHubState>): void {
    const next = { ...hostedHubStore.getState(), ...patch };
    const update = { ...patch, ...this.#projectionPatch(sessions, next) };
    if (Object.keys(update).length > 0) patchState(update);
  }

  /**
   * The changes that make `state` show the selected environment's record.
   *
   * In retained mode the shared transport, session, role and selection fields
   * describe the selected record and nothing else, and this is their only
   * writer: the shared generation moves only with the selection, and relay
   * callbacks write records. While the browser is revalidated, it is
   * `synchronizing` until the selected record is established or has failed
   * for good, and `current` from then on — a slow or offline selection never
   * holds another record, whose admission needs only the revalidated browser
   * and its own session. The session error is published when the record's own
   * error changes, so a directory or access failure published since stays.
   */
  #projectionPatch(
    sessions: HostedEnvironmentSessions,
    state: HostedHubState,
  ): Partial<HostedHubState> {
    const node = state.selectedNode;
    if (node === null) return {};
    const { environmentId } = node;
    const fields = selectedProjectionFields(sessions.read(environmentId), node, {
      directoryReady: state.directoryStatus === "ready",
      deliveryUnknown: sessions.getSnapshot().deliveryUnknown.has(environmentId),
    });
    const message =
      fields.error === null
        ? null
        : fields.error.kind === "session-sync"
          ? HOSTED_SESSION_SYNC_FAILURE_MESSAGE
          : failureMessage(fields.error.failure);
    const published = this.#projectedError;
    const errorChanged =
      published?.environmentId !== environmentId || published.message !== message;
    if (errorChanged) this.#projectedError = { environmentId, message };
    return changedFields(state, {
      transportStatus: fields.transportStatus,
      sessionStatus: fields.sessionStatus,
      sessionEstablished: fields.sessionEstablished,
      sessionRecoveredAfterUnknown: fields.sessionRecoveredAfterUnknown,
      effectiveRole: fields.effectiveRole,
      selectionStatus: fields.selectionStatus,
      ...(this.#browserRevalidated(state)
        ? { browserStatus: fields.establishing ? "synchronizing" : "current" }
        : {}),
      ...(errorChanged ? { errorMessage: message } : {}),
    });
  }

  /**
   * The account and the directory were checked in this browser lifecycle and
   * nothing has suspended it since. The same rule every environment's relay
   * admission reads, so the two can never disagree.
   */
  #browserRevalidated(state: HostedHubState): boolean {
    return state.accountStatus === "authenticated" && hostedBrowserRevalidated(state.browserStatus);
  }

  /**
   * Retained mode's directory publication. The selection follows the
   * directory as in single mode. It leaves it with the revoked or
   * authorization-removed status when its node is gone or revoked, and with
   * no status when its node became locked for this client, which could never
   * connect it. Every record whose node is gone, revoked or locked for this
   * client is released, selected or not; every other one takes its directory
   * entry, and one whose terminal failure that entry's change lifted is
   * re-planned. A directory that becomes current — its first load included —
   * while the browser is revalidated also re-plans the acquisitions refused
   * until then. The shared role is the projection's to publish.
   *
   * Releases run on their own environments' queues and are not awaited: the
   * directory, its next poll and a resume never wait for an environment's
   * lifecycle ports.
   */
  #publishRetainedDirectory(
    sessions: HostedEnvironmentSessions,
    current: HostedHubState,
    nodes: ReadonlyArray<HostedHubNode>,
    refreshedSelection: HostedHubNode | null,
  ): void {
    const selected = current.selectedNode;
    if (
      selected &&
      (!refreshedSelection ||
        refreshedSelection.revokedAt !== null ||
        lockedForThisClient(refreshedSelection))
    ) {
      patchState({
        nodes,
        directoryStatus: "ready",
        ...clearedSelection(
          current,
          refreshedSelection && refreshedSelection.revokedAt === null
            ? { selectionStatus: "none", errorMessage: null, errorReason: null }
            : {
                selectionStatus: refreshedSelection ? "revoked" : "authorization-removed",
                errorMessage: current.errorMessage,
                errorReason: current.errorReason ?? null,
              },
        ),
      });
      this.#projectedError = null;
      setActiveHostedEnvironment(null);
    } else {
      // An unchanged directory publishes nothing: every hosted store
      // subscriber would otherwise re-run for a read that changed nothing.
      const update = changedFields(current, {
        nodes,
        directoryStatus: "ready",
        ...(refreshedSelection ? { selectedNode: refreshedSelection } : {}),
      });
      if (Object.keys(update).length > 0) this.#publishProjected(sessions, update);
    }
    for (const record of sessions.list()) {
      const node = nodes.find(
        (candidate) =>
          candidate.id === record.nodeId && candidate.environmentId === record.environmentId,
      );
      if (!node || node.revokedAt !== null || lockedForThisClient(node)) {
        // A release port that fails has still forgotten the record; nothing
        // here waits for it.
        void this.#releaseRecord(sessions, record.environmentId).catch(() => undefined);
        continue;
      }
      const refreshed = sessions.ensureRecord(node, { access: false });
      if (
        isHostedEnvironmentConnectBlocked(record) &&
        !isHostedEnvironmentConnectBlocked(refreshed)
      ) {
        this.#refusedUntilRecovery.delete(record.nodeId);
        requestHostedEnvironmentReconcile({
          reason: "directory",
          environmentId: record.environmentId,
        });
      }
    }
    if (current.directoryStatus !== "ready") this.#replanRefusedEnvironments(sessions);
  }

  /**
   * An acquisition refused for a cause that passes: the platform holds the
   * environment back, so the node is remembered for the next recovery to
   * re-plan. One refused before any account authenticated belongs to whichever
   * account does; signing out forgets every one.
   */
  #refuseUntilRecovery(nodeId: string): "refused" {
    const state = hostedHubStore.getState();
    this.#refusedUntilRecovery.set(
      nodeId,
      state.accountStatus === "authenticated" ? (state.account?.id ?? null) : null,
    );
    return "refused";
  }

  /**
   * The browser is revalidated and the directory current again — after a
   * successful resume, the directory's first load, or a directory that
   * recovered: ask the platform once to re-plan each environment whose
   * acquisition was refused for a cause that passed, so its demand executor
   * no longer holds it back. Each refused node is looked up in the current
   * directory; one now gone, revoked or locked for this client, one a terminal
   * failure blocks, and one refused for another account are dropped instead.
   * Each is forgotten before it is requested, so one refused again for a
   * passing cause waits for the next recovery rather than being requested
   * again at once.
   */
  #replanRefusedEnvironments(sessions: HostedEnvironmentSessions): void {
    if (this.#refusedUntilRecovery.size === 0) return;
    const state = hostedHubStore.getState();
    if (!this.#browserRevalidated(state) || state.directoryStatus !== "ready") return;
    const refused = Array.from(this.#refusedUntilRecovery);
    this.#refusedUntilRecovery.clear();
    for (const [nodeId, accountId] of refused) {
      if (accountId !== null && accountId !== state.account?.id) continue;
      const node = state.nodes.find((candidate) => candidate.id === nodeId);
      if (!node || node.revokedAt !== null || lockedForThisClient(node)) continue;
      const { environmentId } = node;
      const record = sessions.read(environmentId);
      if (record !== undefined && isHostedEnvironmentConnectBlocked(record)) continue;
      requestHostedEnvironmentReconcile({ reason: "directory", environmentId });
    }
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
    case "budget":
      return "The relay channel reached its transfer budget. Ryco is reconnecting.";
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

// The connection callbacks below name the generation they belong to: the shared
// selection generation in single mode, and the environment's own record
// generation in retained mode, where each one is fenced per environment.

export function markHostedSessionReady(environmentId: EnvironmentId, generation: number): void {
  const sessions = retainedEnvironmentSessions();
  if (sessions) {
    sessions.markSessionReady(environmentId, generation);
    return;
  }
  if (hostedHubStore.getState().generation !== generation) return;
  hostedHubController.markSessionReady(environmentId);
}

export function markHostedSessionReplaying(environmentId: EnvironmentId, generation: number): void {
  const sessions = retainedEnvironmentSessions();
  if (sessions) {
    sessions.markSessionReplaying(environmentId, generation);
    return;
  }
  if (hostedHubStore.getState().generation !== generation) return;
  hostedHubController.markSessionReplaying(environmentId);
}

export function reportHostedShellSnapshotFailure(
  environmentId: EnvironmentId,
  generation: number,
): void {
  const sessions = retainedEnvironmentSessions();
  if (sessions) {
    const record = sessions.read(environmentId);
    // An established session keeps running on its accepted snapshot.
    if (record?.generation === generation && record.sessionEstablished) {
      console.warn("hosted_snapshot_reconciliation_failed");
    }
    sessions.reportShellSnapshotFailure(environmentId, generation);
    return;
  }
  if (hostedHubStore.getState().generation !== generation) return;
  hostedHubController.reportShellSnapshotFailure(environmentId);
}
