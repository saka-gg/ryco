import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Scheduler, Scope } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlStatement from "effect/sql/Statement";
import { StatisticsSnapshot } from "@ryco/contracts";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import {
  makeEventLogCompaction,
  ONLINE_COMPACTION_PASS_OPTIONS,
} from "../persistence/Layers/EventLogCompaction.ts";
import { SqliteReadClient } from "../persistence/SqliteReadClient.ts";
import {
  selectStatisticsTokenActivities,
  selectStatisticsToolUses,
  makeStatisticsQuery,
  STATISTICS_PARTIAL_FORMAT_VERSION,
  StatisticsQuery,
  StatisticsQueryLive,
} from "./StatisticsQuery.ts";

const encodeSnapshot = Schema.encodeUnknownSync(StatisticsSnapshot);

const statisticsLayer = it.layer(
  StatisticsQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const clean = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM orchestration_events`;
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_thread_sessions`;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_worktrees`;
    yield* sql`DELETE FROM projection_state`;
  });

const insertProject = (sql: SqlClient.SqlClient, id: string, title: string) =>
  sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${id}, ${title}, ${`/tmp/${id}`}, '{"provider":"codex","model":"gpt-5.4"}',
      '[]', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL
    )
  `;

const insertThread = (
  sql: SqlClient.SqlClient,
  id: string,
  projectId: string,
  provider: string,
  model: string,
  createdAt: string,
) =>
  sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, latest_turn_id,
      latest_user_message_at, pending_approval_count, pending_user_input_count,
      has_actionable_proposed_plan, created_at, updated_at, deleted_at
    ) VALUES (
      ${id}, ${projectId}, ${`Thread ${id}`},
      ${`{"provider":"${provider}","model":"${model}"}`}, 'full-access',
      'default', NULL, NULL, NULL, NULL, 0, 0, 0, ${createdAt}, ${createdAt}, NULL
    )
  `;

const insertSession = (sql: SqlClient.SqlClient, threadId: string, provider: string) =>
  sql`
    INSERT INTO projection_thread_sessions (
      thread_id, status, provider_name, provider_session_id, provider_thread_id,
      runtime_mode, active_turn_id, last_error, updated_at
    ) VALUES (
      ${threadId}, 'idle', ${provider}, ${`sess-${threadId}`}, ${`pt-${threadId}`},
      'approval-required', NULL, NULL, '2026-06-10T00:00:00.000Z'
    )
  `;

const insertActivity = (
  sql: SqlClient.SqlClient,
  id: string,
  threadId: string,
  turnId: string,
  kind: string,
  payload: string,
  createdAt: string,
  sequence: number,
) =>
  sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
      sequence, created_at
    ) VALUES (
      ${id}, ${threadId}, ${turnId}, 'info', ${kind}, 'note', ${payload},
      ${sequence}, ${createdAt}
    )
  `;

const insertTurn = (
  sql: SqlClient.SqlClient,
  threadId: string,
  turnId: string,
  checkpointCount: number,
  startedAt: string,
  completedAt: string,
  filesJson: string,
) =>
  sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, assistant_message_id, state,
      requested_at, started_at, completed_at, checkpoint_turn_count,
      checkpoint_ref, checkpoint_status, checkpoint_files_json
    ) VALUES (
      ${threadId}, ${turnId}, NULL, NULL, 'completed', ${startedAt}, ${startedAt},
      ${completedAt}, ${checkpointCount}, ${`cp-${turnId}`}, 'ready', ${filesJson}
    )
  `;

const insertWorktree = (
  sql: SqlClient.SqlClient,
  id: string,
  projectId: string,
  origin: string,
  prNumber: number | null,
  archivedAt: string | null,
) =>
  sql`
    INSERT INTO projection_worktrees (
      worktree_id, project_id, branch, origin, pr_number, created_at, updated_at, archived_at
    ) VALUES (
      ${id}, ${projectId}, ${`branch-${id}`}, ${origin}, ${prNumber},
      '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z', ${archivedAt}
    )
  `;

statisticsLayer("StatisticsQuery", (it) => {
  it.effect(
    "reuses unchanged snapshots, shares concurrent reads, and invalidates after writes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statistics = yield* StatisticsQuery;
        yield* clean(sql);
        yield* insertProject(sql, "cached-project", "Cached");
        yield* insertThread(
          sql,
          "cached-thread",
          "cached-project",
          "codex",
          "gpt-5.4",
          "2026-06-10T00:00:00.000Z",
        );
        const snapshots = yield* Effect.all(
          Array.from({ length: 8 }, () => statistics.getStatistics()),
          { concurrency: "unbounded" },
        );
        for (const snapshot of snapshots) assert.strictEqual(snapshot, snapshots[0]);
        yield* sql`UPDATE projection_projects SET title = 'Renamed' WHERE project_id = 'cached-project'`;
        const updated = yield* statistics.getStatistics();
        assert.notStrictEqual(updated, snapshots[0]);
        assert.equal(updated.projects[0]?.title, "Renamed");
        assert.strictEqual(yield* statistics.getStatistics(), updated);
      }),
  );

  it.effect("does not cache data inspected in a transaction that rolls back", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "rollback-project", "Saved");
      yield* insertThread(
        sql,
        "rollback-thread",
        "rollback-project",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE projection_projects SET title = 'Uncommitted' WHERE project_id = 'rollback-project'`;
            assert.equal((yield* statistics.getStatistics()).projects[0]?.title, "Uncommitted");
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.catch(() => Effect.void));
      assert.equal((yield* statistics.getStatistics()).projects[0]?.title, "Saved");
    }),
  );

  it.effect("aggregates per-turn token deltas, file changes, and worktrees", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);

      yield* insertProject(sql, "project-1", "Project One");
      yield* insertThread(
        sql,
        "thread-1",
        "project-1",
        "claudeAgent",
        "claude-opus-4-8",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertThread(
        sql,
        "thread-2",
        "project-1",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertSession(sql, "thread-1", "claudeAgent");
      yield* insertSession(sql, "thread-2", "codex");

      // thread-1, turn-1 has two snapshots; only the final `last*` deltas count.
      yield* insertActivity(
        sql,
        "act-1a",
        "thread-1",
        "turn-1",
        "context-window.updated",
        '{"usedTokens":600,"inputTokens":400,"outputTokens":200,"lastInputTokens":400,"lastOutputTokens":200}',
        "2026-06-10T00:00:01.000Z",
        1,
      );
      yield* insertActivity(
        sql,
        "act-1b",
        "thread-1",
        "turn-1",
        "context-window.updated",
        '{"usedTokens":1500,"inputTokens":1000,"outputTokens":500,"cachedInputTokens":100,"lastInputTokens":1000,"lastOutputTokens":500,"lastCachedInputTokens":100}',
        "2026-06-10T00:00:02.000Z",
        2,
      );
      yield* insertActivity(
        sql,
        "act-2",
        "thread-2",
        "turn-2",
        "context-window.updated",
        '{"usedTokens":3000,"inputTokens":2000,"outputTokens":1000,"lastInputTokens":2000,"lastOutputTokens":1000}',
        "2026-06-10T00:00:03.000Z",
        1,
      );
      yield* insertActivity(
        sql,
        "tool-1",
        "thread-1",
        "turn-1",
        "tool.completed",
        "{}",
        "2026-06-10T00:00:02.500Z",
        3,
      );

      yield* insertTurn(
        sql,
        "thread-1",
        "turn-1",
        1,
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:01:00.000Z",
        '[{"path":"a.ts","kind":"modified","additions":10,"deletions":4}]',
      );
      yield* insertTurn(
        sql,
        "thread-2",
        "turn-2",
        1,
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:00:30.000Z",
        '[{"path":"b.ts","kind":"added","additions":20,"deletions":0},{"path":"c.ts","kind":"deleted","additions":0,"deletions":5}]',
      );

      yield* insertWorktree(sql, "wt-1", "project-1", "branch", null, null);
      yield* insertWorktree(sql, "wt-2", "project-1", "pr", 42, null);
      yield* insertWorktree(sql, "wt-3", "project-1", "branch", null, "2026-06-09T00:00:00.000Z");

      const snapshot = yield* statistics.getStatistics();

      // Per-turn deltas, no double counting of thread-1's two snapshots.
      assert.equal(snapshot.tokenAttribution, "per-turn-delta");
      assert.equal(snapshot.totals.inputTokens, 3000);
      assert.equal(snapshot.totals.outputTokens, 1500);
      assert.equal(snapshot.totals.totalTokens, 4500);
      assert.equal(snapshot.totals.cachedInputTokens, 100);
      assert.equal(snapshot.totals.threads, 2);
      assert.equal(snapshot.totals.toolUses, 1);

      // File/line changes from checkpoint diffs.
      assert.equal(snapshot.totals.filesChanged, 3);
      assert.equal(snapshot.totals.additions, 30);
      assert.equal(snapshot.totals.deletions, 9);

      // Active time = sum of (completed - started): 60s + 30s = 90s.
      assert.equal(snapshot.totals.activeMs, 90_000);

      // Two turns completed.
      assert.equal(snapshot.totals.turns, 2);

      // Per-model split, sorted by tokens (gpt-5.4 leads with 3000).
      const models = snapshot.models.map((entry) => entry.model).toSorted();
      assert.deepEqual(models, ["claude-opus-4-8", "gpt-5.4"]);
      const gpt = snapshot.dailyBuckets
        .filter((bucket) => bucket.model === "gpt-5.4")
        .reduce((acc, bucket) => acc + bucket.inputTokens, 0);
      assert.equal(gpt, 2000);

      // Worktree summary.
      assert.equal(snapshot.worktrees.created, 3);
      assert.equal(snapshot.worktrees.archived, 1);
      assert.equal(snapshot.worktrees.active, 2);
      assert.equal(snapshot.worktrees.openPrs, 1);
      assert.deepEqual(
        snapshot.recentPullRequests.map((pullRequest) => ({
          worktreeId: pullRequest.worktreeId,
          projectTitle: pullRequest.projectTitle,
          prNumber: pullRequest.prNumber,
          active: pullRequest.active,
        })),
        [{ worktreeId: "wt-2", projectTitle: "Project One", prNumber: 42, active: true }],
      );

      // Commits/pushes are not yet instrumented.
      assert.equal(snapshot.totals.commits, 0);
      assert.equal(snapshot.totals.pushes, 0);
    }),
  );

  it.effect("bounds recent pull requests and orders them by update time then worktree id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "project-1", "Project One");

      for (let index = 0; index < 21; index += 1) {
        const suffix = String(index).padStart(2, "0");
        yield* insertWorktree(sql, `wt-${suffix}`, "project-1", "pr", index + 1, null);
      }
      yield* sql`
        UPDATE projection_worktrees
        SET updated_at = '2026-06-06T00:00:00.000Z',
            title = 'Newest worktree',
            pr_title = 'Ship usage statistics',
            pr_state = 'open',
            pr_is_draft = 1
        WHERE worktree_id = 'wt-20'
      `;

      const snapshot = yield* statistics.getStatistics();
      assert.equal(snapshot.recentPullRequests.length, 20);
      assert.deepEqual(
        snapshot.recentPullRequests.map((pullRequest) => pullRequest.worktreeId),
        [
          "wt-20",
          ...Array.from({ length: 19 }, (_, index) => `wt-${String(index).padStart(2, "0")}`),
        ],
      );
      assert.deepInclude(snapshot.recentPullRequests[0]!, {
        worktreeTitle: "Newest worktree",
        prTitle: "Ship usage statistics",
        prState: "open",
        prIsDraft: true,
      });
    }),
  );

  it.effect("falls back to cumulative attribution when per-turn deltas are absent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);

      yield* insertProject(sql, "project-1", "Project One");
      yield* insertThread(
        sql,
        "thread-1",
        "project-1",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertSession(sql, "thread-1", "codex");
      // Cumulative totals only, no `last*` deltas.
      yield* insertActivity(
        sql,
        "act-1",
        "thread-1",
        "turn-1",
        "context-window.updated",
        '{"usedTokens":1200,"inputTokens":800,"outputTokens":400}',
        "2026-06-10T00:00:02.000Z",
        1,
      );

      const snapshot = yield* statistics.getStatistics();
      assert.equal(snapshot.tokenAttribution, "thread-cumulative");
      assert.equal(snapshot.totals.inputTokens, 800);
      assert.equal(snapshot.totals.outputTokens, 400);
      assert.equal(snapshot.totals.totalTokens, 1200);
    }),
  );

  it.effect("counts total-only cumulative usage without inventing token breakdowns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);

      yield* insertProject(sql, "project-1", "Project One");
      yield* insertThread(
        sql,
        "thread-1",
        "project-1",
        "cursor",
        "composer-2",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertSession(sql, "thread-1", "cursor");
      yield* insertActivity(
        sql,
        "act-1",
        "thread-1",
        "turn-1",
        "context-window.updated",
        '{"usedTokens":5000,"lastUsedTokens":5000}',
        "2026-06-10T00:00:02.000Z",
        1,
      );

      const snapshot = yield* statistics.getStatistics();

      assert.equal(snapshot.tokenAttribution, "thread-cumulative");
      assert.equal(snapshot.totals.totalTokens, 5000);
      assert.equal(snapshot.totals.inputTokens, 0);
      assert.equal(snapshot.totals.outputTokens, 0);
      assert.equal(snapshot.dailyBuckets[0]?.totalTokens, 5000);
    }),
  );

  it.effect("coalesces blank model/provider and stays encodable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);

      yield* insertProject(sql, "project-1", "Project One");
      // model_selection_json with empty model + provider, and no session row.
      yield* insertThread(sql, "thread-1", "project-1", "", "", "2026-06-10T00:00:00.000Z");

      const snapshot = yield* statistics.getStatistics();

      // Blank model coalesced to "unknown"; blank provider dropped.
      assert.deepEqual(
        snapshot.models.map((entry) => entry.model),
        ["unknown"],
      );
      assert.equal(snapshot.models[0]?.provider, undefined);
      assert.ok(snapshot.dailyBuckets.every((bucket) => bucket.model === "unknown"));

      // Must encode through the RPC success schema without throwing (else orDie
      // would crash the request).
      assert.doesNotThrow(() => encodeSnapshot(snapshot));
    }),
  );

  it.effect("falls back to cumulative per-turn when mixed data (old + new deltas)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);

      yield* insertProject(sql, "project-1", "Project One");
      // Old thread: cumulative totals only, no deltas.
      yield* insertThread(
        sql,
        "thread-old",
        "project-1",
        "legacy",
        "old-model",
        "2026-06-10T00:00:00.000Z",
      );
      // New thread: has per-turn deltas.
      yield* insertThread(
        sql,
        "thread-new",
        "project-1",
        "anthropic",
        "claude-opus-4-8",
        "2026-06-20T00:00:00.000Z",
      );
      yield* insertSession(sql, "thread-old", "legacy");
      yield* insertSession(sql, "thread-new", "anthropic");

      // Old turn: cumulative only.
      yield* insertActivity(
        sql,
        "act-old",
        "thread-old",
        "turn-1",
        "context-window.updated",
        '{"inputTokens":800,"outputTokens":200,"usedTokens":1000}',
        "2026-06-10T00:00:01.000Z",
        1,
      );

      // New turn: has deltas (per-turn mode).
      yield* insertActivity(
        sql,
        "act-new",
        "thread-new",
        "turn-1",
        "context-window.updated",
        '{"inputTokens":2000,"outputTokens":500,"lastInputTokens":1000,"lastOutputTokens":250,"usedTokens":2500}',
        "2026-06-20T00:00:01.000Z",
        1,
      );

      const snapshot = yield* statistics.getStatistics();

      // Both threads should be counted correctly:
      // - Old thread uses cumulative (800 + 200 = 1000)
      // - New thread uses delta (1000 + 250 = 1250)
      // - Total should be 1000 + 1250 = 2250
      assert.equal(snapshot.totals.inputTokens, 1800); // 800 (old) + 1000 (new)
      assert.equal(snapshot.totals.outputTokens, 450); // 200 (old) + 250 (new)
      assert.equal(snapshot.totals.totalTokens, 2250);
      assert.equal(snapshot.tokenAttribution, "mixed");
    }),
  );

  it.effect("counts cumulative history before exact deltas within the same thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);

      yield* insertProject(sql, "project-1", "Project One");
      yield* insertThread(
        sql,
        "thread-1",
        "project-1",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertSession(sql, "thread-1", "codex");

      yield* insertActivity(
        sql,
        "act-old",
        "thread-1",
        "turn-1",
        "context-window.updated",
        '{"inputTokens":800,"outputTokens":200,"usedTokens":1000}',
        "2026-06-10T00:00:01.000Z",
        1,
      );
      yield* insertActivity(
        sql,
        "act-new",
        "thread-1",
        "turn-2",
        "context-window.updated",
        '{"inputTokens":1200,"outputTokens":300,"lastInputTokens":400,"lastOutputTokens":100,"lastUsedTokens":500}',
        "2026-06-11T00:00:01.000Z",
        2,
      );

      const snapshot = yield* statistics.getStatistics();

      assert.equal(snapshot.tokenAttribution, "mixed");
      assert.equal(snapshot.totals.inputTokens, 1200);
      assert.equal(snapshot.totals.outputTokens, 300);
      assert.equal(snapshot.totals.totalTokens, 1500);
      assert.deepEqual(
        snapshot.dailyBuckets.map((bucket) => ({
          date: bucket.date,
          inputTokens: bucket.inputTokens,
          outputTokens: bucket.outputTokens,
          totalTokens: bucket.totalTokens,
        })),
        [
          { date: "2026-06-10", inputTokens: 800, outputTokens: 200, totalTokens: 1000 },
          { date: "2026-06-11", inputTokens: 400, outputTokens: 100, totalTokens: 500 },
        ],
      );
    }),
  );
});

it.effect("invalidates statistics after another SQLite connection commits", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "ryco-statistics-cache-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    const filename = join(directory, "state.sqlite");
    const persistence = Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* insertProject(sql, "external", "Before");
      yield* insertThread(
        sql,
        "external-thread",
        "external",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      const previous = yield* statistics.getStatistics();
      const other = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(filename)),
        (db) => Effect.sync(() => db.close()),
      );
      yield* Effect.sync(() =>
        other.exec("UPDATE projection_projects SET title = 'After' WHERE project_id = 'external'"),
      );
      const refreshed = yield* statistics.getStatistics();
      assert.notStrictEqual(previous, refreshed);
      assert.equal(refreshed.projects[0]?.title, "After");
      assert.strictEqual(yield* statistics.getStatistics(), refreshed);
    }).pipe(Effect.provide(StatisticsQueryLive.pipe(Layer.provideMerge(persistence))));
  }).pipe(Effect.scoped),
);

statisticsLayer("usage billing counters", (it) => {
  it.effect(
    "recovers overwritten Claude turns from indexed history and avoids counting its projection copy",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statistics = yield* StatisticsQuery;
        yield* clean(sql);
        yield* insertProject(sql, "billing-project", "Billing");
        yield* insertThread(
          sql,
          "billing-thread",
          "billing-project",
          "claudeAgent",
          "claude-opus-5-5",
          "2026-06-10T00:00:00.000Z",
        );
        for (const [index, total] of [1000, 2000].entries()) {
          const createdAt = `2026-06-${10 + index}T00:00:01.000Z`;
          const payload = {
            usedTokens: 100,
            statisticsProvider: "claudeAgent",
            processedUsage: {
              scope: "turn",
              inputTokens: total - 100,
              cachedInputTokens: 400,
              outputTokens: 100,
              reasoningOutputTokens: 0,
              totalTokens: total,
            },
          };
          const activity = {
            id: "claude-context-usage:billing-thread",
            turnId: `turn-${index}`,
            sequence: index,
            kind: "context-window.updated",
            createdAt,
            payload,
          };
          yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
        VALUES (${`usage-event-${index}`},'thread','billing-thread',${index},'thread.activity-appended',${createdAt},'system',${JSON.stringify({ threadId: "billing-thread", activity })},'{}')`;
          if (index === 1)
            yield* insertActivity(
              sql,
              activity.id,
              "billing-thread",
              activity.turnId,
              activity.kind,
              JSON.stringify(payload),
              createdAt,
              index,
            );
        }
        const snapshot = yield* statistics.getStatistics();
        assert.equal(snapshot.totals.totalTokens, 3000);
        assert.equal(snapshot.totals.inputTokens, 2800);
        assert.equal(
          snapshot.dailyBuckets.find((bucket) => bucket.date === "2026-06-10")?.totalTokens,
          1000,
        );
        assert.equal(
          snapshot.dailyBuckets.find((bucket) => bucket.date === "2026-06-11")?.totalTokens,
          2000,
        );
        const plan = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT stream_id FROM orchestration_events WHERE event_type = 'thread.activity-appended' AND json_extract(payload_json, '$.activity.kind') = 'context-window.updated'`;
        assert.ok(plan.some((row) => row.detail.includes("idx_orch_events_statistics_usage")));
      }),
  );
  it.effect("counts all Codex requests in a turn, not just its final context gauge", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "codex-project", "Codex");
      yield* insertThread(
        sql,
        "codex-thread",
        "codex-project",
        "codex",
        "gpt-6-astra",
        "2026-06-10T00:00:00.000Z",
      );
      for (const [index, total] of [1000, 5000, 5000, 9000].entries()) {
        yield* insertActivity(
          sql,
          `usage-${index}`,
          "codex-thread",
          index < 3 ? "turn-a" : "turn-b",
          "context-window.updated",
          JSON.stringify({
            usedTokens: 100,
            lastUsedTokens: 100,
            lastInputTokens: 90,
            lastOutputTokens: 10,
            totalProcessedTokens: total,
          }),
          `2026-06-${index < 3 ? 10 : 11}T00:00:0${index}.000Z`,
          index,
        );
      }
      const snapshot = yield* statistics.getStatistics();
      assert.equal(snapshot.totals.totalTokens, 9000);
      assert.equal(
        snapshot.dailyBuckets.find((bucket) => bucket.date === "2026-06-10")?.totalTokens,
        5000,
      );
      assert.equal(
        snapshot.dailyBuckets.find((bucket) => bucket.date === "2026-06-11")?.totalTokens,
        4000,
      );
      assert.equal(snapshot.tokenAttribution, "thread-cumulative");
    }),
  );
});

statisticsLayer("recorded usage attribution", (it) => {
  it.effect("keeps usage in its original provider/model/project when a thread changes models", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "project-a", "A");
      yield* insertProject(sql, "project-b", "B");
      yield* insertThread(
        sql,
        "changing",
        "project-a",
        "codex",
        "model-b",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertThread(
        sql,
        "other",
        "project-b",
        "opencode",
        "model-c",
        "2026-06-10T00:00:00.000Z",
      );
      for (const [index, total] of [1000, 3000].entries()) {
        yield* insertActivity(
          sql,
          `changing-${index}`,
          "changing",
          `turn-${index}`,
          "context-window.updated",
          JSON.stringify({
            statisticsProvider: "codex",
            statisticsModel: index === 0 ? "model-a" : "model-b",
            processedUsage: {
              scope: "session",
              sessionId: "provider-session",
              inputTokens: total - 100,
              cachedInputTokens: 0,
              outputTokens: 100,
              reasoningOutputTokens: 0,
              totalTokens: total,
            },
          }),
          `2026-06-10T00:00:0${index}.000Z`,
          index,
        );
      }
      yield* insertActivity(
        sql,
        "other-usage",
        "other",
        "turn-other",
        "context-window.updated",
        JSON.stringify({
          statisticsProvider: "opencode",
          statisticsModel: "model-c",
          processedUsage: {
            scope: "request",
            requestId: "message",
            inputTokens: 450,
            cachedInputTokens: 0,
            outputTokens: 50,
            reasoningOutputTokens: 0,
            totalTokens: 500,
          },
        }),
        "2026-06-10T00:00:03.000Z",
        3,
      );
      const snapshot = yield* statistics.getStatistics();
      assert.equal(snapshot.totals.totalTokens, 3500);
      assert.equal(
        snapshot.dailyBuckets.find((bucket) => bucket.model === "model-a")?.totalTokens,
        1000,
      );
      assert.equal(
        snapshot.dailyBuckets.find((bucket) => bucket.model === "model-b")?.totalTokens,
        2000,
      );
      assert.equal(
        snapshot.dailyBuckets.find((bucket) => bucket.projectId === "project-b")?.totalTokens,
        500,
      );
      assert.ok(
        snapshot.models.some((model) => model.model === "model-a" && model.provider === "codex"),
      );
    }),
  );
});

const insertContextEvent = (
  sql: SqlClient.SqlClient,
  eventId: string,
  threadId: string,
  turnId: string,
  createdAt: string,
  payload: object,
) =>
  sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      actor_kind, payload_json, metadata_json
    ) VALUES (
      ${eventId}, 'thread', ${threadId},
      (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${threadId}),
      'thread.activity-appended', ${createdAt}, 'system',
      ${JSON.stringify({
        threadId,
        activity: {
          id: eventId,
          turnId,
          kind: "context-window.updated",
          createdAt,
          payload,
        },
      })},
      '{}'
    )
  `;

/** What the projection pipeline records after projecting every stored event. */
const markProjected = (sql: SqlClient.SqlClient) =>
  sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT value, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events), '2026-06-10T00:00:00.000Z'
    FROM json_each('["projection.threads","projection.thread-sessions","projection.thread-activities","projection.thread-turns","projection.checkpoints"]')
    WHERE true
    ON CONFLICT (projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence
  `;

/** A full recompute: inside a caller transaction the cache is bypassed. */
const recompute = (sql: SqlClient.SqlClient, statistics: StatisticsQuery["Service"]) =>
  sql.withTransaction(statistics.getStatistics());

const withoutGeneratedAt = (snapshot: StatisticsSnapshot) => ({
  ...snapshot,
  generatedAt: "",
});

statisticsLayer("incremental statistics", (it) => {
  it.effect("plans the projection-only fallback lookup on every index column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN ${selectStatisticsTokenActivities(sql, null)}`;
      assert.ok(
        plan.some(
          (row) =>
            row.detail.includes("idx_orch_events_statistics_usage") &&
            row.detail.includes("(stream_id=? AND <expr>=? AND <expr>=?)"),
        ),
        JSON.stringify(plan),
      );
      const scoped = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN ${selectStatisticsTokenActivities(sql, '["thread"]')}`;
      assert.ok(
        scoped.some(
          (row) =>
            row.detail.startsWith("SEARCH orchestration_events") &&
            row.detail.includes("idx_orch_events_statistics_usage (stream_id=?)"),
        ),
        JSON.stringify(scoped),
      );
    }),
  );

  it.effect("reads tool uses and projection-only token rows through the kind index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const toolUses = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN ${selectStatisticsToolUses(sql, null)}`;
      // Migration 085's kind-leading index: the tool-use count reads only its
      // tool.completed entries instead of walking every activity row.
      assert.ok(
        toolUses.some(
          (row) =>
            row.detail.startsWith("SEARCH projection_thread_activities") &&
            row.detail.includes(
              "COVERING INDEX idx_projection_thread_activities_kind_order (kind=?)",
            ),
        ),
        JSON.stringify(toolUses),
      );
      const tokens = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN ${selectStatisticsTokenActivities(sql, null)}`;
      // ...and so does the outer scan of the projection-only fallback.
      assert.ok(
        tokens.some(
          (row) =>
            row.detail.startsWith("SEARCH a") &&
            row.detail.includes("idx_projection_thread_activities_kind_order (kind=?)"),
        ),
        JSON.stringify(tokens),
      );
    }),
  );

  it.effect("refreshes only threads with new events and matches a full recompute", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "inc-project", "Incremental");
      yield* insertProject(sql, "inc-other", "Other");
      yield* insertThread(
        sql,
        "inc-a",
        "inc-project",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertThread(
        sql,
        "inc-b",
        "inc-project",
        "claudeAgent",
        "claude-opus-5-5",
        "2026-06-10T00:00:00.000Z",
      );
      const perTurn = (input: number, output: number) => ({
        usedTokens: input + output,
        lastInputTokens: input,
        lastOutputTokens: output,
        lastUsedTokens: input + output,
      });
      yield* insertContextEvent(
        sql,
        "inc-a-1",
        "inc-a",
        "turn-a1",
        "2026-06-10T00:00:01.000Z",
        perTurn(100, 10),
      );
      yield* insertContextEvent(
        sql,
        "inc-b-1",
        "inc-b",
        "turn-b1",
        "2026-06-10T00:00:02.000Z",
        perTurn(200, 20),
      );
      yield* insertTurn(
        sql,
        "inc-b",
        "turn-b1",
        1,
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:00:30.000Z",
        '[{"path":"b.ts","kind":"modified","additions":3,"deletions":1}]',
      );
      yield* markProjected(sql);
      const first = yield* statistics.getStatistics();
      assert.equal(first.totals.totalTokens, 330);

      // New work on thread A (event + projection rows in one commit), and a
      // meta change on thread B that re-buckets its existing usage.
      yield* insertContextEvent(
        sql,
        "inc-a-2",
        "inc-a",
        "turn-a2",
        "2026-06-11T00:00:01.000Z",
        perTurn(1000, 100),
      );
      yield* insertActivity(
        sql,
        "inc-a-tool",
        "inc-a",
        "turn-a2",
        "tool.completed",
        "{}",
        "2026-06-11T00:00:02.000Z",
        5,
      );
      yield* insertTurn(
        sql,
        "inc-a",
        "turn-a2",
        2,
        "2026-06-11T00:00:00.000Z",
        "2026-06-11T00:01:00.000Z",
        '[{"path":"a.ts","kind":"added","additions":7,"deletions":0}]',
      );
      yield* sql`UPDATE projection_threads SET project_id = 'inc-other' WHERE thread_id = 'inc-b'`;

      yield* markProjected(sql);
      const incremental = yield* statistics.getStatistics();
      assert.notStrictEqual(incremental, first);
      assert.equal(incremental.totals.totalTokens, 1430);
      assert.equal(incremental.totals.toolUses, 1);
      assert.equal(incremental.totals.additions, 10);
      assert.equal(
        incremental.dailyBuckets
          .filter((bucket) => bucket.projectId === "inc-other")
          .reduce((sum, bucket) => sum + bucket.totalTokens, 0),
        220,
      );
      assert.deepEqual(
        withoutGeneratedAt(incremental),
        withoutGeneratedAt(yield* recompute(sql, statistics)),
      );
      assert.strictEqual(yield* statistics.getStatistics(), incremental);
    }),
  );

  it.effect("re-reads only threads whose streams received events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "scope-project", "Scope");
      for (const threadId of ["scope-a", "scope-b"]) {
        yield* insertThread(
          sql,
          threadId,
          "scope-project",
          "codex",
          "gpt-5.4",
          "2026-06-10T00:00:00.000Z",
        );
        yield* insertContextEvent(
          sql,
          `${threadId}-1`,
          threadId,
          "turn-1",
          "2026-06-10T00:00:01.000Z",
          { lastInputTokens: 50, lastOutputTokens: 5, lastUsedTokens: 55 },
        );
      }
      yield* insertTurn(
        sql,
        "scope-b",
        "turn-1",
        1,
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:00:30.000Z",
        '[{"path":"b.ts","kind":"modified","additions":3,"deletions":1}]',
      );
      yield* markProjected(sql);
      assert.equal((yield* statistics.getStatistics()).totals.additions, 3);
      // Production writes thread rows only together with a thread event. A
      // write that bypasses that (only possible in tests) shows the cached
      // partial of thread B was reused rather than re-read.
      yield* sql`UPDATE projection_turns SET checkpoint_files_json = '[]' WHERE thread_id = 'scope-b'`;
      yield* insertContextEvent(sql, "scope-a-2", "scope-a", "turn-2", "2026-06-10T00:00:02.000Z", {
        lastInputTokens: 10,
        lastOutputTokens: 1,
        lastUsedTokens: 11,
      });
      yield* markProjected(sql);
      const incremental = yield* statistics.getStatistics();
      assert.equal(incremental.totals.totalTokens, 121);
      assert.equal(incremental.totals.additions, 3);
      assert.equal((yield* recompute(sql, statistics)).totals.additions, 0);
    }),
  );

  it.effect("re-reads threads whose events were not projected yet", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "lag-project", "Lag");
      yield* insertThread(
        sql,
        "lag-a",
        "lag-project",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertThread(
        sql,
        "lag-b",
        "lag-project",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertContextEvent(sql, "lag-a-1", "lag-a", "turn-1", "2026-06-10T00:00:01.000Z", {
        lastInputTokens: 50,
        lastOutputTokens: 5,
        lastUsedTokens: 55,
      });
      yield* markProjected(sql);
      // Thread B's event is stored, but the turns projector has not applied it.
      yield* insertContextEvent(sql, "lag-b-1", "lag-b", "turn-1", "2026-06-10T00:00:02.000Z", {
        lastInputTokens: 10,
        lastOutputTokens: 1,
        lastUsedTokens: 11,
      });
      assert.equal((yield* statistics.getStatistics()).totals.additions, 0);
      // The projector catches up later, in its own transaction.
      yield* insertTurn(
        sql,
        "lag-b",
        "turn-1",
        1,
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:00:30.000Z",
        '[{"path":"b.ts","kind":"modified","additions":4,"deletions":0}]',
      );
      yield* markProjected(sql);
      const caughtUp = yield* statistics.getStatistics();
      assert.equal(caughtUp.totals.additions, 4);
      assert.deepEqual(
        withoutGeneratedAt(caughtUp),
        withoutGeneratedAt(yield* recompute(sql, statistics)),
      );
    }),
  );

  it.effect("drops a deleted thread's usage while keeping the rest incremental", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "del-project", "Deleted");
      for (const threadId of ["del-a", "del-b"]) {
        yield* insertThread(
          sql,
          threadId,
          "del-project",
          "codex",
          "gpt-5.4",
          "2026-06-10T00:00:00.000Z",
        );
        yield* insertContextEvent(
          sql,
          `${threadId}-1`,
          threadId,
          "turn-1",
          "2026-06-10T00:00:01.000Z",
          { lastInputTokens: 50, lastOutputTokens: 5, lastUsedTokens: 55 },
        );
      }
      yield* markProjected(sql);
      assert.equal((yield* statistics.getStatistics()).totals.totalTokens, 110);
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'del-b'`;
      yield* insertContextEvent(sql, "del-a-2", "del-a", "turn-2", "2026-06-10T00:00:02.000Z", {
        lastInputTokens: 10,
        lastOutputTokens: 1,
        lastUsedTokens: 11,
      });
      yield* markProjected(sql);
      const snapshot = yield* statistics.getStatistics();
      assert.equal(snapshot.totals.totalTokens, 66);
      assert.equal(snapshot.totals.threads, 1);
      assert.deepEqual(
        withoutGeneratedAt(snapshot),
        withoutGeneratedAt(yield* recompute(sql, statistics)),
      );
    }),
  );
});

statisticsLayer("forked threads", (it) => {
  it.effect("counts a fork's own work only, never the history it inherited", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "fork-project", "Forks");
      yield* insertThread(
        sql,
        "source",
        "fork-project",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertThread(
        sql,
        "fork",
        "fork-project",
        "codex",
        "gpt-5.4",
        "2026-06-12T00:00:00.000Z",
      );
      const inherited = (id: string) => `fork:inherited:${id}`;
      const turnRow = (
        threadId: string,
        turnId: string,
        assistantMessageId: string,
        startedAt: string,
        completedAt: string,
        filesJson: string,
      ) => sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, assistant_message_id, state, requested_at, started_at,
          completed_at, checkpoint_files_json
        ) VALUES (
          ${threadId}, ${turnId}, ${assistantMessageId}, 'completed', ${startedAt}, ${startedAt},
          ${completedAt}, ${filesJson}
        )
      `;
      // The source's turn, and the fork's inherited copy of it (same ids and times, as fork
      // publication projects it).
      yield* turnRow(
        "source",
        "turn-source",
        "message-answer",
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:01:00.000Z",
        '[{"path":"a.ts","kind":"modified","additions":10,"deletions":4}]',
      );
      yield* turnRow(
        "fork",
        "turn-source",
        inherited("message-answer"),
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:01:00.000Z",
        "[]",
      );
      yield* turnRow(
        "fork",
        "turn-own",
        "message-own",
        "2026-06-12T00:00:00.000Z",
        "2026-06-12T00:00:30.000Z",
        "[]",
      );
      for (const [id, threadId, turnId, createdAt] of [
        ["tool-source", "source", "turn-source", "2026-06-10T00:00:10.000Z"],
        [inherited("tool-source"), "fork", "turn-source", "2026-06-10T00:00:10.000Z"],
        ["tool-own", "fork", "turn-own", "2026-06-12T00:00:10.000Z"],
      ] as const) {
        yield* insertActivity(sql, id, threadId, turnId, "tool.completed", "{}", createdAt, 1);
      }
      const usage = '{"usedTokens":600,"lastInputTokens":400,"lastOutputTokens":200}';
      yield* insertActivity(
        sql,
        "ctx-source",
        "source",
        "turn-source",
        "context-window.updated",
        usage,
        "2026-06-10T00:00:20.000Z",
        2,
      );
      // Usage never belongs in a fork's inherited history; if a copy existed, neither its
      // projection row nor its event may count.
      yield* insertActivity(
        sql,
        inherited("ctx-source"),
        "fork",
        "turn-source",
        "context-window.updated",
        usage,
        "2026-06-10T00:00:20.000Z",
        2,
      );
      const inheritedEventActivity = {
        id: inherited("ctx-earlier"),
        turnId: "turn-earlier",
        sequence: 1,
        kind: "context-window.updated",
        createdAt: "2026-06-09T00:00:20.000Z",
        payload: JSON.parse(usage),
      };
      yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
        VALUES ('fork-usage-event','thread','fork',1,'thread.activity-appended',${inheritedEventActivity.createdAt},'system',${JSON.stringify({ threadId: "fork", activity: inheritedEventActivity })},'{}')`;

      const snapshot = yield* statistics.getStatistics();
      encodeSnapshot(snapshot);
      assert.equal(snapshot.totals.turns, 2);
      assert.equal(snapshot.totals.activeMs, 90_000);
      assert.equal(snapshot.totals.toolUses, 2);
      assert.equal(snapshot.totals.filesChanged, 1);
      assert.equal(snapshot.totals.totalTokens, 600);
      assert.equal(snapshot.totals.inputTokens, 400);
      // The source's day holds the source's work once; the fork's day holds the fork's.
      const day = (date: string) => snapshot.dailyBuckets.find((bucket) => bucket.date === date);
      assert.include(day("2026-06-10"), { turns: 1, toolUses: 1, activeMs: 60_000 });
      assert.include(day("2026-06-12"), { turns: 1, toolUses: 1, activeMs: 30_000 });
      assert.isUndefined(day("2026-06-09"));

      // The inherited-item filters are residual: usage history still reads through its index.
      const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const capture: SqlStatement.Transformer = (statement) =>
        Effect.sync(() => {
          const compiled = statement.compile();
          // The token-activity read: the only statement over activity events.
          if (compiled[0].includes("event_type = 'thread.activity-appended'")) {
            statements.push(compiled);
          }
          return statement;
        });
      // Inside a transaction the snapshot cache is bypassed, so the queries run again.
      yield* statistics
        .getStatistics()
        .pipe(sql.withTransaction, Effect.provideService(SqlStatement.CurrentTransformer, capture));
      assert.lengthOf(statements, 1);
      const [statement, params] = statements[0]!;
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement}`, params);
      assert.ok(
        plan.some((row) => row.detail.includes("idx_orch_events_statistics_usage")),
        JSON.stringify(plan),
      );
    }),
  );
});

/** A file database with the production persistence layer (read worker included). */
const withFileDatabase = <A, E>(
  body: (filename: string) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "ryco-statistics-persisted-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    return yield* body(join(directory, "state.sqlite"));
  }).pipe(Effect.scoped);

const fileStatistics = (filename: string) =>
  StatisticsQueryLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(filename)),
    Layer.provide(NodeServices.layer),
  );

const seedTwoThreads = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* insertProject(sql, "persist-project", "Persisted");
    for (const threadId of ["persist-a", "persist-b"]) {
      yield* insertThread(
        sql,
        threadId,
        "persist-project",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      yield* insertContextEvent(
        sql,
        `${threadId}-1`,
        threadId,
        "turn-1",
        "2026-06-10T00:00:01.000Z",
        {
          lastInputTokens: 50,
          lastOutputTokens: 5,
          lastUsedTokens: 55,
        },
      );
      yield* insertTurn(
        sql,
        threadId,
        "turn-1",
        1,
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:00:30.000Z",
        '[{"path":"a.ts","kind":"modified","additions":3,"deletions":1}]',
      );
    }
    yield* markProjected(sql);
  });

describe("persisted statistics partials", () => {
  it.effect("restarts incrementally from the partials the previous process persisted", () =>
    withFileDatabase((filename) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedTwoThreads(sql);
          const first = yield* (yield* StatisticsQuery).getStatistics();
          assert.equal(first.totals.totalTokens, 110);
          assert.equal(first.totals.additions, 6);
          const [persisted] = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM statistics_thread_partials
          `;
          assert.equal(persisted?.count, 2);
        }).pipe(Effect.provide(fileStatistics(filename)));

        // A new process (fresh layer). Production writes thread rows only together with an
        // event; this bypassing write shows thread B's partial was restored, not re-read.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projection_turns SET checkpoint_files_json = '[]' WHERE thread_id = 'persist-b'`;
          yield* insertContextEvent(
            sql,
            "persist-a-2",
            "persist-a",
            "turn-2",
            "2026-06-10T00:00:02.000Z",
            {
              lastInputTokens: 10,
              lastOutputTokens: 1,
              lastUsedTokens: 11,
            },
          );
          yield* markProjected(sql);
          const restarted = yield* (yield* StatisticsQuery).getStatistics();
          assert.equal(restarted.totals.totalTokens, 121);
          assert.equal(restarted.totals.additions, 6);
          assert.equal((yield* recompute(sql, yield* StatisticsQuery)).totals.additions, 3);
        }).pipe(Effect.provide(fileStatistics(filename)));
      }),
    ),
  );

  it.effect("drops persisted partials written under another format or schema", () =>
    withFileDatabase((filename) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedTwoThreads(sql);
          yield* (yield* StatisticsQuery).getStatistics();
          yield* sql`UPDATE projection_turns SET checkpoint_files_json = '[]' WHERE thread_id = 'persist-b'`;
          yield* sql`UPDATE statistics_partials_state SET format_version = format_version + 1`;
        }).pipe(Effect.provide(fileStatistics(filename)));

        yield* Effect.gen(function* () {
          const snapshot = yield* (yield* StatisticsQuery).getStatistics();
          // Everything recomputed: thread B's emptied files are visible.
          assert.equal(snapshot.totals.additions, 3);
          const sql = yield* SqlClient.SqlClient;
          const [state] = yield* sql<{ readonly formatVersion: number }>`
            SELECT format_version AS "formatVersion" FROM statistics_partials_state
          `;
          assert.equal(state?.formatVersion, STATISTICS_PARTIAL_FORMAT_VERSION);
        }).pipe(Effect.provide(fileStatistics(filename)));
      }),
    ),
  );

  it.effect("reads statistics rows on the worker connection with identical results", () =>
    withFileDatabase((filename) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const reader = yield* SqliteReadClient;
        assert.notStrictEqual(reader, sql);
        yield* seedTwoThreads(sql);
        const before = (
          reader as unknown as { readWorkerStats: () => { workerStatements: number } }
        ).readWorkerStats().workerStatements;
        const snapshot = yield* (yield* StatisticsQuery).getStatistics();
        const after = (
          reader as unknown as { readWorkerStats: () => { workerStatements: number } }
        ).readWorkerStats().workerStatements;
        assert.isAbove(after, before);
        assert.deepEqual(
          withoutGeneratedAt(snapshot),
          withoutGeneratedAt(yield* recompute(sql, yield* StatisticsQuery)),
        );
      }).pipe(Effect.provide(fileStatistics(filename))),
    ),
  );
});

it.live("answers with the previous snapshot while a slow refresh runs, then refreshes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statistics = yield* StatisticsQuery;
    yield* clean(sql);
    yield* insertProject(sql, "swr-project", "Before");
    yield* insertThread(
      sql,
      "swr-thread",
      "swr-project",
      "codex",
      "gpt-5.4",
      "2026-06-10T00:00:00.000Z",
    );
    const previous = yield* statistics.getStatistics();
    yield* sql`UPDATE projection_projects SET title = 'After' WHERE project_id = 'swr-project'`;

    // Hold the only connection, so the refresh cannot read its revision.
    const release = yield* Deferred.make<void>();
    const holding = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      sql.withTransaction(
        Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(holding);
    const stale = yield* statistics.getStatistics({ maxWaitMs: 20 });
    assert.strictEqual(stale, previous);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);

    // The background refresh completes; the next answer is current.
    const fresh = yield* statistics.getStatistics({ maxWaitMs: 5_000 });
    assert.equal(fresh.projects[0]?.title, "After");
  }).pipe(Effect.provide(StatisticsQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

statisticsLayer("statistics stale-while-revalidate", (it) => {
  it.effect("waits for the first snapshot when there is none to serve", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* clean(sql);
      yield* insertProject(sql, "swr-first", "First");
      yield* insertThread(
        sql,
        "swr-first-thread",
        "swr-first",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      // A fresh service instance has no snapshot yet.
      const snapshot = yield* Effect.scoped(
        Effect.flatMap(makeStatisticsQuery, (statistics) =>
          statistics.getStatistics({ maxWaitMs: 0 }),
        ),
      );
      assert.equal(snapshot.projects[0]?.title, "First");
    }),
  );
});

it.live("never keeps serving a background refresh that already finished", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* clean(sql);
    yield* insertProject(sql, "swr-latch", "Initial");
    yield* insertThread(
      sql,
      "swr-latch-thread",
      "swr-latch",
      "codex",
      "gpt-5.4",
      "2026-06-10T00:00:00.000Z",
    );
    const statistics = yield* makeStatisticsQuery;
    yield* statistics.getStatistics();
    // A cache-hit refresh can finish before its forking fiber resumes when the
    // op budget runs out right after the fork. Sweep the ops spent before the
    // call across a whole budget so that boundary is hit, then check that new
    // data still reaches callers. The budget must stay large enough for the
    // forked cache-hit refresh to finish without yielding itself.
    const budget = 256;
    for (let preceding = 0; preceding <= budget + 32; preceding++) {
      const title = `Title ${preceding}`;
      let padding: Effect.Effect<void> = Effect.yieldNow;
      for (let op = 0; op < preceding; op++) padding = Effect.andThen(padding, Effect.void);
      yield* padding.pipe(
        Effect.andThen(statistics.getStatistics({ maxWaitMs: 5_000 })),
        Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
      );
      yield* sql`UPDATE projection_projects SET title = ${title} WHERE project_id = 'swr-latch'`;
      const fresh = yield* statistics.getStatistics({ maxWaitMs: 5_000 });
      assert.equal(fresh.projects[0]?.title, title, `${preceding} preceding ops`);
    }
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
);

statisticsLayer("statistics checkpoint file totals", (it) => {
  it.effect("sums files in SQL like the former JS parse, tolerating malformed rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "files-project", "Files");
      yield* insertThread(
        sql,
        "files-thread",
        "files-project",
        "codex",
        "gpt-5.4",
        "2026-06-10T00:00:00.000Z",
      );
      const files: ReadonlyArray<string> = [
        '[{"path":"a.ts","kind":"modified","additions":3,"deletions":1},{"path":"b.ts","kind":"added","additions":"7","deletions":2.5}]',
        "not json",
        '{"path":"x.ts"}',
        '[null, 4, {"additions":1}]',
        "[]",
      ];
      for (const [index, json] of files.entries()) {
        yield* insertTurn(
          sql,
          "files-thread",
          `turn-${index}`,
          index + 1,
          "2026-06-10T00:00:00.000Z",
          "2026-06-10T00:00:30.000Z",
          json,
        );
      }
      const snapshot = yield* statistics.getStatistics();
      // 2 + 0 + 0 + 3 + 0 files; numeric additions/deletions only.
      assert.equal(snapshot.totals.filesChanged, 5);
      assert.equal(snapshot.totals.additions, 4);
      assert.equal(snapshot.totals.deletions, 3.5);
    }),
  );
});

const insertActivityEvent = (
  sql: SqlClient.SqlClient,
  input: {
    readonly eventId: string;
    readonly threadId: string;
    readonly activityId: string;
    readonly kind: string;
    readonly turnId: string;
    readonly createdAt: string;
    readonly payload: object;
  },
) =>
  sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      actor_kind, payload_json, metadata_json
    ) VALUES (
      ${input.eventId}, 'thread', ${input.threadId},
      (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${input.threadId}),
      'thread.activity-appended', ${input.createdAt}, 'system',
      ${JSON.stringify({
        threadId: input.threadId,
        activity: {
          id: input.activityId,
          turnId: input.turnId,
          kind: input.kind,
          createdAt: input.createdAt,
          payload: input.payload,
        },
      })},
      '{}'
    )
  `;

statisticsLayer("statistics after event-log compaction", (it) => {
  it.effect("are unchanged: every context-window sample stays in the log", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statistics = yield* StatisticsQuery;
      yield* clean(sql);
      yield* insertProject(sql, "compact-project", "Compaction");
      yield* insertThread(
        sql,
        "compact-thread",
        "compact-project",
        "claudeAgent",
        "claude-opus-5-5",
        "2026-06-10T00:00:00.000Z",
      );
      let serial = 0;
      for (const [turnIndex, turnId] of ["turn-c1", "turn-c2", "turn-c3"].entries()) {
        for (let sample = 0; sample < 4; sample += 1) {
          serial += 1;
          const createdAt = `2026-06-1${turnIndex}T00:00:0${sample}.000Z`;
          // Claude's gauge reuses one activity id for every sample.
          yield* insertActivityEvent(sql, {
            eventId: `compact-usage-${serial}`,
            threadId: "compact-thread",
            activityId: "claude-context-usage:compact-thread",
            kind: "context-window.updated",
            turnId,
            createdAt,
            payload: {
              usedTokens: 1000 * (sample + 1),
              lastInputTokens: 100 * (sample + 1),
              lastOutputTokens: 10 * (sample + 1),
              lastUsedTokens: 110 * (sample + 1),
            },
          });
          yield* insertActivityEvent(sql, {
            eventId: `compact-progress-${serial}`,
            threadId: "compact-thread",
            activityId: "task-progress:compact-thread:task-1",
            kind: "task.progress",
            turnId,
            createdAt,
            payload: { taskId: "task-1", summary: `step ${serial}` },
          });
        }
        yield* insertTurn(
          sql,
          "compact-thread",
          turnId,
          turnIndex + 1,
          `2026-06-1${turnIndex}T00:00:00.000Z`,
          `2026-06-1${turnIndex}T00:01:00.000Z`,
          '[{"path":"a.ts","kind":"modified","additions":2,"deletions":1}]',
        );
      }
      yield* markProjected(sql);
      const before = yield* recompute(sql, statistics);
      const cached = yield* statistics.getStatistics();
      assert.isAbove(before.totals.totalTokens, 0);

      const compaction = yield* makeEventLogCompaction;
      const pass = yield* compaction.runPass({
        ...ONLINE_COMPACTION_PASS_OPTIONS,
        horizon: "head",
        interBatchPauseMs: 0,
        idleRatio: 0,
        receipts: null,
      });
      assert.equal(pass.deletedEvents, 11);
      const [usage] = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM orchestration_events
        WHERE json_extract(payload_json, '$.activity.kind') = 'context-window.updated'
      `;
      assert.equal(usage?.count, 12);

      assert.deepEqual(
        withoutGeneratedAt(yield* recompute(sql, statistics)),
        withoutGeneratedAt(before),
      );
      assert.deepEqual(
        withoutGeneratedAt(yield* statistics.getStatistics()),
        withoutGeneratedAt(cached),
      );
    }),
  );
});
