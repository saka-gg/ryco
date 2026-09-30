import type { OrchestrationReadModel } from "@ryco/contracts";
import { derivePendingThreadRequestState } from "@ryco/shared/threadActivity";
import { findThreadWorktree as threadWorktree } from "./commandInvariants.ts";

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
    prState: worktree?.prState ?? null,
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
