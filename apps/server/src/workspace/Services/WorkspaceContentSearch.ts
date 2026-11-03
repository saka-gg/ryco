/**
 * WorkspaceContentSearch - Effect service contract for searching the text of
 * a workspace's files.
 *
 * Owns literal content search over the files the workspace index lists, one
 * bounded page at a time: git checkouts through `git grep`, other folders and
 * the rest of a search git could not finish by scanning the index.
 *
 * @module WorkspaceContentSearch
 */
import { Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectSearchContentInput, ProjectSearchContentResult } from "@ryco/contracts";

export class WorkspaceContentSearchError extends Schema.TaggedError<WorkspaceContentSearchError>()(
  "WorkspaceContentSearchError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceContentSearchCursorError extends Schema.TaggedError<WorkspaceContentSearchCursorError>()(
  "WorkspaceContentSearchCursorError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "This search can't continue. Search again.";
  }
}

/**
 * WorkspaceContentSearchShape - Service API for workspace content search.
 */
export interface WorkspaceContentSearchShape {
  /**
   * One page of the lines that contain the query, in path order. A page holds
   * whole files and ends when it is full, when the files run out or when its
   * time budget is spent; `nextCursor` continues after it.
   */
  readonly search: (
    input: ProjectSearchContentInput,
  ) => Effect.Effect<
    ProjectSearchContentResult,
    WorkspaceContentSearchError | WorkspaceContentSearchCursorError
  >;
}

/**
 * WorkspaceContentSearch - Service tag for workspace content search.
 */
export class WorkspaceContentSearch extends Context.Service<
  WorkspaceContentSearch,
  WorkspaceContentSearchShape
>()("ryco/workspace/Services/WorkspaceContentSearch") {}
