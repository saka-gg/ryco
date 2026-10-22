import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CommandId,
  LOCAL_TASK_MAX_FILES,
  type LocalTaskChange,
  type LocalTaskFile,
  type LocalTaskLink,
  MessageId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type LocalTaskDelegateInput,
} from "@ryco/contracts";
import {
  cleanupOrphanTaskFiles,
  INTERRUPTED_START_ERROR,
  LocalTaskService,
  makeLocalTaskService,
} from "./LocalTaskService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readDelegatedRunState } from "../persistence/delegatedRunStatus.ts";
import { ensureLocalTaskDelegationsTable } from "../persistence/Migrations/092_LocalTaskDelegations.ts";

const makeTaskFilesDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ryco-task-files-"));
const makeLayer = (taskFilesDir = makeTaskFilesDir()) =>
  Layer.effect(LocalTaskService, makeLocalTaskService({ taskFilesDir })).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  );
const layer = makeLayer();
const create = (taskId = "task") => ({
  taskId,
  title: "Investigate reconnects",
  notes: "Keep the owner fence",
  priority: "high" as const,
  dueAt: null,
  projectId: null,
});
const projectId = ProjectId.make("project");
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', '/tmp/project', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES ('thread', ${projectId}, 'Thread', '{"instanceId":"codex","model":"gpt-5"}', 'approval-required', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
});
const addThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'Thread', '{"instanceId":"codex","model":"gpt-5"}', 'approval-required', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
  });
const command = (suffix = "one", threadId = "thread"): LocalTaskDelegateInput["command"] => ({
  type: "thread.turn.start",
  commandId: CommandId.make(`command-${suffix}`),
  threadId: ThreadId.make(threadId),
  message: {
    messageId: MessageId.make(`message-${suffix}`),
    role: "user",
    text: "Investigate reconnects",
    attachments: [],
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-10-02T00:00:00.000Z",
});
const createThreadBootstrap = (targetProjectId: ProjectId = projectId) => ({
  projectId: targetProjectId,
  title: "New",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdAt: "2026-10-02T00:00:00.000Z",
});
const bootstrapCommand = (suffix: string): LocalTaskDelegateInput["command"] => ({
  ...command(suffix, `new-thread-${suffix}`),
  bootstrap: {
    createThread: createThreadBootstrap(),
    prepareWorktree: {
      projectCwd: "/tmp/project",
      baseBranch: "origin/HEAD",
      branch: `task/${suffix}`,
    },
  },
});
const putTurn = (
  messageId: string,
  state: string,
  turnId = "delegated-turn",
  threadId = "thread",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, completed_at, checkpoint_files_json)
    VALUES (${threadId}, ${turnId}, ${messageId}, ${state}, '2026-10-02T00:00:00.000Z', ${state === "completed" ? "2026-10-02T00:01:00.000Z" : null}, '[]')`;
  });
const acceptReceipt = (commandId: string, status = "accepted", threadId = "thread") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
      VALUES (${commandId}, 'thread', ${threadId}, '2026-10-02T00:00:00.000Z', 1, ${status})`;
  });
const taskFile = (fileId: string, sizeBytes = 3): LocalTaskFile => ({
  fileId,
  type: "file",
  name: `${fileId}.txt`,
  mimeType: "text/plain",
  sizeBytes,
  addedAt: "2026-10-02T00:00:00.000Z",
});
const startRows = (taskId = "task") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      command_id: string;
      sequence: number;
      branch: string | null;
      file_ids_json: string;
    }>`SELECT command_id, sequence, branch, file_ids_json FROM local_task_delegations WHERE task_id = ${taskId} ORDER BY sequence`;
  });

describe("local task service", () => {
  it.effect(
    "validates bounded task input and refuses delegation outside the selected project",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* LocalTaskService;
        const sql = yield* SqlClient.SqlClient;
        for (const input of [
          { ...create(), title: " " },
          { ...create(), notes: "x".repeat(20_001) },
        ])
          assert.equal((yield* tasks.create(input).pipe(Effect.flip)).reason, "invalid");
        assert.equal((yield* tasks.list({ limit: 101 }).pipe(Effect.flip)).reason, "invalid");
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('other-project', 'Other', '/tmp/other', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
        yield* tasks.create({ ...create(), projectId: ProjectId.make("other-project") });
        assert.equal(
          (yield* tasks
            .reserveDelegation({ taskId: "task", expectedRevision: 0, command: command() })
            .pipe(Effect.flip)).reason,
          "invalid",
        );
        assert.deepEqual((yield* tasks.get("task")).delegations, []);
        assert.deepEqual(yield* startRows(), []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "recovers accepted dispatch receipts and starts a corrected chat next to a rejected one",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* LocalTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* tasks.create(create());
        const input = { taskId: "task", command: command() };
        assert.equal(yield* tasks.getSettledDelegation(input), null);
        const reserved = yield* tasks.reserveDelegation(input);
        // The task joined the chat's project; that is the only revision a start causes.
        assert.equal(reserved.task.projectId, projectId);
        assert.equal(reserved.task.revision, 1);
        assert.equal(yield* tasks.getSettledDelegation(input), null);
        yield* acceptReceipt(command().commandId);
        const recovered = yield* tasks.getSettledDelegation(input);
        assert.equal(recovered?.delegations[0]?.dispatched, true);
        assert.equal(recovered?.revision, 1);
        assert.equal((yield* tasks.getSettledDelegation(input))?.revision, 1);
        // A resend restamps the message, so the same thread and message are the same start.
        assert.equal(
          (yield* tasks.getSettledDelegation({
            ...input,
            command: { ...command(), createdAt: "2026-10-02T00:09:00.000Z" },
          }))?.revision,
          1,
        );
        // The same command id for another message is another command.
        assert.equal(
          (yield* tasks
            .getSettledDelegation({
              ...input,
              command: {
                ...command(),
                message: { ...command().message, messageId: MessageId.make("message-other") },
              },
            })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* sql`UPDATE orchestration_command_receipts SET status = 'rejected' WHERE command_id = ${command().commandId}`;
        assert.equal((yield* tasks.get("task")).status, "failed");
        const corrected = yield* tasks.reserveDelegation({
          taskId: "task",
          expectedRevision: recovered!.revision,
          command: command("corrected"),
        });
        assert.deepEqual(
          corrected.task.delegations.map((delegation) => [
            delegation.sequence,
            delegation.messageId,
            delegation.status,
          ]),
          [
            [1, "message-one", "failed"],
            [2, "message-corrected", "starting"],
          ],
        );
        assert.equal(corrected.task.status, "starting");
        assert.equal(corrected.task.revision, 1);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "isolates task reservations and correlates provider startup failures even after pending rows are replaced",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* LocalTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* tasks.create(create());
        yield* tasks.create(create("other-task"));
        yield* tasks.reserveDelegation({ taskId: "task", expectedRevision: 0, command: command() });
        assert.equal(
          (yield* tasks
            .reserveDelegation({ taskId: "other-task", expectedRevision: 0, command: command() })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* putTurn(command().message.messageId, "pending");
        const appendFailure = (
          id: string,
          messageId: string,
        ) => sql`INSERT INTO projection_thread_activities
      (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES (${id}, 'thread', 'error', 'provider.turn.start.failed', 'Provider failed', ${JSON.stringify({ messageId })}, '2026-10-02T00:00:00.000Z')`;
        yield* appendFailure("unrelated-failure", "different-message");
        assert.equal((yield* tasks.get("task")).status, "starting");
        yield* appendFailure("own-failure", command().message.messageId);
        assert.equal((yield* tasks.get("task")).status, "failed");
        yield* sql`DELETE FROM projection_turns WHERE pending_message_id = ${command().message.messageId}`;
        assert.equal((yield* tasks.get("task")).status, "failed");
        const saved = yield* tasks.get("task");
        assert.equal(
          (yield* tasks.reserveDelegation({
            taskId: "task",
            expectedRevision: saved.revision,
            command: command("recovered"),
          })).task.status,
          "starting",
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "ends a delegated run whose start a Stop cancelled instead of reporting it starting",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* LocalTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* tasks.create(create());
        yield* tasks.reserveDelegation({ taskId: "task", expectedRevision: 0, command: command() });
        const messageId = command().message.messageId;
        // The cancelled start keeps its pending row; no turn ever binds to it.
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        VALUES ('thread', NULL, ${messageId}, 'pending', '2026-10-02T00:00:00.000Z', '[]')`;
        assert.equal((yield* tasks.get("task")).status, "starting");
        const appendCancel = (id: string, cancelledMessageId: string) =>
          sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
          VALUES (${id}, 'thread', 'info', 'provider.turn.start.cancelled', 'Turn start cancelled',
            ${JSON.stringify({ messageId: cancelledMessageId, reason: "stopped-before-start" })},
            '2026-10-02T00:00:01.000Z')`;
        yield* appendCancel("other-cancel", "different-message");
        assert.equal((yield* tasks.get("task")).status, "starting");
        yield* appendCancel("own-cancel", messageId);
        assert.equal(
          yield* readDelegatedRunState(sql, { threadId: "thread", messageId }),
          "interrupted",
        );
        assert.equal((yield* tasks.get("task")).status, "failed");
        // The projection now drops the cancelled start's pending row; it still reads ended.
        yield* sql`DELETE FROM projection_turns WHERE pending_message_id = ${messageId}`;
        assert.equal(
          yield* readDelegatedRunState(sql, { threadId: "thread", messageId }),
          "interrupted",
        );
        assert.equal((yield* tasks.get("task")).status, "failed");
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reads a chat whose first turn ran and errored as ended, even when a stale session still points to its turn",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* LocalTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* tasks.create(create());
        yield* tasks.reserveDelegation({ taskId: "task", expectedRevision: 0, command: command() });
        yield* putTurn(command().message.messageId, "error");
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
      VALUES ('thread', 'running', 'delegated-turn', '2026-10-02T00:00:00.000Z')`;
        yield* sql`UPDATE projection_threads SET pending_approval_count = 1 WHERE thread_id = 'thread'`;
        // The turn bound and ran: the chat started, so it is there to review, not "failed to start".
        assert.equal((yield* tasks.get("task")).status, "review");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a chat whose first turn a Stop or a restart ended ready to review", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.create(create());
      yield* tasks.reserveDelegation({ taskId: "task", command: command() });
      yield* tasks.markDelegated(command().commandId);
      yield* putTurn(command().message.messageId, "running");
      assert.equal((yield* tasks.get("task")).status, "running");
      // A Stop interrupts the bound turn; that row stays interrupted for good.
      yield* sql`UPDATE projection_turns SET state = 'interrupted' WHERE turn_id = 'delegated-turn'`;
      assert.equal(
        yield* readDelegatedRunState(sql, {
          threadId: "thread",
          messageId: command().message.messageId,
        }),
        "interrupted",
      );
      assert.equal((yield* tasks.get("task")).status, "review");
      // A follow-up the user sends runs its own turn; the task still reads ready to review.
      yield* putTurn("follow-up", "completed", "follow-up-turn");
      const task = yield* tasks.get("task");
      assert.equal(task.status, "review");
      assert.equal(task.delegations[0]?.status, "review");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "persists idempotent creates, rejects stale edits, paginates and tombstones deletion",
    () =>
      Effect.gen(function* () {
        const tasks = yield* LocalTaskService;
        const task = yield* tasks.create(create());
        assert.equal(task.status, "todo");
        assert.deepEqual(task.links, []);
        assert.deepEqual(task.files, []);
        assert.deepEqual(yield* tasks.create(create()), task);
        const updated = yield* tasks.update({
          taskId: task.taskId,
          expectedRevision: 0,
          notes: "More context",
        });
        assert.equal(updated.revision, 1);
        assert.equal((yield* tasks.get(task.taskId)).notes, "More context");
        assert.equal(
          (yield* tasks
            .update({ taskId: task.taskId, expectedRevision: 0, title: "Lost update" })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* tasks.create(create("task-z"));
        const page = yield* tasks.list({ limit: 1 });
        assert.equal(page.tasks.length, 1);
        assert.equal(page.nextCursor, "task");
        assert.equal(
          (yield* tasks.list({ afterId: page.nextCursor!, limit: 1 })).tasks[0]?.taskId,
          "task-z",
        );
        yield* tasks.remove({ taskId: "task", expectedRevision: 1 });
        assert.equal((yield* tasks.get("task").pipe(Effect.flip)).reason, "not-found");
        assert.equal((yield* tasks.create(create()).pipe(Effect.flip)).reason, "conflict");
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reserves an identical start once under concurrency, numbers different starts and replays the durable command",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* LocalTaskService;
        yield* tasks.create(create());
        const [first, second] = yield* Effect.all(
          [
            tasks.reserveDelegation({ taskId: "task", expectedRevision: 0, command: command() }),
            tasks.reserveDelegation({ taskId: "task", expectedRevision: 0, command: command() }),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(first.command, second.command);
        assert.equal(Number(first.replayed) + Number(second.replayed), 1);
        assert.isTrue(first.needsDispatch && second.needsDispatch);
        const saved = yield* tasks.get("task");
        assert.equal(saved.revision, 1);
        assert.equal(saved.status, "starting");
        // A resend of a start still to run (restamped) replays it, and is what runs.
        const resent = { ...command(), createdAt: "2026-10-02T00:07:00.000Z" };
        const replayed = yield* tasks.reserveDelegation({ taskId: "task", command: resent });
        assert.deepEqual([replayed.replayed, replayed.needsDispatch], [true, true]);
        assert.deepEqual(replayed.command, resent);
        // The same command id for another message is another command.
        const other = {
          ...command(),
          message: { ...command().message, messageId: MessageId.make("message-other") },
        };
        assert.equal(
          (yield* tasks.reserveDelegation({ taskId: "task", command: other }).pipe(Effect.flip))
            .reason,
          "conflict",
        );
        // A revision, when sent, must be current; starting never needs one.
        assert.equal(
          (yield* tasks
            .reserveDelegation({ taskId: "task", expectedRevision: 0, command: command("two") })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* Effect.all(
          [
            tasks.reserveDelegation({ taskId: "task", command: command("two") }),
            tasks.reserveDelegation({ taskId: "task", command: command("three") }),
          ],
          { concurrency: "unbounded" },
        );
        // Concurrent starts of one task take the next numbers, in either order.
        const rows = yield* startRows();
        assert.deepEqual(
          rows.map((row) => row.sequence),
          [1, 2, 3],
        );
        assert.equal(rows[0]?.command_id, "command-one");
        assert.deepEqual(rows.map((row) => row.command_id).toSorted(), [
          "command-one",
          "command-three",
          "command-two",
        ]);
        yield* tasks.markDelegated(command().commandId);
        const dispatched = yield* tasks.get("task");
        assert.equal(dispatched.delegations[0]?.dispatched, true);
        assert.equal(dispatched.revision, 1);
        yield* tasks.markDelegated(command().commandId);
        assert.equal((yield* tasks.get("task")).revision, 1);
        const replay = yield* tasks.reserveDelegation({
          taskId: "task",
          expectedRevision: 0,
          command: command(),
        });
        assert.isTrue(replay.replayed);
        assert.isFalse(replay.needsDispatch);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "uses the exact delegated turn, requires explicit Done, and ignores unrelated chat turns",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* LocalTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* putTurn("old-message", "completed", "old-turn");
        yield* tasks.create(create());
        yield* tasks.reserveDelegation({ taskId: "task", expectedRevision: 0, command: command() });
        assert.equal((yield* tasks.get("task")).status, "starting");
        yield* putTurn(command().message.messageId, "running");
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
      VALUES ('thread', 'running', 'delegated-turn', '2026-10-02T00:00:00.000Z')`;
        assert.equal((yield* tasks.get("task")).status, "running");
        yield* sql`UPDATE projection_threads SET pending_approval_count = 1 WHERE thread_id = 'thread'`;
        assert.equal((yield* tasks.get("task")).status, "needs-you");
        yield* sql`UPDATE projection_turns SET state = 'completed' WHERE turn_id = 'delegated-turn'`;
        assert.equal((yield* tasks.get("task")).status, "needs-you");
        yield* sql`UPDATE projection_thread_sessions SET active_turn_id = NULL, status = 'ready' WHERE thread_id = 'thread'`;
        assert.equal((yield* tasks.get("task")).status, "review");
        yield* putTurn("later-message", "running", "later-turn");
        yield* sql`UPDATE projection_thread_sessions SET active_turn_id = 'later-turn', status = 'running' WHERE thread_id = 'thread'`;
        assert.equal((yield* tasks.get("task")).status, "review");
        const saved = yield* tasks.get("task");
        assert.equal(saved.state, "todo");
        const done = yield* tasks.update({
          taskId: "task",
          expectedRevision: saved.revision,
          state: "done",
        });
        assert.equal(done.status, "done");
        yield* sql`UPDATE projection_threads SET deleted_at = '2026-10-02T01:00:00.000Z' WHERE thread_id = 'thread'`;
        assert.equal((yield* tasks.get("task")).status, "done");
        // A deleted chat says nothing about the task: it reads open again.
        const reopened = yield* tasks.update({
          taskId: "task",
          expectedRevision: done.revision,
          state: "todo",
        });
        assert.equal(reopened.status, "todo");
        assert.equal(reopened.delegations[0]?.status, "unavailable");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("ranks a task by its most urgent chat", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* addThread("second-thread");
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.create({ ...create(), projectId });
      yield* tasks.reserveDelegation({ taskId: "task", command: command("review") });
      yield* putTurn(command("review").message.messageId, "completed");
      assert.equal((yield* tasks.get("task")).status, "review");
      yield* tasks.reserveDelegation({ taskId: "task", command: command("failed") });
      yield* tasks.markDelegationFailed(
        command("failed").commandId,
        "The worktree already exists.",
      );
      const failed = yield* tasks.get("task");
      assert.equal(failed.status, "failed");
      assert.equal(failed.delegations[1]?.error, "The worktree already exists.");
      yield* tasks.reserveDelegation({
        taskId: "task",
        command: command("live", "second-thread"),
      });
      assert.equal((yield* tasks.get("task")).status, "starting");
      yield* putTurn(command("live").message.messageId, "running", "live-turn", "second-thread");
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
        VALUES ('second-thread', 'running', 'live-turn', '2026-10-02T00:00:00.000Z')`;
      assert.equal((yield* tasks.get("task")).status, "running");
      yield* sql`UPDATE projection_threads SET pending_user_input_count = 1 WHERE thread_id = 'second-thread'`;
      const waiting = yield* tasks.get("task");
      assert.equal(waiting.status, "needs-you");
      assert.deepEqual(
        waiting.delegations.map((delegation) => delegation.status),
        ["review", "failed", "needs-you"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("starts a chat whose thread a bootstrap creates, before the thread is projected", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.create(create());
      const reserved = yield* tasks.reserveDelegation({
        taskId: "task",
        command: bootstrapCommand("fresh"),
      });
      assert.isTrue(reserved.needsDispatch);
      assert.equal(reserved.task.projectId, projectId);
      assert.deepEqual(
        reserved.task.delegations.map((delegation) => [
          delegation.threadId,
          delegation.branch,
          delegation.status,
        ]),
        [["new-thread-fresh", "task/fresh", "starting"]],
      );
      assert.equal(
        (yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = 'new-thread-fresh'`).length,
        0,
      );
      // A second worktree chat for the same task.
      yield* tasks.reserveDelegation({ taskId: "task", command: bootstrapCommand("again") });
      assert.deepEqual(
        (yield* startRows()).map((row) => [row.sequence, row.branch]),
        [
          [1, "task/fresh"],
          [2, "task/again"],
        ],
      );
      // Once dispatched, a thread that never appeared is gone.
      yield* tasks.markDelegated(bootstrapCommand("fresh").commandId);
      assert.equal((yield* tasks.get("task")).delegations[0]?.status, "unavailable");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates a permanently deleted thread's id again, never a trashed one's", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.create(create());
      // A failed first send deleted the thread it created; its resend creates it again.
      yield* addThread("thread-again");
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-10-02T00:00:00.000Z' WHERE thread_id = 'thread-again'`;
      const again = {
        ...command("again", "thread-again"),
        bootstrap: { createThread: createThreadBootstrap() },
      };
      const reserved = yield* tasks.reserveDelegation({ taskId: "task", command: again });
      assert.isTrue(reserved.needsDispatch);
      // Without a bootstrap that creates it, the deleted thread is still unavailable.
      yield* addThread("thread-gone");
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-10-02T00:00:00.000Z' WHERE thread_id = 'thread-gone'`;
      const gone = yield* tasks
        .reserveDelegation({ taskId: "task", command: command("gone", "thread-gone") })
        .pipe(Effect.flip);
      assert.equal(gone.reason, "invalid");
      // A trashed thread can come back from the trash, so its id is still taken.
      yield* addThread("thread-trashed");
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-10-02T00:00:00.000Z', trashed_at = '2026-10-02T00:00:00.000Z' WHERE thread_id = 'thread-trashed'`;
      const trashed = yield* tasks
        .reserveDelegation({
          taskId: "task",
          command: {
            ...command("trashed", "thread-trashed"),
            bootstrap: { createThread: createThreadBootstrap() },
          },
        })
        .pipe(Effect.flip);
      assert.equal(trashed.reason, "invalid");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses starts whose target thread and bootstrap disagree", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      yield* tasks.create(create());
      const refused = (startCommand: LocalTaskDelegateInput["command"]) =>
        tasks.reserveDelegation({ taskId: "task", command: startCommand }).pipe(
          Effect.flip,
          Effect.map((failure) => failure.reason),
        );
      // An existing thread cannot be created again.
      assert.equal(
        yield* refused({
          ...command("exists"),
          bootstrap: { createThread: createThreadBootstrap() },
        }),
        "invalid",
      );
      // A thread that does not exist needs a bootstrap that creates it.
      assert.equal(yield* refused(command("missing", "missing-thread")), "invalid");
      // A task's chat always runs in a project.
      assert.equal(
        yield* refused({
          ...command("chat", "chat-thread"),
          bootstrap: {
            createChatProject: { projectId: ProjectId.make("chat-project"), titleSeed: "Chat" },
            createThread: createThreadBootstrap(ProjectId.make("chat-project")),
          },
        }),
        "invalid",
      );
      assert.deepEqual(yield* startRows(), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects historical messages and reports a task whose project is gone", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.create(create());
      yield* putTurn(command().message.messageId, "completed");
      assert.equal(
        (yield* tasks
          .reserveDelegation({ taskId: "task", expectedRevision: 0, command: command() })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      yield* tasks.reserveDelegation({
        taskId: "task",
        expectedRevision: 0,
        command: command("fresh"),
      });
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-02T01:00:00.000Z' WHERE project_id = ${projectId}`;
      assert.equal((yield* tasks.get("task")).status, "unavailable");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("searches by state, project and text, newest change first, a page at a time", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.create({ ...create("old"), title: "Ärger mit dem Login" });
      yield* tasks.create({ ...create("new"), title: "Second", projectId });
      const done = yield* tasks.create({ ...create("done"), title: "Finished" });
      yield* tasks.update({ taskId: "done", expectedRevision: done.revision, state: "done" });
      for (const [taskId, updatedAt] of [
        ["old", "2026-10-01T00:00:00.000Z"],
        ["new", "2026-10-03T00:00:00.000Z"],
        ["done", "2026-10-02T00:00:00.000Z"],
      ])
        yield* sql`UPDATE local_tasks SET task_json = json_set(task_json, '$.updatedAt', ${updatedAt})
          WHERE task_id = ${taskId}`;
      const ids = (found: { readonly tasks: ReadonlyArray<{ readonly taskId: string }> }) =>
        found.tasks.map((task) => task.taskId);
      const page = { limit: 10, offset: 0 };

      const open = yield* tasks.search({ state: "todo", ...page });
      assert.deepEqual([ids(open), open.total], [["new", "old"], 2]);
      assert.deepEqual(ids(yield* tasks.search({ state: "all", ...page })), ["new", "done", "old"]);
      assert.deepEqual(ids(yield* tasks.search({ state: "done", ...page })), ["done"]);
      assert.deepEqual(ids(yield* tasks.search({ state: "all", projectId, ...page })), ["new"]);
      // Any case, beyond ASCII too; the notes count as well.
      assert.deepEqual(ids(yield* tasks.search({ state: "all", query: "ärger", ...page })), [
        "old",
      ]);
      assert.equal((yield* tasks.search({ state: "all", query: "OWNER FENCE", ...page })).total, 3);
      const second = yield* tasks.search({ state: "all", limit: 1, offset: 1 });
      assert.deepEqual([ids(second), second.total], [["done"], 3]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("publishes each task a change touched, deletions and starts included", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const received = yield* Queue.unbounded<string>();
      yield* tasks.changes.pipe(
        Stream.runForEach((change) =>
          Queue.offer(
            received,
            change.taskId === undefined
              ? "*"
              : change.deleted
                ? `deleted ${change.taskId}`
                : change.taskId,
          ),
        ),
        Effect.forkScoped,
      );
      const next = Queue.take(received);
      // First the cue to read everything, once the subscription listens.
      assert.equal(yield* next, "*");
      const created = yield* tasks.create(create("one"));
      assert.equal(yield* next, "one");
      const updated = yield* tasks.update({
        taskId: "one",
        expectedRevision: created.revision,
        title: "Renamed",
      });
      assert.equal(yield* next, "one");
      yield* tasks.create(create("two"));
      assert.equal(yield* next, "two");
      yield* tasks.reserveDelegation({ taskId: "two", command: command() });
      assert.equal(yield* next, "two");
      yield* tasks.markDelegated(command().commandId);
      assert.equal(yield* next, "two");
      yield* tasks.remove({ taskId: "one", expectedRevision: updated.revision });
      assert.equal(yield* next, "deleted one");
      // A failed write changes nothing, so it says nothing: the next change is the write after it.
      yield* tasks
        .update({ taskId: "two", expectedRevision: 99, title: "Stale" })
        .pipe(Effect.flip);
      yield* tasks.create(create("three"));
      assert.equal(yield* next, "three");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stamps each list page with the change position read before it", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const before = (yield* tasks.list({})).position!;
      yield* tasks.create(create("one"));
      const after = (yield* tasks.list({})).position!;
      assert.equal(after.feed, before.feed);
      assert.equal(after.sequence, before.sequence + 1);

      yield* tasks.create(create("two"));
      const first = yield* tasks.list({ limit: 1 });
      assert.equal(first.nextCursor, "one");
      const second = yield* tasks.list({ limit: 1, afterId: first.nextCursor! });
      assert.deepEqual(
        [first.position, second.position],
        [
          { feed: before.feed, sequence: before.sequence + 2 },
          { feed: before.feed, sequence: before.sequence + 2 },
        ],
      );

      // The change stream's word to read everything comes from the same feed.
      const received = yield* Queue.unbounded<LocalTaskChange>();
      yield* tasks.changes.pipe(
        Stream.runForEach((change) => Queue.offer(received, change)),
        Effect.forkScoped,
      );
      const word = yield* Queue.take(received);
      assert.deepEqual(word, { position: { feed: before.feed, sequence: before.sequence + 2 } });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("records a failed start once, unless orchestration accepted it", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      yield* tasks.create(create());
      yield* tasks.reserveDelegation({ taskId: "task", command: command() });
      assert.isTrue(
        yield* tasks.markDelegationFailed(command().commandId, "Worktree setup failed."),
      );
      yield* tasks.markDelegationFailed(command().commandId, "A later message.");
      const failed = yield* tasks.get("task");
      assert.equal(failed.status, "failed");
      assert.equal(failed.delegations[0]?.error, "Worktree setup failed.");
      // Orchestration never took the failed command, so its resend runs. A resend restamps the
      // message: the changed command replaces the failed start (same sequence, no error).
      assert.isNull(yield* tasks.getSettledDelegation({ taskId: "task", command: command() }));
      const resent = { ...command(), createdAt: "2026-10-02T00:05:00.000Z" };
      const reserved = yield* tasks.reserveDelegation({ taskId: "task", command: resent });
      assert.deepEqual([reserved.replayed, reserved.needsDispatch], [false, true]);
      const retried = yield* tasks.get("task");
      assert.deepEqual(
        retried.delegations.map((delegation) => [
          delegation.commandId,
          delegation.sequence,
          delegation.status,
          delegation.error,
        ]),
        [["command-one", 1, "starting", null]],
      );
      // The same command id for another message is another command.
      const other = yield* tasks
        .reserveDelegation({
          taskId: "task",
          command: {
            ...command(),
            message: { ...command().message, messageId: MessageId.make("message-other") },
          },
        })
        .pipe(Effect.flip);
      assert.deepEqual(
        [other.reason, other.message],
        ["conflict", "The chat start command changed."],
      );
      yield* tasks.reserveDelegation({ taskId: "task", command: command("accepted") });
      yield* acceptReceipt(command("accepted").commandId);
      assert.isFalse(
        yield* tasks.markDelegationFailed(command("accepted").commandId, "Lost the response."),
      );
      const accepted = (yield* tasks.get("task")).delegations[1];
      assert.equal(accepted?.dispatched, true);
      assert.equal(accepted?.error, null);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("settles starts a restart cut off", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.create(create());
      for (const suffix of ["accepted", "rejected", "lost"])
        yield* tasks.reserveDelegation({ taskId: "task", command: command(suffix) });
      yield* acceptReceipt(command("accepted").commandId);
      yield* acceptReceipt(command("rejected").commandId, "rejected");
      yield* sql`UPDATE orchestration_command_receipts SET error = 'Model unavailable.' WHERE command_id = ${command("rejected").commandId}`;
      // A new process builds the service again over the same database.
      const restarted = yield* Effect.scoped(
        makeLocalTaskService({ taskFilesDir: makeTaskFilesDir() }),
      );
      const settled = yield* restarted.get("task");
      assert.deepEqual(
        settled.delegations.map((delegation) => [
          delegation.commandId,
          delegation.dispatched,
          delegation.status,
          delegation.error,
        ]),
        [
          ["command-accepted", true, "starting", null],
          ["command-rejected", false, "failed", null],
          ["command-lost", false, "failed", INTERRUPTED_START_ERROR],
        ],
      );
      // Resending a start answers with what became of it: the chat it reached, or why it can
      // never run (so a client starts again with a new command instead of reporting a chat).
      // One the restart cut off before orchestration took it is not settled: it runs again.
      const resend = (suffix: string) =>
        restarted.getSettledDelegation({ taskId: "task", command: command(suffix) });
      assert.equal((yield* resend("accepted"))?.taskId, "task");
      const refused = yield* resend("rejected").pipe(Effect.flip);
      assert.deepEqual([refused.reason, refused.message], ["conflict", "Model unavailable."]);
      assert.isNull(yield* resend("lost"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("locks the project once the task has a chat", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('other-project', 'Other', '/tmp/other', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      const task = yield* tasks.create(create());
      const moved = yield* tasks.update({
        taskId: "task",
        expectedRevision: task.revision,
        projectId: ProjectId.make("other-project"),
      });
      const back = yield* tasks.update({
        taskId: "task",
        expectedRevision: moved.revision,
        projectId,
      });
      yield* tasks.reserveDelegation({ taskId: "task", command: command() });
      assert.equal(
        (yield* tasks
          .update({
            taskId: "task",
            expectedRevision: back.revision,
            projectId: ProjectId.make("other-project"),
          })
          .pipe(Effect.flip)).reason,
        "invalid",
      );
      // Other edits still go through.
      assert.equal(
        (yield* tasks.update({ taskId: "task", expectedRevision: back.revision, title: "Renamed" }))
          .title,
        "Renamed",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("frees the project once no start can have a chat in it", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      const otherProject = ProjectId.make("other-project");
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${otherProject}, 'Other', '/tmp/other', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      yield* tasks.create(create());
      const move = (projectTo: ProjectId) =>
        Effect.gen(function* () {
          const current = yield* tasks.get("task");
          return yield* tasks.update({
            taskId: "task",
            expectedRevision: current.revision,
            projectId: projectTo,
          });
        });
      // A worktree start that failed before its thread existed (no origin/HEAD, say).
      yield* tasks.reserveDelegation({ taskId: "task", command: bootstrapCommand("no-head") });
      assert.equal((yield* move(otherProject).pipe(Effect.flip)).reason, "invalid");
      yield* tasks.markDelegationFailed(bootstrapCommand("no-head").commandId, "No origin/HEAD.");
      assert.equal((yield* move(otherProject)).projectId, otherProject);
      yield* move(projectId);
      // A chat that runs holds the project; once deleted, it holds nothing.
      yield* tasks.reserveDelegation({ taskId: "task", command: command() });
      yield* tasks.markDelegated(command().commandId);
      assert.equal((yield* move(otherProject).pipe(Effect.flip)).reason, "invalid");
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-10-02T01:00:00.000Z' WHERE thread_id = 'thread'`;
      assert.equal((yield* move(otherProject)).projectId, otherProject);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("replaces validated links", () =>
    Effect.gen(function* () {
      const tasks = yield* LocalTaskService;
      yield* tasks.create(create());
      const links: ReadonlyArray<LocalTaskLink> = [
        { kind: "pr", number: 746, url: "https://github.com/saka-gg/ryco/pull/746" },
        { kind: "issue", number: 12 },
        { kind: "workItem", provider: "jira", key: "ABC-123" },
        { kind: "branch", name: "fix/login-loop" },
        { kind: "thread", threadId: ThreadId.make("thread") },
        { kind: "url", url: "https://example.com/spec", label: "Spec" },
      ];
      const linked = yield* tasks.update({ taskId: "task", expectedRevision: 0, links });
      assert.deepEqual(linked.links, links);
      assert.deepEqual((yield* tasks.get("task")).links, links);
      const invalidLinks: ReadonlyArray<ReadonlyArray<unknown>> = [
        Array.from({ length: 21 }, (_, index) => ({ kind: "issue", number: index + 1 })),
        [{ kind: "pr", number: 0 }],
        [{ kind: "workItem", provider: "jira", key: "abc-1" }],
        [{ kind: "url", url: "ftp://example.com" }],
        [{ kind: "branch", name: " " }],
        [{ kind: "comment", text: "nope" }],
      ];
      for (const candidate of invalidLinks)
        assert.equal(
          (yield* tasks
            .update({ taskId: "task", expectedRevision: 1, links: candidate as never })
            .pipe(Effect.flip)).reason,
          "invalid",
        );
      const cleared = yield* tasks.update({ taskId: "task", expectedRevision: 1, links: [] });
      assert.deepEqual(cleared.links, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adds and removes files within the task's limits", () => {
    const taskFilesDir = makeTaskFilesDir();
    return Effect.gen(function* () {
      const tasks = yield* LocalTaskService;
      yield* tasks.create(create());
      fs.writeFileSync(path.join(taskFilesDir, "task-task-a-txt"), "abc");
      const first = yield* tasks.addFile({
        taskId: "task",
        expectedRevision: 0,
        file: taskFile("task-task-a-txt"),
      });
      assert.equal(first.revision, 1);
      // The same file again (a retried add) changes nothing, whatever revision it sends.
      assert.equal(
        (yield* tasks.addFile({
          taskId: "task",
          expectedRevision: 0,
          file: taskFile("task-task-a-txt"),
        })).revision,
        1,
      );
      assert.equal(
        (yield* tasks
          .addFile({ taskId: "task", expectedRevision: 0, file: taskFile("task-task-b-txt") })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      let revision = first.revision;
      for (let index = 1; index < LOCAL_TASK_MAX_FILES; index += 1)
        revision = (yield* tasks.addFile({
          taskId: "task",
          expectedRevision: revision,
          file: taskFile(`task-task-${index}-txt`),
        })).revision;
      assert.equal(
        (yield* tasks
          .addFile({
            taskId: "task",
            expectedRevision: revision,
            file: taskFile("task-task-9-txt"),
          })
          .pipe(Effect.flip)).reason,
        "invalid",
      );
      const removed = yield* tasks.removeFile({
        taskId: "task",
        expectedRevision: revision,
        fileId: "task-task-a-txt",
      });
      assert.equal(removed.files.length, LOCAL_TASK_MAX_FILES - 1);
      assert.isFalse(fs.existsSync(path.join(taskFilesDir, "task-task-a-txt")));
      assert.equal(
        (yield* tasks
          .removeFile({
            taskId: "task",
            expectedRevision: removed.revision,
            fileId: "task-task-a-txt",
          })
          .pipe(Effect.flip)).reason,
        "not-found",
      );
      assert.equal(
        (yield* tasks
          .removeFile({ taskId: "task", expectedRevision: revision, fileId: "task-task-1-txt" })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      // The byte budget: one message's worth across all files.
      yield* tasks.create(create("big"));
      const big = yield* tasks.addFile({
        taskId: "big",
        expectedRevision: 0,
        file: taskFile("task-big-a-bin", PROVIDER_SEND_TURN_MAX_FILE_BYTES),
      });
      assert.equal(
        (yield* tasks
          .addFile({
            taskId: "big",
            expectedRevision: big.revision,
            file: taskFile("task-big-b-bin", 1),
          })
          .pipe(Effect.flip)).reason,
        "invalid",
      );
    }).pipe(Effect.provide(makeLayer(taskFilesDir)));
  });

  it.effect("keeps a start within one message's file budget and records the files it carries", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      yield* tasks.create(create());
      const withFile = yield* tasks.addFile({
        taskId: "task",
        expectedRevision: 0,
        file: taskFile("task-task-a-txt"),
      });
      const tooMany = {
        ...command("too-many"),
        message: {
          ...command("too-many").message,
          attachments: Array.from({ length: LOCAL_TASK_MAX_FILES }, (_, index) => ({
            type: "file" as const,
            name: `notes-${index}.txt`,
            mimeType: "text/plain",
            sizeBytes: 3,
            dataUrl: "data:text/plain;base64,YWJj",
          })),
        },
      };
      assert.equal(
        (yield* tasks.reserveDelegation({ taskId: "task", command: tooMany }).pipe(Effect.flip))
          .reason,
        "invalid",
      );
      assert.deepEqual(yield* startRows(), []);
      const reserved = yield* tasks.reserveDelegation({ taskId: "task", command: command() });
      assert.deepEqual(reserved.files, withFile.files);
      assert.deepEqual(
        (yield* startRows()).map((row) => JSON.parse(row.file_ids_json)),
        [["task-task-a-txt"]],
      );
      // A replay carries the files the start recorded.
      const replay = yield* tasks.reserveDelegation({ taskId: "task", command: command() });
      assert.deepEqual(replay.files, withFile.files);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("deletes a task's starts and files with the task", () => {
    const taskFilesDir = makeTaskFilesDir();
    return Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      yield* tasks.create(create());
      fs.writeFileSync(path.join(taskFilesDir, "task-task-a-txt"), "abc");
      const withFile = yield* tasks.addFile({
        taskId: "task",
        expectedRevision: 0,
        file: taskFile("task-task-a-txt"),
      });
      const reserved = yield* tasks.reserveDelegation({ taskId: "task", command: command() });
      yield* tasks.remove({ taskId: "task", expectedRevision: reserved.task.revision });
      assert.isAbove(reserved.task.revision, withFile.revision);
      assert.deepEqual(yield* startRows(), []);
      assert.isFalse(fs.existsSync(path.join(taskFilesDir, "task-task-a-txt")));
    }).pipe(Effect.provide(makeLayer(taskFilesDir)));
  });

  it.effect("deletes old task files no live task references", () => {
    // Not the service's own store, so its startup cleanup cannot race this one.
    const taskFilesDir = makeTaskFilesDir();
    return Effect.gen(function* () {
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.create(create());
      yield* tasks.addFile({
        taskId: "task",
        expectedRevision: 0,
        file: taskFile("task-task-kept-txt"),
      });
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      for (const name of ["task-task-kept-txt", "task-gone-old-txt", "task-gone-upload-txt.part"]) {
        fs.writeFileSync(path.join(taskFilesDir, name), "abc");
        fs.utimesSync(path.join(taskFilesDir, name), old, old);
      }
      fs.writeFileSync(path.join(taskFilesDir, "task-gone-fresh-txt"), "abc");
      // A copy or upload still being written is fresh; an old `.part` file is one a crash left.
      fs.writeFileSync(path.join(taskFilesDir, "task-gone-writing-txt.part"), "abc");
      assert.equal(yield* cleanupOrphanTaskFiles({ sql, taskFilesDir, nowMs: Date.now() }), 2);
      assert.deepEqual(fs.readdirSync(taskFilesDir).toSorted(), [
        "task-gone-fresh-txt",
        "task-gone-writing-txt.part",
        "task-task-kept-txt",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("decodes a task row written before 092 and shows its start", () =>
    Effect.gen(function* () {
      yield* seed;
      const tasks = yield* LocalTaskService;
      const sql = yield* SqlClient.SqlClient;
      const legacy = {
        taskId: "legacy",
        revision: 1,
        title: "Old task",
        notes: "",
        priority: "normal",
        dueAt: null,
        projectId,
        state: "todo",
        status: "starting",
        delegation: {
          threadId: "thread",
          messageId: "message-legacy",
          commandId: "command-legacy",
          dispatched: true,
        },
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:05:00.000Z",
      };
      yield* sql`DROP TABLE local_task_delegations`;
      yield* sql`INSERT INTO local_tasks (task_id, revision, task_json, create_digest, command_id,
          delegation_thread_id, delegation_message_id, command_json, command_digest)
        VALUES ('legacy', 1, ${JSON.stringify(legacy)}, 'digest', 'command-legacy', 'thread',
          'message-legacy', ${JSON.stringify(command("legacy"))}, 'legacy-digest')`;
      assert.isTrue(yield* ensureLocalTaskDelegationsTable);
      const task = yield* tasks.get("legacy");
      assert.deepEqual(task.links, []);
      assert.deepEqual(task.files, []);
      assert.notProperty(task, "delegation");
      assert.deepEqual(
        task.delegations.map((delegation) => [
          delegation.commandId,
          delegation.sequence,
          delegation.dispatched,
          delegation.createdAt,
        ]),
        [["command-legacy", 1, true, "2026-10-01T00:05:00.000Z"]],
      );
      // Its next write stores the current record shape.
      yield* tasks.update({ taskId: "legacy", expectedRevision: 1, notes: "Now" });
      const [row] = yield* sql<{
        task_json: string;
      }>`SELECT task_json FROM local_tasks WHERE task_id = 'legacy'`;
      const stored = JSON.parse(row!.task_json) as Record<string, unknown>;
      assert.notProperty(stored, "status");
      assert.notProperty(stored, "delegation");
      assert.deepEqual(stored.links, []);
    }).pipe(Effect.provide(layer)),
  );
});
