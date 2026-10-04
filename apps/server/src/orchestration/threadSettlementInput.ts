import type { OrchestrationReadModel, OrchestrationThreadShell } from "@ryco/contracts";
import { derivePendingThreadRequestState } from "@ryco/shared/threadActivity";
import type { ThreadSettlementInput } from "@ryco/shared/threadSettlement";
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
  } satisfies ThreadSettlementInput;
}

/**
 * Settlement input from a projected thread shell. Used where only shells are
 * loaded (checkpoint revert re-checks and neighbour safety); the busy and
 * activity signals match `threadSettlementInput`, and fields a shell does not
 * carry are passed as neutral values.
 */
export function threadShellSettlementInput(
  shell: OrchestrationThreadShell,
  nowIso: string,
): ThreadSettlementInput {
  return {
    threadSettlementSupported: true,
    archivedAt: shell.archivedAt,
    deletedAt: null,
    worktreeArchivedAt: null,
    settledOverride: shell.settledOverride,
    settledAt: shell.settledAt,
    sessionStatus: shell.session?.status ?? null,
    latestTurnState: shell.latestTurn?.state ?? null,
    latestTurnRequestedAt: shell.latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: shell.latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: shell.latestTurn?.completedAt ?? null,
    latestUserMessageAt: shell.latestUserMessageAt,
    hasPendingApprovals: shell.hasPendingApprovals,
    hasPendingUserInput: shell.hasPendingUserInput,
    hasLocalQueuedMessage: false,
    deliveryUnknown: false,
    pinned: false,
    backgroundLiveness: shell.backgroundLiveness ?? null,
    prNumber: null,
    prState: null,
    prTerminalAt: null,
    worktreeUpdatedAt: null,
    updatedAt: shell.updatedAt,
    createdAt: shell.createdAt,
    autoSettleAfterDays: null,
    nowMs: Date.parse(nowIso),
  };
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
