import type { OrchestrationReadModel } from "@ryco/contracts";
import { derivePendingThreadRequestState } from "@ryco/shared/threadActivity";
import { findThreadWorktree as threadWorktree } from "./commandInvariants.ts";

/**
 * Server-side settlement input. The server only checks manual settle and snooze
 * eligibility (`canSettleThread`/`canSnoozeThread`); it never auto-settles. Pins
 * are client-local and liveness is not in the read model, and neither ever gates
 * manual settlement, so both are passed as neutral values.
 */
export function threadSettlementInput(
  readModel: OrchestrationReadModel,
  thread: OrchestrationReadModel["threads"][number],
  occurredAt: string,
) {
  const pendingRequests = derivePendingThreadRequestState(thread.activities);
  const worktree = threadWorktree(readModel, thread);
  return {
    threadSettlementSupported: true,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    worktreeArchivedAt: worktree?.archivedAt ?? null,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    sessionStatus: thread.session?.status ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
    latestTurnRequestedAt: thread.latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: thread.latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
    latestUserMessageAt: latestUserMessageAt(thread),
    hasPendingApprovals: pendingRequests.hasPendingApprovals,
    hasPendingUserInput: pendingRequests.hasPendingUserInput,
    hasLocalQueuedMessage: false,
    deliveryUnknown: false,
    pinned: false,
    backgroundLiveness: null,
    prNumber: worktree?.prNumber ?? null,
    prState: worktree?.prState ?? null,
    prTerminalAt: worktree?.prTerminalAt ?? null,
    worktreeUpdatedAt: worktree?.updatedAt ?? null,
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    autoSettleAfterDays: null,
    nowMs: Date.parse(occurredAt),
  } satisfies import("@ryco/shared/threadSettlement").ThreadSettlementInput;
}

function latestUserMessageAt(thread: OrchestrationReadModel["threads"][number]): string | null {
  return (
    thread.messages
      .filter((message) => message.role === "user")
      .map((message) => message.createdAt)
      .toSorted()
      .at(-1) ?? null
  );
}
