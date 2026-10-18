/**
 * Private-session tools for the node's Tasks (the user's to-do list on the Tasks page,
 * `LocalTaskService`): list, read, create, edit, complete, files, start a task's chat, and a
 * delete the user approves. Reads need `local-tasks.read`; changes need `local-tasks.manage` and
 * exact active-turn authority. Edits run at once (revision-checked); starting a chat goes through
 * `ryco_create_threads` (its project and permission rules); deleting is a proposal. Never
 * installed on the external endpoint.
 *
 * @module agentControl/Mcp/localTaskTools
 */
import { createHash } from "node:crypto";

import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_LOCAL_TASK_LIST_DEFAULT,
  AGENT_CONTROL_LOCAL_TASK_LIST_MAX,
  AGENT_CONTROL_LOCAL_TASK_MCP_TOOLS,
  AGENT_CONTROL_LOCAL_TASK_NOTES_PREVIEW_CHARS,
  AGENT_CONTROL_MCP_TOOLS,
  AGENT_CONTROL_TITLE_MAX_CHARS,
  AgentControlAddLocalTaskFileInput,
  AgentControlCreateLocalTaskInput,
  AgentControlListLocalTasksInput,
  AgentControlProposeLocalTaskDeleteInput,
  AgentControlReadLocalTaskInput,
  AgentControlRemoveLocalTaskFileInput,
  AgentControlStartLocalTaskChatInput,
  AgentControlUpdateLocalTaskInput,
  LOCAL_TASK_MAX_LINKS,
  type AgentControlCapability,
  type LocalTask,
  type LocalTaskError,
  type ThreadId,
} from "@ryco/contracts";
import { buildTaskStartPrompt } from "@ryco/shared/localTasks";
import { Effect, Option, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { LocalTaskServiceShape } from "../../tasks/LocalTaskService.ts";
import {
  deleteTaskFiles,
  storeTaskFileFromWorkspace,
  toLocalTaskFile,
} from "../../tasks/taskFiles.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import { ToolFailure } from "./threadReads.ts";
import {
  modelSelectionSchema,
  submitAgentControlMutation,
  type AgentControlMcpToolDeps,
  type AgentControlMcpToolDescriptor,
  type AgentControlMcpToolResult,
  type AgentControlMcpTools,
} from "./tools.ts";

const TOOLS = AGENT_CONTROL_LOCAL_TASK_MCP_TOOLS;
const NOT_TASK_RUNS =
  "Tasks are the user's to-do list on the Tasks page, not the runs this chat delegated (ryco_task_status).";

const taskIdProperty = { type: "string", minLength: 1, maxLength: 128 } as const;
const requestIdProperty = { type: "string", minLength: 1, maxLength: 128 } as const;
const revisionProperty = {
  type: "integer",
  minimum: 0,
  description: "The task's revision as last read; a task changed since fails, read it again.",
} as const;
const urlProperty = { type: "string", maxLength: 2048, pattern: "^https?://" } as const;
const linkTitleProperty = { type: "string", minLength: 1, maxLength: 300 } as const;
const linkSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        kind: { const: "pr" },
        number: { type: "integer", minimum: 1 },
        url: urlProperty,
        title: linkTitleProperty,
      },
      required: ["kind", "number"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "issue" },
        number: { type: "integer", minimum: 1 },
        url: urlProperty,
        title: linkTitleProperty,
      },
      required: ["kind", "number"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "workItem" },
        provider: { const: "jira" },
        key: { type: "string", pattern: "^[A-Z][A-Z0-9_]*-\\d+$" },
        url: urlProperty,
        title: linkTitleProperty,
      },
      required: ["kind", "provider", "key"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "branch" },
        name: { type: "string", minLength: 1, maxLength: 255 },
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "thread" }, threadId: { type: "string", maxLength: 256 } },
      required: ["kind", "threadId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "url" },
        url: urlProperty,
        label: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["kind", "url"],
      additionalProperties: false,
    },
  ],
} as const;
const linksProperty = {
  type: "array",
  maxItems: LOCAL_TASK_MAX_LINKS,
  items: linkSchema,
  description:
    "What the task links to: pull requests, issues, Jira items, branches, chats (thread ids) and web pages. Replaces the whole list.",
} as const;
const fieldProperties = {
  title: { type: "string", minLength: 1, maxLength: 500 },
  notes: {
    type: "string",
    maxLength: 20_000,
    description: "Free text: the problem, the idea, details.",
  },
  priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
  dueAt: {
    type: ["string", "null"],
    description: "ISO instant of the due day (its local midnight), or null for none.",
  },
  projectId: {
    type: ["string", "null"],
    maxLength: 256,
    description: "The project (from ryco_list_projects) the task belongs to, or null for none.",
  },
  links: linksProperty,
} as const;

const descriptors = {
  list: {
    name: TOOLS.list,
    description: `List the node's Tasks, newest change first: id, revision, title, state (todo/done), status of their chats, priority, due day, project, links and a notes preview. ${NOT_TASK_RUNS}`,
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["todo", "done", "all"], description: "Defaults to todo." },
        projectId: { type: "string", maxLength: 256 },
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: AGENT_CONTROL_LOCAL_TASK_LIST_MAX },
      },
      additionalProperties: false,
    },
  },
  read: {
    name: TOOLS.read,
    description:
      "Read one Task whole: notes, links, files (ids for ryco_remove_local_task_file) and the chats started from it with their status. Use its revision for edits.",
    inputSchema: {
      type: "object",
      properties: { taskId: taskIdProperty },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  create: {
    name: TOOLS.create,
    description: `Add a Task to the user's Tasks page. Use a stable requestId: a retry with it answers with the same task. ${NOT_TASK_RUNS}`,
    inputSchema: {
      type: "object",
      properties: { requestId: requestIdProperty, ...fieldProperties },
      required: ["requestId", "title"],
      additionalProperties: false,
    },
  },
  update: {
    name: TOOLS.update,
    description:
      "Edit a Task: title, notes, priority, due day, project, links (the whole list), or state: done completes it, todo reopens it. Pass the revision you read; on a conflict read it again. A task with chats cannot move projects.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: taskIdProperty,
        expectedRevision: revisionProperty,
        ...fieldProperties,
        state: { type: "string", enum: ["todo", "done"] },
      },
      required: ["taskId", "expectedRevision"],
      additionalProperties: false,
    },
  },
  addFile: {
    name: TOOLS.addFile,
    description:
      "Add a file of this thread's workspace to a Task: every chat started from the task gets it with its first message. The path is relative to the workspace, with no links or parent traversal. At most 8 files and 50 MiB per task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: taskIdProperty,
        expectedRevision: revisionProperty,
        path: { type: "string", minLength: 1, maxLength: 4096 },
        name: { type: "string", minLength: 1, maxLength: 255 },
      },
      required: ["taskId", "expectedRevision", "path"],
      additionalProperties: false,
    },
  },
  removeFile: {
    name: TOOLS.removeFile,
    description: "Remove a file from a Task (chats that already got it keep their copy).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: taskIdProperty,
        expectedRevision: revisionProperty,
        fileId: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["taskId", "expectedRevision", "fileId"],
      additionalProperties: false,
    },
  },
  startChat: {
    name: TOOLS.startChat,
    description:
      "Start a chat for a Task, like Start on the Tasks page: recorded under the task, with the task's files on its first message. The first message is the task's title, notes and links unless you give a prompt. It runs through ryco_create_threads (the same project, runtime-mode and worktree rules), in the task's project (a task without one joins this chat's). Returns that request's receipt; confirm with ryco_wait_for_control_request.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: requestIdProperty,
        taskId: taskIdProperty,
        modelSelection: modelSelectionSchema,
        runtimeMode: {
          type: "string",
          enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
        },
        envMode: { type: "string", enum: ["local", "worktree"] },
        tokenMode: { type: "string", enum: ["off", "balanced", "aggressive"] },
        baseRef: { type: "string", maxLength: 256 },
        returnToOrigin: {
          type: "boolean",
          description: "Wake this chat with the chat's result or a failure/stop notice.",
        },
        title: { type: "string", minLength: 1, maxLength: AGENT_CONTROL_TITLE_MAX_CHARS },
        prompt: { type: "string", minLength: 1, maxLength: 120_000 },
      },
      required: ["requestId", "taskId", "modelSelection", "runtimeMode", "envMode"],
      additionalProperties: false,
    },
  },
  proposeDelete: {
    name: TOOLS.proposeDelete,
    description:
      "Ask the user to delete a Task with its files (its chats are kept). Nothing is deleted until the user approves; never approve it yourself. Returns a receipt; ryco_wait_for_control_request follows it.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: requestIdProperty,
        taskId: taskIdProperty,
        expectedRevision: revisionProperty,
      },
      required: ["requestId", "taskId", "expectedRevision"],
      additionalProperties: false,
    },
  },
} satisfies Record<keyof typeof TOOLS, AgentControlMcpToolDescriptor>;

const READ_TOOLS = new Set<string>([TOOLS.list, TOOLS.read]);
const ALL = Object.values(descriptors);

/** A task as the tools answer with it. */
const toTaskView = (task: LocalTask) => ({
  taskId: task.taskId,
  revision: task.revision,
  title: task.title,
  notes: task.notes,
  state: task.state,
  status: task.status,
  priority: task.priority,
  dueAt: task.dueAt,
  projectId: task.projectId,
  links: task.links,
  files: task.files.map((file) => ({
    fileId: file.fileId,
    name: file.name,
    type: file.type,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  })),
  chats: task.delegations.map((start) => ({
    threadId: start.threadId,
    sequence: start.sequence,
    status: start.status,
    branch: start.branch,
    error: start.error,
    startedAt: start.createdAt,
  })),
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

const toTaskSummary = (task: LocalTask) => {
  const notes = task.notes.trim();
  return {
    taskId: task.taskId,
    revision: task.revision,
    title: task.title,
    state: task.state,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt,
    projectId: task.projectId,
    notesPreview: notes.slice(0, AGENT_CONTROL_LOCAL_TASK_NOTES_PREVIEW_CHARS),
    notesTruncated: notes.length > AGENT_CONTROL_LOCAL_TASK_NOTES_PREVIEW_CHARS,
    links: task.links,
    fileCount: task.files.length,
    chatCount: task.delegations.length,
    updatedAt: task.updatedAt,
  };
};

const result = (value: unknown): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const errorResult = (text: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** The node's own words for a task error, with what an agent does about a conflict. */
const taskFailure = (error: LocalTaskError) =>
  new ToolFailure(
    error.reason === "conflict" && error.message.startsWith("Task changed")
      ? "The task changed since it was read. Read it again with ryco_read_local_task, then retry with its revision."
      : error.reason === "not-found"
        ? `${error.message} Use ryco_list_local_tasks for task ids.`
        : error.message,
  );

/** Every task, read page by page (the node caps one page at 100). */
const readAllTasks = (tasks: LocalTaskServiceShape) =>
  Effect.gen(function* () {
    const all: LocalTask[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const listed = yield* tasks.list({ limit: 100, ...(afterId ? { afterId } : {}) });
      all.push(...listed.tasks);
      if (listed.nextCursor === null) break;
      afterId = listed.nextCursor;
    }
    return all;
  });

export interface LocalTaskToolDeps extends Pick<
  AgentControlMcpToolDeps,
  "validator" | "proposals"
> {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly tasks: LocalTaskServiceShape;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getThreadCheckpointContext"
  >;
  /** Files are added from the caller's workspace; without these, ryco_add_local_task_file fails. */
  readonly workspaceAccess?: Pick<WorkspaceAccessPolicyShape, "assertExistingPath">;
  readonly taskFilesDir?: string;
}

/** Private, provider-session tools only. Same wrapper pattern as the delegation tools. */
export function withLocalTaskTools(
  base: AgentControlMcpTools,
  deps: LocalTaskToolDeps,
): AgentControlMcpTools {
  const capabilityFor = (name: string): AgentControlCapability =>
    READ_TOOLS.has(name)
      ? AGENT_CONTROL_CAPABILITIES.readLocalTasks
      : AGENT_CONTROL_CAPABILITIES.manageLocalTasks;
  const visibleTo = (
    session: AgentControlSessionRecord,
    descriptor: AgentControlMcpToolDescriptor,
  ) =>
    session.grantedCapabilities.includes(capabilityFor(descriptor.name)) &&
    // Starting a chat creates a thread: it needs that grant too.
    (descriptor.name !== TOOLS.startChat ||
      session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.createThreads));

  const authorize = (
    session: AgentControlSessionRecord,
    name: string,
    turnId?: AgentControlTurnAuthority["turnId"],
  ) =>
    deps.policy
      .authorize({
        principal: {
          kind: "provider-session",
          threadId: session.threadId,
          providerInstanceId: session.providerInstanceId,
          runtimeSessionId: session.runtimeSessionId,
          ...(turnId === undefined ? {} : { turnId }),
        },
        grantedCapabilities: session.grantedCapabilities,
        requiredCapability: capabilityFor(name),
        operation: `mcp:${name}`,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentControlDisabledError"
            ? new ToolFailure("Agent Control is disabled.")
            : new ToolFailure("Capability denied."),
        ),
      );
  /** The caller's exact active turn, or a failure: changes need it. */
  const requireAuthority = (session: AgentControlSessionRecord, name: string) =>
    Effect.gen(function* () {
      const authority = Option.filter(
        yield* deps.registry.getTurnAuthority(session.sessionId),
        (value) => value.sessionId === session.sessionId && value.threadId === session.threadId,
      );
      if (Option.isNone(authority))
        return yield* Effect.fail(
          new ToolFailure("Exact active-turn write authority is unavailable."),
        );
      yield* authorize(session, name, authority.value.turnId);
      return authority.value;
    });
  const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError(() => new ToolFailure("Invalid tool arguments.")),
    ) as Effect.Effect<S["Type"], ToolFailure>;
  const tasks = deps.tasks;
  const task = <A>(effect: Effect.Effect<A, LocalTaskError>) =>
    effect.pipe(Effect.mapError(taskFailure));

  const list = (args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlListLocalTasksInput, args);
      const state = input.state ?? "todo";
      const needle = input.query?.toLowerCase();
      const matching = (yield* task(readAllTasks(tasks)))
        .filter((entry) => state === "all" || entry.state === state)
        .filter((entry) => input.projectId === undefined || entry.projectId === input.projectId)
        .filter(
          (entry) =>
            needle === undefined ||
            entry.title.toLowerCase().includes(needle) ||
            entry.notes.toLowerCase().includes(needle),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const limit = Math.min(
        input.limit ?? AGENT_CONTROL_LOCAL_TASK_LIST_DEFAULT,
        AGENT_CONTROL_LOCAL_TASK_LIST_MAX,
      );
      return {
        tasks: matching.slice(0, limit).map(toTaskSummary),
        total: matching.length,
        truncated: matching.length > limit,
      };
    });

  const read = (args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlReadLocalTaskInput, args);
      return { task: toTaskView(yield* task(tasks.get(input.taskId))) };
    });

  const create = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlCreateLocalTaskInput, args);
      // One task per request: a retry of the same request finds it again.
      const taskId = `task-agent-${createHash("sha256")
        .update(JSON.stringify([session.threadId, input.requestId]))
        .digest("hex")
        .slice(0, 32)}`;
      const created = yield* tasks
        .create({
          taskId,
          title: input.title,
          notes: input.notes ?? "",
          priority: input.priority ?? "normal",
          dueAt: input.dueAt ?? null,
          projectId: input.projectId ?? null,
        })
        .pipe(
          Effect.mapError((error) =>
            error.reason === "conflict"
              ? new ToolFailure("Request ID was already used for a different task.")
              : taskFailure(error),
          ),
        );
      // Links are set by the first edit; a retry finds them set (or the task edited since).
      const links = input.links ?? [];
      const saved =
        links.length > 0 && created.revision === 0
          ? yield* task(tasks.update({ taskId, expectedRevision: 0, links }))
          : created;
      return { task: toTaskView(saved) };
    });

  const update = (args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlUpdateLocalTaskInput, args);
      return { task: toTaskView(yield* task(tasks.update(input))) };
    });

  const addFile = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlAddLocalTaskFileInput, args);
      if (deps.workspaceAccess === undefined || deps.taskFilesDir === undefined)
        return yield* Effect.fail(new ToolFailure("Task files are unavailable on this node."));
      const taskFilesDir = deps.taskFilesDir;
      const context = Option.getOrUndefined(
        yield* deps.projections
          .getThreadCheckpointContext(session.threadId)
          .pipe(Effect.mapError(() => new ToolFailure("This thread's workspace is unavailable."))),
      );
      const cwd = context?.worktreePath ?? context?.workspaceRoot;
      if (!cwd) return yield* Effect.fail(new ToolFailure("This thread has no workspace."));
      const authorizedCwd = yield* deps.workspaceAccess
        .assertExistingPath({ path: cwd, operation: "task file from workspace" })
        .pipe(Effect.mapError(() => new ToolFailure("This thread's workspace is unavailable.")));
      const stored = yield* task(
        storeTaskFileFromWorkspace({
          taskFilesDir,
          taskId: input.taskId,
          cwd: authorizedCwd,
          relativePath: input.path,
          name: input.name,
        }),
      );
      const saved = yield* tasks
        .addFile({
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          file: toLocalTaskFile({ ...stored, addedAt: new Date().toISOString() }),
        })
        .pipe(
          // A file the task does not hold has nowhere to go: unless the task holds it already.
          Effect.tapError(() =>
            tasks.get(input.taskId).pipe(
              Effect.flatMap((current) =>
                current.files.some((file) => file.fileId === stored.fileId)
                  ? Effect.void
                  : deleteTaskFiles(taskFilesDir, [stored.fileId]),
              ),
              Effect.catch(() => deleteTaskFiles(taskFilesDir, [stored.fileId])),
            ),
          ),
          Effect.mapError(taskFailure),
        );
      return { task: toTaskView(saved), fileId: stored.fileId };
    });

  const removeFile = (args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlRemoveLocalTaskFileInput, args);
      return { task: toTaskView(yield* task(tasks.removeFile(input))) };
    });

  const describeThread = (threadId: ThreadId) =>
    deps.projections.getThreadShellById(threadId).pipe(
      Effect.map((shell) => Option.getOrNull(Option.map(shell, (thread) => thread.title))),
      Effect.catch(() => Effect.succeed(null)),
    );

  const startChat = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlStartLocalTaskChatInput, args);
      const current = yield* task(tasks.get(input.taskId));
      if (current.state === "done")
        return yield* Effect.fail(
          new ToolFailure("The task is done. Reopen it (state todo) before starting a chat."),
        );
      const projectId =
        current.projectId ??
        Option.getOrNull(
          Option.map(
            yield* deps.projections
              .getThreadShellById(session.threadId)
              .pipe(Effect.mapError(() => new ToolFailure("This thread is unavailable."))),
            (thread) => thread.projectId,
          ),
        );
      if (projectId === null)
        return yield* Effect.fail(new ToolFailure("The task has no project to start a chat in."));
      const titles = new Map<ThreadId, string | null>();
      for (const link of current.links)
        if (link.kind === "thread") titles.set(link.threadId, yield* describeThread(link.threadId));
      const prompt =
        input.prompt ??
        buildTaskStartPrompt({
          title: current.title,
          notes: current.notes,
          links: current.links,
          describeThread: (threadId) => titles.get(threadId) ?? null,
        });
      // The validated, routine and audited thread-creation path does the rest.
      return yield* base.callTool(session, AGENT_CONTROL_MCP_TOOLS.createThreads, {
        requestId: input.requestId,
        entries: [
          {
            projectId,
            title:
              input.title ??
              (current.title.trim().slice(0, AGENT_CONTROL_TITLE_MAX_CHARS).trim() || "Task"),
            prompt: prompt.slice(0, 120_000),
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            envMode: input.envMode,
            ...(input.tokenMode === undefined ? {} : { tokenMode: input.tokenMode }),
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            ...(input.returnToOrigin === undefined ? {} : { returnToOrigin: input.returnToOrigin }),
            localTaskId: current.taskId,
          },
        ],
      });
    });

  const proposeDelete = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decode(AgentControlProposeLocalTaskDeleteInput, args);
      const current = yield* task(tasks.get(input.taskId));
      return yield* submitAgentControlMutation(deps, {
        session,
        authority,
        requestId: input.requestId,
        plan: {
          kind: "deleteLocalTask",
          taskId: current.taskId,
          expectedRevision: input.expectedRevision,
          title: current.title,
        },
      });
    });

  /** A tool's answer, whatever its shape. */
  const answer = <A>(effect: Effect.Effect<A, ToolFailure>): Effect.Effect<unknown, ToolFailure> =>
    effect;
  const run = (
    session: AgentControlSessionRecord,
    name: string,
    args: unknown,
  ): Effect.Effect<unknown, ToolFailure> => {
    if (name === TOOLS.list)
      return authorize(session, name).pipe(Effect.andThen(answer(list(args))));
    if (name === TOOLS.read)
      return authorize(session, name).pipe(Effect.andThen(answer(read(args))));
    return requireAuthority(session, name).pipe(
      Effect.flatMap((authority) => {
        switch (name) {
          case TOOLS.create:
            return answer(create(session, args));
          case TOOLS.update:
            return answer(update(args));
          case TOOLS.addFile:
            return answer(addFile(session, args));
          case TOOLS.removeFile:
            return answer(removeFile(args));
          case TOOLS.proposeDelete:
            return answer(proposeDelete(session, authority, args));
          default:
            return Effect.fail(new ToolFailure("Unknown tool."));
        }
      }),
    );
  };

  const call = (
    session: AgentControlSessionRecord,
    name: string,
    args: unknown,
  ): Effect.Effect<AgentControlMcpToolResult> =>
    // Starting a chat answers with the thread-creation tool's own result.
    (name === TOOLS.startChat
      ? requireAuthority(session, name).pipe(Effect.andThen(startChat(session, args)))
      : run(session, name, args).pipe(Effect.map(result))
    ).pipe(Effect.catch((failure) => Effect.succeed(errorResult(failure.reason))));

  return {
    ...base,
    descriptors: [...base.descriptors, ...ALL],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled)) return tools;
        return [...tools, ...ALL.filter((descriptor) => visibleTo(session, descriptor))];
      }),
    hasTool: (name) => ALL.some((descriptor) => descriptor.name === name) || base.hasTool(name),
    isWriteTool: (name) =>
      (ALL.some((descriptor) => descriptor.name === name) && !READ_TOOLS.has(name)) ||
      base.isWriteTool(name),
    callTool: (session, name, args) =>
      ALL.some((descriptor) => descriptor.name === name)
        ? call(session, name, args)
        : base.callTool(session, name, args),
  };
}
