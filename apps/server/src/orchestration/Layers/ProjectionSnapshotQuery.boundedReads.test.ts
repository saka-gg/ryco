/**
 * Per-action reads of a long thread that must not walk its whole history: the kind-filtered
 * activity reads (pending requests, task records, task path references) and the side-question
 * context. Each test pins the results at their edges and the query plan that keeps the cost
 * independent of how many other rows the thread holds.
 */
import { ThreadId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlStatement from "effect/sql/Statement";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { THREAD_ACTIVITY_KIND_INDEX } from "../../persistence/threadActivityKindReads.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

/** Runs `effect` and returns the statements it compiled whose text matches `pattern`. */
const capturing = <A, E, R>(pattern: RegExp, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const capture: SqlStatement.Transformer = (statement) =>
      Effect.sync(() => {
        const compiled = statement.compile();
        if (pattern.test(compiled[0])) statements.push(compiled);
        return statement;
      });
    const result = yield* effect.pipe(
      Effect.provideService(SqlStatement.CurrentTransformer, capture),
    );
    return { result, statements };
  });

const planOf = (statement: readonly [string, ReadonlyArray<unknown>]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statement[0]}`,
      statement[1],
    );
    return rows.map((row) => row.detail);
  });

const byKindIndex = new RegExp(`INDEXED BY ${THREAD_ACTIVITY_KIND_INDEX}`);

const sequenced = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

layer("bounded long-thread reads", (it) => {
  it.effect("reads one thread's pending requests and task rows through the kind index", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("kind-reads");
      const insert = (input: {
        readonly id: string;
        readonly kind: string;
        readonly payload: unknown;
        readonly sequence: number;
        readonly thread?: string;
      }) =>
        sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
          VALUES (${input.id}, ${input.thread ?? threadId}, 'turn-1', 'info', ${input.kind}, ${input.kind},
            ${typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload)},
            ${input.sequence}, '2026-09-12T00:00:00.000Z')`;

      // An empty thread: nothing pending, no task paths.
      assert.deepStrictEqual(yield* query.listThreadPendingRequestActivities!(threadId), []);
      assert.deepStrictEqual(yield* query.listThreadTaskPathRefs!(threadId), {
        scriptPaths: [],
        outputPaths: [],
      });

      // An approval asked at the very start of a long thread, far outside any window, and a
      // question answered later; then hundreds of tool calls.
      yield* insert({
        id: "approval-old",
        kind: "approval.requested",
        payload: { requestId: "r-1" },
        sequence: 1,
      });
      yield* insert({
        id: "question",
        kind: "user-input.requested",
        payload: { requestId: "r-2" },
        sequence: 2,
      });
      for (const n of sequenced(300)) {
        yield* insert({
          id: `tool-${n}`,
          kind: "tool.completed",
          payload: { outputFile: `/tool-${n}` },
          sequence: 2 + n,
        });
      }
      yield* insert({
        id: "answer",
        kind: "user-input.resolved",
        payload: { requestId: "r-2" },
        sequence: 400,
      });
      yield* insert({
        id: "task-start",
        kind: "task.started",
        payload: { taskId: "t-1", runHandles: { scriptPath: "/script.js" } },
        sequence: 401,
      });
      yield* insert({
        id: "task-progress",
        kind: "task.progress",
        payload: { taskId: "t-1", outputFile: 7, runHandles: ["/array.js"] },
        sequence: 402,
      });
      yield* insert({
        id: "task-update",
        kind: "task.updated",
        payload: { taskId: "t-1", runHandles: { scriptPath: 3 } },
        sequence: 403,
      });
      yield* insert({
        id: "task-done",
        kind: "task.completed",
        payload: { taskId: "t-1", outputFile: "/task.output" },
        sequence: 404,
      });
      yield* insert({ id: "task-null", kind: "task.completed", payload: null, sequence: 405 });
      // Another thread's rows of the same kinds are not this thread's.
      yield* insert({
        id: "other-approval",
        kind: "approval.requested",
        payload: { requestId: "r-9" },
        sequence: 1,
        thread: "kind-reads-other",
      });
      yield* insert({
        id: "other-task",
        kind: "task.completed",
        payload: { outputFile: "/other.output" },
        sequence: 2,
        thread: "kind-reads-other",
      });

      const pending = yield* capturing(
        byKindIndex,
        query.listThreadPendingRequestActivities!(threadId),
      );
      assert.deepStrictEqual(
        pending.result.map((activity) => activity.id),
        ["approval-old", "question", "answer"],
      );
      const tasks = yield* capturing(
        byKindIndex,
        query.listThreadTaskActivities!({ threadId, taskId: "t-1" }),
      );
      assert.deepStrictEqual(
        tasks.result.map((activity) => activity.id),
        ["task-start", "task-progress", "task-update"],
      );
      const paths = yield* capturing(byKindIndex, query.listThreadTaskPathRefs!(threadId));
      // Strings only, from task kinds only (a tool's outputFile is not a task's).
      assert.deepStrictEqual(paths.result, {
        scriptPaths: ["/script.js"],
        outputPaths: ["/task.output"],
      });

      for (const read of [pending, tasks, paths]) {
        assert.equal(read.statements.length, 1);
        const plan = yield* planOf(read.statements[0]!);
        assert.isTrue(
          plan.some((detail) =>
            detail.includes(`INDEX ${THREAD_ACTIVITY_KIND_INDEX} (kind=? AND thread_id=?)`),
          ),
          JSON.stringify(plan),
        );
        assert.isFalse(
          plan.some((detail) => /SCAN projection_thread_activities|thread_sequence/.test(detail)),
          JSON.stringify(plan),
        );
      }

      // A malformed task payload fails the read, as decoding it did: path checks fail closed.
      yield* insert({
        id: "task-broken",
        kind: "task.progress",
        payload: "not json",
        sequence: 406,
      });
      const broken = yield* Effect.exit(query.listThreadTaskPathRefs!(threadId));
      assert.isTrue(Exit.isFailure(broken));

      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id IN (${threadId}, 'kind-reads-other')`;
    }),
  );

  it.effect("reads side-question context by seeking turns, with the old join's rows", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("side-bounded");
      const turn = (turnId: string, state: string, pendingMessageId: string | null) =>
        sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
          VALUES (${threadId}, ${turnId}, ${pendingMessageId}, ${state}, '2026-09-12T00:00:00.000Z', '[]')`;
      const message = (id: string, turnId: string | null, role: string, at: string) =>
        sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${id}, ${threadId}, ${turnId}, ${role}, ${id}, 0, ${at}, ${at})`;
      const texts = Effect.map(query.getCompletedSideQuestionContext!(threadId), (context) =>
        context.messages.map((entry) => entry.text),
      );

      // Empty thread.
      assert.deepStrictEqual(yield* texts, []);

      // Turns that did not complete contribute nothing, however many messages they hold.
      yield* turn("t-running", "interrupted", "u-running");
      yield* message("u-running", "t-running", "user", "2026-09-12T00:00:00.000Z");
      for (const n of sequenced(50)) {
        yield* message(`r-running-${n}`, "t-running", "assistant", "2026-09-12T00:00:01.000Z");
      }
      assert.deepStrictEqual(yield* texts, []);

      // A user message that starts a turn and is stored under it appears once; a message stored
      // under one completed turn and starting another appears twice, as the joined pairs did.
      yield* turn("t-1", "completed", "u-1");
      yield* message("u-1", "t-1", "user", "2026-09-12T00:00:02.000Z");
      yield* message("r-1", "t-1", "assistant", "2026-09-12T00:00:03.000Z");
      yield* turn("t-2", "completed", "r-1");
      // A turnless user message starting a completed turn (queued, then dispatched).
      yield* turn("t-3", "completed", "u-3");
      yield* message("u-3", null, "user", "2026-09-12T00:00:04.000Z");
      assert.deepStrictEqual(yield* texts, ["u-1", "r-1", "r-1", "u-3"]);

      // More than the side chat takes: the read stops at 201 rows, the oldest first, and the
      // handler refuses the context (it holds over 200).
      for (const n of sequenced(240)) {
        yield* message(
          `r-3-${String(n).padStart(3, "0")}`,
          "t-3",
          "assistant",
          "2026-09-12T00:01:00.000Z",
        );
      }
      const capped = yield* capturing(/UNION ALL/, texts);
      assert.equal(capped.result.length, 201);
      assert.deepStrictEqual(capped.result.slice(0, 6), [
        "u-1",
        "r-1",
        "r-1",
        "u-3",
        "r-3-001",
        "r-3-002",
      ]);
      assert.equal(capped.result.at(-1), "r-3-197");

      assert.equal(capped.statements.length, 1);
      const plan = yield* planOf(capped.statements[0]!);
      assert.isTrue(
        plan.some((detail) =>
          /SEARCH t USING INDEX \S+ \(thread_id=\? AND turn_id=\?\)/.test(detail),
        ),
        JSON.stringify(plan),
      );
      assert.isFalse(
        plan.some((detail) => /SCAN (t|m)\b/.test(detail)),
        JSON.stringify(plan),
      );

      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
    }),
  );
});
