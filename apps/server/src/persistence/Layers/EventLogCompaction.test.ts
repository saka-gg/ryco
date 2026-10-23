import { CommandId, EventId, ThreadId } from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  claudeContextUsageActivityId,
  reasoningActivityId,
  taskProgressActivityId,
  toolProgressActivityId,
} from "@ryco/shared/latestStateActivities";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";
import {
  EventLogCompaction,
  type EventLogCompactionPassOptions,
} from "../Services/EventLogCompaction.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import {
  compactionWindowQuery,
  EventLogCompactionLive,
  firstEventFromQuery,
  isPrunableReceiptCommandId,
  ONLINE_COMPACTION_PASS_OPTIONS,
  receiptPageQuery,
} from "./EventLogCompaction.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

/** A fresh database per test: sequences start at 1 and no state is stored. */
const TestLayer = Layer.mergeAll(
  EventLogCompactionLive,
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");
const OLD = "2026-10-01T00:00:00.000Z";
const RECENT = "2026-10-20T06:00:00.000Z";

const TEST_PASS: EventLogCompactionPassOptions = {
  ...ONLINE_COMPACTION_PASS_OPTIONS,
  interBatchPauseMs: 0,
  idleRatio: 0,
  receipts: null,
};

let serial = 0;
const appendActivity = (input: {
  readonly threadId: string;
  readonly id: string;
  readonly kind: string;
  readonly occurredAt?: string;
  readonly payload?: unknown;
}) =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    serial += 1;
    const threadId = ThreadId.make(input.threadId);
    const occurredAt = input.occurredAt ?? OLD;
    const event = yield* store.append({
      type: "thread.activity-appended",
      eventId: EventId.make(`evt-compaction-${serial}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        activity: {
          id: EventId.make(input.id),
          tone: "info",
          kind: input.kind,
          summary: `${input.kind} ${serial}`,
          payload: input.payload ?? { tick: serial },
          turnId: null,
          createdAt: occurredAt,
        },
      },
    });
    return event.sequence;
  });

const remainingSequences = (from: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM orchestration_events WHERE sequence >= ${from} ORDER BY sequence
    `;
    return rows.map((row) => row.sequence);
  });

const compactionTest = <E>(
  name: string,
  body: () => Effect.Effect<void, E, Layer.Success<typeof TestLayer>>,
) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* body();
    }).pipe(Effect.provide(TestLayer)),
  );

describe("EventLogCompaction", () => {
  compactionTest("removes only superseded settled versions and keeps the newest of each key", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const thread = "thread-compaction-a";
      const task = taskProgressActivityId(thread, "task-1");
      const tool = toolProgressActivityId(thread, "task-1");
      const reasoning = reasoningActivityId(thread, "turn-1", "0");
      const gauge = claudeContextUsageActivityId(thread);
      const s1 = yield* appendActivity({ threadId: thread, id: task, kind: "task.progress" });
      const s2 = yield* appendActivity({
        threadId: thread,
        id: gauge,
        kind: "context-window.updated",
      });
      const s3 = yield* appendActivity({ threadId: thread, id: task, kind: "task.progress" });
      const s4 = yield* appendActivity({ threadId: thread, id: tool, kind: "tool.progress" });
      const s5 = yield* appendActivity({
        threadId: thread,
        id: gauge,
        kind: "context-window.updated",
      });
      const s6 = yield* appendActivity({ threadId: thread, id: reasoning, kind: "reasoning" });
      const s7 = yield* appendActivity({ threadId: thread, id: tool, kind: "tool.progress" });
      const s8 = yield* appendActivity({ threadId: thread, id: reasoning, kind: "reasoning" });
      // Settled, but its newer version is not: it stays until that version settles.
      const s9 = yield* appendActivity({ threadId: thread, id: task, kind: "task.progress" });
      const s10 = yield* appendActivity({
        threadId: thread,
        id: task,
        kind: "task.progress",
        occurredAt: RECENT,
      });

      const result = yield* compaction.runPass(TEST_PASS);
      assert.equal(result.deletedEvents, 4);
      assert.equal(result.horizonSequence, s9);
      assert.equal(result.backlogSequences, 0);
      assert.deepEqual(yield* remainingSequences(s1), [s2, s5, s7, s8, s9, s10]);
      assert.notInclude(yield* remainingSequences(s1), s3);
      assert.notInclude(yield* remainingSequences(s1), s4);
      assert.notInclude(yield* remainingSequences(s1), s6);

      // A day later the newest version has settled. The next pass resumes from its cursor with
      // an empty carry, so the version it kept last time (s9) stays: the documented bound of one
      // stale version per key and pass boundary.
      yield* TestClock.adjust(DAY_MS);
      const next = yield* compaction.runPass(TEST_PASS);
      assert.equal(next.startSequence, s9);
      assert.equal(next.deletedEvents, 0);
      const state = yield* compaction.readState("delete");
      assert.equal(state.compactedThroughSequence, s10);
      assert.equal(state.totals.deletedEvents, 4);
      assert.isNotNull(state.lastPassCompletedAt);

      // An offline pass from the beginning over the whole log removes it.
      const offline = yield* compaction.runPass({
        ...TEST_PASS,
        horizon: "head",
        fromBeginning: true,
        carryCapacity: Number.POSITIVE_INFINITY,
      });
      assert.equal(offline.deletedEvents, 1);
      assert.deepEqual(yield* remainingSequences(s1), [s2, s5, s7, s8, s10]);
    }),
  );

  compactionTest("never removes a recent event, whatever the order of timestamps", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const thread = "thread-compaction-clock";
      const task = taskProgressActivityId(thread, "task-1");
      const s1 = yield* appendActivity({ threadId: thread, id: task, kind: "task.progress" });
      // A clock that jumped ahead, and one timestamp that does not parse: both count as recent.
      const s2 = yield* appendActivity({
        threadId: thread,
        id: task,
        kind: "task.progress",
        occurredAt: RECENT,
      });
      const s3 = yield* appendActivity({
        threadId: thread,
        id: task,
        kind: "task.progress",
        occurredAt: "not a timestamp",
      });
      const settled: Array<number> = [];
      for (let index = 0; index < 7; index += 1) {
        settled.push(yield* appendActivity({ threadId: thread, id: task, kind: "task.progress" }));
      }
      const last = settled.at(-1)!;

      // The binary search lands past the two recent rows; selection still leaves them alone.
      const result = yield* compaction.runPass({ ...TEST_PASS, selectionPageSequences: 2 });
      assert.equal(result.horizonSequence, last);
      assert.deepEqual(yield* remainingSequences(s1), [s2, s3, last]);
    }),
  );

  compactionTest("stops at the scan budget and resumes from the stored cursor", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const thread = "thread-compaction-budget";
      const ids = [0, 1, 2].map((index) => taskProgressActivityId(thread, `task-${index}`));
      const first = yield* appendActivity({ threadId: thread, id: ids[0]!, kind: "task.progress" });
      for (let index = 1; index < 60; index += 1) {
        yield* appendActivity({ threadId: thread, id: ids[index % 3]!, kind: "task.progress" });
      }
      const budget = {
        ...TEST_PASS,
        maxScanSequences: 20,
        selectionPageSequences: 7,
        receipts: ONLINE_COMPACTION_PASS_OPTIONS.receipts,
      };
      const partial = yield* compaction.runPass(budget);
      assert.equal(first, 1);
      assert.equal(partial.stopReason, "scan-budget");
      assert.equal(partial.scannedSequences, 20);
      assert.equal(partial.compactedThroughSequence, 20);
      assert.equal(partial.backlogSequences, 40);
      // Receipts wait for the events to catch up, and say so.
      assert.isTrue(partial.receiptBacklog);
      const stored = yield* compaction.readState("delete");
      assert.equal(stored.compactedThroughSequence, 20);
      assert.isTrue(stored.lastPass?.receiptBacklog);

      let passes = 1;
      let last = partial;
      while ((last = yield* compaction.runPass(budget)).stopReason !== "complete") passes += 1;
      assert.isAtLeast(passes, 2);
      assert.isFalse(last.receiptBacklog);
      const remaining = yield* remainingSequences(first);
      // Each later pass starts with an empty carry: at most one stale version per key per pass
      // boundary stays, never more, and the newest version of every key does.
      assert.includeMembers(remaining, [first + 57, first + 58, first + 59]);
      assert.isAtMost(remaining.length, 3 + 3 * passes);
    }),
  );

  compactionTest("keeps its cursor at the last committed window when a delete fails", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const sql = yield* SqlClient.SqlClient;
      const thread = "thread-compaction-failure";
      const id = taskProgressActivityId(thread, "task-1");
      const sequences: Array<number> = [];
      for (let index = 0; index < 12; index += 1) {
        sequences.push(yield* appendActivity({ threadId: thread, id, kind: "task.progress" }));
      }
      const doomed = sequences[6]!;
      yield* sql.unsafe(`
        CREATE TRIGGER compaction_test_trigger BEFORE DELETE ON orchestration_events
        WHEN old.sequence = ${doomed}
        BEGIN SELECT RAISE(ABORT, 'simulated failure'); END
      `);
      const options = { ...TEST_PASS, selectionPageSequences: 4 };
      const failed = yield* compaction.runPass(options).pipe(Effect.flip);
      assert.equal(failed._tag, "PersistenceSqlError");
      // The first window (4 sequences) committed; the second rolled back.
      const state = yield* compaction.readState("delete");
      assert.equal(sequences[0], 1);
      assert.equal(state.compactedThroughSequence, 4);
      assert.include(yield* remainingSequences(sequences[0]!), sequences[4]!);

      yield* sql`DROP TRIGGER compaction_test_trigger`;
      yield* compaction.runPass(options);
      // Converged: only the newest version and at most the one the empty carry left behind.
      const remaining = yield* remainingSequences(sequences[0]!);
      assert.include(remaining, sequences[11]!);
      assert.isAtMost(remaining.length, 3);
    }),
  );

  compactionTest("skips a batch whose survivor disappeared, with a warning", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const sql = yield* SqlClient.SqlClient;
      const thread = "thread-compaction-survivor";
      const a = taskProgressActivityId(thread, "a");
      const b = taskProgressActivityId(thread, "b");
      const s1 = yield* appendActivity({ threadId: thread, id: a, kind: "task.progress" });
      const s2 = yield* appendActivity({ threadId: thread, id: b, kind: "task.progress" });
      const s3 = yield* appendActivity({ threadId: thread, id: a, kind: "task.progress" });
      const s4 = yield* appendActivity({ threadId: thread, id: b, kind: "task.progress" });
      // Deleting s1 removes s4 behind the pass's back: s2's survivor is gone when its turn comes.
      yield* sql.unsafe(`
        CREATE TRIGGER compaction_test_trigger AFTER DELETE ON orchestration_events
        WHEN old.sequence = ${s1}
        BEGIN DELETE FROM orchestration_events WHERE sequence = ${s4}; END
      `);
      const result = yield* compaction.runPass({
        ...TEST_PASS,
        deleteBatch: { initial: 1, min: 1, max: 1, targetMs: 8 },
      });
      assert.equal(result.skippedBatches, 1);
      assert.deepEqual(yield* remainingSequences(s1), [s2, s3]);
    }),
  );

  compactionTest("counts only the events a batch actually removed", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const sql = yield* SqlClient.SqlClient;
      const thread = "thread-compaction-accounting";
      const id = taskProgressActivityId(thread, "a");
      const s1 = yield* appendActivity({ threadId: thread, id, kind: "task.progress" });
      const s2 = yield* appendActivity({
        threadId: thread,
        id,
        kind: "task.progress",
        payload: { text: "x".repeat(4_000) },
      });
      const s3 = yield* appendActivity({ threadId: thread, id, kind: "task.progress" });
      const dry = yield* compaction.runPass({ ...TEST_PASS, mode: "dry-run" });
      assert.equal(dry.deletedEvents, 2);
      // Deleting s1 removes s2 behind the pass's back; its survivor s3 stays, so the batch runs.
      yield* sql.unsafe(`
        CREATE TRIGGER compaction_test_trigger AFTER DELETE ON orchestration_events
        WHEN old.sequence = ${s1}
        BEGIN DELETE FROM orchestration_events WHERE sequence = ${s2}; END
      `);
      const result = yield* compaction.runPass(TEST_PASS);
      assert.equal(result.skippedBatches, 0);
      assert.equal(result.deletedEvents, 1);
      assert.isBelow(result.deletedBytes, dry.deletedBytes / 2);
      assert.deepEqual(yield* remainingSequences(s1), [s3]);
    }),
  );

  compactionTest("dry runs count what a deleting pass removes, without moving its cursor", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const thread = "thread-compaction-dry";
      const first = yield* appendActivity({
        threadId: thread,
        id: taskProgressActivityId(thread, "x"),
        kind: "task.progress",
      });
      for (let index = 1; index < 40; index += 1) {
        yield* appendActivity({
          threadId: thread,
          id: taskProgressActivityId(thread, `task-${index % 4}`),
          kind: index % 5 === 0 ? "context-window.updated" : "task.progress",
        });
      }
      const before = yield* remainingSequences(first);
      const dry = yield* compaction.runPass({ ...TEST_PASS, mode: "dry-run" });
      assert.isAbove(dry.deletedEvents, 0);
      assert.deepEqual(yield* remainingSequences(first), before);
      // Repeated dry runs pick up where they stopped, under their own state.
      assert.equal((yield* compaction.readState("dry-run")).compactedThroughSequence, first + 39);
      assert.equal((yield* compaction.readState("delete")).compactedThroughSequence, 0);
      assert.equal(
        (yield* compaction.runPass({ ...TEST_PASS, mode: "dry-run" })).scannedSequences,
        0,
      );

      // Switching to deleting starts from the beginning and removes what the dry run counted.
      const real = yield* compaction.runPass(TEST_PASS);
      assert.equal(real.deletedEvents, dry.deletedEvents);
      assert.equal(real.deletedBytes, dry.deletedBytes);
      assert.equal((yield* remainingSequences(first)).length, before.length - dry.deletedEvents);

      // A pass that may not write (a read-only connection) leaves every state alone.
      const stateBefore = yield* compaction.readState("delete");
      yield* compaction.runPass({ ...TEST_PASS, persistState: false, fromBeginning: true });
      assert.deepEqual(yield* compaction.readState("delete"), stateBefore);
    }),
  );

  compactionTest("prunes only old receipts of per-emission ids and never strands its cursor", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const sql = yield* SqlClient.SqlClient;
      const receipts = yield* OrchestrationCommandReceiptRepository;
      const old = new Date(NOW_MS - 8 * DAY_MS).toISOString();
      const fresh = new Date(NOW_MS - DAY_MS).toISOString();
      const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
      const uuid2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
      const hex64 = "a".repeat(64);
      const insert = (commandId: string, acceptedAt: string) =>
        receipts.upsert({
          commandId: CommandId.make(commandId),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-receipts"),
          acceptedAt,
          resultSequence: 1,
          status: "accepted",
          error: null,
        });
      const oldPrunable = [`provider:${uuid}:thread-activity-append:x`, `history:${uuid}`];
      const kept = [
        `provider:${hex64}:thread-activity-append`,
        // Clients mint bare UUIDs and may replay them from an outbox much later.
        "3b241101-e2bb-4255-8caf-4136c566a962",
        "thread-purge:thread-a:2026-09-01T00:00:00.000Z",
        "restart-continuation:thread-a:turn-1",
        "completion-return:batch-1",
        // Local task delegations read receipt absence as "never sent".
        "agent-control:operation-1:delegate",
        `history:${uuid}:extra`,
      ];
      // A kept id whose time is the command's own (here: ahead of the clock) never holds the
      // cursor back, since it is never pruned.
      const keptAhead = "thread-fork:thread-b";
      yield* insert(keptAhead, new Date(NOW_MS + 365 * DAY_MS).toISOString());
      for (const id of oldPrunable) yield* insert(id, old);
      for (const id of kept) yield* insert(id, old);
      yield* insert(`provider:${uuid2}:thread-activity-append:y`, fresh);
      // An old prunable receipt after a recent one: the cursor never passes the recent one.
      yield* insert(`history:${uuid2}`, old);

      // A scan budget smaller than the settled receipts leaves a backlog for the next pass.
      const budgeted = yield* compaction.runPass({
        ...TEST_PASS,
        receipts: { ...ONLINE_COMPACTION_PASS_OPTIONS.receipts!, pageRows: 1, maxScanRows: 1 },
        mode: "dry-run",
      });
      assert.isTrue(budgeted.receiptBacklog);

      const result = yield* compaction.runPass({
        ...TEST_PASS,
        receipts: ONLINE_COMPACTION_PASS_OPTIONS.receipts,
      });
      assert.equal(result.deletedReceipts, 2);
      assert.isFalse(result.receiptBacklog);
      const remaining = (yield* sql<{ readonly commandId: string }>`
        SELECT command_id AS "commandId" FROM orchestration_command_receipts ORDER BY rowid
      `).map((row) => row.commandId);
      assert.deepEqual(remaining, [
        keptAhead,
        ...kept,
        `provider:${uuid2}:thread-activity-append:y`,
        `history:${uuid2}`,
      ]);
      // Dedupe still answers from a kept receipt.
      const answer = yield* receipts.getByCommandId({
        commandId: CommandId.make("thread-purge:thread-a:2026-09-01T00:00:00.000Z"),
      });
      assert.isTrue(Option.isSome(answer));

      // Everything old: the newest rowids go as well, and the cursor follows the table down so
      // a reused rowid is still visited.
      yield* TestClock.adjust(30 * DAY_MS);
      yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id NOT LIKE 'provider:%' AND command_id NOT LIKE 'history:%'`;
      yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id LIKE 'provider:aaaa%' OR command_id LIKE 'history:%:extra'`;
      yield* compaction.runPass({
        ...TEST_PASS,
        receipts: ONLINE_COMPACTION_PASS_OPTIONS.receipts,
      });
      assert.equal((yield* compaction.readState("delete")).receiptRowidCursor, 0);
      yield* insert(`provider:${uuid}:reused`, old);
      const again = yield* compaction.runPass({
        ...TEST_PASS,
        receipts: ONLINE_COMPACTION_PASS_OPTIONS.receipts,
      });
      assert.equal(again.deletedReceipts, 1);
    }),
  );

  compactionTest("starts the receipt walk over when its cursor is past the table", () =>
    Effect.gen(function* () {
      const compaction = yield* EventLogCompaction;
      const sql = yield* SqlClient.SqlClient;
      const receipts = yield* OrchestrationCommandReceiptRepository;
      const old = new Date(NOW_MS - 8 * DAY_MS).toISOString();
      const insert = (commandId: string) =>
        receipts.upsert({
          commandId: CommandId.make(commandId),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-receipts"),
          acceptedAt: old,
          resultSequence: 1,
          status: "accepted",
          error: null,
        });
      for (let index = 0; index < 5; index += 1) yield* insert(`thread-fork:thread-${index}`);
      const options = { ...TEST_PASS, receipts: ONLINE_COMPACTION_PASS_OPTIONS.receipts };
      yield* compaction.runPass(options);
      assert.equal((yield* compaction.readState("delete")).receiptRowidCursor, 5);

      // The table is replaced behind the pass (a restored file, or a VACUUM renumbering rows).
      yield* sql`DELETE FROM orchestration_command_receipts`;
      yield* insert("provider:0f8fad5b-d9cb-469f-a165-70867728950e:thread-activity-append:x");
      const result = yield* compaction.runPass(options);
      assert.equal(result.deletedReceipts, 1);
      assert.isFalse(result.receiptBacklog);
    }),
  );

  it("classifies receipt command ids", () => {
    assert.isTrue(isPrunableReceiptCommandId("provider:0F8FAD5B-D9CB-469F-A165-70867728950E:x"));
    assert.isTrue(
      isPrunableReceiptCommandId("provider:0f8fad5b-d9cb-469f-a165-70867728950e:tool:usage"),
    );
    assert.isTrue(isPrunableReceiptCommandId("history:0f8fad5b-d9cb-469f-a165-70867728950e"));
    assert.isFalse(isPrunableReceiptCommandId("history:0f8fad5b-d9cb-469f-a165-70867728950e:x"));
    assert.isFalse(isPrunableReceiptCommandId("provider:0f8fad5b-d9cb-469f-a165-70867728950e"));
    assert.isFalse(isPrunableReceiptCommandId(`provider:${"b".repeat(64)}:subagent`));
    assert.isFalse(isPrunableReceiptCommandId("thread-fork:thread-a"));
    assert.isFalse(isPrunableReceiptCommandId("0f8fad5b-d9cb-469f-a165-70867728950e"));
  });

  compactionTest("reads windows, receipt pages and the horizon by the rowid alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const explain = (statement: {
        readonly compile: () => readonly [string, ReadonlyArray<unknown>];
      }) => {
        const [text, params] = statement.compile();
        return sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params);
      };
      const plans = [
        yield* explain(compactionWindowQuery(sql, 10, 2_010)),
        yield* explain(firstEventFromQuery(sql, 10, 2_010)),
      ];
      for (const plan of plans) {
        assert.isTrue(
          plan.some((row) =>
            row.detail.includes("USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)"),
          ),
          JSON.stringify(plan),
        );
        assert.isFalse(
          plan.some((row) => row.detail.includes("TEMP B-TREE")),
          JSON.stringify(plan),
        );
      }
      const receiptPlan = yield* explain(receiptPageQuery(sql, 10, 1_000));
      assert.isTrue(
        receiptPlan.some((row) => row.detail.includes("USING INTEGER PRIMARY KEY (rowid>?)")),
        JSON.stringify(receiptPlan),
      );
      assert.isFalse(
        receiptPlan.some((row) => row.detail.includes("TEMP B-TREE")),
        JSON.stringify(receiptPlan),
      );
    }),
  );
});
