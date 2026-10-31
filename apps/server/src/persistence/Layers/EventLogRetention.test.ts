import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { ORCHESTRATION_PROJECTOR_NAMES } from "../../orchestration/projectorNames.ts";
import {
  EventLogCompaction,
  type EventLogCompactionPassOptions,
} from "../Services/EventLogCompaction.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { readStatisticsThreadPartial } from "../../statistics/statisticsRows.ts";
import { makeEventLogCompaction, makeEventLogCompactionWith } from "./EventLogCompaction.ts";
import { ONLINE_COMPACTION_PASS_OPTIONS } from "./EventLogCompactionDeferred.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const TestLayer = Layer.mergeAll(
  Layer.effect(
    EventLogCompaction,
    makeEventLogCompactionWith({ readThreadUsage: readStatisticsThreadPartial }),
  ),
  OrchestrationEventStoreLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW_MS - daysAgo * DAY_MS).toISOString();

const PASS: EventLogCompactionPassOptions = {
  ...ONLINE_COMPACTION_PASS_OPTIONS,
  horizon: "head",
  interBatchPauseMs: 0,
  idleRatio: 0,
  receipts: null,
  retention: { ...ONLINE_COMPACTION_PASS_OPTIONS.retention!, deleteBatch: 3 },
};

let serial = 0;
const insertEvent = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly type: string;
    readonly occurredAt: string;
    readonly payload?: object;
  },
) =>
  Effect.gen(function* () {
    serial += 1;
    const [row] = yield* sql<{ readonly sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json
      ) VALUES (
        ${`evt-retention-${serial}`}, 'thread', ${input.threadId},
        (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${input.threadId}),
        ${input.type}, ${input.occurredAt}, 'system',
        ${JSON.stringify(input.payload ?? { threadId: input.threadId })}, '{}'
      )
      RETURNING sequence
    `;
    return Number(row!.sequence);
  });

const usageEvent = (sql: SqlClient.SqlClient, threadId: string, occurredAt: string) =>
  insertEvent(sql, {
    threadId,
    type: "thread.activity-appended",
    occurredAt,
    payload: {
      threadId,
      activity: {
        id: `usage-${serial}`,
        turnId: "turn-1",
        kind: "context-window.updated",
        createdAt: occurredAt,
        payload: { lastInputTokens: 10, lastOutputTokens: 5, lastUsedTokens: 15 },
      },
    },
  });

const insertThread = (
  sql: SqlClient.SqlClient,
  threadId: string,
  state: { readonly deletedAt?: string; readonly trashedAt?: string } = {},
) => sql`
  INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
    branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count,
    pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at, deleted_at,
    trashed_at
  ) VALUES (
    ${threadId}, 'project-1', ${threadId}, '{"provider":"codex","model":"gpt-5.4"}',
    'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0, ${iso(90)}, ${iso(90)},
    ${state.deletedAt ?? null}, ${state.trashedAt ?? null}
  )
`;

/** Every projector has applied `sequence` (the whole log by default). */
const markProjected = (sql: SqlClient.SqlClient, sequence = Number.MAX_SAFE_INTEGER) => sql`
  INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
  SELECT value, ${sequence}, ${iso(0)}
  FROM json_each(${JSON.stringify(Object.values(ORCHESTRATION_PROJECTOR_NAMES))})
  WHERE true
  ON CONFLICT (projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence
`;

const remaining = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ readonly sequence: number; readonly type: string }>`
    SELECT sequence, event_type AS type FROM orchestration_events
    WHERE stream_id = ${threadId} ORDER BY sequence
  `;

const floorOf = (sql: SqlClient.SqlClient, kind: string, streamId: string) =>
  sql<{ readonly floor: number }>`
    SELECT floor_sequence AS floor FROM orchestration_stream_floors
    WHERE aggregate_kind = ${kind} AND stream_id = ${streamId}
  `.pipe(Effect.map((rows) => rows[0]?.floor ?? 0));

/** A deleted thread: created, two turns of events, deleted `deletedDaysAgo` days ago. */
const deletedThread = (sql: SqlClient.SqlClient, threadId: string, deletedDaysAgo: number) =>
  Effect.gen(function* () {
    yield* insertThread(sql, threadId, { deletedAt: iso(deletedDaysAgo) });
    yield* insertEvent(sql, { threadId, type: "thread.created", occurredAt: iso(40) });
    yield* insertEvent(sql, { threadId, type: "thread.turn-start-requested", occurredAt: iso(39) });
    yield* insertEvent(sql, { threadId, type: "thread.message-sent", occurredAt: iso(39) });
    yield* usageEvent(sql, threadId, iso(39));
    yield* insertEvent(sql, { threadId, type: "thread.message-sent", occurredAt: iso(38) });
    return yield* insertEvent(sql, {
      threadId,
      type: "thread.deleted",
      occurredAt: iso(deletedDaysAgo),
    });
  });

const retentionTest = <E>(
  name: string,
  body: () => Effect.Effect<void, E, Layer.Success<typeof TestLayer>>,
) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* body();
    }).pipe(Effect.provide(TestLayer)),
  );

describe("EventLogRetention", () => {
  retentionTest(
    "removes a deleted thread's events below its deletion a week later, with its usage rolled up",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const compaction = yield* EventLogCompaction;
        const deletion = yield* deletedThread(sql, "thread-gone", 8);
        const recentDeletion = yield* deletedThread(sql, "thread-just-gone", 2);
        yield* markProjected(sql);

        const pass = yield* compaction.runPass(PASS);

        assert.deepEqual(yield* remaining(sql, "thread-gone"), [
          { sequence: deletion, type: "thread.deleted" },
        ]);
        assert.equal((yield* remaining(sql, "thread-just-gone")).length, 6);
        assert.equal(pass.retention?.deletedThreads, 1);
        assert.equal(pass.retention?.deletedEvents, 5);
        assert.equal(pass.retention?.rollups, 1);
        assert.equal(yield* floorOf(sql, "thread", "thread-gone"), deletion - 1);
        assert.equal(yield* floorOf(sql, "log", ""), deletion - 1);
        assert.equal(yield* floorOf(sql, "thread", "thread-just-gone"), 0);
        assert.isBelow(deletion, recentDeletion);

        const rollups = yield* sql<{ readonly threadId: string; readonly partialJson: string }>`
          SELECT thread_id AS "threadId", partial_json AS "partialJson"
          FROM statistics_usage_rollups
        `;
        assert.equal(rollups.length, 1);
        assert.equal(rollups[0]?.threadId, "thread-gone");
        const partial = JSON.parse(rollups[0]!.partialJson) as {
          buckets: Array<{ totalTokens: number }>;
        };
        assert.equal(
          partial.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
          15,
        );

        // A second pass has nothing left to do and never rolls up twice.
        const again = yield* compaction.runPass(PASS);
        assert.equal(again.retention?.deletedEvents, 0);
        assert.equal(again.retention?.rollups, 0);
      }),
  );

  retentionTest("keeps every deleted thread's events without a usage reader", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* deletedThread(sql, "thread-unreadable", 10);
      yield* markProjected(sql);

      const compaction = yield* makeEventLogCompaction;
      const pass = yield* compaction.runPass(PASS);

      assert.equal(pass.retention?.deletedEvents, 0);
      assert.equal((yield* remaining(sql, "thread-unreadable")).length, 6);
    }),
  );

  retentionTest("keeps a thread in Trash and a deleted thread that was created again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const compaction = yield* EventLogCompaction;
      yield* insertThread(sql, "thread-trash", { deletedAt: iso(20), trashedAt: iso(20) });
      yield* insertEvent(sql, {
        threadId: "thread-trash",
        type: "thread.created",
        occurredAt: iso(5),
      });
      yield* insertEvent(sql, {
        threadId: "thread-trash",
        type: "thread.trashed",
        occurredAt: iso(5),
      });
      // Deleted, then created again: its newest event is no deletion.
      yield* deletedThread(sql, "thread-again", 20);
      yield* insertEvent(sql, {
        threadId: "thread-again",
        type: "thread.created",
        occurredAt: iso(1),
      });
      yield* markProjected(sql);

      const pass = yield* compaction.runPass(PASS);

      assert.equal(pass.retention?.deletedEvents, 0);
      assert.equal((yield* remaining(sql, "thread-trash")).length, 2);
      assert.equal((yield* remaining(sql, "thread-again")).length, 7);
    }),
  );

  retentionTest(
    "trims a live thread's history older than 30 days before its latest turn, keeping anchors",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const compaction = yield* EventLogCompaction;
        const thread = "thread-live";
        yield* insertThread(sql, thread);
        const created = yield* insertEvent(sql, {
          threadId: thread,
          type: "thread.created",
          occurredAt: iso(60),
        });
        yield* insertEvent(sql, {
          threadId: thread,
          type: "thread.turn-start-requested",
          occurredAt: iso(60),
        });
        const oldMessage = yield* insertEvent(sql, {
          threadId: thread,
          type: "thread.message-sent",
          occurredAt: iso(59),
        });
        const usage = yield* usageEvent(sql, thread, iso(59));
        const lastOld = yield* insertEvent(sql, {
          threadId: thread,
          type: "thread.activity-appended",
          occurredAt: iso(45),
          payload: { threadId: thread, activity: { kind: "tool.completed" } },
        });
        // The latest turn started 40 days ago and stays whole, old or not.
        const latestTurn = yield* insertEvent(sql, {
          threadId: thread,
          type: "thread.turn-start-requested",
          occurredAt: iso(40),
        });
        const inLatestTurn = yield* insertEvent(sql, {
          threadId: thread,
          type: "thread.message-sent",
          occurredAt: iso(40),
        });
        yield* markProjected(sql);

        const pass = yield* compaction.runPass(PASS);

        assert.deepEqual(
          (yield* remaining(sql, thread)).map((row) => row.sequence),
          [created, usage, latestTurn, inLatestTurn],
        );
        assert.equal(pass.retention?.trimmedThreads, 1);
        assert.equal(pass.retention?.deletedEvents, 3);
        assert.equal(yield* floorOf(sql, "thread", thread), latestTurn - 1);
        assert.isAbove(lastOld, oldMessage);
      }),
  );

  retentionTest("keeps recent history and threads without a turn start", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const compaction = yield* EventLogCompaction;
      yield* insertThread(sql, "thread-recent");
      yield* insertEvent(sql, {
        threadId: "thread-recent",
        type: "thread.created",
        occurredAt: iso(10),
      });
      yield* insertEvent(sql, {
        threadId: "thread-recent",
        type: "thread.turn-start-requested",
        occurredAt: iso(10),
      });
      yield* insertEvent(sql, {
        threadId: "thread-recent",
        type: "thread.message-sent",
        occurredAt: iso(10),
      });
      yield* insertEvent(sql, {
        threadId: "thread-recent",
        type: "thread.turn-start-requested",
        occurredAt: iso(1),
      });
      yield* insertThread(sql, "thread-no-turn");
      yield* insertEvent(sql, {
        threadId: "thread-no-turn",
        type: "thread.created",
        occurredAt: iso(60),
      });
      yield* insertEvent(sql, {
        threadId: "thread-no-turn",
        type: "thread.meta-updated",
        occurredAt: iso(59),
      });
      yield* markProjected(sql);

      const pass = yield* compaction.runPass(PASS);

      assert.equal(pass.retention?.deletedEvents, 0);
      assert.equal(yield* floorOf(sql, "log", ""), 0);
    }),
  );

  retentionTest(
    "never removes what an open intent, a lagging projector or a held thread needs",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const compaction = yield* EventLogCompaction;
        yield* deletedThread(sql, "thread-child", 10);
        yield* deletedThread(sql, "thread-continued", 10);
        const gone = yield* deletedThread(sql, "thread-intent", 10);
        // An open provider intent recorded at the second event of thread-intent's stream.
        yield* sql`
        INSERT INTO provider_effect_intents (sequence, event_id, thread_id, kind, recorded_at)
        VALUES (${gone - 4}, 'evt-intent', 'thread-other', 'turn-start', ${iso(10)})
      `;
        yield* sql`
        INSERT INTO agent_control_completion_returns (
          child_thread_id, proposal_id, status, revision, next_check_at, record_json
        ) VALUES ('thread-child', 'proposal-1', 'waiting', 0, ${iso(0)}, '{}')
      `;
        yield* sql`
        INSERT INTO restart_continuations (
          thread_id, source_turn_id, kind, status, captured_at, last_observed_at, record_json
        ) VALUES ('thread-continued', 'turn-1', 'in-flight', 'pending', ${iso(1)}, ${iso(1)}, '{}')
      `;
        yield* markProjected(sql);

        const pass = yield* compaction.runPass(PASS);

        // Only the event below the intent goes; the held threads keep everything.
        assert.equal(pass.retention?.deletedEvents, 1);
        assert.equal((yield* remaining(sql, "thread-intent")).length, 5);
        assert.equal((yield* remaining(sql, "thread-child")).length, 6);
        assert.equal((yield* remaining(sql, "thread-continued")).length, 6);

        // Without every projector's cursor, nothing goes at all.
        yield* sql`DELETE FROM provider_effect_intents`;
        yield* sql`DELETE FROM projection_state WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.worktrees}`;
        const lagging = yield* compaction.runPass(PASS);
        assert.equal(lagging.retention?.deletedEvents, 0);
      }),
  );

  retentionTest("counts without removing in a dry run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const compaction = yield* EventLogCompaction;
      yield* deletedThread(sql, "thread-dry", 10);
      yield* markProjected(sql);

      const pass = yield* compaction.runPass({ ...PASS, mode: "dry-run" });

      assert.equal(pass.retention?.deletedEvents, 5);
      assert.equal((yield* remaining(sql, "thread-dry")).length, 6);
      assert.equal(yield* floorOf(sql, "log", ""), 0);
      const [rollups] = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM statistics_usage_rollups
      `;
      assert.equal(rollups?.count, 0);
    }),
  );

  retentionTest("stops at its event budget and reports the backlog", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const compaction = yield* EventLogCompaction;
      yield* deletedThread(sql, "thread-budget-a", 10);
      yield* deletedThread(sql, "thread-budget-b", 10);
      yield* markProjected(sql);

      const pass = yield* compaction.runPass({
        ...PASS,
        retention: { ...PASS.retention!, maxEventsPerPass: 4 },
      });

      assert.isTrue(pass.retention?.backlog);
      assert.isAtLeast(pass.retention!.deletedEvents, 4);
      const next = yield* compaction.runPass(PASS);
      assert.isFalse(next.retention?.backlog);
      assert.equal(pass.retention!.deletedEvents + next.retention!.deletedEvents, 10);
    }),
  );

  retentionTest("makes a resume below a floor take a snapshot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const compaction = yield* EventLogCompaction;
      const store = yield* OrchestrationEventStore;
      yield* insertThread(sql, "thread-other");
      const other = yield* insertEvent(sql, {
        threadId: "thread-other",
        type: "thread.created",
        occurredAt: iso(0),
      });
      const deletion = yield* deletedThread(sql, "thread-resume", 10);
      yield* markProjected(sql);
      const probe = (sequence: number, streamId?: string) =>
        store.probeResume!({
          sequence,
          limit: 1000,
          ...(streamId === undefined
            ? {}
            : { stream: { aggregateKind: "thread", streamId, limit: 1000 } }),
        }).pipe(Effect.map((result) => result.anchored));

      assert.isTrue(yield* probe(deletion - 3));
      yield* compaction.runPass(PASS);

      assert.isFalse(yield* probe(deletion - 3), "shell below the log floor");
      assert.isFalse(yield* probe(deletion - 3, "thread-resume"), "thread below its floor");
      assert.isTrue(yield* probe(deletion - 1), "shell at the floor");
      assert.isTrue(yield* probe(deletion - 3, "thread-other"), "another thread's own floor");
      assert.equal(
        yield* store.readReplayFloor!({ aggregateKind: "log", streamId: "" }),
        deletion - 1,
      );
      assert.isBelow(other, deletion);
    }),
  );

  it("is checked against every projector: a new one must seed from projections", () => {
    // Retention removes events every projector has applied. A projector added later starts at 0
    // and would replay a log with holes, so it must build its first state from existing
    // projections instead. Update this list once the new projector does.
    assert.deepEqual(Object.values(ORCHESTRATION_PROJECTOR_NAMES).toSorted(), [
      "projection.checkpoints",
      "projection.pending-approvals",
      "projection.projects",
      "projection.thread-activities",
      "projection.thread-command-watches",
      "projection.thread-follow-up-queues",
      "projection.thread-messages",
      "projection.thread-proposed-plans",
      "projection.thread-pull-request-watches",
      "projection.thread-sessions",
      "projection.thread-turns",
      "projection.threads",
      "projection.worktrees",
    ]);
  });
});
