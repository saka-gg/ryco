/**
 * projectorNames - the names projection cursors are stored under (`projection_state.projector`).
 *
 * Kept apart from the projection pipeline (`Layers/ProjectionPipeline.ts`) so readers that only
 * need the names, such as `ryco doctor`, which loads on demand, do not pull in the pipeline.
 *
 * @module projectorNames
 */
export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
  worktrees: "projection.worktrees",
  threadPullRequestWatches: "projection.thread-pull-request-watches",
  threadCommandWatches: "projection.thread-command-watches",
  threadFollowUpQueues: "projection.thread-follow-up-queues",
} as const;

export type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];
