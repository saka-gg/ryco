import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  ClientThreadTurnStartCommand,
  LOCAL_TASK_MAX_FILE_TOTAL_BYTES,
  LOCAL_TASK_MAX_FILES,
  type LocalTask,
  LocalTaskCreateInput,
  type LocalTaskDelegation,
  type LocalTaskDelegationStatus,
  LocalTaskDelegateInput,
  LocalTaskDeleteInput,
  LocalTaskError,
  LocalTaskFile,
  LocalTaskListInput,
  type LocalTaskListResult,
  LocalTaskRecord,
  LocalTaskRemoveFileInput,
  LocalTaskUpdateInput,
  type ProjectId,
} from "@ryco/contracts";
import { aggregateLocalTaskStatus } from "@ryco/shared/localTasks";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { type DelegatedRun, readDelegatedRun } from "../persistence/delegatedRunStatus.ts";
import { deleteTaskFiles } from "./taskFiles.ts";

type TaskEffect<A> = Effect.Effect<A, LocalTaskError>;
type TurnStartCommand = LocalTaskDelegateInput["command"];

/** A reserved (or replayed) chat start, and whether it still has to be dispatched. */
export interface LocalTaskDelegationReservation {
  readonly task: LocalTask;
  readonly command: TurnStartCommand;
  /** The task files the start carries into its first message. */
  readonly files: ReadonlyArray<LocalTaskFile>;
  readonly replayed: boolean;
  /**
   * False once the start reached orchestration: dispatching it again could only repeat work. (A
   * replay of a start that failed or was refused is not reserved at all; it fails.)
   */
  readonly needsDispatch: boolean;
}

export interface LocalTaskServiceShape {
  readonly list: (input: LocalTaskListInput) => TaskEffect<LocalTaskListResult>;
  readonly get: (taskId: string) => TaskEffect<LocalTask>;
  readonly create: (input: LocalTaskCreateInput) => TaskEffect<LocalTask>;
  readonly update: (input: LocalTaskUpdateInput) => TaskEffect<LocalTask>;
  readonly remove: (input: LocalTaskDeleteInput) => TaskEffect<{ deleted: true }>;
  /**
   * The task, when this exact start already reached its chat and needs no dispatch; otherwise
   * null. A start that failed or was refused fails again with its error (see `reserveDelegation`).
   */
  readonly getSettledDelegation: (input: LocalTaskDelegateInput) => TaskEffect<LocalTask | null>;
  /**
   * Reserves a new start, or replays one with the same command. A replay of a start that failed
   * or that orchestration refused fails with that error instead of answering: its command can
   * never run, and a client resending it (a Retry) must start again with a new one.
   */
  readonly reserveDelegation: (
    input: LocalTaskDelegateInput,
  ) => TaskEffect<LocalTaskDelegationReservation>;
  readonly markDelegated: (commandId: string) => TaskEffect<void>;
  /**
   * Records that a start failed, unless orchestration accepted its command: then it reached its
   * chat and reads dispatched, and this succeeds with false. True means nothing of the start
   * reached orchestration, so what the attempt prepared for it (its file copies) is unused.
   */
  readonly markDelegationFailed: (commandId: string, message: string) => TaskEffect<boolean>;
  readonly addFile: (input: {
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly file: LocalTaskFile;
  }) => TaskEffect<LocalTask>;
  readonly removeFile: (input: LocalTaskRemoveFileInput) => TaskEffect<LocalTask>;
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
const conflict = () => error("conflict", "Task changed. Reload before editing.");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown) => sha256(JSON.stringify(value));

/** Stored through the JSON codec, so dates inside source-control contexts decode back. */
const TurnStartCommandJson = Schema.toCodecJson(ClientThreadTurnStartCommand);
const encodeRecord = (record: LocalTaskRecord) =>
  JSON.stringify(Schema.encodeSync(LocalTaskRecord)(record));

/** Long enough for any dispatch error the user should read, short enough to bound the row. */
const MAX_START_ERROR_CHARS = 2_000;
export const INTERRUPTED_START_ERROR = "The chat start was interrupted by a restart.";
const FAILED_START_ERROR = "The chat could not be started.";
/** A replayed start that can never run: start the chat again with a new command. */
const startFailed = (message: string | null) =>
  error("conflict", message?.trim() ? message : FAILED_START_ERROR);
/** Leaves a file alone while an upload or add that wrote it may still be on its way. */
const ORPHAN_TASK_FILE_GRACE_MS = 60 * 60 * 1000;

interface TaskRow {
  task_id: string;
  revision: number;
  task_json: string;
  create_digest: string;
  deleted_at: string | null;
}
interface StartRow {
  command_id: string;
  task_id: string;
  sequence: number;
  thread_id: string;
  message_id: string;
  branch: string | null;
  command_digest: string;
  file_ids_json: string;
  dispatched: number;
  failed_at: string | null;
  error: string | null;
  created_at: string;
}

const parseRecord = (row: TaskRow) =>
  Schema.decodeUnknownSync(LocalTaskRecord)(JSON.parse(row.task_json));

/**
 * A chat's status from its delegated run. `failed` means the chat never got going: its turn start
 * failed, was refused, or a Stop cancelled it before any turn. A first turn that bound did run,
 * however it ended (a Stop, a restart, a provider error), so the chat is there to look at: it
 * reads `review` like a completed one, and whatever the user does in it next is the chat's own.
 */
const delegationStatus = ({ state, turnBound }: DelegatedRun): LocalTaskDelegationStatus => {
  switch (state) {
    case "completed":
      return "review";
    case "failed":
    case "interrupted":
      return turnBound ? "review" : "failed";
    case "rejected":
      return "failed";
    default:
      return state;
  }
};

const toDelegation = (start: StartRow, status: LocalTaskDelegationStatus) =>
  ({
    commandId: start.command_id,
    threadId: start.thread_id,
    messageId: start.message_id,
    sequence: start.sequence,
    branch: start.branch,
    dispatched: start.dispatched === 1,
    status,
    error: start.failed_at === null ? null : start.error,
    createdAt: start.created_at,
  }) as LocalTaskDelegation;

/**
 * Settles the starts a stopped process left unsent: one orchestration accepted did reach its
 * chat; one with no receipt never will, so it failed. A rejected start keeps its receipt, which
 * already reports it failed.
 */
export const settleInterruptedLocalTaskStarts = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`UPDATE local_task_delegations SET dispatched = 1
        WHERE dispatched = 0 AND failed_at IS NULL AND EXISTS (
          SELECT 1 FROM orchestration_command_receipts receipts
          WHERE receipts.command_id = local_task_delegations.command_id AND receipts.status = 'accepted')`;
      yield* sql`UPDATE local_task_delegations
        SET failed_at = ${new Date().toISOString()}, error = ${INTERRUPTED_START_ERROR}
        WHERE dispatched = 0 AND failed_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM orchestration_command_receipts receipts
          WHERE receipts.command_id = local_task_delegations.command_id)`;
    }),
  );

/**
 * Deletes files in the task-file store that no live task references: uploads nobody added,
 * files of a task whose deletion was cut short. Skips streaming `.part` files and anything
 * written within the last hour, which an upload or add may still be about to reference.
 * Returns how many files it deleted.
 */
export const cleanupOrphanTaskFiles = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly taskFilesDir: string;
  readonly nowMs: number;
}) =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise(() => readdir(input.taskFilesDir)).pipe(
      Effect.orElseSucceed((): string[] => []),
    );
    if (names.length === 0) return 0;
    const referenced = yield* input.sql<{ file_id: string | null }>`
      SELECT json_extract(file.value, '$.fileId') AS file_id
      FROM local_tasks,
        json_each(CASE WHEN json_valid(local_tasks.task_json) THEN local_tasks.task_json ELSE '{}' END, '$.files') AS file
      WHERE local_tasks.deleted_at IS NULL`;
    const live = new Set(referenced.flatMap((row) => (row.file_id ? [row.file_id] : [])));
    let deleted = 0;
    for (const name of names) {
      if (name.endsWith(".part") || live.has(name)) continue;
      const filePath = path.join(input.taskFilesDir, name);
      const info = yield* Effect.tryPromise(() => lstat(filePath)).pipe(Effect.option);
      if (
        Option.isNone(info) ||
        !info.value.isFile() ||
        input.nowMs - info.value.mtimeMs < ORPHAN_TASK_FILE_GRACE_MS
      )
        continue;
      const removed = yield* Effect.tryPromise(() => rm(filePath, { force: true })).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (removed) deleted += 1;
    }
    return deleted;
  });

export const makeLocalTaskService = (options: { readonly taskFilesDir: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { taskFilesDir } = options;

    // Before any request: a start a restart cut off must not read as starting forever.
    yield* settleInterruptedLocalTaskStarts(sql).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to settle interrupted local task starts", { cause }),
      ),
    );
    yield* cleanupOrphanTaskFiles({ sql, taskFilesDir, nowMs: Date.now() }).pipe(
      Effect.tap((deleted) =>
        deleted > 0 ? Effect.log(`Deleted ${deleted} orphaned task files`) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to clean up orphaned task files", { cause }),
      ),
      Effect.forkScoped,
    );

    const rowFor = (taskId: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<TaskRow>`SELECT task_id, revision, task_json, create_digest, deleted_at
          FROM local_tasks WHERE task_id = ${taskId}`;
        const row = rows[0];
        if (!row || row.deleted_at !== null)
          return yield* Effect.fail(error("not-found", "Task not found."));
        return row;
      });
    const recordFor = (row: TaskRow) =>
      Effect.try({
        try: () => parseRecord(row),
        catch: () => error("persistence", "Task storage is unavailable."),
      });
    const checkProject = (projectId: ProjectId | null) =>
      Effect.gen(function* () {
        if (projectId === null) return;
        const rows =
          yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`;
        if (!rows.length)
          return yield* Effect.fail(error("invalid", "The task project is unavailable."));
      });

    /**
     * A chat's status, judged by the exact first message it was started with. A done task's
     * chats are not read: the task is finished whatever they do, and clients show live chats
     * from their own thread state.
     */
    const startStatus = (start: StartRow, done: boolean) => {
      if (start.failed_at !== null) return Effect.succeed<LocalTaskDelegationStatus>("failed");
      if (done) return Effect.succeed<LocalTaskDelegationStatus>("review");
      return readDelegatedRun(sql, {
        threadId: start.thread_id,
        messageId: start.message_id,
        commandId: start.command_id,
        dispatched: start.dispatched === 1,
      }).pipe(Effect.map(delegationStatus));
    };

    /** One read of the page's starts and one of its projects, then each open task's chats. */
    const presentMany = (rows: ReadonlyArray<TaskRow>) =>
      Effect.gen(function* () {
        if (rows.length === 0) return [];
        const records = yield* Effect.forEach(rows, recordFor);
        const starts = yield* sql<StartRow>`SELECT command_id, task_id, sequence, thread_id,
            message_id, branch, command_digest, file_ids_json, dispatched, failed_at, error, created_at
          FROM local_task_delegations
          WHERE ${sql.in(
            "task_id",
            records.map((record) => record.taskId),
          )}
          ORDER BY task_id, sequence`;
        const startsByTask = new Map<string, StartRow[]>();
        for (const start of starts) {
          const list = startsByTask.get(start.task_id);
          if (list) list.push(start);
          else startsByTask.set(start.task_id, [start]);
        }
        const projectIds = [
          ...new Set(
            records.flatMap((record) =>
              record.state !== "done" && record.projectId !== null ? [record.projectId] : [],
            ),
          ),
        ];
        const liveProjects = new Set(
          projectIds.length === 0
            ? []
            : (yield* sql<{ project_id: string }>`SELECT project_id FROM projection_projects
                WHERE deleted_at IS NULL AND ${sql.in("project_id", projectIds)}`).map(
                (row) => row.project_id,
              ),
        );
        return yield* Effect.forEach(records, (record) =>
          Effect.gen(function* () {
            const done = record.state === "done";
            const delegations = yield* Effect.forEach(
              startsByTask.get(record.taskId) ?? [],
              (start) =>
                startStatus(start, done).pipe(Effect.map((status) => toDelegation(start, status))),
            );
            const status: LocalTask["status"] = done
              ? "done"
              : record.projectId !== null && !liveProjects.has(record.projectId)
                ? "unavailable"
                : aggregateLocalTaskStatus(delegations.map((delegation) => delegation.status));
            return { ...record, status, delegations } satisfies LocalTask;
          }),
        );
      });
    const present = (row: TaskRow) =>
      presentMany([row]).pipe(Effect.map((tasks) => tasks[0] as LocalTask));

    const save = (row: TaskRow, record: LocalTaskRecord) =>
      Effect.gen(function* () {
        const next: LocalTaskRecord = {
          ...record,
          revision: row.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        const taskJson = encodeRecord(next);
        const changed =
          yield* sql`UPDATE local_tasks SET revision = ${next.revision}, task_json = ${taskJson}
          WHERE task_id = ${row.task_id} AND revision = ${row.revision} AND deleted_at IS NULL RETURNING task_id`;
        if (!changed.length) return yield* Effect.fail(conflict());
        return { ...row, revision: next.revision, task_json: taskJson } satisfies TaskRow;
      });
    const validateRevision = (row: TaskRow, expected: number) =>
      row.revision === expected ? Effect.void : Effect.fail(conflict());
    const get = (taskId: string) =>
      rowFor(taskId).pipe(Effect.flatMap(present), Effect.mapError(mapError));
    const commandDigest = (command: TurnStartCommand) =>
      Schema.encodeEffect(TurnStartCommandJson)(command).pipe(
        Effect.map((encoded) => {
          const json = JSON.stringify(encoded);
          return { json, digest: sha256(json) };
        }),
      );

    /**
     * The stored start with this command id, checked to be the same command for the same task;
     * null when there is none. An unsent start whose command orchestration accepted is marked
     * dispatched here (its first attempt lost the race with a restart or a dropped response). A
     * start that failed, or whose command orchestration refused, fails with its error: it can
     * never run, and answering it like a start that did would report a chat that isn't there.
     */
    const findStart = (taskId: string, command: TurnStartCommand, expectedDigest: string) =>
      Effect.gen(function* () {
        const start = (yield* sql<StartRow>`SELECT command_id, task_id, sequence, thread_id,
            message_id, branch, command_digest, file_ids_json, dispatched, failed_at, error, created_at
          FROM local_task_delegations WHERE command_id = ${command.commandId}`)[0];
        if (!start) return null;
        if (start.task_id !== taskId || start.command_digest !== expectedDigest)
          return yield* Effect.fail(error("conflict", "The chat start command changed."));
        if (start.failed_at !== null) return yield* Effect.fail(startFailed(start.error));
        if (start.dispatched === 1) return { start, needsDispatch: false };
        const receipt = (yield* sql<{
          status: string;
          aggregate_id: string;
          error: string | null;
        }>`SELECT status, aggregate_id, error FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`)[0];
        if (receipt?.status === "accepted" && receipt.aggregate_id === command.threadId) {
          yield* sql`UPDATE local_task_delegations SET dispatched = 1 WHERE command_id = ${command.commandId}`;
          return { start: { ...start, dispatched: 1 }, needsDispatch: false };
        }
        if (receipt?.status === "rejected") return yield* Effect.fail(startFailed(receipt.error));
        // Orchestration answers a repeated command id from its receipt; only an unseen one runs.
        return { start, needsDispatch: receipt === undefined };
      });
    const startFiles = (start: StartRow, record: LocalTaskRecord) => {
      const fileIds = new Set(JSON.parse(start.file_ids_json) as ReadonlyArray<string>);
      return record.files.filter((file) => fileIds.has(file.fileId));
    };

    const service: LocalTaskServiceShape = {
      get,
      list: (input) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(LocalTaskListInput)(input);
          const limit = decoded.limit ?? 50;
          const rows =
            yield* sql<TaskRow>`SELECT task_id, revision, task_json, create_digest, deleted_at
            FROM local_tasks WHERE deleted_at IS NULL AND task_id > ${decoded.afterId ?? ""}
            ORDER BY task_id ASC LIMIT ${limit + 1}`;
          const tasks = yield* presentMany(rows.slice(0, limit));
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
                (yield* sql<TaskRow>`SELECT task_id, revision, task_json, create_digest, deleted_at
                FROM local_tasks WHERE task_id = ${decoded.taskId}`)[0];
              if (existing) {
                if (existing.deleted_at !== null || existing.create_digest !== digest(decoded))
                  return yield* Effect.fail(
                    error("conflict", "Task identifier is already in use."),
                  );
                return yield* present(existing);
              }
              yield* checkProject(decoded.projectId);
              const now = new Date().toISOString();
              const record: LocalTaskRecord = {
                ...decoded,
                revision: 0,
                links: [],
                files: [],
                state: "todo",
                createdAt: now,
                updatedAt: now,
              };
              yield* sql`INSERT INTO local_tasks (task_id, revision, task_json, create_digest)
                VALUES (${record.taskId}, 0, ${encodeRecord(record)}, ${digest(decoded)})`;
              return { ...record, status: "todo", delegations: [] } satisfies LocalTask;
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
              const record = yield* recordFor(row);
              if (decoded.title !== undefined && !decoded.title.trim())
                return yield* Effect.fail(error("invalid", "Task title is required."));
              if (decoded.projectId !== undefined && decoded.projectId !== record.projectId) {
                // Its chats run in the project; moving the task would orphan them. A start holds
                // the project while it may have a chat there: its thread is live, or it was not
                // sent yet and nothing says it failed. One that failed before its chat existed,
                // or whose chat was deleted, has nothing to orphan. (Clients mirror this with
                // `taskProjectLocked`.)
                const started = yield* sql`SELECT 1 FROM local_task_delegations starts
                  LEFT JOIN projection_threads threads ON threads.thread_id = starts.thread_id
                  WHERE starts.task_id = ${record.taskId} AND (
                    (threads.thread_id IS NOT NULL AND threads.deleted_at IS NULL)
                    OR (threads.thread_id IS NULL AND starts.dispatched = 0 AND starts.failed_at IS NULL
                      AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts receipts
                        WHERE receipts.command_id = starts.command_id AND receipts.status = 'rejected')))
                  LIMIT 1`;
                if (started.length)
                  return yield* Effect.fail(
                    error("invalid", "A task with chats cannot move projects."),
                  );
                yield* checkProject(decoded.projectId);
              }
              const saved = yield* save(row, {
                ...record,
                title: decoded.title ?? record.title,
                notes: decoded.notes ?? record.notes,
                priority: decoded.priority ?? record.priority,
                dueAt: decoded.dueAt === undefined ? record.dueAt : decoded.dueAt,
                projectId: decoded.projectId === undefined ? record.projectId : decoded.projectId,
                state: decoded.state ?? record.state,
                links: decoded.links ?? record.links,
              });
              return yield* present(saved);
            }),
          )
          .pipe(Effect.mapError(mapError)),
      remove: (input) =>
        Effect.gen(function* () {
          const fileIds = yield* sql.withTransaction(
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(LocalTaskDeleteInput)(input);
              const row = yield* rowFor(decoded.taskId);
              yield* validateRevision(row, decoded.expectedRevision);
              const record = yield* recordFor(row);
              // A tombstone prevents a retried create from resurrecting a deleted task.
              yield* sql`UPDATE local_tasks SET deleted_at = ${new Date().toISOString()}, revision = revision + 1
                WHERE task_id = ${decoded.taskId} AND revision = ${decoded.expectedRevision}`;
              yield* sql`DELETE FROM local_task_delegations WHERE task_id = ${decoded.taskId}`;
              return record.files.map((file) => file.fileId);
            }),
          );
          // The chats keep their own copies; only the task's originals go.
          yield* deleteTaskFiles(taskFilesDir, fileIds);
          return { deleted: true as const };
        }).pipe(Effect.mapError(mapError)),
      getSettledDelegation: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(LocalTaskDelegateInput)(input);
              const { digest: expectedDigest } = yield* commandDigest(decoded.command);
              const replay = yield* findStart(decoded.taskId, decoded.command, expectedDigest);
              if (!replay || replay.needsDispatch) return null;
              return yield* rowFor(decoded.taskId).pipe(Effect.flatMap(present));
            }),
          )
          .pipe(Effect.mapError(mapError)),
      reserveDelegation: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(LocalTaskDelegateInput)(input);
              const command = decoded.command;
              const stored = yield* commandDigest(command);
              let row = yield* rowFor(decoded.taskId);
              const record = yield* recordFor(row);
              const replay = yield* findStart(decoded.taskId, command, stored.digest);
              if (replay) {
                return {
                  task: yield* present(row),
                  command,
                  files: startFiles(replay.start, record),
                  replayed: true,
                  needsDispatch: replay.needsDispatch,
                };
              }
              if (record.state === "done")
                return yield* Effect.fail(
                  error("invalid", "Reopen the task before starting a chat."),
                );
              // Starting a chat leaves the task's revision alone, so a client sends one only to
              // start from exactly what it shows.
              if (decoded.expectedRevision !== undefined)
                yield* validateRevision(row, decoded.expectedRevision);
              const claimed =
                yield* sql`SELECT 1 FROM local_task_delegations WHERE thread_id = ${command.threadId} AND message_id = ${command.message.messageId}
                UNION ALL SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${command.commandId} LIMIT 1`;
              if (claimed.length)
                return yield* Effect.fail(
                  error("conflict", "The chat start command or message is already in use."),
                );
              const bootstrap = command.bootstrap;
              if (bootstrap?.createChatProject !== undefined)
                return yield* Effect.fail(
                  error("invalid", "A task's chat starts in a project, not as a chat without one."),
                );
              const thread = (yield* sql<{
                project_id: ProjectId;
                deleted_at: string | null;
              }>`SELECT project_id, deleted_at FROM projection_threads WHERE thread_id = ${command.threadId}`)[0];
              let projectId: ProjectId;
              if (thread) {
                if (thread.deleted_at !== null)
                  return yield* Effect.fail(error("invalid", "The target thread is unavailable."));
                if (bootstrap?.createThread !== undefined)
                  return yield* Effect.fail(error("invalid", "The target thread already exists."));
                projectId = thread.project_id;
              } else {
                // The thread may not be projected yet: only a start that creates it may name it.
                if (bootstrap?.createThread === undefined)
                  return yield* Effect.fail(
                    error("invalid", "Select an existing thread or create one for the task."),
                  );
                projectId = bootstrap.createThread.projectId;
              }
              yield* checkProject(projectId);
              if (record.projectId !== null && record.projectId !== projectId)
                return yield* Effect.fail(
                  error("invalid", "The chat belongs to another project than the task."),
                );
              const previousMessage =
                yield* sql`SELECT 1 FROM projection_thread_messages WHERE thread_id = ${command.threadId} AND message_id = ${command.message.messageId}
                UNION ALL SELECT 1 FROM projection_turns WHERE thread_id = ${command.threadId} AND pending_message_id = ${command.message.messageId} LIMIT 1`;
              if (previousMessage.length)
                return yield* Effect.fail(
                  error("conflict", "Starting a chat requires a new user message."),
                );
              // Every task file travels with the message, inside one message's budget.
              const attachments = command.message.attachments;
              const fileCount = attachments.length + record.files.length;
              const fileBytes =
                attachments.reduce((total, attachment) => total + (attachment.sizeBytes ?? 0), 0) +
                record.files.reduce((total, file) => total + file.sizeBytes, 0);
              if (fileCount > LOCAL_TASK_MAX_FILES || fileBytes > LOCAL_TASK_MAX_FILE_TOTAL_BYTES)
                return yield* Effect.fail(
                  error(
                    "invalid",
                    `The message and the task's files exceed one message's ${LOCAL_TASK_MAX_FILES} files or ${LOCAL_TASK_MAX_FILE_TOTAL_BYTES} bytes.`,
                  ),
                );
              // A task without a project joins the one its first chat runs in.
              if (record.projectId === null) row = yield* save(row, { ...record, projectId });
              yield* sql`INSERT INTO local_task_delegations (command_id, task_id, sequence, thread_id,
                  message_id, branch, command_json, command_digest, file_ids_json, created_at)
                SELECT ${command.commandId}, ${record.taskId}, COALESCE(MAX(sequence), 0) + 1,
                  ${command.threadId}, ${command.message.messageId},
                  ${bootstrap?.prepareWorktree?.branch ?? null}, ${stored.json}, ${stored.digest},
                  ${JSON.stringify(record.files.map((file) => file.fileId))}, ${new Date().toISOString()}
                FROM local_task_delegations WHERE task_id = ${record.taskId}`;
              return {
                task: yield* present(row),
                command,
                files: record.files,
                replayed: false,
                needsDispatch: true,
              };
            }),
          )
          .pipe(Effect.mapError(mapError)),
      markDelegated: (commandId) =>
        sql`UPDATE local_task_delegations SET dispatched = 1 WHERE command_id = ${commandId}`.pipe(
          Effect.asVoid,
          Effect.mapError(mapError),
        ),
      markDelegationFailed: (commandId, message) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              // A command orchestration accepted reached its chat, whatever failed after it.
              const accepted =
                yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${commandId} AND status = 'accepted'`;
              if (accepted.length) {
                yield* sql`UPDATE local_task_delegations SET dispatched = 1 WHERE command_id = ${commandId}`;
                return false;
              }
              yield* sql`UPDATE local_task_delegations
                SET failed_at = ${new Date().toISOString()}, error = ${message.slice(0, MAX_START_ERROR_CHARS)}
                WHERE command_id = ${commandId} AND dispatched = 0 AND failed_at IS NULL`;
              return true;
            }),
          )
          .pipe(Effect.mapError(mapError)),
      addFile: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const file = yield* Schema.decodeUnknownEffect(LocalTaskFile)(input.file);
              const row = yield* rowFor(input.taskId);
              const record = yield* recordFor(row);
              // A retried add of a claimed upload names the same file.
              if (record.files.some((existing) => existing.fileId === file.fileId))
                return yield* present(row);
              yield* validateRevision(row, input.expectedRevision);
              const files = [...record.files, file];
              if (files.length > LOCAL_TASK_MAX_FILES)
                return yield* Effect.fail(
                  error("invalid", `A task holds at most ${LOCAL_TASK_MAX_FILES} files.`),
                );
              if (
                files.reduce((total, entry) => total + entry.sizeBytes, 0) >
                LOCAL_TASK_MAX_FILE_TOTAL_BYTES
              )
                return yield* Effect.fail(
                  error(
                    "invalid",
                    `A task's files add up to at most ${LOCAL_TASK_MAX_FILE_TOTAL_BYTES} bytes.`,
                  ),
                );
              return yield* present(yield* save(row, { ...record, files }));
            }),
          )
          .pipe(Effect.mapError(mapError)),
      removeFile: (input) =>
        Effect.gen(function* () {
          const task = yield* sql.withTransaction(
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(LocalTaskRemoveFileInput)(input);
              const row = yield* rowFor(decoded.taskId);
              yield* validateRevision(row, decoded.expectedRevision);
              const record = yield* recordFor(row);
              if (!record.files.some((file) => file.fileId === decoded.fileId))
                return yield* Effect.fail(error("not-found", "Task file not found."));
              const saved = yield* save(row, {
                ...record,
                files: record.files.filter((file) => file.fileId !== decoded.fileId),
              });
              return yield* present(saved);
            }),
          );
          yield* deleteTaskFiles(taskFilesDir, [input.fileId]);
          return task;
        }).pipe(Effect.mapError(mapError)),
    };
    return service;
  });

export const LocalTaskServiceLive = Layer.effect(
  LocalTaskService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeLocalTaskService({ taskFilesDir: config.taskFilesDir });
  }),
);
