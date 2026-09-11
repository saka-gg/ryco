import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
export const PROJECT_STAGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const PROJECT_STAGE_FILE_MAX_BASE64_CHARS = Math.ceil((PROJECT_STAGE_FILE_MAX_BYTES * 4) / 3) + 4;
/**
 * Raster image previews travel as base64 over the same frame budget that already
 * carries 10 MiB staged uploads, so 4 MiB of raw bytes (~5.4 MiB encoded) stays
 * comfortably inside proven transport limits.
 */
export const PROJECT_READ_FILE_BINARY_MAX_BYTES = 4 * 1024 * 1024;

export const ProjectFileEncoding = Schema.Literals(["utf8", "utf8-bom"]);
export type ProjectFileEncoding = typeof ProjectFileEncoding.Type;

export const ProjectFileLineEnding = Schema.Literals(["lf", "crlf", "cr", "mixed"]);
export type ProjectFileLineEnding = typeof ProjectFileLineEnding.Type;

export const ProjectWriteFileFailureReason = Schema.Literals([
  "conflict",
  "deleted",
  "unsupported",
  "failed",
]);
export type ProjectWriteFileFailureReason = typeof ProjectWriteFileFailureReason.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedError<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  version: TrimmedNonEmptyString,
  encoding: ProjectFileEncoding,
  lineEnding: ProjectFileLineEnding,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export class ProjectReadFileError extends Schema.TaggedError<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectReadFileBinaryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileBinaryInput = typeof ProjectReadFileBinaryInput.Type;

/**
 * The mime type is derived from the file's magic bytes, never from its
 * extension — the client renders these bytes, so the server decides what they
 * actually are.
 */
export const ProjectReadFileBinaryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  dataBase64: Schema.String,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
});
export type ProjectReadFileBinaryResult = typeof ProjectReadFileBinaryResult.Type;

export class ProjectReadFileBinaryError extends Schema.TaggedError<ProjectReadFileBinaryError>()(
  "ProjectReadFileBinaryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export class ProjectListEntriesError extends Schema.TaggedError<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  expectedVersion: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  encoding: Schema.optional(ProjectFileEncoding),
  lineEnding: Schema.optional(ProjectFileLineEnding),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedError<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    reason: ProjectWriteFileFailureReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectStageFileReferenceInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scopeId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROJECT_STAGE_FILE_MAX_BYTES)),
  dataBase64: Schema.String.check(Schema.isMaxLength(PROJECT_STAGE_FILE_MAX_BASE64_CHARS)),
});
export type ProjectStageFileReferenceInput = typeof ProjectStageFileReferenceInput.Type;

export const ProjectStageFileReferenceResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
});
export type ProjectStageFileReferenceResult = typeof ProjectStageFileReferenceResult.Type;

export class ProjectStageFileReferenceError extends Schema.TaggedError<ProjectStageFileReferenceError>()(
  "ProjectStageFileReferenceError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Optional, bounded project artwork carried inside the authenticated node RPC channel. */
export const PROJECT_ICON_MAX_BYTES = 512 * 1024;
export const ProjectReadIconInput = Schema.Struct({ projectId: ProjectId });
export type ProjectReadIconInput = typeof ProjectReadIconInput.Type;
export const ProjectReadIconResult = Schema.NullOr(
  Schema.Struct({
    dataBase64: Schema.String.check(Schema.isMaxLength(Math.ceil(PROJECT_ICON_MAX_BYTES / 3) * 4)),
    mimeType: Schema.Literals([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/svg+xml",
      "image/x-icon",
    ]),
  }),
);
export type ProjectReadIconResult = typeof ProjectReadIconResult.Type;
export class ProjectReadIconError extends Schema.TaggedError<ProjectReadIconError>()(
  "ProjectReadIconError",
  { message: TrimmedNonEmptyString },
) {}
