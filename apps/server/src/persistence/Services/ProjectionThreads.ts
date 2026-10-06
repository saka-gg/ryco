/**
 * ProjectionThreadRepository - Projection repository interface for threads.
 *
 * Owns persistence operations for projected thread records in the
 * orchestration read model.
 *
 * @module ProjectionThreadRepository
 */
import {
  IsoDateTime,
  AgentTokenMode,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  StatusBucket,
  ThreadSettlementOverride,
  ThreadId,
  ThreadGoal,
  ThreadUsageLimit,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  tokenMode: Schema.optionalKey(AgentTokenMode),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  manualStatusBucket: Schema.optional(Schema.NullOr(StatusBucket)),
  manualPosition: Schema.optional(Schema.Number),
  latestTurnId: Schema.NullOr(TurnId),
  goal: Schema.NullOr(ThreadGoal),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(ThreadSettlementOverride),
  settledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  hasActionableProposedPlan: NonNegativeInt,
  usageLimit: Schema.optional(Schema.NullOr(ThreadUsageLimit)),
  deletedAt: Schema.NullOr(IsoDateTime),
  /**
   * Set while the thread is in Trash (`deletedAt` is set too, hiding it everywhere).
   * Required for the same reason as lineage: a SELECT that skipped it would let the
   * next `...existingRow` upsert turn a recoverable thread into a deleted one.
   */
  trashedAt: Schema.NullOr(IsoDateTime),
  /**
   * Delegation lineage columns. Required on purpose: every SELECT must read them,
   * otherwise the next `...existingRow` upsert would silently wipe the lineage.
   */
  lineageParentThreadId: Schema.NullOr(ThreadId),
  lineageRootThreadId: Schema.NullOr(ThreadId),
  lineageRelationship: Schema.NullOr(Schema.String),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

export const AttachProjectionThreadToWorktreeInput = Schema.Struct({
  threadId: ThreadId,
  worktreeId: Schema.NullOr(WorktreeId),
});
export type AttachProjectionThreadToWorktreeInput =
  typeof AttachProjectionThreadToWorktreeInput.Type;

export const SetProjectionThreadManualBucketInput = Schema.Struct({
  threadId: ThreadId,
  bucket: Schema.NullOr(StatusBucket),
});
export type SetProjectionThreadManualBucketInput = typeof SetProjectionThreadManualBucketInput.Type;

export const SetProjectionThreadManualPositionInput = Schema.Struct({
  threadId: ThreadId,
  position: Schema.Number,
});
export type SetProjectionThreadManualPositionInput =
  typeof SetProjectionThreadManualPositionInput.Type;

export const ProjectionTrashedThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.NullOr(Schema.String),
  projectDeletedAt: Schema.NullOr(IsoDateTime),
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  worktreeId: Schema.NullOr(WorktreeId),
  archivedAt: Schema.NullOr(IsoDateTime),
  trashedAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionTrashedThread = typeof ProjectionTrashedThread.Type;

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export interface ProjectionThreadRepositoryShape {
  /**
   * Insert or replace a projected thread row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread row by id.
   */
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * List projected threads for a project.
   *
   * Returned in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * Soft-delete a projected thread row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly attachToWorktree: (
    input: AttachProjectionThreadToWorktreeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly setManualBucket: (
    input: SetProjectionThreadManualBucketInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly setManualPosition: (
    input: SetProjectionThreadManualPositionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Live (not archived, not deleted) threads with a recorded usage limit, oldest first.
   * Bounded; the usage-limit recovery worker sweeps them.
   */
  readonly listUsageLimitedThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionRepositoryError
  >;

  /** Threads in Trash, most recently trashed first. Bounded by `limit`. */
  readonly listTrashed: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ProjectionTrashedThread>, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends Context.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("ryco/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
