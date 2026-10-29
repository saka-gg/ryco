/**
 * ProjectionThreadPullRequestWatchRepository - the projected pull request watches of each
 * thread (`thread.pull-request-watch-updated`), one row per thread that ever watched one.
 *
 * The row keeps the full state for the command read model and the shell summary the
 * projector derives from it, so shell reads never parse the full state.
 *
 * @module ProjectionThreadPullRequestWatchRepository
 */
import { IsoDateTime, ThreadId, ThreadPullRequestWatches } from "@ryco/contracts";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPullRequestWatches = Schema.Struct({
  threadId: ThreadId,
  watches: ThreadPullRequestWatches,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadPullRequestWatches = typeof ProjectionThreadPullRequestWatches.Type;

export const ProjectionThreadPullRequestWatchesThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectionThreadPullRequestWatchesThreadInput =
  typeof ProjectionThreadPullRequestWatchesThreadInput.Type;

export interface ProjectionThreadPullRequestWatchRepositoryShape {
  /** Replace a thread's watches; the shell summary and the active count follow from them. */
  readonly upsert: (
    row: ProjectionThreadPullRequestWatches,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Forget a thread's watches (the thread was deleted permanently). */
  readonly deleteByThreadId: (
    input: ProjectionThreadPullRequestWatchesThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByThreadId: (
    input: ProjectionThreadPullRequestWatchesThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadPullRequestWatches>, ProjectionRepositoryError>;
  /** Every thread with at least one active watch, oldest change first. */
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadPullRequestWatches>,
    ProjectionRepositoryError
  >;
}

export class ProjectionThreadPullRequestWatchRepository extends Context.Service<
  ProjectionThreadPullRequestWatchRepository,
  ProjectionThreadPullRequestWatchRepositoryShape
>()(
  "ryco/persistence/Services/ProjectionThreadPullRequestWatches/ProjectionThreadPullRequestWatchRepository",
) {}
