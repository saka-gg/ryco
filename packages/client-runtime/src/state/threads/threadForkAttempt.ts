/**
 * The fork dialog's state, shared by every client so web and mobile follow one key policy.
 *
 * One attempt is one boundary (environment, source thread, reply) plus one idempotency key. The
 * node keys everything on that key (thread id, worktree, native session copy) and finishes an
 * accepted fork even when the client goes away, so the rules here decide when a request may go
 * out under which key without ever creating a second fork:
 *
 * - The key stays bound to a request while the node may still hold an attempt for it (an unknown
 *   outcome, or an error with `attempt: "running"`). Only that exact request is sent again, and no
 *   new key is minted: the selection is locked until the node answers definitively.
 * - A request refused before it was sent changes nothing: an earlier "may have been created" or
 *   "still being prepared" state stays exactly as it was.
 * - After `attempt: "stopped"` the node released everything and never resumes, so a changed
 *   request gets a fresh key (the old key would answer idempotency-conflict). After
 *   `attempt: "none"` the node holds nothing for the key, so the key is free for any request.
 * - Locked attempts are remembered per boundary while the app runs (`rememberThreadForkAttempt`),
 *   so closing and reopening the dialog continues the same attempt instead of minting a key. So is
 *   a created fork until a dialog opened it (`acknowledgeThreadForkAttempt`): a dialog that went
 *   away before the answer arrived reopens onto that fork, never onto a fresh form, unless the
 *   fork was deleted or trashed since (the controller then starts a new attempt). An app restart
 *   forgets them; the node still completes or recovers the fork, which then appears in the thread
 *   list.
 * - An attempt's first request is checked against the connection the form was reviewed under;
 *   every later one against the connection live when the user pressed (`threadForkSendReadiness`).
 *
 * Pure apart from the module-level registry and the time a created fork is stamped with; keys
 * are minted by the caller (`mintKey`). A dialog or sheet drives all of this through
 * `createThreadForkAttemptController`.
 */
import type {
  EnvironmentId,
  MessageId,
  ThreadForkAttemptState as NodeAttemptState,
  ThreadForkErrorReason,
  ThreadForkInput,
  ThreadForkKey,
  ThreadForkResult,
  ThreadId,
} from "@ryco/contracts";

import {
  buildThreadForkInput,
  effectiveThreadForkOption,
  runThreadFork,
  THREAD_FORK_COPY,
  threadForkBusyLabel,
  threadForkRequestSignature,
  type ThreadForkApi,
  type ThreadForkApiRefusal,
  type ThreadForkDestinationOption,
  type ThreadForkOutcome,
  type ThreadForkSelection,
  type ThreadForkWorktreeStartOption,
} from "./threadFork.ts";

/** The reply a fork starts from, on one environment. */
export interface ThreadForkAttemptBoundary {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceMessageId: MessageId;
}

/**
 * What the node may hold under the attempt's key:
 * - `stopped`: an attempt that ended and released what it created; it never resumes.
 * - `running`: an unfinished attempt the node will complete (also after a restart).
 * - `unknown`: a request is in flight or its outcome was lost.
 */
export type ThreadForkNodeAttempt = "stopped" | "running" | "unknown";

export interface ThreadForkAttemptBinding {
  /**
   * The request the node holds under the key; null when it holds one this client never sent
   * (an idempotency conflict).
   */
  readonly request: ThreadForkInput | null;
  readonly nodeAttempt: ThreadForkNodeAttempt;
}

export type ThreadForkAttemptPhase =
  | "editing"
  | "submitting"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "running";

/** The node's last typed refusal. */
export interface ThreadForkAttemptFailure {
  readonly reason: ThreadForkErrorReason;
  readonly retryable: boolean;
  readonly attempt: NodeAttemptState;
  /** Shared copy for the reason and attempt. */
  readonly message: string;
  /** The node's own message. */
  readonly detail: string;
  /** The request it answered. */
  readonly request: ThreadForkInput;
}

/** The last submit that went nowhere: refused before it was sent. */
export interface ThreadForkAttemptRefusal {
  readonly message: string;
  /** The same request can go out once the connection is ready again. */
  readonly awaiting: boolean;
}

interface ThreadForkAttemptRestorePoint {
  readonly phase: ThreadForkAttemptPhase;
  readonly forkKey: ThreadForkKey;
  readonly bound: ThreadForkAttemptBinding | null;
  readonly failure: ThreadForkAttemptFailure | null;
  readonly refusal: ThreadForkAttemptRefusal | null;
}

export interface ThreadForkAttemptState {
  readonly boundary: ThreadForkAttemptBoundary;
  readonly forkKey: ThreadForkKey;
  /** The form: what the next request is built from. */
  readonly selection: ThreadForkSelection;
  /** What a base-ref start is prefilled with when the node refuses the checkpoint. */
  readonly defaultBaseRef: string;
  /** What the node may hold under `forkKey`; null when it holds nothing. */
  readonly bound: ThreadForkAttemptBinding | null;
  readonly phase: ThreadForkAttemptPhase;
  readonly failure: ThreadForkAttemptFailure | null;
  readonly refusal: ThreadForkAttemptRefusal | null;
  /** The node refused this turn's checkpoint; offer a base-ref start only. */
  readonly checkpointRefused: boolean;
  /** Counts submits, so an outcome only applies to the submit it answers. */
  readonly submission: number;
  /** While submitting: the state a request refused before sending returns to. */
  readonly restorePoint: ThreadForkAttemptRestorePoint | null;
  readonly result: ThreadForkResult | null;
  /**
   * When this client learned the fork was created (`Date.now()`); null until it succeeded. A
   * created fork whose thread has had time to arrive and is still missing was deleted since.
   */
  readonly settledAt: number | null;
}

/** Opens a new attempt: an editable form under a fresh key that the node has never seen. */
export function beginThreadForkAttempt(input: {
  readonly boundary: ThreadForkAttemptBoundary;
  readonly selection: ThreadForkSelection;
  /** The source branch or `HEAD` (`defaultThreadForkBaseRef`). */
  readonly defaultBaseRef: string;
  readonly mintKey: () => ThreadForkKey;
}): ThreadForkAttemptState {
  return {
    boundary: input.boundary,
    forkKey: input.mintKey(),
    selection: input.selection,
    defaultBaseRef: input.defaultBaseRef,
    bound: null,
    phase: "editing",
    failure: null,
    refusal: null,
    checkpointRefused: false,
    submission: 0,
    restorePoint: null,
    result: null,
    settledAt: null,
  };
}

/**
 * Whether the node may still be working on a request under the key: then only that request may
 * be sent again, and no other key may be minted, until the node answers definitively.
 */
export function isThreadForkAttemptLocked(state: ThreadForkAttemptState): boolean {
  return state.bound !== null && state.bound.nodeAttempt !== "stopped";
}

function canEditSelection(state: ThreadForkAttemptState): boolean {
  return (
    (state.phase === "editing" || state.phase === "failed") && !isThreadForkAttemptLocked(state)
  );
}

/** Applies a form change; ignored while the selection is locked or a request is in flight. */
export function updateThreadForkSelection(
  state: ThreadForkAttemptState,
  patch: Partial<ThreadForkSelection>,
): ThreadForkAttemptState {
  if (!canEditSelection(state)) return state;
  return { ...state, selection: { ...state.selection, ...patch } };
}

/** The form a request was built from (`buildThreadForkInput`'s inverse). */
export function threadForkSelectionOfRequest(request: ThreadForkInput): ThreadForkSelection {
  const { destination } = request;
  if (destination.kind !== "new-worktree") return { destination: destination.kind };
  return destination.start.kind === "base-ref"
    ? { destination: "new-worktree", worktreeStart: "base-ref", baseRef: destination.start.baseRef }
    : { destination: "new-worktree", worktreeStart: "checkpoint" };
}

/**
 * The attempt as a form shows and sends it. While the selection can change, a choice whose option
 * is unavailable reads as the first enabled option (options change as Git status loads or the
 * node refuses the checkpoint); with none enabled the choice stays as it was. While the attempt is
 * locked or in flight, the request the node may hold, which is the only one that can go out again.
 * Returns `state` itself when nothing changes, so it can be memoized on.
 */
export function alignThreadForkSelection(
  state: ThreadForkAttemptState,
  options: {
    readonly destinations: ReadonlyArray<ThreadForkDestinationOption>;
    readonly worktreeStarts: ReadonlyArray<ThreadForkWorktreeStartOption>;
  },
): ThreadForkAttemptState {
  const { selection } = state;
  let next: ThreadForkSelection;
  if (canEditSelection(state)) {
    const destination =
      effectiveThreadForkOption(options.destinations, selection.destination) ??
      selection.destination;
    next = {
      ...selection,
      destination,
      worktreeStart:
        destination === "new-worktree"
          ? effectiveThreadForkOption(options.worktreeStarts, selection.worktreeStart)
          : (selection.worktreeStart ?? null),
    };
  } else {
    const request = state.bound?.request ?? null;
    if (request === null) return state;
    next = { ...selection, ...threadForkSelectionOfRequest(request) };
  }
  const unchanged =
    next.destination === selection.destination &&
    (next.worktreeStart ?? null) === (selection.worktreeStart ?? null) &&
    (next.baseRef ?? null) === (selection.baseRef ?? null);
  return unchanged ? state : { ...state, selection: next };
}

function buildRequest(state: ThreadForkAttemptState, forkKey: ThreadForkKey) {
  return buildThreadForkInput({
    forkKey,
    sourceThreadId: state.boundary.sourceThreadId,
    sourceMessageId: state.boundary.sourceMessageId,
    selection: state.selection,
  });
}

function sameRequest(left: ThreadForkInput | null, right: ThreadForkInput): boolean {
  return left !== null && threadForkRequestSignature(left) === threadForkRequestSignature(right);
}

export type ThreadForkSubmitPreparation =
  | { readonly ok: true; readonly state: ThreadForkAttemptState; readonly input: ThreadForkInput }
  | {
      readonly ok: false;
      /**
       * - `busy`: a request is in flight.
       * - `settled`: the fork was created.
       * - `locked`: the node holds a request under the key that this client cannot resend.
       * - `invalid`: the selection cannot be sent yet (`message` says why).
       */
      readonly reason: "busy" | "settled" | "locked" | "invalid";
      readonly message: string;
    };

/**
 * The request the next submit sends, and the key it goes under:
 * - while locked, exactly the bound request (a retry under the same key);
 * - the current key when the node holds nothing for it, or holds this same request;
 * - a fresh key when the node holds a different request whose attempt stopped.
 * The returned state is `submitting` and binds the request as unknown until its outcome lands.
 */
export function prepareThreadForkSubmit(
  state: ThreadForkAttemptState,
  mintKey: () => ThreadForkKey,
): ThreadForkSubmitPreparation {
  if (state.phase === "submitting") {
    return { ok: false, reason: "busy", message: threadForkBusyMessage(state) };
  }
  if (state.phase === "succeeded") {
    return { ok: false, reason: "settled", message: THREAD_FORK_COPY.created };
  }
  let input: ThreadForkInput;
  if (isThreadForkAttemptLocked(state)) {
    const request = state.bound?.request ?? null;
    if (request === null) {
      return {
        ok: false,
        reason: "locked",
        message: state.failure?.message ?? THREAD_FORK_COPY.running,
      };
    }
    input = request;
  } else {
    const built = buildRequest(state, state.forkKey);
    if (!built.ok) return { ok: false, reason: "invalid", message: built.message };
    input = built.input;
    if (state.bound !== null && !sameRequest(state.bound.request, input)) {
      // The stopped attempt never resumes, and its key answers any other request with
      // idempotency-conflict: this request starts over under a key of its own.
      const rebuilt = buildRequest(state, mintKey());
      if (!rebuilt.ok) return { ok: false, reason: "invalid", message: rebuilt.message };
      input = rebuilt.input;
    }
  }
  return {
    ok: true,
    input,
    state: {
      ...state,
      phase: "submitting",
      forkKey: input.forkKey,
      bound: { request: input, nodeAttempt: "unknown" },
      refusal: null,
      submission: state.submission + 1,
      restorePoint: {
        phase: state.phase,
        forkKey: state.forkKey,
        bound: state.bound,
        failure: state.failure,
        refusal: state.refusal,
      },
      result: null,
      settledAt: null,
    },
  };
}

function threadForkBusyMessage(state: ThreadForkAttemptState): string {
  const request = state.bound?.request;
  return request ? threadForkBusyLabel(request.destination.kind) : THREAD_FORK_COPY.busy.creating;
}

/**
 * Applies the outcome of the submit `state` is waiting for. Outcomes of an earlier submit, or
 * any outcome while nothing is in flight, leave the state as it is.
 */
export function applyThreadForkOutcome(
  state: ThreadForkAttemptState,
  outcome: ThreadForkOutcome,
  submission: number = state.submission,
): ThreadForkAttemptState {
  const sent = state.bound?.request ?? null;
  if (state.phase !== "submitting" || submission !== state.submission || sent === null) {
    return state;
  }
  const settled = { ...state, restorePoint: null };
  switch (outcome.status) {
    case "succeeded":
      // The key holds a completed fork: asking again only replays it.
      return {
        ...settled,
        phase: "succeeded",
        bound: { request: sent, nodeAttempt: "stopped" },
        failure: null,
        result: outcome.result,
        settledAt: Date.now(),
      };
    case "refused": {
      // Nothing reached the node: whatever it held before this submit, it still holds.
      const before = state.restorePoint;
      if (before === null) return { ...settled, phase: "editing", bound: null };
      return {
        ...settled,
        phase: before.phase,
        forkKey: before.forkKey,
        bound: before.bound,
        failure: before.failure,
        refusal: { message: outcome.message, awaiting: outcome.awaiting },
      };
    }
    case "uncertain":
      return {
        ...settled,
        phase: "uncertain",
        bound: { request: sent, nodeAttempt: "unknown" },
        failure: null,
      };
    case "failed": {
      const failure: ThreadForkAttemptFailure = {
        reason: outcome.reason,
        retryable: outcome.retryable,
        attempt: outcome.attempt,
        message: outcome.message,
        detail: outcome.detail,
        request: sent,
      };
      const bound: ThreadForkAttemptBinding | null =
        outcome.reason === "idempotency-conflict"
          ? // The key holds some other request this client cannot resend.
            {
              request: null,
              nodeAttempt: outcome.attempt === "running" ? "running" : "stopped",
            }
          : outcome.attempt === "none"
            ? null
            : { request: sent, nodeAttempt: outcome.attempt };
      const running = bound?.nodeAttempt === "running";
      const failed: ThreadForkAttemptState = {
        ...settled,
        phase: running ? "running" : "failed",
        bound,
        failure,
      };
      if (outcome.reason !== "checkpoint-unavailable" || running) return failed;
      // The turn's checkpoint cannot start a worktree: offer the base-ref start, prefilled.
      const typedBaseRef = state.selection.baseRef?.trim();
      return {
        ...failed,
        checkpointRefused: true,
        selection: {
          destination: "new-worktree",
          worktreeStart: "base-ref",
          baseRef: typedBaseRef ? state.selection.baseRef : state.defaultBaseRef,
        },
      };
    }
  }
}

export interface ThreadForkAttemptNotice {
  readonly tone: "error" | "warning";
  readonly title: string;
  readonly message: string;
  /** A second line: the node's explanation of a preparation failure, or the locked state. */
  readonly detail: string | null;
}

export interface ThreadForkAttemptView {
  /** The node may hold a request under the key: the selection cannot change. */
  readonly locked: boolean;
  readonly canEdit: boolean;
  /** The primary action can run now. */
  readonly canSubmit: boolean;
  /** The primary action resends the exact last request under the same key. */
  readonly canRetry: boolean;
  /** The dialog may close (never while a request is in flight). */
  readonly canDismiss: boolean;
  readonly submitLabel: string;
  /** Shown instead of the primary action while a request is in flight. */
  readonly busyLabel: string | null;
  /** Why the selection cannot be sent yet. */
  readonly selectionError: string | null;
  readonly notice: ThreadForkAttemptNotice | null;
  /** The node refused the checkpoint: the base-ref start is selected and the checkpoint is off. */
  readonly suggestBaseRef: boolean;
}

function failureTitle(failure: ThreadForkAttemptFailure): string {
  const nothingKept = failure.attempt === "none" || failure.attempt === "stopped";
  return nothingKept && failure.reason !== "deleted" && failure.reason !== "idempotency-conflict"
    ? THREAD_FORK_COPY.titles.notCreated
    : THREAD_FORK_COPY.titles.failed;
}

/** Everything a dialog renders for an attempt, in shared words. */
export function threadForkAttemptView(state: ThreadForkAttemptState): ThreadForkAttemptView {
  const suggestBaseRef = state.checkpointRefused;
  if (state.phase === "submitting") {
    return {
      locked: true,
      canEdit: false,
      canSubmit: false,
      canRetry: false,
      canDismiss: false,
      submitLabel: THREAD_FORK_COPY.submit,
      busyLabel: threadForkBusyMessage(state),
      selectionError: null,
      notice: null,
      suggestBaseRef,
    };
  }
  if (state.phase === "succeeded") {
    return {
      locked: true,
      canEdit: false,
      canSubmit: false,
      canRetry: false,
      canDismiss: true,
      submitLabel: THREAD_FORK_COPY.submit,
      busyLabel: null,
      selectionError: null,
      notice: null,
      suggestBaseRef,
    };
  }
  if (isThreadForkAttemptLocked(state)) {
    const canRetry = (state.bound?.request ?? null) !== null;
    const running = state.bound?.nodeAttempt === "running";
    const lockedMessage = running
      ? (state.failure?.message ?? THREAD_FORK_COPY.running)
      : THREAD_FORK_COPY.uncertain;
    return {
      locked: true,
      canEdit: false,
      canSubmit: canRetry,
      canRetry,
      canDismiss: true,
      submitLabel: running ? THREAD_FORK_COPY.checkAgain : THREAD_FORK_COPY.retry,
      busyLabel: null,
      selectionError: null,
      notice: {
        tone: "warning",
        title: running ? THREAD_FORK_COPY.titles.running : THREAD_FORK_COPY.titles.uncertain,
        // A retry refused before sending says why; the fork may still exist either way.
        message: state.refusal?.message ?? lockedMessage,
        detail: state.refusal ? lockedMessage : null,
      },
      suggestBaseRef,
    };
  }
  const built = buildRequest(state, state.forkKey);
  const { failure, refusal } = state;
  const answersFailure =
    state.phase === "failed" &&
    failure !== null &&
    built.ok &&
    sameRequest(failure.request, built.input);
  const canRetry = answersFailure && failure.retryable;
  // Resending a request the node refused for good would only repeat the refusal.
  const repeatsFinalRefusal = answersFailure && !failure.retryable;
  const notice: ThreadForkAttemptNotice | null = refusal
    ? {
        tone: refusal.awaiting ? "warning" : "error",
        title: THREAD_FORK_COPY.titles.notSent,
        message: refusal.message,
        detail: null,
      }
    : state.phase === "failed" && failure !== null
      ? {
          tone: "error",
          title: failureTitle(failure),
          message: failure.message,
          detail:
            failure.reason === "preparation-failed" && failure.detail.trim().length > 0
              ? failure.detail
              : null,
        }
      : null;
  return {
    locked: false,
    canEdit: true,
    canSubmit: built.ok && !repeatsFinalRefusal,
    canRetry,
    canDismiss: true,
    submitLabel: canRetry ? THREAD_FORK_COPY.retry : THREAD_FORK_COPY.submit,
    busyLabel: null,
    selectionError: built.ok ? null : built.message,
    notice,
    suggestBaseRef,
  };
}

// ── Registry ───────────────────────────────────────────────────────────

const attempts = new Map<string, ThreadForkAttemptState>();
const settling = new Map<string, Promise<ThreadForkAttemptState>>();

function boundaryKey(boundary: ThreadForkAttemptBoundary): string {
  return `${boundary.environmentId}\u0000${boundary.sourceThreadId}\u0000${boundary.sourceMessageId}`;
}

/**
 * Whether an attempt must survive its dialog: a request in flight, a locked key, or a created
 * fork no dialog has opened yet (`acknowledgeThreadForkAttempt`).
 */
export function shouldRememberThreadForkAttempt(state: ThreadForkAttemptState): boolean {
  return (
    state.phase === "succeeded" || state.phase === "submitting" || isThreadForkAttemptLocked(state)
  );
}

/**
 * Keeps `state` for its boundary while it must survive its dialog, else forgets the boundary: a
 * settled failure starts over with a fresh attempt next time. A created fork is kept until a
 * dialog opened it, so one that went away before the answer arrived reopens onto that fork.
 */
export function rememberThreadForkAttempt(state: ThreadForkAttemptState): void {
  const key = boundaryKey(state.boundary);
  if (shouldRememberThreadForkAttempt(state)) attempts.set(key, state);
  else attempts.delete(key);
}

/** The attempt a dialog for the boundary reopens onto: unsettled, or created but not opened. */
export function restoreThreadForkAttempt(
  boundary: ThreadForkAttemptBoundary,
): ThreadForkAttemptState | null {
  return attempts.get(boundaryKey(boundary)) ?? null;
}

export function forgetThreadForkAttempt(boundary: ThreadForkAttemptBoundary): void {
  attempts.delete(boundaryKey(boundary));
}

/**
 * A dialog opened (or announced) the fork `state` created: the next fork from this reply is a new
 * one. Ignored when the registry holds another attempt for the boundary by then.
 */
export function acknowledgeThreadForkAttempt(state: ThreadForkAttemptState): void {
  const key = boundaryKey(state.boundary);
  const current = attempts.get(key);
  if (
    current?.phase === "succeeded" &&
    current.forkKey === state.forkKey &&
    current.submission === state.submission
  ) {
    attempts.delete(key);
  }
}

/** What a dialog opening for a boundary starts from. */
export interface ThreadForkAttemptOpening {
  readonly state: ThreadForkAttemptState;
  /**
   * While `state` is a request still in flight (the dialog reopened before its answer): the state
   * that request settles to. Read in the same step as `state`, so an answer landing before the
   * dialog follows it is never mistaken for a lost one. Null otherwise.
   */
  readonly settling: Promise<ThreadForkAttemptState> | null;
}

/**
 * The attempt a dialog for the boundary opens onto: the one a closed dialog left unsettled (same
 * key, same locked request, possibly still in flight) or created without opening, else a new one.
 */
export function openThreadForkAttempt(
  input: Parameters<typeof beginThreadForkAttempt>[0],
): ThreadForkAttemptOpening {
  const key = boundaryKey(input.boundary);
  const restored = attempts.get(key);
  if (restored === undefined) return { state: beginThreadForkAttempt(input), settling: null };
  if (restored.phase !== "submitting") return { state: restored, settling: null };
  const pending = settling.get(key);
  if (pending !== undefined) return { state: restored, settling: pending };
  // Recorded as in flight, but nothing will ever settle it (only a submitting state remembered
  // by hand gets here): its outcome is lost, so the fork may exist.
  const lost = applyThreadForkOutcome(restored, {
    status: "uncertain",
    message: THREAD_FORK_COPY.uncertain,
    error: null,
  });
  rememberThreadForkAttempt(lost);
  return { state: lost, settling: null };
}

/**
 * The connection check a submit of `state` runs right before sending
 * (`captureReviewedSendReadiness`). An attempt's first request is checked against the connection
 * the user reviewed the form under, captured when the dialog opened: a reconnect while they chose
 * refuses it. Every later request (Retry, Check again, a send after a refusal or a failure) is
 * checked against the connection live when the user pressed, captured now: an earlier send
 * already decided what goes out, and the connection that lost its answer has usually come back
 * by the time the user retries.
 */
export function threadForkSendReadiness(
  state: ThreadForkAttemptState,
  readiness: {
    /** Asserts the connection captured when the dialog opened. */
    readonly opened: () => void;
    /** Captures the live connection; the result asserts it. */
    readonly capture: () => () => void;
  },
): () => void {
  return state.submission === 0 ? readiness.opened : readiness.capture();
}

export type ThreadForkSubmission =
  | Extract<ThreadForkSubmitPreparation, { ok: false }>
  | {
      readonly ok: true;
      /** The `submitting` state to render now. */
      readonly state: ThreadForkAttemptState;
      readonly input: ThreadForkInput;
      /** The state after the node answered; also kept in the registry if the dialog is gone. */
      readonly settled: Promise<ThreadForkAttemptState>;
    };

/**
 * Submits an attempt: prepares the request and key, remembers the attempt while the request is
 * in flight, sends it through `runThreadFork` and records the outcome, also when the dialog
 * closed in between. Without an API to send to (`resolveThreadForkApi`) nothing is sent: the
 * refusal is recorded, which leaves whatever the node may already hold for the key exactly as it
 * was. Never throws.
 */
export function submitThreadForkAttempt(input: {
  readonly state: ThreadForkAttemptState;
  readonly mintKey: () => ThreadForkKey;
  /** The environment's fork API, or the refusal to record (`resolveThreadForkApi`). */
  readonly api: ThreadForkApi | ThreadForkApiRefusal;
  readonly assertMutationReady?: (() => void) | undefined;
}): ThreadForkSubmission {
  const prepared = prepareThreadForkSubmit(input.state, input.mintKey);
  if (!prepared.ok) return prepared;
  const submitting = prepared.state;
  const key = boundaryKey(submitting.boundary);
  rememberThreadForkAttempt(submitting);
  const { api } = input;
  const outcome: Promise<ThreadForkOutcome> =
    "refusal" in api
      ? Promise.resolve(api.refusal)
      : runThreadFork({
          api,
          input: prepared.input,
          assertMutationReady: input.assertMutationReady,
        });
  const settled = outcome.then((answer) => {
    const next = applyThreadForkOutcome(submitting, answer);
    const current = attempts.get(key);
    // Record it unless a newer attempt for the boundary took over meanwhile.
    if (
      current === undefined ||
      (current.forkKey === submitting.forkKey && current.submission === submitting.submission)
    ) {
      rememberThreadForkAttempt(next);
    }
    if (settling.get(key) === settled) settling.delete(key);
    return next;
  });
  settling.set(key, settled);
  return { ok: true, state: submitting, input: prepared.input, settled };
}
