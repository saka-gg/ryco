import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type LocalTaskDelegateInput,
} from "@ryco/contracts";
import { LocalTaskService, LocalTaskServiceLive } from "./LocalTaskService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readDelegatedRunState } from "../persistence/delegatedRunStatus.ts";

const layer = LocalTaskServiceLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
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
const command = (suffix = "one"): LocalTaskDelegateInput["command"] => ({
  type: "thread.turn.start",
  commandId: CommandId.make(`command-${suffix}`),
  threadId: ThreadId.make("thread"),
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
const putTurn = (messageId: string, state: string, turnId = "delegated-turn") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, completed_at, checkpoint_files_json)
    VALUES ('thread', ${turnId}, ${messageId}, ${state}, '2026-10-02T00:00:00.000Z', ${state === "completed" ? "2026-10-02T00:01:00.000Z" : null}, '[]')`;
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
        assert.equal((yield* tasks.get("task")).delegation, null);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "recovers accepted dispatch receipts and releases rejected work for a corrected delegation",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* LocalTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* tasks.create(create());
        const input = { taskId: "task", expectedRevision: 0, command: command() };
        assert.equal(yield* tasks.getAcceptedDelegation(input), null);
        yield* tasks.reserveDelegation(input);
        yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
      VALUES (${command().commandId}, 'thread', 'thread', '2026-10-02T00:00:00.000Z', 1, 'accepted')`;
        const recovered = yield* tasks.getAcceptedDelegation(input);
        assert.equal(recovered?.delegation?.dispatched, true);
        assert.equal(recovered?.revision, 2);
        assert.equal((yield* tasks.getAcceptedDelegation(input))?.revision, 2);
        assert.equal(
          (yield* tasks
            .getAcceptedDelegation({
              ...input,
              command: { ...command(), message: { ...command().message, text: "Changed prompt" } },
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
        assert.equal(corrected.task.delegation?.messageId, "message-corrected");
        assert.equal(corrected.task.status, "starting");
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

  it.effect("reports terminal failure even when a stale session still points to its turn", () =>
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
      assert.equal((yield* tasks.get("task")).status, "failed");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "persists idempotent creates, rejects stale edits, paginates and tombstones deletion",
    () =>
      Effect.gen(function* () {
        const tasks = yield* LocalTaskService;
        const task = yield* tasks.create(create());
        assert.equal(task.status, "todo");
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
    "reserves exactly one delegation under concurrency and replays the identical durable command",
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
        const saved = yield* tasks.get("task");
        assert.equal(saved.revision, 1);
        assert.equal(saved.status, "starting");
        const changed = { ...command(), message: { ...command().message, text: "Different work" } };
        assert.equal(
          (yield* tasks
            .reserveDelegation({ taskId: "task", expectedRevision: 0, command: changed })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        assert.equal(
          (yield* tasks
            .reserveDelegation({ taskId: "task", expectedRevision: 1, command: command("two") })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        const dispatched = yield* tasks.markDelegated({
          taskId: "task",
          commandId: command().commandId,
        });
        assert.equal(dispatched.delegation?.dispatched, true);
        assert.equal(
          (yield* tasks.markDelegated({ taskId: "task", commandId: command().commandId })).revision,
          dispatched.revision,
        );
        assert.equal(
          (yield* tasks.reserveDelegation({
            taskId: "task",
            expectedRevision: 0,
            command: command(),
          })).replayed,
          true,
        );
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
        assert.equal(
          (yield* tasks.update({ taskId: "task", expectedRevision: done.revision, state: "todo" }))
            .status,
          "unavailable",
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects historical messages and bootstrap delegation without starting work", () =>
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
      const newCommand = {
        ...command("new"),
        threadId: ThreadId.make("new-thread"),
        bootstrap: {
          createThread: {
            projectId,
            title: "New",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "approval-required" as const,
            interactionMode: "default" as const,
            branch: null,
            worktreePath: null,
            createdAt: "2026-10-02T00:00:00.000Z",
          },
        },
      };
      assert.equal(
        (yield* tasks
          .reserveDelegation({
            taskId: "task",
            expectedRevision: 0,
            command: newCommand,
          })
          .pipe(Effect.flip)).reason,
        "invalid",
      );
      yield* tasks.reserveDelegation({
        taskId: "task",
        expectedRevision: 0,
        command: command("fresh"),
      });
      assert.equal(
        (yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = 'new-thread'`).length,
        0,
      );
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-02T01:00:00.000Z' WHERE project_id = ${projectId}`;
      assert.equal((yield* tasks.get("task")).status, "unavailable");
    }).pipe(Effect.provide(layer)),
  );
});
