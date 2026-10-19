import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
  rejectExcessProperties,
} from "./baseSchemas.ts";
import {
  AgentControlCreateThreadEntry,
  AgentControlRequestId,
  AgentControlTitle,
} from "./agentControl.ts";
import { ChatAttachmentId, ChatAttachmentName } from "./orchestration.ts";
import {
  LocalTaskId,
  LocalTaskLink,
  LocalTaskNotes,
  LocalTaskPriority,
  LocalTaskTitle,
  LOCAL_TASK_MAX_LINKS,
} from "./localTasks.ts";

/**
 * Private-session tools for the node's Tasks: the user's to-do list on the Tasks
 * page (`LocalTaskService`), not the runs a chat delegates (`ryco_task_status`).
 * Like the inspection and delegation tools, they are not part of
 * `AGENT_CONTROL_MCP_TOOLS` and never reach the external endpoint.
 */
export const AGENT_CONTROL_LOCAL_TASK_MCP_TOOLS = {
  list: "ryco_list_local_tasks",
  read: "ryco_read_local_task",
  create: "ryco_create_local_task",
  update: "ryco_update_local_task",
  addFile: "ryco_add_local_task_file",
  removeFile: "ryco_remove_local_task_file",
  startChat: "ryco_start_local_task_chat",
  proposeDelete: "ryco_propose_local_task_delete",
} as const;

export const AGENT_CONTROL_LOCAL_TASK_LIST_MAX = 100;
export const AGENT_CONTROL_LOCAL_TASK_LIST_DEFAULT = 50;
/** Notes in a list are cut to this; `ryco_read_local_task` returns them whole. */
export const AGENT_CONTROL_LOCAL_TASK_NOTES_PREVIEW_CHARS = 280;

const LocalTaskLinks = Schema.Array(LocalTaskLink).check(Schema.isMaxLength(LOCAL_TASK_MAX_LINKS));

export const AgentControlListLocalTasksInput = Schema.Struct({
  /** Open tasks (`todo`, the default), completed ones (`done`) or both (`all`). */
  state: Schema.optional(Schema.Literals(["todo", "done", "all"])),
  projectId: Schema.optional(ProjectId),
  /** Case-insensitive text the title or notes contain. */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AGENT_CONTROL_LOCAL_TASK_LIST_MAX })),
  ),
  /** How many matching tasks to skip: the previous answer's `nextOffset`. */
  offset: Schema.optional(NonNegativeInt),
}).pipe(rejectExcessProperties);
export type AgentControlListLocalTasksInput = typeof AgentControlListLocalTasksInput.Type;

export const AgentControlReadLocalTaskInput = Schema.Struct({
  taskId: LocalTaskId,
}).pipe(rejectExcessProperties);
export type AgentControlReadLocalTaskInput = typeof AgentControlReadLocalTaskInput.Type;

export const AgentControlCreateLocalTaskInput = Schema.Struct({
  /** Names the task: a retry with the same requestId answers with the same task. */
  requestId: AgentControlRequestId,
  title: LocalTaskTitle,
  notes: Schema.optional(LocalTaskNotes),
  priority: Schema.optional(LocalTaskPriority),
  dueAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  links: Schema.optional(LocalTaskLinks),
}).pipe(rejectExcessProperties);
export type AgentControlCreateLocalTaskInput = typeof AgentControlCreateLocalTaskInput.Type;

export const AgentControlUpdateLocalTaskInput = Schema.Struct({
  taskId: LocalTaskId,
  /** The revision last read; a task changed since fails, to be read again. */
  expectedRevision: NonNegativeInt,
  title: Schema.optional(LocalTaskTitle),
  notes: Schema.optional(LocalTaskNotes),
  priority: Schema.optional(LocalTaskPriority),
  dueAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  /** `done` completes the task; `todo` reopens it. */
  state: Schema.optional(Schema.Literals(["todo", "done"])),
  /** Replaces the task's whole link list. */
  links: Schema.optional(LocalTaskLinks),
}).pipe(rejectExcessProperties);
export type AgentControlUpdateLocalTaskInput = typeof AgentControlUpdateLocalTaskInput.Type;

export const AgentControlAddLocalTaskFileInput = Schema.Struct({
  taskId: LocalTaskId,
  expectedRevision: NonNegativeInt,
  /** A regular file of this thread's workspace or worktree, relative to it (no links or `..`). */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  /** The file's name on the task; the path's base name by default. */
  name: Schema.optional(ChatAttachmentName),
}).pipe(rejectExcessProperties);
export type AgentControlAddLocalTaskFileInput = typeof AgentControlAddLocalTaskFileInput.Type;

export const AgentControlRemoveLocalTaskFileInput = Schema.Struct({
  taskId: LocalTaskId,
  expectedRevision: NonNegativeInt,
  fileId: ChatAttachmentId,
}).pipe(rejectExcessProperties);
export type AgentControlRemoveLocalTaskFileInput = typeof AgentControlRemoveLocalTaskFileInput.Type;

const createThreadFields = AgentControlCreateThreadEntry.fields;

export const AgentControlStartLocalTaskChatInput = Schema.Struct({
  requestId: AgentControlRequestId,
  taskId: LocalTaskId,
  modelSelection: createThreadFields.modelSelection,
  runtimeMode: createThreadFields.runtimeMode,
  envMode: createThreadFields.envMode,
  tokenMode: createThreadFields.tokenMode,
  baseRef: createThreadFields.baseRef,
  returnToOrigin: createThreadFields.returnToOrigin,
  /** The chat's title; the task's title by default. */
  title: Schema.optional(AgentControlTitle),
  /** The first message; the task's title, notes and links by default. */
  prompt: createThreadFields.prompt.pipe(Schema.optional),
}).pipe(rejectExcessProperties);
export type AgentControlStartLocalTaskChatInput = typeof AgentControlStartLocalTaskChatInput.Type;

export const AgentControlProposeLocalTaskDeleteInput = Schema.Struct({
  requestId: AgentControlRequestId,
  taskId: LocalTaskId,
  expectedRevision: NonNegativeInt,
}).pipe(rejectExcessProperties);
export type AgentControlProposeLocalTaskDeleteInput =
  typeof AgentControlProposeLocalTaskDeleteInput.Type;
