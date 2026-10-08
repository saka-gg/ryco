/**
 * ProjectRelocationRepository - The crash-safe journal for moving a project's folder.
 *
 * "Turn into project…" moves a chat's folder to a new place. A row is written before any file
 * moves and is advanced as the move progresses, so startup recovery can tell what an
 * interrupted move left behind: `pending` (nothing verified at the destination yet), `moved`
 * (the destination is complete), then `done` or `failed`.
 *
 * @module ProjectRelocationRepository
 */
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "@ryco/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectRelocationState = Schema.Literals(["pending", "moved", "done", "failed"]);
export type ProjectRelocationState = typeof ProjectRelocationState.Type;

/** `rename` moves the folder in place; `copy` copies it across devices, then removes the source. */
export const ProjectRelocationStrategy = Schema.Literals(["rename", "copy"]);
export type ProjectRelocationStrategy = typeof ProjectRelocationStrategy.Type;

export const ProjectRelocation = Schema.Struct({
  relocationId: TrimmedNonEmptyString,
  projectId: ProjectId,
  sourcePath: TrimmedNonEmptyString,
  destinationPath: TrimmedNonEmptyString,
  strategy: ProjectRelocationStrategy,
  state: ProjectRelocationState,
  /** Ryco created the destination folder (a copy), so recovery may remove a partial one. */
  destinationCreated: Schema.Boolean,
  /** The promoted project's title, so recovery finishes the promotion the user asked for. */
  title: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectRelocation = typeof ProjectRelocation.Type;

export const GetProjectRelocationInput = Schema.Struct({
  relocationId: TrimmedNonEmptyString,
});
export type GetProjectRelocationInput = typeof GetProjectRelocationInput.Type;

export const ListProjectRelocationsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectRelocationsByProjectInput = typeof ListProjectRelocationsByProjectInput.Type;

export const UpdateProjectRelocationInput = Schema.Struct({
  relocationId: TrimmedNonEmptyString,
  state: ProjectRelocationState,
  strategy: ProjectRelocationStrategy,
  destinationCreated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type UpdateProjectRelocationInput = typeof UpdateProjectRelocationInput.Type;

export interface ProjectRelocationRepositoryShape {
  /** Journal a move before any file is touched. */
  readonly create: (row: ProjectRelocation) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getById: (
    input: GetProjectRelocationInput,
  ) => Effect.Effect<Option.Option<ProjectRelocation>, ProjectionRepositoryError>;

  /** Moves an interrupted process may have left half done (`pending` or `moved`), oldest first. */
  readonly listUnresolved: () => Effect.Effect<
    ReadonlyArray<ProjectRelocation>,
    ProjectionRepositoryError
  >;

  /** One project's unresolved moves, oldest first. */
  readonly listUnresolvedByProjectId: (
    input: ListProjectRelocationsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectRelocation>, ProjectionRepositoryError>;

  /**
   * Advance an unresolved move. `done` and `failed` are final: updating such a row changes nothing
   * and returns false.
   */
  readonly update: (
    input: UpdateProjectRelocationInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class ProjectRelocationRepository extends Context.Service<
  ProjectRelocationRepository,
  ProjectRelocationRepositoryShape
>()("ryco/persistence/Services/ProjectRelocations/ProjectRelocationRepository") {}
