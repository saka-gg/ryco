/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import { Schema, Context } from "effect";
import type { Effect } from "effect";

import type {
  ProjectReadFileBinaryInput,
  ProjectReadFileBinaryResult,
  ProjectReadFileChunkInput,
  ProjectReadFileChunkResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectStageFileReferenceInput,
  ProjectStageFileReferenceResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@ryco/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

export class WorkspaceFileSystemError extends Schema.TaggedError<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceFileConflictError extends Schema.TaggedError<WorkspaceFileConflictError>()(
  "WorkspaceFileConflictError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return "This file changed on disk after it was opened. Reload it before saving.";
  }
}

export class WorkspaceFileDeletedError extends Schema.TaggedError<WorkspaceFileDeletedError>()(
  "WorkspaceFileDeletedError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return "This file was removed from disk after it was opened. Explorer will not recreate it.";
  }
}

export class WorkspaceFileUnsupportedEditError extends Schema.TaggedError<WorkspaceFileUnsupportedEditError>()(
  "WorkspaceFileUnsupportedEditError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * WorkspaceFileSystemShape - Service API for workspace-relative file operations.
 */
export interface WorkspaceFileSystemShape {
  /**
   * Read a file relative to the workspace root.
   *
   * Rejects paths that escape the workspace root.
   */
  readonly readFile: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<
    ProjectReadFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Read a raster image relative to the workspace root as base64.
   *
   * Rejects paths that escape the workspace root, files above the binary
   * preview budget, and bytes whose magic number is not a supported raster
   * image — the returned mime type is derived from those bytes, never from the
   * path's extension.
   */
  readonly readFileBinary: (
    input: ProjectReadFileBinaryInput,
  ) => Effect.Effect<
    ProjectReadFileBinaryResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Read one bounded chunk of a PDF or raster image relative to the workspace
   * root, for previews too large for one relay message.
   *
   * Rejects paths that escape the workspace root, files above the chunked
   * preview budget, and files whose first bytes are neither a PDF nor a
   * supported raster image (sniffed on every chunk, never from the path's
   * extension). Each chunk carries a fingerprint of the file's state; a chunk
   * read with `expectedFingerprint` fails when the file changed since.
   */
  readonly readFileChunk: (
    input: ProjectReadFileChunkInput,
  ) => Effect.Effect<
    ProjectReadFileChunkResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Write a file relative to the workspace root.
   *
   * Creates parent directories as needed and rejects paths that escape the
   * workspace root.
   */
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    | WorkspaceFileConflictError
    | WorkspaceFileDeletedError
    | WorkspaceFileSystemError
    | WorkspaceFileUnsupportedEditError
    | WorkspacePathOutsideRootError
  >;

  /**
   * Stage a user-selected file inside the workspace and return a prompt-safe
   * relative path that the provider can read.
   */
  readonly stageFileReference: (
    input: ProjectStageFileReferenceInput,
  ) => Effect.Effect<
    ProjectStageFileReferenceResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
}

/**
 * WorkspaceFileSystem - Service tag for workspace file operations.
 */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("ryco/workspace/Services/WorkspaceFileSystem") {}
