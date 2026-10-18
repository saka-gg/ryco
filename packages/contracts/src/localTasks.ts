import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ChatAttachmentId,
  ChatAttachmentMimeType,
  ChatAttachmentName,
  ClientThreadTurnStartCommand,
  FileAttachmentUploadToken,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS,
} from "./orchestration.ts";
import { WorkItemProviderKind } from "./workItems.ts";

export const LocalTaskId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Notes = Schema.String.check(Schema.isMaxLength(20_000));
export const LocalTaskPriority = Schema.Literals(["low", "normal", "high", "urgent"]);
const LocalTaskFields = {
  title: Title,
  notes: Notes,
  priority: LocalTaskPriority,
  dueAt: Schema.NullOr(IsoDateTime),
  projectId: Schema.NullOr(ProjectId),
};

/** The most links one task can hold. */
export const LOCAL_TASK_MAX_LINKS = 20;
/** The most files one task can hold: every chat started from it carries all of them. */
export const LOCAL_TASK_MAX_FILES = PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
/** The most bytes one task's files can add up to, the same budget as one chat message. */
export const LOCAL_TASK_MAX_FILE_TOTAL_BYTES = PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES;

const LocalTaskUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\/\S+$/i),
);
/** A Jira-style issue key such as `ABC-123`. */
export const LocalTaskWorkItemKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z][A-Z0-9_]*-\d+$/),
);

/**
 * Something a task points at. A pull request or branch also offers a place to
 * start the task's chats; issues, work items and chats travel into the first
 * message as references.
 */
export const LocalTaskLink = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pr"),
    number: PositiveInt,
    url: Schema.optionalKey(LocalTaskUrl),
  }),
  Schema.Struct({
    kind: Schema.Literal("issue"),
    number: PositiveInt,
    url: Schema.optionalKey(LocalTaskUrl),
  }),
  Schema.Struct({
    kind: Schema.Literal("workItem"),
    provider: WorkItemProviderKind,
    key: LocalTaskWorkItemKey,
    url: Schema.optionalKey(LocalTaskUrl),
  }),
  Schema.Struct({
    kind: Schema.Literal("branch"),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: LocalTaskUrl,
    label: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  }),
]);
export type LocalTaskLink = typeof LocalTaskLink.Type;
const LocalTaskLinks = Schema.Array(LocalTaskLink).check(Schema.isMaxLength(LOCAL_TASK_MAX_LINKS));

/**
 * A file kept with the task on its node, outside every chat. Each chat
 * started from the task receives its own copy as a message attachment.
 */
export const LocalTaskFile = Schema.Struct({
  /** The file's name in the node's task-file store. */
  fileId: ChatAttachmentId,
  type: Schema.Literals(["image", "file"]),
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  width: Schema.optionalKey(NonNegativeInt),
  height: Schema.optionalKey(NonNegativeInt),
  addedAt: IsoDateTime,
});
export type LocalTaskFile = typeof LocalTaskFile.Type;
const LocalTaskFiles = Schema.Array(LocalTaskFile).check(Schema.isMaxLength(LOCAL_TASK_MAX_FILES));

export const LocalTaskStatus = Schema.Literals([
  "todo",
  "starting",
  "running",
  "needs-you",
  "review",
  "failed",
  "unavailable",
  "done",
]);
export type LocalTaskStatus = typeof LocalTaskStatus.Type;

/** The state of one chat started from a task, judged by its exact first message. */
export const LocalTaskDelegationStatus = Schema.Literals([
  "starting",
  "running",
  "needs-you",
  "review",
  "failed",
  "unavailable",
]);
export type LocalTaskDelegationStatus = typeof LocalTaskDelegationStatus.Type;

/** One chat started from a task. A task keeps every chat it started, oldest first. */
export const LocalTaskDelegation = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  /** 1 for the task's first chat, 2 for the next, and so on. */
  sequence: PositiveInt,
  /** The worktree branch the start asked for; `null` when it ran in an existing checkout. */
  branch: Schema.NullOr(Schema.String),
  dispatched: Schema.Boolean,
  status: LocalTaskDelegationStatus,
  /** Why the start failed before its chat could run; `null` otherwise. */
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type LocalTaskDelegation = typeof LocalTaskDelegation.Type;

const LocalTaskRecordFields = {
  taskId: LocalTaskId,
  revision: NonNegativeInt,
  ...LocalTaskFields,
  links: LocalTaskLinks.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  files: LocalTaskFiles.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  state: Schema.Literals(["todo", "done"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

/**
 * What a node stores for a task. Rows written before links, files and
 * multiple chats existed decode with empty lists.
 */
export const LocalTaskRecord = Schema.Struct(LocalTaskRecordFields);
export type LocalTaskRecord = typeof LocalTaskRecord.Type;

export const LocalTask = Schema.Struct({
  ...LocalTaskRecordFields,
  /** Derived on every read: `done`, `unavailable`, the most urgent chat's status, or `todo`. */
  status: LocalTaskStatus,
  delegations: Schema.Array(LocalTaskDelegation).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type LocalTask = typeof LocalTask.Type;

export const LocalTaskCreateInput = Schema.Struct({ taskId: LocalTaskId, ...LocalTaskFields });
export type LocalTaskCreateInput = typeof LocalTaskCreateInput.Type;
export const LocalTaskUpdateInput = Schema.Struct({
  taskId: LocalTaskId,
  expectedRevision: NonNegativeInt,
  title: Schema.optional(Title),
  notes: Schema.optional(Notes),
  priority: Schema.optional(LocalTaskPriority),
  dueAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  state: Schema.optional(Schema.Literals(["todo", "done"])),
  /** Replaces the task's whole link list. */
  links: Schema.optional(LocalTaskLinks),
});
export type LocalTaskUpdateInput = typeof LocalTaskUpdateInput.Type;
export const LocalTaskDeleteInput = Schema.Struct({
  taskId: LocalTaskId,
  expectedRevision: NonNegativeInt,
});
export type LocalTaskDeleteInput = typeof LocalTaskDeleteInput.Type;
export const LocalTaskListInput = Schema.Struct({
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  afterId: Schema.optional(LocalTaskId),
});
export type LocalTaskListInput = typeof LocalTaskListInput.Type;
export const LocalTaskListResult = Schema.Struct({
  tasks: Schema.Array(LocalTask),
  nextCursor: Schema.NullOr(LocalTaskId),
});
export type LocalTaskListResult = typeof LocalTaskListResult.Type;

/**
 * Starts one more chat for a task. The command may create its thread (and
 * worktree) through `bootstrap`, or target a thread that already exists. The
 * node adds every task file to the message. Starting a chat never changes
 * the task's revision, so `expectedRevision` is only checked when sent.
 */
export const LocalTaskDelegateInput = Schema.Struct({
  taskId: LocalTaskId,
  expectedRevision: Schema.optional(NonNegativeInt),
  command: ClientThreadTurnStartCommand,
});
export type LocalTaskDelegateInput = typeof LocalTaskDelegateInput.Type;

/** Mints an upload token for one task file; the bytes go to the node's `/attachments/upload`. */
export const LocalTaskFileUploadInput = Schema.Struct({
  taskId: LocalTaskId,
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});
export type LocalTaskFileUploadInput = typeof LocalTaskFileUploadInput.Type;

/** Adds a file to a task, from a finished upload or inline as a data URL (exactly one). */
export const LocalTaskAddFileInput = Schema.Struct({
  taskId: LocalTaskId,
  expectedRevision: NonNegativeInt,
  name: ChatAttachmentName,
  mimeType: ChatAttachmentMimeType,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  width: Schema.optionalKey(NonNegativeInt),
  height: Schema.optionalKey(NonNegativeInt),
  uploadToken: Schema.optionalKey(FileAttachmentUploadToken),
  dataUrl: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS)),
  ),
}).check(
  Schema.makeFilter((input) => {
    const hasDataUrl = input.dataUrl !== undefined;
    const hasUploadToken = input.uploadToken !== undefined;
    return hasDataUrl !== hasUploadToken
      ? true
      : {
          path: ["dataUrl"],
          issue: hasDataUrl
            ? "provide either dataUrl or uploadToken, not both"
            : "provide exactly one of dataUrl or uploadToken",
        };
  }),
);
export type LocalTaskAddFileInput = typeof LocalTaskAddFileInput.Type;

export const LocalTaskRemoveFileInput = Schema.Struct({
  taskId: LocalTaskId,
  expectedRevision: NonNegativeInt,
  fileId: ChatAttachmentId,
});
export type LocalTaskRemoveFileInput = typeof LocalTaskRemoveFileInput.Type;

export class LocalTaskError extends Schema.TaggedError<LocalTaskError>()("LocalTaskError", {
  reason: Schema.Literals(["not-found", "conflict", "invalid", "persistence"]),
  message: Schema.String,
}) {}
