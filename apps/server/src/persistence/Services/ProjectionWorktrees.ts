/**
 * ProjectionWorktreeRepository - Projection repository interface for worktrees.
 *
 * Owns persistence operations for projected worktree records in the
 * orchestration read model.
 *
 * @module ProjectionWorktreeRepository
 */
import {
  IsoDateTime,
  ProjectId,
  WorkItemProviderKind,
  Worktree,
  WorktreeId,
} from "@ryco/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorktree = Worktree;
export type ProjectionWorktree = typeof ProjectionWorktree.Type;

export const GetProjectionWorktreeInput = Schema.Struct({
  worktreeId: WorktreeId,
});
export type GetProjectionWorktreeInput = typeof GetProjectionWorktreeInput.Type;

export const ListProjectionWorktreesByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionWorktreesByProjectInput =
  typeof ListProjectionWorktreesByProjectInput.Type;

export const FindProjectionWorktreeByOriginInput = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.Literals(["pr", "issue"]),
  number: Schema.Number,
});
export type FindProjectionWorktreeByOriginInput = typeof FindProjectionWorktreeByOriginInput.Type;

export const FindActiveProjectionWorktreesByLinkedNumberInput = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.Literals(["pr", "issue"]),
  number: Schema.Number,
});
export type FindActiveProjectionWorktreesByLinkedNumberInput =
  typeof FindActiveProjectionWorktreesByLinkedNumberInput.Type;

export const FindProjectionWorktreeByWorkItemInput = Schema.Struct({
  projectId: ProjectId,
  provider: WorkItemProviderKind,
  key: Schema.String,
});
export type FindProjectionWorktreeByWorkItemInput =
  typeof FindProjectionWorktreeByWorkItemInput.Type;

export const FindProjectionWorktreeByPathInput = Schema.Struct({
  worktreePath: Schema.String,
});
export type FindProjectionWorktreeByPathInput = typeof FindProjectionWorktreeByPathInput.Type;

export const MarkProjectionWorktreeArchivedInput = Schema.Struct({
  worktreeId: WorktreeId,
  archivedAt: IsoDateTime,
});
export type MarkProjectionWorktreeArchivedInput = typeof MarkProjectionWorktreeArchivedInput.Type;

export const MarkProjectionWorktreeRestoredInput = Schema.Struct({
  worktreeId: WorktreeId,
  restoredAt: IsoDateTime,
});
export type MarkProjectionWorktreeRestoredInput = typeof MarkProjectionWorktreeRestoredInput.Type;

export const UpdateProjectionWorktreeMetaInput = Schema.Struct({
  worktreeId: WorktreeId,
  title: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type UpdateProjectionWorktreeMetaInput = typeof UpdateProjectionWorktreeMetaInput.Type;

export const SetProjectionWorktreeManualPositionInput = Schema.Struct({
  worktreeId: WorktreeId,
  position: Schema.Number,
});
export type SetProjectionWorktreeManualPositionInput =
  typeof SetProjectionWorktreeManualPositionInput.Type;

export interface ProjectionWorktreeRepositoryShape {
  readonly upsert: (worktree: ProjectionWorktree) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getById: (
    input: GetProjectionWorktreeInput,
  ) => Effect.Effect<Option.Option<ProjectionWorktree>, ProjectionRepositoryError>;

  readonly listByProjectId: (
    input: ListProjectionWorktreesByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionWorktree>, ProjectionRepositoryError>;

  readonly findByOrigin: (
    input: FindProjectionWorktreeByOriginInput,
  ) => Effect.Effect<WorktreeId | null, ProjectionRepositoryError>;

  readonly findActiveByLinkedNumber: (
    input: FindActiveProjectionWorktreesByLinkedNumberInput,
  ) => Effect.Effect<ReadonlyArray<WorktreeId>, ProjectionRepositoryError>;

  readonly findByWorkItem: (
    input: FindProjectionWorktreeByWorkItemInput,
  ) => Effect.Effect<WorktreeId | null, ProjectionRepositoryError>;

  /** The live (not archived, checkout present) workspace checked out at `worktreePath`. */
  readonly findActiveByWorktreePath: (
    input: FindProjectionWorktreeByPathInput,
  ) => Effect.Effect<Option.Option<ProjectionWorktree>, ProjectionRepositoryError>;

  readonly markArchived: (
    input: MarkProjectionWorktreeArchivedInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly markRestored: (
    input: MarkProjectionWorktreeRestoredInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly updateMeta: (
    input: UpdateProjectionWorktreeMetaInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly deleteById: (
    input: GetProjectionWorktreeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly setManualPosition: (
    input: SetProjectionWorktreeManualPositionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionWorktreeRepository extends Context.Service<
  ProjectionWorktreeRepository,
  ProjectionWorktreeRepositoryShape
>()("ryco/persistence/Services/ProjectionWorktrees/ProjectionWorktreeRepository") {}
