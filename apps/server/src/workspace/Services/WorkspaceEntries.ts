/**
 * WorkspaceEntries - Effect service contract for cached workspace entry search.
 *
 * Owns indexed workspace entry search plus index revalidation for workspace
 * roots when the underlying filesystem changes.
 *
 * @module WorkspaceEntries
 */
import { Schema, Context } from "effect";
import type { Effect } from "effect";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@ryco/contracts";

export class WorkspaceEntriesError extends Schema.TaggedError<WorkspaceEntriesError>()(
  "WorkspaceEntriesError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceEntriesBrowseError extends Schema.TaggedError<WorkspaceEntriesBrowseError>()(
  "WorkspaceEntriesBrowseError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface WorkspaceSearchFiles {
  readonly paths: ReadonlyArray<string>;
  readonly partial: boolean;
}

/**
 * WorkspaceEntriesShape - Service API for workspace entry search and cache
 * invalidation.
 */
export interface WorkspaceEntriesShape {
  /**
   * Browse matching directories for the provided partial path.
   */
  readonly browse: (
    input: FilesystemBrowseInput,
  ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;

  /**
   * List indexed workspace entries for the project tree.
   */
  readonly listEntries: (
    input: ProjectListEntriesInput,
  ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;

  /**
   * Search indexed workspace entries for files and directories matching the
   * provided query.
   */
  readonly search: (
    input: ProjectSearchEntriesInput,
  ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;

  /**
   * Every indexed file of the root in UTF-8 byte order, for content search.
   * Like `search`, it answers from the current index without waiting for a
   * pending rebuild. `partial` marks an index that covers only part of the
   * workspace.
   */
  readonly readSearchFiles: (
    cwd: string,
  ) => Effect.Effect<WorkspaceSearchFiles, WorkspaceEntriesError>;

  /**
   * Mark the workspace root's entries as changed. A root in recent use is
   * re-indexed in the background (reads keep serving the previous index until
   * then); an idle root drops its index.
   */
  readonly invalidate: (cwd: string) => Effect.Effect<void>;

  /**
   * Record a file written through Ryco: the path is added to the root's index
   * right away (no rebuild for files it already lists), then reconciled by a
   * background rebuild.
   */
  readonly recordFileWrite: (cwd: string, relativePath: string) => Effect.Effect<void>;
}

/**
 * WorkspaceEntries - Service tag for cached workspace entry search.
 */
export class WorkspaceEntries extends Context.Service<WorkspaceEntries, WorkspaceEntriesShape>()(
  "ryco/workspace/Services/WorkspaceEntries",
) {}
