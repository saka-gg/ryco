import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ClientThreadTurnStartCommand,
  LocalTask,
  LocalTaskCreateInput,
  LocalTaskUpdateInput,
  LocalTaskDelegateInput,
  LocalTaskDeleteInput,
  LocalTaskListInput,
  LocalTaskListResult,
  LocalTaskError,
  type ProjectId,
} from "@ryco/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readDelegatedRunState } from "../persistence/delegatedRunStatus.ts";

type TaskEffect<A> = Effect.Effect<A, LocalTaskError>;
export interface LocalTaskServiceShape {
  readonly list: (input: LocalTaskListInput) => TaskEffect<LocalTaskListResult>;
  readonly get: (taskId: string) => TaskEffect<LocalTask>;
  readonly create: (input: LocalTaskCreateInput) => TaskEffect<LocalTask>;
  readonly update: (input: LocalTaskUpdateInput) => TaskEffect<LocalTask>;
  readonly remove: (input: LocalTaskDeleteInput) => TaskEffect<{ deleted: true }>;
  readonly getAcceptedDelegation: (input: LocalTaskDelegateInput) => TaskEffect<LocalTask | null>;
  readonly reserveDelegation: (input: LocalTaskDelegateInput) => TaskEffect<{
    task: LocalTask;
    command: LocalTaskDelegateInput["command"];
    replayed: boolean;
  }>;
  readonly markDelegated: (input: { taskId: string; commandId: string }) => TaskEffect<LocalTask>;
}
export class LocalTaskService extends Context.Service<LocalTaskService, LocalTaskServiceShape>()(
  "ryco/tasks/LocalTaskService",
) {}

const error = (reason: LocalTaskError["reason"], message: string) =>
  new LocalTaskError({ reason, message });
const mapError = (cause: unknown) =>
  Schema.is(LocalTaskError)(cause)
    ? cause
    : Schema.isSchemaError(cause)
      ? error("invalid", "Task input is invalid.")
      : error("persistence", "Task storage is unavailable.");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Row {
  task_id: string;
  revision: number;
  task_json: string;
  create_digest: string;
  command_json: string | null;
  command_digest: string | null;
  deleted_at: string | null;
}
const parseTask = (row: Row) => Schema.decodeUnknownSync(LocalTask)(JSON.parse(row.task_json));

export const makeLocalTaskService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rowFor = (taskId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<Row>`SELECT * FROM local_tasks WHERE task_id = ${taskId}`;
      const row = rows[0];
      if (!row || row.deleted_at !== null)
        return yield* Effect.fail(error("not-found", "Task not found."));
      return row;
    });
  const checkProject = (projectId: ProjectId | null) =>
    Effect.gen(function* () {
      if (projectId === null) return;
      const rows =
        yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`;
      if (!rows.length)
        return yield* Effect.fail(error("invalid", "The task project is unavailable."));
    });
  const present = (row: Row) =>
    Effect.gen(function* () {
      const task = yield* Effect.try({
        try: () => parseTask(row),
        catch: () => error("persistence", "Task storage is unavailable."),
      });
      if (task.state === "done") return { ...task, status: "done" as const };
      if (task.projectId !== null) {
        const project =
          yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${task.projectId} AND deleted_at IS NULL`;
        if (!project.length) return { ...task, status: "unavailable" as const };
      }
      const delegation = task.delegation;
      if (!delegation) return { ...task, status: "todo" as const };
      const run = yield* readDelegatedRunState(sql, delegation);
      switch (run) {
        case "rejected":
        case "failed":
        case "interrupted":
          return { ...task, status: "failed" as const };
        case "completed":
          return { ...task, status: "review" as const };
        default:
          return { ...task, status: run };
      }
    });
  const save = (row: Row, task: LocalTask, command?: LocalTaskDelegateInput["command"]) =>
    Effect.gen(function* () {
      const next = { ...task, revision: row.revision + 1, updatedAt: new Date().toISOString() };
      const changed =
        yield* sql`UPDATE local_tasks SET revision = ${next.revision}, task_json = ${JSON.stringify(next)},
      command_json = ${command ? JSON.stringify(command) : row.command_json}, command_digest = ${command ? digest(command) : row.command_digest},
      command_id = ${next.delegation?.commandId ?? null}, delegation_thread_id = ${next.delegation?.threadId ?? null}, delegation_message_id = ${next.delegation?.messageId ?? null}
      WHERE task_id = ${row.task_id} AND revision = ${row.revision} AND deleted_at IS NULL RETURNING task_id`;
      if (!changed.length)
        return yield* Effect.fail(error("conflict", "Task changed. Reload before editing."));
      return yield* rowFor(row.task_id).pipe(Effect.flatMap(present));
    });
  const validateRevision = (row: Row, expected: number) =>
    row.revision === expected
      ? Effect.void
      : Effect.fail(error("conflict", "Task changed. Reload before editing."));
  const get = (taskId: string) =>
    rowFor(taskId).pipe(Effect.flatMap(present), Effect.mapError(mapError));
  const replayDelegation = (row: Row, task: LocalTask, decoded: LocalTaskDelegateInput) =>
    Effect.gen(function* () {
      if (task.delegation?.commandId !== decoded.command.commandId || !row.command_json)
        return null;
      const command = yield* Schema.decodeUnknownEffect(ClientThreadTurnStartCommand)(
        JSON.parse(row.command_json),
      );
      if (!isDeepStrictEqual(command, decoded.command))
        return yield* Effect.fail(error("conflict", "The delegation command changed."));
      const receipts = yield* sql<{
        status: string;
        aggregate_id: string;
      }>`SELECT status, aggregate_id FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`;
      const accepted =
        receipts[0]?.status === "accepted" && receipts[0].aggregate_id === command.threadId;
      const recovered =
        accepted && !task.delegation.dispatched
          ? yield* save(row, { ...task, delegation: { ...task.delegation, dispatched: true } })
          : task;
      return { task: recovered, command, replayed: true as const };
    });
  const service: LocalTaskServiceShape = {
    getAcceptedDelegation: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const decoded = yield* Schema.decodeUnknownEffect(LocalTaskDelegateInput)(input);
            const row = yield* rowFor(decoded.taskId);
            const task = yield* present(row);
            const replay = yield* replayDelegation(row, task, decoded);
            return replay?.task.delegation?.dispatched ? replay.task : null;
          }),
        )
        .pipe(Effect.mapError(mapError)),
    get,
    list: (input) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(LocalTaskListInput)(input);
        const limit = decoded.limit ?? 50;
        const rows =
          yield* sql<Row>`SELECT * FROM local_tasks WHERE deleted_at IS NULL AND task_id > ${decoded.afterId ?? ""} ORDER BY task_id ASC LIMIT ${limit + 1}`;
        const tasks = yield* Effect.forEach(rows.slice(0, limit), present);
        return { tasks, nextCursor: rows.length > limit ? tasks.at(-1)!.taskId : null };
      }).pipe(Effect.mapError(mapError)),
    create: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const decoded = yield* Schema.decodeUnknownEffect(LocalTaskCreateInput)(input);
            if (!decoded.title.trim())
              return yield* Effect.fail(error("invalid", "Task title is required."));
            const existing =
              (yield* sql<Row>`SELECT * FROM local_tasks WHERE task_id = ${decoded.taskId}`)[0];
            if (existing) {
              if (existing.deleted_at !== null || existing.create_digest !== digest(decoded))
                return yield* Effect.fail(error("conflict", "Task identifier is already in use."));
              return yield* present(existing);
            }
            yield* checkProject(decoded.projectId);
            const now = new Date().toISOString();
            const task: LocalTask = {
              ...decoded,
              revision: 0,
              state: "todo",
              status: "todo",
              delegation: null,
              createdAt: now,
              updatedAt: now,
            };
            yield* sql`INSERT INTO local_tasks (task_id, revision, task_json, create_digest) VALUES (${task.taskId}, 0, ${JSON.stringify(task)}, ${digest(decoded)})`;
            return task;
          }),
        )
        .pipe(Effect.mapError(mapError)),
    update: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const decoded = yield* Schema.decodeUnknownEffect(LocalTaskUpdateInput)(input);
            const row = yield* rowFor(decoded.taskId);
            yield* validateRevision(row, decoded.expectedRevision);
            const task = yield* present(row);
            if (decoded.title !== undefined && !decoded.title.trim())
              return yield* Effect.fail(error("invalid", "Task title is required."));
            if (decoded.projectId !== undefined && decoded.projectId !== task.projectId) {
              if (task.delegation)
                return yield* Effect.fail(
                  error("invalid", "A delegated task cannot move projects."),
                );
              yield* checkProject(decoded.projectId);
            }
            return yield* save(row, {
              ...task,
              title: decoded.title ?? task.title,
              notes: decoded.notes ?? task.notes,
              priority: decoded.priority ?? task.priority,
              dueAt: decoded.dueAt === undefined ? task.dueAt : decoded.dueAt,
              projectId: decoded.projectId === undefined ? task.projectId : decoded.projectId,
              state: decoded.state ?? task.state,
            });
          }),
        )
        .pipe(Effect.mapError(mapError)),
    remove: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const decoded = yield* Schema.decodeUnknownEffect(LocalTaskDeleteInput)(input);
            const row = yield* rowFor(decoded.taskId);
            yield* validateRevision(row, decoded.expectedRevision);
            // A tombstone prevents a retried create from resurrecting a deleted task.
            yield* sql`UPDATE local_tasks SET deleted_at = ${new Date().toISOString()}, revision = revision + 1,
        command_json = NULL, command_digest = NULL WHERE task_id = ${decoded.taskId} AND revision = ${decoded.expectedRevision}`;
            return { deleted: true as const };
          }),
        )
        .pipe(Effect.mapError(mapError)),
    reserveDelegation: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const decoded = yield* Schema.decodeUnknownEffect(LocalTaskDelegateInput)(input);
            if (decoded.command.bootstrap !== undefined)
              return yield* Effect.fail(
                error(
                  "invalid",
                  "Create the chat through normal orchestration before delegating a task.",
                ),
              );
            const row = yield* rowFor(decoded.taskId);
            const task = yield* present(row);
            if (task.state === "done")
              return yield* Effect.fail(error("invalid", "Reopen the task before delegating it."));
            const replayed = yield* replayDelegation(row, task, decoded);
            if (replayed) return replayed;
            yield* validateRevision(row, decoded.expectedRevision);
            if (["starting", "running", "needs-you"].includes(task.status))
              return yield* Effect.fail(
                error("conflict", "The task already has active delegated work."),
              );
            const command = decoded.command;
            const claimed =
              yield* sql`SELECT 1 FROM local_tasks WHERE command_id = ${command.commandId}
              OR (delegation_thread_id = ${command.threadId} AND delegation_message_id = ${command.message.messageId})
              UNION ALL SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${command.commandId} LIMIT 1`;
            if (claimed.length)
              return yield* Effect.fail(
                error("conflict", "The delegation command or message is already in use."),
              );
            const threads = yield* sql<{
              project_id: ProjectId;
              deleted_at: string | null;
            }>`SELECT project_id, deleted_at FROM projection_threads WHERE thread_id = ${command.threadId}`;
            const thread = threads[0];
            if (thread?.deleted_at)
              return yield* Effect.fail(error("invalid", "The target thread is unavailable."));
            const projectId = thread?.project_id;
            if (!projectId)
              return yield* Effect.fail(
                error("invalid", "Select an existing thread before delegating a task."),
              );
            yield* checkProject(projectId);
            if (task.projectId !== null && task.projectId !== projectId)
              return yield* Effect.fail(
                error("invalid", "The target thread belongs to another project."),
              );
            const previousMessage =
              yield* sql`SELECT 1 FROM projection_thread_messages WHERE thread_id = ${command.threadId} AND message_id = ${command.message.messageId}
        UNION ALL SELECT 1 FROM projection_turns WHERE thread_id = ${command.threadId} AND pending_message_id = ${command.message.messageId} LIMIT 1`;
            if (previousMessage.length)
              return yield* Effect.fail(
                error("conflict", "Delegation requires a new user message."),
              );
            const saved = yield* save(
              row,
              {
                ...task,
                projectId,
                delegation: {
                  threadId: command.threadId,
                  messageId: command.message.messageId,
                  commandId: command.commandId,
                  dispatched: false,
                },
              },
              command,
            );
            return { task: saved, command, replayed: false };
          }),
        )
        .pipe(Effect.mapError(mapError)),
    markDelegated: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* rowFor(input.taskId);
            const task = yield* present(row);
            if (task.delegation?.commandId !== input.commandId)
              return yield* Effect.fail(error("conflict", "Task delegation changed."));
            if (task.delegation.dispatched) return task;
            return yield* save(row, {
              ...task,
              delegation: { ...task.delegation, dispatched: true },
            });
          }),
        )
        .pipe(Effect.mapError(mapError)),
  };
  return service;
});
export const LocalTaskServiceLive = Layer.effect(LocalTaskService, makeLocalTaskService);
