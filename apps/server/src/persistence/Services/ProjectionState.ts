/**
 * ProjectionStateRepository - Projection repository interface for projector cursors.
 *
 * Owns persistence operations for projection cursor state used to resume
 * incremental event projection.
 *
 * @module ProjectionStateRepository
 */
import { IsoDateTime, NonNegativeInt } from "@ryco/contracts";
import { Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionState = Schema.Struct({
  projector: Schema.String,
  lastAppliedSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ProjectionState = typeof ProjectionState.Type;

/**
 * ProjectionStateRepositoryShape - Service API for projector state records.
 */
export interface ProjectionStateRepositoryShape {
  /**
   * Insert or replace multiple projection cursors with one database statement.
   * Empty batches are a no-op.
   */
  readonly upsertMany: (
    rows: ReadonlyArray<ProjectionState>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List all projector cursor rows.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionState>, ProjectionRepositoryError>;
}

/**
 * ProjectionStateRepository - Service tag for projection cursor persistence.
 */
export class ProjectionStateRepository extends Context.Service<
  ProjectionStateRepository,
  ProjectionStateRepositoryShape
>()("ryco/persistence/Services/ProjectionState/ProjectionStateRepository") {}
