import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DailyRecapRequest, DailyRecapSnapshot } from "@ryco/contracts";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { DailyRecapQuery, DailyRecapQueryLive, dailyRecapWindow } from "./DailyRecapQuery.ts";

const request = { date: "2026-10-02", timeZone: "Europe/Berlin" };
const encode = Schema.encodeUnknownSync(DailyRecapSnapshot);

const clean = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_thread_sessions`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        'project', 'Project', '/tmp/project', '{"provider":"codex","model":"model"}',
        '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      )
    `;
  });

const thread = (sql: SqlClient.SqlClient, id: string) => sql`
  INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode,
    interaction_mode, branch, worktree_path, latest_turn_id,
    latest_user_message_at, pending_approval_count, pending_user_input_count,
    has_actionable_proposed_plan, created_at, updated_at, deleted_at
  ) VALUES (
    ${id}, 'project', ${`Thread ${id}`}, '{"provider":"codex","model":"model"}',
    'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
    '2026-01-01T00:00:00.000Z', '2026-10-03T12:00:00.000Z', NULL
  )
`;

const turn = (
  sql: SqlClient.SqlClient,
  threadId: string,
  turnId: string,
  state: string,
  completedAt: string | null,
) => sql`
  INSERT INTO projection_turns (
    thread_id, turn_id, pending_message_id, assistant_message_id, state,
    requested_at, started_at, completed_at, checkpoint_turn_count,
    checkpoint_ref, checkpoint_status, checkpoint_files_json
  ) VALUES (
    ${threadId}, ${turnId}, NULL, NULL, ${state},
    '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ${completedAt},
    NULL, NULL, NULL, '[]'
  )
`;

const session = (sql: SqlClient.SqlClient, threadId: string, status: string) => sql`
  INSERT INTO projection_thread_sessions (
    thread_id, status, provider_name, provider_session_id, provider_thread_id,
    runtime_mode, active_turn_id, last_error, updated_at
  ) VALUES (
    ${threadId}, ${status}, 'codex', ${`session-${threadId}`}, ${`provider-${threadId}`},
    'approval-required', NULL, 'previous error', '2026-10-04T00:00:00.000Z'
  )
`;

describe("daily recap calendar boundaries", () => {
  for (const [date, from, to] of [
    ["2026-03-29", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
  ] as const) {
    it.effect(`resolves both midnights across DST on ${date}`, () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* dailyRecapWindow({ date, timeZone: "Europe/Berlin" }), {
          from,
          to,
        });
      }),
    );
  }

  for (const [input, reason] of [
    [{ date: "2026-02-30", timeZone: "UTC" }, "invalid-date"],
    [{ date: "2026-10-02", timeZone: "Mars/Olympus" }, "invalid-time-zone"],
    [{ date: "2011-12-30", timeZone: "Pacific/Apia" }, "invalid-date"],
  ] as const) {
    it.effect(`rejects ${JSON.stringify(input)}`, () =>
      Effect.gen(function* () {
        const error = yield* dailyRecapWindow(input).pipe(Effect.flip);
        assert.equal(error.reason, reason);
      }),
    );
  }

  it("rejects unbounded section sizes at the contract boundary", () => {
    const decode = Schema.decodeUnknownSync(DailyRecapRequest);
    assert.throws(() => decode({ ...request, limit: 51 }));
    assert.throws(() => decode({ ...request, limit: 0 }));
  });
});

it.layer(DailyRecapQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "DailyRecapQuery",
  (it) => {
    it.effect("returns an encodable empty recap", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* clean(sql);
        const service = yield* DailyRecapQuery;
        const result = yield* service.getDailyRecap(request);
        encode(result);
        assert.deepStrictEqual(result.counts, {
          completedTurns: 0,
          failedTurns: 0,
          interruptedTurns: 0,
        });
        assert.deepStrictEqual(result.completed, {
          totalThreads: 0,
          threads: [],
          truncated: false,
        });
        assert.deepStrictEqual(result.failed, result.completed);
        assert.deepStrictEqual(result.needsAttention, result.completed);
        assert.equal(result.from, "2026-10-01T22:00:00.000Z");
        assert.equal(result.to, "2026-10-02T22:00:00.000Z");
      }),
    );

    it.effect(
      "counts terminal outcomes inside the local day and keeps current attention separate",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* clean(sql);
          for (const id of [
            "mixed",
            "boundary",
            "pending",
            "deleted",
            "archived",
            "error",
            "recovered",
          ]) {
            yield* thread(sql, id);
          }
          yield* turn(sql, "mixed", "completed-1", "completed", "2026-10-02T01:00:00.000Z");
          yield* turn(sql, "mixed", "completed-2", "completed", "2026-10-02T02:00:00.000Z");
          yield* turn(sql, "mixed", "failed", "error", "2026-10-02T03:00:00.000Z");
          yield* turn(sql, "mixed", "interrupted", "interrupted", "2026-10-02T04:00:00.000Z");
          yield* turn(sql, "boundary", "before", "completed", "2026-10-01T21:59:59.999Z");
          yield* turn(sql, "boundary", "start", "completed", "2026-10-01T22:00:00.000Z");
          yield* turn(sql, "boundary", "end", "completed", "2026-10-02T22:00:00.000Z");
          yield* turn(sql, "pending", "pending", "pending", null);
          yield* turn(sql, "deleted", "deleted", "completed", "2026-10-02T03:00:00.000Z");
          yield* turn(sql, "archived", "archived", "completed", "2026-10-02T05:00:00.000Z");
          yield* sql`UPDATE projection_threads SET deleted_at = '2026-10-03T00:00:00.000Z'
          WHERE thread_id = 'deleted'`;
          yield* sql`UPDATE projection_threads SET archived_at = '2026-10-03T00:00:00.000Z',
          pending_approval_count = 1 WHERE thread_id = 'archived'`;
          yield* sql`UPDATE projection_threads SET pending_approval_count = 2,
          pending_user_input_count = 1, has_actionable_proposed_plan = 1 WHERE thread_id = 'pending'`;
          yield* session(sql, "error", "error");
          yield* session(sql, "recovered", "idle");
          const service = yield* DailyRecapQuery;
          const result = yield* service.getDailyRecap(request);
          encode(result);
          assert.deepStrictEqual(result.counts, {
            completedTurns: 4,
            failedTurns: 1,
            interruptedTurns: 1,
          });
          assert.deepStrictEqual(
            result.completed.threads.map((item) => item.threadId),
            ["archived", "mixed", "boundary"],
          );
          assert.deepStrictEqual(
            result.failed.threads.map((item) => item.threadId),
            ["mixed"],
          );
          assert.equal(result.completed.threads[1]?.lastActivityAt, "2026-10-02T02:00:00.000Z");
          assert.deepStrictEqual(
            result.needsAttention.threads.map((item) => item.threadId),
            ["error", "pending"],
          );
          assert.equal(result.needsAttention.threads[0]?.sessionError, true);
          assert.equal(result.needsAttention.threads[1]?.pendingApprovals, 2);
          assert.equal(result.needsAttention.threads[1]?.pendingUserInputs, 1);
          assert.equal(result.needsAttention.threads[1]?.hasProposedPlan, true);

          yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-04T00:00:00.000Z'`;
          const afterDeletion = yield* service.getDailyRecap(request);
          assert.equal(afterDeletion.counts.completedTurns, 0);
          assert.equal(afterDeletion.completed.totalThreads, 0);
          assert.equal(afterDeletion.needsAttention.totalThreads, 0);
        }),
    );

    it.effect("excludes live commentary until its exact provider turn is no longer active", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* clean(sql);
        yield* thread(sql, "live");
        yield* turn(sql, "live", "earlier", "completed", "2026-10-02T00:00:00.000Z");
        yield* turn(sql, "live", "commentary", "completed", "2026-10-02T01:00:00.000Z");
        yield* session(sql, "live", "running");
        yield* sql`UPDATE projection_thread_sessions SET active_turn_id = 'commentary'
          WHERE thread_id = 'live'`;
        const service = yield* DailyRecapQuery;
        const running = yield* service.getDailyRecap(request);
        assert.equal(running.counts.completedTurns, 1);
        assert.equal(running.completed.threads[0]?.lastActivityAt, "2026-10-02T00:00:00.000Z");
        yield* sql`UPDATE projection_thread_sessions SET active_turn_id = NULL, status = 'idle'
          WHERE thread_id = 'live'`;
        const completed = yield* service.getDailyRecap(request);
        assert.equal(completed.counts.completedTurns, 2);
        assert.equal(completed.completed.threads[0]?.lastActivityAt, "2026-10-02T01:00:00.000Z");
      }),
    );

    it.effect("limits sections deterministically without truncating counts", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* clean(sql);
        for (const id of ["alpha", "beta", "gamma"]) {
          yield* thread(sql, id);
          yield* turn(sql, id, `${id}-done`, "completed", "2026-10-02T01:00:00.000Z");
          yield* turn(sql, id, `${id}-error`, "error", "2026-10-02T01:00:00.000Z");
          yield* sql`UPDATE projection_threads SET pending_user_input_count = 1 WHERE thread_id = ${id}`;
        }
        const service = yield* DailyRecapQuery;
        const result = yield* service.getDailyRecap({ ...request, limit: 2 });
        for (const section of [result.completed, result.failed, result.needsAttention]) {
          assert.equal(section.totalThreads, 3);
          assert.equal(section.truncated, true);
          assert.deepStrictEqual(
            section.threads.map((item) => item.threadId),
            ["alpha", "beta"],
          );
        }
        assert.equal(result.counts.completedTurns, 3);
        assert.equal(result.counts.failedTurns, 3);
      }),
    );

    it.effect("uses range and sparse attention indexes instead of scanning history", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const outcomePlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
          SELECT turns.thread_id FROM projection_turns turns
          JOIN projection_threads threads ON threads.thread_id = turns.thread_id
          JOIN projection_projects projects ON projects.project_id = threads.project_id
          WHERE turns.completed_at >= '2026-10-01T22:00:00.000Z'
            AND turns.completed_at < '2026-10-02T22:00:00.000Z'
            AND threads.deleted_at IS NULL AND projects.deleted_at IS NULL`;
        assert.ok(
          outcomePlan.some((row) =>
            row.detail.includes(
              "SEARCH turns USING COVERING INDEX idx_projection_turns_completed_at",
            ),
          ),
        );
        const attentionPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
          SELECT thread_id FROM projection_threads
          WHERE deleted_at IS NULL AND archived_at IS NULL
            AND (pending_approval_count > 0 OR pending_user_input_count > 0
              OR has_actionable_proposed_plan = 1)
          UNION
          SELECT thread_id FROM projection_thread_sessions WHERE status = 'error'`;
        assert.ok(
          attentionPlan.some((row) =>
            row.detail.includes("idx_projection_threads_pending_attention"),
          ),
          JSON.stringify(attentionPlan),
        );
        assert.ok(
          attentionPlan.some((row) => row.detail.includes("idx_projection_thread_sessions_error")),
        );
      }),
    );
  },
);
