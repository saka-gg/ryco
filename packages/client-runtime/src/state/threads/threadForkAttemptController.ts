/**
 * One opening of a fork dialog or sheet, on top of the shared fork-attempt state machine
 * (`threadForkAttempt.ts`). Web's dialog and the native sheet both drive their attempt through
 * it, so the lifecycle around a request is one implementation:
 * - the attempt it opens onto, read together with the outcome of a request still in flight;
 * - which connection each send is checked against (`threadForkSendReadiness`);
 * - following a request a reopened dialog inherited, and applying outcomes only to the submit
 *   they answer;
 * - staying open while a request or the created fork's opening is in flight;
 * - opening a created fork once its thread arrived (also one created while no dialog was open)
 *   and only then letting the next "Fork from here" start a new one;
 * - starting a new attempt instead when a fork created while no dialog was open was deleted or
 *   trashed since (its thread will never arrive).
 * The apps only render the snapshot and supply the platform through `ports`. Plain TypeScript:
 * no React, DOM or React Native.
 */
import type { EnvironmentId, ThreadForkKey, ThreadForkResult } from "@ryco/contracts";

import { scopeThreadRef } from "../../scoped.ts";

import {
  THREAD_FORK_SHELL_TIMEOUT_MS,
  type ThreadForkApi,
  type ThreadForkApiRefusal,
  type ThreadForkSelection,
} from "./threadFork.ts";
import {
  acknowledgeThreadForkAttempt,
  beginThreadForkAttempt,
  isThreadForkAttemptLocked,
  openThreadForkAttempt,
  submitThreadForkAttempt,
  threadForkAttemptView,
  threadForkSendReadiness,
  updateThreadForkSelection,
  type ThreadForkAttemptBoundary,
  type ThreadForkAttemptState,
} from "./threadForkAttempt.ts";
import { selectThreadAvailabilityByRef, useStore, type ThreadAvailability } from "./store.ts";
import { waitForThreadShell, type ThreadShellSource } from "./waitForThreadShell.ts";

/** What a dialog renders from. Replaced, never mutated, so `useSyncExternalStore` can compare. */
export interface ThreadForkAttemptSnapshot {
  readonly attempt: ThreadForkAttemptState;
  /** The fork was created; the dialog waits for its thread to arrive before opening it. */
  readonly opening: boolean;
  /**
   * `attempt` is a fork created while no dialog showed it, restored from the registry. Its
   * opening may be cancelled: nothing is in flight, and the registry keeps it for the next one.
   */
  readonly restored: boolean;
}

/** The platform side of a dialog: keys, connections, the fork API and the shell wait. */
export interface ThreadForkAttemptControllerPorts {
  readonly mintKey: () => ThreadForkKey;
  /**
   * Captures the environment's live connection (`captureReviewedSendReadiness` with
   * `THREAD_FORK_COPY.connectionChanged`); the result asserts it right before a send.
   */
  readonly captureReadiness: () => () => void;
  /** The environment's fork API at the moment of a send (`resolveThreadForkApi`). */
  readonly resolveApi: () => ThreadForkApi | ThreadForkApiRefusal;
  /**
   * Resolves true once the fork's thread reached this client, false on timeout or abort
   * (`waitForThreadForkShell`).
   */
  readonly waitForShell: (result: ThreadForkResult, signal: AbortSignal) => Promise<boolean>;
  /** Whether the fork's thread is on its environment now (`threadForkAvailability`). */
  readonly readAvailability: (result: ThreadForkResult) => ThreadAvailability;
}

export interface ThreadForkAttemptController {
  readonly getSnapshot: () => ThreadForkAttemptSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** A form change; ignored while the attempt is locked or a request is in flight. */
  readonly select: (patch: Partial<ThreadForkSelection>) => void;
  /**
   * Sends the attempt: the bound request again while it is locked, else `selection` (the form's
   * effective selection, `alignThreadForkSelection`; null when no destination can be sent, which
   * sends nothing unless the attempt is locked).
   */
  readonly submit: (selection: ThreadForkSelection | null) => void;
  /**
   * Whether the dialog may close now (Cancel, Escape, swipe, Android back). Never while a request
   * is in flight or the fork it created is being opened: closing would hide an outcome the node
   * still produces. A fork created while no dialog showed it may stop opening: the registry
   * keeps it for the next "Fork from here".
   */
  readonly requestClose: () => boolean;
  /** The dialog is showing: act on outcomes, and open a fork created while none was. */
  readonly start: () => void;
  /** The dialog is gone: stop acting. An in-flight request still records its outcome. */
  readonly stop: () => void;
}

/** Whether a dialog showing `snapshot` may close. */
export function isThreadForkAttemptDismissible(snapshot: ThreadForkAttemptSnapshot): boolean {
  return (
    (!snapshot.opening || snapshot.restored) && threadForkAttemptView(snapshot.attempt).canDismiss
  );
}

/**
 * Waits for a created fork's thread to reach this client before it is opened, so it never shows
 * blank or without its checkout (a new worktree also waits for the shell's attachment). Resolves
 * false after `THREAD_FORK_SHELL_TIMEOUT_MS` or on abort; a slow stream still opens the fork.
 */
export function waitForThreadForkShell(input: {
  readonly environmentId: EnvironmentId;
  readonly result: ThreadForkResult;
  readonly signal?: AbortSignal | undefined;
  readonly store?: ThreadShellSource | undefined;
}): Promise<boolean> {
  const { result } = input;
  return waitForThreadShell({
    environmentId: input.environmentId,
    threadId: result.threadId,
    timeoutMs: THREAD_FORK_SHELL_TIMEOUT_MS,
    worktreeId: result.checkout.kind === "new-worktree" ? result.checkout.worktreeId : null,
    signal: input.signal,
    store: input.store,
  });
}

/** Whether a created fork's thread is on its environment now (`selectThreadAvailabilityByRef`). */
export function threadForkAvailability(input: {
  readonly environmentId: EnvironmentId;
  readonly result: ThreadForkResult;
  readonly store?: Pick<ThreadShellSource, "getState"> | undefined;
}): ThreadAvailability {
  const state = (input.store ?? useStore).getState();
  return selectThreadAvailabilityByRef(
    state,
    scopeThreadRef(input.environmentId, input.result.threadId),
  );
}

/** A dialog's view of a created fork's thread on this client's threads store. */
export function threadForkShellPorts(
  environmentId: EnvironmentId,
  store?: ThreadShellSource,
): Pick<ThreadForkAttemptControllerPorts, "waitForShell" | "readAvailability"> {
  return {
    waitForShell: (result, signal) =>
      waitForThreadForkShell({ environmentId, result, signal, store }),
    readAvailability: (result) => threadForkAvailability({ environmentId, result, store }),
  };
}

/**
 * Opens a dialog's attempt for `boundary`: the attempt a closed dialog left for the same reply
 * (same key, same locked request, possibly still in flight, or created but never opened), else
 * a fresh one.
 */
export function createThreadForkAttemptController(input: {
  readonly boundary: ThreadForkAttemptBoundary;
  readonly initialSelection: ThreadForkSelection;
  /** The source branch or `HEAD` (`defaultThreadForkBaseRef`). */
  readonly defaultBaseRef: string;
  readonly ports: ThreadForkAttemptControllerPorts;
  /**
   * Open the created fork now (`arrived`: its thread reached this client; false after a timeout).
   * Called once per controller, only while it is started.
   */
  readonly onForked: (result: ThreadForkResult, arrived: boolean) => void;
}): ThreadForkAttemptController {
  const { ports } = input;
  const opened = openThreadForkAttempt({
    boundary: input.boundary,
    selection: input.initialSelection,
    defaultBaseRef: input.defaultBaseRef,
    mintKey: ports.mintKey,
  });
  let snapshot: ThreadForkAttemptSnapshot = {
    attempt: opened.state,
    opening: false,
    // Created while no dialog showed it (a fresh or in-flight attempt is never succeeded yet).
    restored: opened.state.phase === "succeeded",
  };
  const listeners = new Set<() => void>();
  // The connection the user reviews the form against: the one live when the dialog opened.
  const openedReadiness = ports.captureReadiness();
  let active = false;
  let lifetime: AbortController | null = null;
  // The fork was opened; a later start never opens it a second time.
  let forked = false;

  const publish = (next: ThreadForkAttemptSnapshot) => {
    if (
      next.attempt === snapshot.attempt &&
      next.opening === snapshot.opening &&
      next.restored === snapshot.restored
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  /**
   * A restored fork that is gone: its thread had the time a dialog waits for it to arrive, and
   * the environment's current snapshot still lacks it, so it was deleted or moved to Trash since.
   * A fork created moments ago whose thread is still on its way never counts as gone.
   */
  const restoredForkGone = (attempt: ThreadForkAttemptState): boolean =>
    snapshot.restored &&
    attempt.result !== null &&
    attempt.settledAt !== null &&
    Date.now() - attempt.settledAt >= THREAD_FORK_SHELL_TIMEOUT_MS &&
    ports.readAvailability(attempt.result) === "missing";

  /** Forgets a restored fork that is gone: this opening is a new attempt from the reply. */
  const startOver = (attempt: ThreadForkAttemptState) => {
    acknowledgeThreadForkAttempt(attempt);
    publish({
      attempt: beginThreadForkAttempt({
        boundary: input.boundary,
        selection: input.initialSelection,
        defaultBaseRef: input.defaultBaseRef,
        mintKey: ports.mintKey,
      }),
      opening: false,
      restored: false,
    });
  };

  const open = (attempt: ThreadForkAttemptState) => {
    const { result } = attempt;
    const signal = lifetime?.signal;
    if (!signal || result === null || snapshot.opening || forked) return;
    // Never wait for, announce or navigate to a fork that is known to be gone.
    if (restoredForkGone(attempt)) {
      startOver(attempt);
      return;
    }
    publish({ ...snapshot, opening: true });
    void ports.waitForShell(result, signal).then((arrived) => {
      // A slow stream still opens the fork; a dialog that went away does not, and leaves the
      // created fork in the registry for the next opening.
      if (signal.aborted || !active) return;
      if (!arrived && restoredForkGone(attempt)) {
        startOver(attempt);
        return;
      }
      forked = true;
      acknowledgeThreadForkAttempt(attempt);
      input.onForked(result, arrived);
    });
  };

  /** Applies the outcome of the submit the attempt is waiting for, whoever sent it. */
  const follow = (settled: Promise<ThreadForkAttemptState>, submission: number) => {
    void settled.then((next) => {
      const current = snapshot.attempt;
      if (
        current.phase !== "submitting" ||
        current.submission !== submission ||
        next.submission !== submission
      ) {
        return;
      }
      publish({ attempt: next, opening: false, restored: false });
      if (active && next.phase === "succeeded") open(next);
    });
  };

  // A dialog that reopened while this reply's request was in flight waits for its answer. The
  // promise was read together with the attempt, so an answer that lands before the dialog shows
  // still settles it with the real outcome.
  if (opened.settling !== null) follow(opened.settling, opened.state.submission);

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select: (patch) => {
      publish({ ...snapshot, attempt: updateThreadForkSelection(snapshot.attempt, patch) });
    },
    submit: (selection) => {
      if (snapshot.opening) return;
      let state = snapshot.attempt;
      if (selection !== null) state = updateThreadForkSelection(state, selection);
      else if (!isThreadForkAttemptLocked(state)) return;
      const submission = submitThreadForkAttempt({
        state,
        mintKey: ports.mintKey,
        api: ports.resolveApi(),
        assertMutationReady: threadForkSendReadiness(state, {
          opened: openedReadiness,
          capture: ports.captureReadiness,
        }),
      });
      if (!submission.ok) {
        publish({ ...snapshot, attempt: state });
        return;
      }
      publish({ attempt: submission.state, opening: false, restored: false });
      follow(submission.settled, submission.state.submission);
    },
    requestClose: () => isThreadForkAttemptDismissible(snapshot),
    start: () => {
      if (active) return;
      active = true;
      lifetime = new AbortController();
      // Created while no dialog was showing it (or before this one started): open it now, or
      // start over when it was deleted since.
      if (snapshot.attempt.phase === "succeeded") open(snapshot.attempt);
    },
    stop: () => {
      if (!active) return;
      active = false;
      lifetime?.abort();
      lifetime = null;
      if (snapshot.opening) publish({ ...snapshot, opening: false });
    },
  };
}
