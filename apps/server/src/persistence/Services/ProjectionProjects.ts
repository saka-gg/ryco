/**
 * ProjectionProjectRepository - Projection repository interface for projects.
 *
 * Owns persistence operations for project rows in the orchestration projection
 * read model.
 *
 * @module ProjectionProjectRepository
 */
import {
  IsoDateTime,
  ModelSelection,
  ProjectId,
  ProjectKind,
  ProjectMetadataDir,
  ProjectScript,
} from "@ryco/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProject = Schema.Struct({
  projectId: ProjectId,
  kind: ProjectKind,
  title: Schema.String,
  workspaceRoot: Schema.String,
  projectMetadataDir: ProjectMetadataDir,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  customSystemPrompt: Schema.optional(Schema.NullOr(Schema.String)),
  customAvatarContentHash: Schema.NullOr(Schema.String),
  preferredRemoteName: Schema.NullOr(Schema.String),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProject = typeof ProjectionProject.Type;

export const GetProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type GetProjectionProjectInput = typeof GetProjectionProjectInput.Type;

export const DeleteProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteProjectionProjectInput = typeof DeleteProjectionProjectInput.Type;

/**
 * An active project's persisted repository identity bookkeeping (migration 086). The JSON is
 * kept raw: it is a cache, so a row that no longer decodes is re-resolved, never fatal.
 */
export const ProjectionProjectRepositoryIdentityState = Schema.Struct({
  projectId: ProjectId,
  kind: ProjectKind,
  workspaceRoot: Schema.String,
  repositoryIdentityJson: Schema.NullOr(Schema.String),
  fingerprint: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProjectRepositoryIdentityState =
  typeof ProjectionProjectRepositoryIdentityState.Type;

export const ListProjectionProjectRepositoryIdentityStatesInput = Schema.Struct({
  /** Only this project; every active project when absent. */
  projectId: Schema.optional(ProjectId),
});
export type ListProjectionProjectRepositoryIdentityStatesInput =
  typeof ListProjectionProjectRepositoryIdentityStatesInput.Type;

export const RecordProjectionProjectRepositoryIdentityInput = Schema.Struct({
  projectId: ProjectId,
  /** The root the identity was resolved for; a project moved meanwhile is left untouched. */
  workspaceRoot: Schema.String,
  repositoryIdentityJson: Schema.NullOr(Schema.String),
  fingerprint: Schema.NullOr(Schema.String),
  checkedAt: IsoDateTime,
});
export type RecordProjectionProjectRepositoryIdentityInput =
  typeof RecordProjectionProjectRepositoryIdentityInput.Type;

export const ListOrphanChatProjectsInput = Schema.Struct({
  /** Exclusive: chats created at or after this instant may still be retrying a first send. */
  createdBefore: IsoDateTime,
});
export type ListOrphanChatProjectsInput = typeof ListOrphanChatProjectsInput.Type;

/**
 * ProjectionProjectRepositoryShape - Service API for projected project records.
 */
export interface ProjectionProjectRepositoryShape {
  /**
   * Insert or replace a projected project row.
   *
   * Upserts by `projectId` and persists scripts through JSON encoding.
   */
  readonly upsert: (row: ProjectionProject) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected project row by id.
   */
  readonly getById: (
    input: GetProjectionProjectInput,
  ) => Effect.Effect<Option.Option<ProjectionProject>, ProjectionRepositoryError>;

  /**
   * List all projected project rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionProject>,
    ProjectionRepositoryError
  >;

  /**
   * Soft-delete a projected project row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Active (not deleted) projects with their persisted repository identity bookkeeping.
   */
  readonly listRepositoryIdentityStates: (
    input?: ListProjectionProjectRepositoryIdentityStatesInput,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionProjectRepositoryIdentityState>,
    ProjectionRepositoryError
  >;

  /**
   * Store a resolved repository identity. Only applies while the project still has the
   * workspace root it was resolved for; returns whether a row was updated.
   */
  readonly recordRepositoryIdentity: (
    input: RecordProjectionProjectRepositoryIdentityInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Active chat projects created before the cutoff with no conversation: every thread row they
   * have, if any, is a rolled-back creation (see `isRolledBackThreadCreation`). One anti-join
   * instead of a thread read per chat.
   */
  readonly listOrphanChatProjects: (
    input: ListOrphanChatProjectsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionProject>, ProjectionRepositoryError>;
}

/**
 * ProjectionProjectRepository - Service tag for project projection persistence.
 */
export class ProjectionProjectRepository extends Context.Service<
  ProjectionProjectRepository,
  ProjectionProjectRepositoryShape
>()("ryco/persistence/Services/ProjectionProjects/ProjectionProjectRepository") {}
