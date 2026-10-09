import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { CHAT_PROJECT_TITLE_MAX_CHARS } from "./orchestration.ts";

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

/** Server-local absolute directory; access and filesystem validation belong to the server. */
const ProjectChatDestination = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

/**
 * Where a promoted chat folder would go. Only `available` can be promoted:
 * - `exists`: something is already at the destination, or another chat is moving there.
 * - `invalid`: not an absolute path, or its parent is missing or not a writable directory.
 * - `access-denied`: the workspace access policy rejects it.
 * - `inside-chats`: it lies inside the chats root.
 * - `inside-source`: it lies inside the chat folder being moved.
 * - `retired-checkout`: it is at or inside a workspace checkout Ryco removed (or is removing or
 *   moving). The server keeps new work out of such paths, so a project there could never run.
 */
export const ProjectChatDestinationStatus = Schema.Literals([
  "available",
  "exists",
  "invalid",
  "access-denied",
  "inside-chats",
  "inside-source",
  "retired-checkout",
]);
export type ProjectChatDestinationStatus = typeof ProjectChatDestinationStatus.Type;

export const ProjectsPromoteChatPreviewInput = Schema.Struct({
  projectId: ProjectId,
  /** Absent previews the default destination. Any text is accepted and judged in the result. */
  destination: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type ProjectsPromoteChatPreviewInput = typeof ProjectsPromoteChatPreviewInput.Type;

/** Read-only: previewing never creates, moves or locks anything. */
export const ProjectsPromoteChatPreviewResult = Schema.Struct({
  projectId: ProjectId,
  /** The chat folder that would move. */
  source: TrimmedNonEmptyString,
  /**
   * A free folder under `addProjectBaseDirectory` (or its default): `<slug>` when nothing is there,
   * otherwise the first free `<slug>-2`, `<slug>-3`, …
   */
  defaultDestination: TrimmedNonEmptyString,
  /** The destination that was judged: the input's (normalized) or the default. */
  destination: Schema.String,
  destinationStatus: ProjectChatDestinationStatus,
  fileCount: NonNegativeInt,
  totalBytes: NonNegativeInt,
  /** The scan stopped at its bound; the counts are lower limits. */
  countTruncated: Schema.Boolean,
  /** Threads with live work (running turn, pending approval or input, queued dispatch). */
  busyThreadIds: Schema.Array(ThreadId),
  gitAvailable: Schema.Boolean,
  /** Whether `user.name` and `user.email` resolve, so an initial commit can succeed. */
  gitIdentityConfigured: Schema.Boolean,
  /** Source and destination are on different devices: the move is a copy, then a delete. */
  crossDevice: Schema.Boolean,
});
export type ProjectsPromoteChatPreviewResult = typeof ProjectsPromoteChatPreviewResult.Type;

export const ProjectsPromoteChatInput = Schema.Struct({
  projectId: ProjectId,
  /** Compare-and-set guard against the project as previewed. */
  expectedUpdatedAt: Schema.optional(IsoDateTime),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_PROJECT_TITLE_MAX_CHARS)),
  destination: ProjectChatDestination,
  initializeGit: Schema.Boolean,
  /** Ignored unless `initializeGit`. */
  initialCommit: Schema.Boolean,
  /** Ignored unless `initializeGit`; never overwrites an existing `.gitignore`. */
  writeGitignore: Schema.Boolean,
});
export type ProjectsPromoteChatInput = typeof ProjectsPromoteChatInput.Type;

export const ProjectsPromoteChatResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  gitInitialized: Schema.Boolean,
  initialCommitCreated: Schema.Boolean,
  /** The project was promoted, but its first commit failed (for example, no Git identity). */
  commitError: Schema.optional(Schema.String),
});
export type ProjectsPromoteChatResult = typeof ProjectsPromoteChatResult.Type;

/**
 * The explicit "Also delete files" step for a chat. Refused while the chat still has threads, and
 * never removes anything outside the chats root.
 */
export const ProjectsDeleteChatFolderInput = Schema.Struct({ projectId: ProjectId });
export type ProjectsDeleteChatFolderInput = typeof ProjectsDeleteChatFolderInput.Type;

export const ProjectsDeleteChatFolderResult = Schema.Struct({
  /** False when the folder was already gone. */
  deleted: Schema.Boolean,
});
export type ProjectsDeleteChatFolderResult = typeof ProjectsDeleteChatFolderResult.Type;

export const ProjectChatErrorReason = Schema.Literals([
  "not-found",
  "not-chat",
  "busy",
  "stale",
  "destination-exists",
  "destination-invalid",
  "destination-inside-chats",
  "destination-inside-source",
  "destination-retired-checkout",
  "access-denied",
  "move-failed",
  "git-failed",
  "chats-unavailable",
  "has-threads",
  "outside-chats-root",
]);
export type ProjectChatErrorReason = typeof ProjectChatErrorReason.Type;

/** One error for every chat-folder RPC; `reason` is the stable, machine-readable part. */
export class ProjectChatError extends Schema.TaggedError<ProjectChatError>()("ProjectChatError", {
  reason: ProjectChatErrorReason,
  message: TrimmedNonEmptyString,
}) {}
