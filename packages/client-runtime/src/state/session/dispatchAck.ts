import type { TurnId } from "@ryco/contracts";

import type { QueueThreadView } from "../message-queue/threadView.ts";
import type { SessionPhase, Thread, ThreadSession } from "../threads/types.ts";

// ---------------------------------------------------------------------------
// Local-dispatch UI gate.
//
// This is the UI-busy gate. It is intentionally loose: any server reaction,
// including errors and `session-set(ready)`, must release the composer
// spinner. It must not be used to sequence sends. Queued sends use
// `resolveQueuedDispatchAck`.
// ---------------------------------------------------------------------------

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== undefined &&
      session.activeTurnId !== null &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

// ---------------------------------------------------------------------------
// Strict, message-scoped queued-dispatch gate.
//
// A queued send is acknowledged only by a turn that is not the snapshot's, by
// a `provider.turn.start.failed` naming the dispatched message, or by a
// `provider.turn.start.cancelled` naming it (a Stop settled it). Session
// churn (`session-set(ready)` from the startSession bind, `lastError`,
// `updatedAt`) is never an acknowledgement: a second `thread.turn.start` sent
// in that window is accepted by the decider and orphaned by the reactor.
// ---------------------------------------------------------------------------

export interface QueuedDispatchSnapshot {
  readonly messageId: string;
  readonly latestTurnId: TurnId | null;
  readonly activeTurnId: TurnId | null;
  readonly capturedAt: string;
}

export function captureQueuedDispatchSnapshot(
  view: {
    readonly latestTurn: { readonly turnId: TurnId } | null;
    readonly session: { readonly activeTurnId: TurnId | null } | null;
  } | null,
  messageId: string,
  nowIso: string,
): QueuedDispatchSnapshot {
  return {
    messageId,
    latestTurnId: view?.latestTurn?.turnId ?? null,
    activeTurnId: view?.session?.activeTurnId ?? null,
    capturedAt: nowIso,
  };
}

export type QueuedDispatchAck =
  | { readonly kind: "pending" }
  | { readonly kind: "started"; readonly turnId: TurnId }
  /**
   * A Stop cancelled the start before any turn existed. Settled like a
   * started-then-interrupted turn, never failed: the Stop placed its own hold.
   */
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly causeKey: string; readonly detail: string | null };

const PENDING_ACK: QueuedDispatchAck = { kind: "pending" };
const SETTLED_ACK: QueuedDispatchAck = { kind: "settled" };

export function resolveQueuedDispatchAck(input: {
  readonly snapshot: QueuedDispatchSnapshot;
  readonly view: Pick<
    QueueThreadView,
    "turnStartFailures" | "turnStartCancelledMessageIds" | "session" | "latestTurn"
  >;
}): QueuedDispatchAck {
  const { snapshot, view } = input;
  if (view.turnStartCancelledMessageIds.has(snapshot.messageId)) {
    return SETTLED_ACK;
  }
  const failure = view.turnStartFailures.find((entry) => entry.messageId === snapshot.messageId);
  if (failure) {
    return {
      kind: "failed",
      causeKey: `start-failed:${failure.activityId}`,
      detail: failure.detail,
    };
  }
  const activeTurnId = view.session?.activeTurnId ?? null;
  if (
    activeTurnId !== null &&
    activeTurnId !== snapshot.latestTurnId &&
    activeTurnId !== snapshot.activeTurnId
  ) {
    return { kind: "started", turnId: activeTurnId };
  }
  // Covers a turn that started and settled inside one applied batch.
  const latestTurnId = view.latestTurn?.turnId ?? null;
  if (latestTurnId !== null && latestTurnId !== snapshot.latestTurnId) {
    return { kind: "started", turnId: latestTurnId };
  }
  return PENDING_ACK;
}
