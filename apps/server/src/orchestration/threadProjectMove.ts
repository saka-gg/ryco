/**
 * The decider's reading of a thread for "Move to project" (`thread.project.move`): whether it is
 * idle enough to move, and the checkpoint count its move record keeps (`@ryco/shared/threadMove`).
 *
 * @module orchestration/threadProjectMove
 */
import type { OrchestrationReadModel } from "@ryco/contracts";
import { hasQueuedTurnStart } from "@ryco/shared/threadSettlement";
import type { ThreadProjectMoveInput } from "@ryco/shared/threadMove";

import { isCheckpointRevertPending } from "./checkpointRevertPolicy.ts";
import { hasActionableContextHandoff } from "./commandInvariants.ts";
import { threadSettlementInput } from "./threadSettlementInput.ts";

type Thread = OrchestrationReadModel["threads"][number];

/** The busy signals of a thread at `occurredAt` (server time), as the move rule reads them. */
export function threadMoveIdleInput(
  readModel: OrchestrationReadModel,
  thread: Thread,
  occurredAt: string,
): Omit<ThreadProjectMoveInput, "archived" | "deleted" | "backgroundWorking"> {
  const settlement = threadSettlementInput(readModel, thread, occurredAt);
  return {
    sessionStatus: settlement.sessionStatus,
    latestTurnRunning: settlement.latestTurnState === "running",
    hasPendingApprovals: settlement.hasPendingApprovals,
    hasPendingUserInput: settlement.hasPendingUserInput,
    queuedTurn: hasQueuedTurnStart(settlement),
    contextHandoffPending: hasActionableContextHandoff(thread),
    checkpointRevertPending: isCheckpointRevertPending(thread.activities, settlement.nowMs),
  };
}

/** The newest checkpoint count, as the checkpoint reactor numbers the next baseline. */
export function latestCheckpointTurnCount(thread: Pick<Thread, "checkpoints">): number {
  return thread.checkpoints.reduce(
    (latest, checkpoint) => Math.max(latest, checkpoint.checkpointTurnCount),
    0,
  );
}
