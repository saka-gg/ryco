import type { EnvironmentId, ScopedThreadRef, ThreadId, TurnId } from "@ryco/contracts";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { scopeThreadRef, scopedThreadKey } from "../../scoped.ts";
import { deriveThreadActivityStatus } from "./threadActivityStatus.ts";
import type { SidebarThreadSummary } from "./types.ts";

export type ThreadNotificationKind = "approval" | "input" | "plan-ready" | "completed" | "failed";

export interface ThreadNotificationEvent {
  readonly id: string;
  readonly groupKey: string;
  readonly ref: ScopedThreadRef;
  readonly kind: ThreadNotificationKind;
  readonly title: string;
  readonly turnId: TurnId | null;
  readonly sequence: number;
  /** Opaque lifecycle token; revalidate with isCurrent immediately before delivery. */
  readonly generation: object;
}

type ThreadState = {
  readonly fingerprint: string;
  readonly terminalSeen: string | null;
  readonly notificationId: string | null;
};
type EnvironmentState = {
  readonly generation: object;
  sequence: number;
  readonly baselineSequence: number;
  readonly seenAtSequence: Set<ThreadId>;
  readonly threads: Map<ThreadId, ThreadState>;
};

function describe(thread: SidebarThreadSummary, nowMs: number) {
  const activity = deriveThreadActivityStatus(thread);
  const terminal = thread.latestTurn?.state;
  const terminalKey =
    terminal === "completed" || terminal === "error"
      ? JSON.stringify([thread.latestTurn!.turnId, terminal])
      : null;
  const suppressed = thread.archivedAt !== null || isThreadSnoozed(thread, nowMs);
  let kind: ThreadNotificationKind | null = null;
  if (!suppressed) {
    if (activity === "approval" || activity === "input" || activity === "plan-ready")
      kind = activity;
    else if (activity === "idle" && thread.latestTurn?.completedAt) {
      if (terminal === "completed") kind = "completed";
      if (terminal === "error") kind = "failed";
    }
  }
  return {
    kind,
    terminalKey,
    suppressed,
    fingerprint: JSON.stringify([kind, thread.latestTurn?.turnId ?? null]),
  };
}

/**
 * Pure projection of accepted shell transitions, with no OS or network delivery.
 * The connection lifecycle supplies a token only for a current synchronized shell.
 * Every connection attempt/resnapshot must baseline silently before observing live
 * thread updates. A resumed stream must baseline its already accepted local shell
 * before replaying updates; stale or absent baselines never produce notifications.
 */
export function createThreadNotificationProjector(input: {
  readonly readGeneration: (environmentId: EnvironmentId) => object | null;
}) {
  const environments = new Map<EnvironmentId, EnvironmentState>();
  const validSequence = (sequence: number) => Number.isSafeInteger(sequence) && sequence >= 0;
  const current = (environmentId: EnvironmentId, generation: object) => {
    const state = environments.get(environmentId);
    return input.readGeneration(environmentId) === generation && state?.generation === generation
      ? state
      : null;
  };
  // One accepted shell envelope can update multiple normalized thread rows.
  // Fence old envelopes globally and duplicate rows within the current envelope.
  const advance = (state: EnvironmentState, sequence: number, threadId: ThreadId): boolean => {
    if (!validSequence(sequence) || sequence <= state.baselineSequence || sequence < state.sequence)
      return false;
    if (sequence > state.sequence) {
      state.sequence = sequence;
      state.seenAtSequence.clear();
    }
    if (state.seenAtSequence.has(threadId)) return false;
    state.seenAtSequence.add(threadId);
    return true;
  };
  return {
    baseline(inputBaseline: {
      readonly environmentId: EnvironmentId;
      readonly generation: object;
      readonly sequence: number;
      readonly threads: ReadonlyArray<SidebarThreadSummary>;
      readonly nowMs: number;
    }): void {
      const { environmentId, generation, sequence, threads, nowMs } = inputBaseline;
      if (input.readGeneration(environmentId) !== generation || !validSequence(sequence)) return;
      const previous = environments.get(environmentId);
      if (previous?.generation === generation && previous.sequence > sequence) return;
      const baseline = new Map<ThreadId, ThreadState>();
      for (const thread of threads) {
        if (thread.environmentId !== environmentId) continue;
        const state = describe(thread, nowMs);
        baseline.set(thread.id, {
          fingerprint: state.fingerprint,
          terminalSeen: state.terminalKey,
          notificationId: null,
        });
      }
      environments.set(environmentId, {
        generation,
        sequence,
        baselineSequence: sequence,
        seenAtSequence: new Set(),
        threads: baseline,
      });
    },
    observe(update: {
      readonly generation: object;
      readonly sequence: number;
      readonly thread: SidebarThreadSummary;
      readonly nowMs: number;
    }): ThreadNotificationEvent | null {
      const { generation, sequence, thread, nowMs } = update;
      const state = current(thread.environmentId, generation);
      if (!state || !advance(state, sequence, thread.id)) return null;
      const previous = state.threads.get(thread.id);
      const next = describe(thread, nowMs);
      const terminalNotification = next.kind === "completed" || next.kind === "failed";
      const shouldNotify =
        previous !== undefined &&
        next.kind !== null &&
        next.fingerprint !== previous.fingerprint &&
        (!terminalNotification || next.terminalKey !== previous.terminalSeen);
      const notificationId = shouldNotify
        ? JSON.stringify([thread.environmentId, thread.id, sequence, next.kind])
        : next.fingerprint === previous?.fingerprint
          ? previous.notificationId
          : null;
      state.threads.set(thread.id, {
        fingerprint: next.fingerprint,
        terminalSeen:
          !previous || next.suppressed || terminalNotification || next.kind === "plan-ready"
            ? next.terminalKey
            : previous.terminalSeen,
        notificationId,
      });
      if (!shouldNotify || next.kind === null) return null;
      const ref = Object.freeze(scopeThreadRef(thread.environmentId, thread.id));
      return Object.freeze({
        id: notificationId!,
        groupKey: scopedThreadKey(ref),
        ref,
        kind: next.kind,
        title: thread.title,
        turnId: thread.latestTurn?.turnId ?? null,
        sequence,
        generation,
      });
    },
    /** Fence already queued events when reconnects or resolved requests overtake delivery. */
    isCurrent(event: ThreadNotificationEvent): boolean {
      const state = current(event.ref.environmentId, event.generation);
      return state?.threads.get(event.ref.threadId)?.notificationId === event.id;
    },
    remove(inputRemove: {
      readonly environmentId: EnvironmentId;
      readonly generation: object;
      readonly sequence: number;
      readonly threadId: ThreadId;
    }): void {
      const state = current(inputRemove.environmentId, inputRemove.generation);
      if (!state || !advance(state, inputRemove.sequence, inputRemove.threadId)) return;
      state.threads.delete(inputRemove.threadId);
    },
    clear: (environmentId: EnvironmentId) => {
      environments.delete(environmentId);
    },
    reset: () => {
      environments.clear();
    },
  };
}
