import { Schema } from "effect";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "./baseSchemas.ts";
import { ClientThreadTurnStartCommand } from "./orchestration.ts";

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
export const LocalTask = Schema.Struct({
  taskId: LocalTaskId,
  revision: NonNegativeInt,
  ...LocalTaskFields,
  state: Schema.Literals(["todo", "done"]),
  status: LocalTaskStatus,
  delegation: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      messageId: MessageId,
      commandId: CommandId,
      dispatched: Schema.Boolean,
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
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
export const LocalTaskDelegateInput = Schema.Struct({
  taskId: LocalTaskId,
  expectedRevision: NonNegativeInt,
  command: ClientThreadTurnStartCommand,
});
export type LocalTaskDelegateInput = typeof LocalTaskDelegateInput.Type;
export class LocalTaskError extends Schema.TaggedError<LocalTaskError>()("LocalTaskError", {
  reason: Schema.Literals(["not-found", "conflict", "invalid", "persistence"]),
  message: Schema.String,
}) {}
