/**
 * The shape of the engine's command read model: what the decider and the command invariants read,
 * and no more. The live projector (projector.ts) and the hydration after a restart
 * (ProjectionSnapshotQuery.getCommandReadModel) both build it from these rules, so a long-running
 * server holds the same slim model as a freshly booted one.
 *
 * - Messages: only user messages, as anchors without text or attachments (the decider reads their
 *   id, role, creation time and order: thread started, the delegated-return fence and settlement
 *   recency).
 * - Plans: ids and timestamps; the decider only checks that a source plan exists.
 * - Activities: only the kinds in {@link COMMAND_READ_MODEL_ACTIVITY_KINDS}.
 * - Checkpoints: summaries without their changed-file lists. Only the projector's own revert
 *   handler reads them (turn counts and refs); every checkpoint consumer outside the engine reads
 *   the projection tables.
 *
 * @module orchestration/commandReadModelShape
 */
import {
  CHECKPOINT_REVERT_ACTIVITY_KIND,
  THREAD_FORKED_ACTIVITY_KIND,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@ryco/contracts";

export const COMMAND_MODEL_OMITTED_PLAN_MARKDOWN = "(not loaded in the command read model)";

/**
 * Every activity kind a command-model reader looks at:
 * - approval and user-input lifecycles (`derivePendingThreadRequests`, the request invariants,
 *   settlement and restart continuation);
 * - context handoffs and fork records (`hasActionableContextHandoff`,
 *   `forkContextHandoffPending`); both are also activity-cap milestones;
 * - turn starts that ended before dispatch (`hasActionableContextHandoff`);
 * - the checkpoint revert journal (`isCheckpointRevertPending`, the decider's turn-start guard).
 *
 * Hydration reads them through `idx_projection_thread_activities_kind_order` (migration 085;
 * plan-guarded). Adding a reader of another kind means adding the kind here.
 */
export const COMMAND_READ_MODEL_ACTIVITY_KINDS = [
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.response.submitted",
  "approval.response.submitted",
  "user-input.resolved",
  "provider.user-input.respond.failed",
  "context-handoff",
  THREAD_FORKED_ACTIVITY_KIND,
  "provider.turn.start.failed",
  "provider.turn.start.cancelled",
  CHECKPOINT_REVERT_ACTIVITY_KIND,
] as const;

const COMMAND_READ_MODEL_ACTIVITY_KIND_SET: ReadonlySet<string> = new Set(
  COMMAND_READ_MODEL_ACTIVITY_KINDS,
);

/** Whether the command read model keeps activities of this kind. */
export function isCommandModelActivityKind(kind: string): boolean {
  return COMMAND_READ_MODEL_ACTIVITY_KIND_SET.has(kind);
}

export function commandModelMessage(
  message: Omit<OrchestrationMessage, "text" | "attachments">,
): OrchestrationMessage {
  return { ...message, text: "" };
}

export function commandModelProposedPlan(
  plan: OrchestrationThread["proposedPlans"][number],
): OrchestrationThread["proposedPlans"][number] {
  return plan.planMarkdown === COMMAND_MODEL_OMITTED_PLAN_MARKDOWN
    ? plan
    : { ...plan, planMarkdown: COMMAND_MODEL_OMITTED_PLAN_MARKDOWN };
}

export function commandModelCheckpoint(
  checkpoint: OrchestrationCheckpointSummary,
): OrchestrationCheckpointSummary {
  return checkpoint.files.length === 0 ? checkpoint : { ...checkpoint, files: [] };
}
