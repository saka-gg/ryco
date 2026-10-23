// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";

import { PersistenceSqlError } from "../Errors.ts";
import {
  type CompactionLastPass,
  type CompactionPassResult,
  type CompactionState,
  EMPTY_COMPACTION_STATE,
  EventLogCompaction,
  type EventLogCompactionPassOptions,
} from "../Services/EventLogCompaction.ts";
import {
  DEFAULT_DATABASE_MAINTENANCE_OPTIONS,
  DEFAULT_FREE_PAGE_RECLAIM_OPTIONS,
  type EventCompactionSetting,
  firstPassDelayMs,
  makeDatabaseMaintenance,
  makeFreePageReclaim,
  parseEventCompactionSetting,
  reclaimFreePages,
} from "./DatabaseMaintenance.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START_MS = Date.parse("2026-10-20T12:00:00.000Z");

const passResult = (
  options: EventLogCompactionPassOptions,
  backlogSequences: number,
  receiptBacklog = false,
): CompactionPassResult => ({
  mode: options.mode,
  horizon: options.horizon,
  horizonSequence: 100,
  headSequence: 120,
  startSequence: 0,
  compactedThroughSequence: 100 - backlogSequences,
  backlogSequences,
  scannedSequences: 10,
  selectedEvents: 3,
  deletedEvents: options.mode === "delete" ? 3 : 0,
  deletedBytes: 300,
  skippedBatches: 0,
  scannedReceipts: 0,
  deletedReceipts: 0,
  receiptBacklog,
  durationMs: 5,
  mainThreadMs: 2,
  maxBatchMs: 1,
  batchDurationsMs: [1],
  receiptBatchDurationsMs: [],
  stopReason: backlogSequences > 0 ? "scan-budget" : "complete",
});

/**
 * Runs the scheduler against a fake compaction whose passes report `backlogs` in turn (the last
 * one repeats; `"fail"` / `"disk-full"` fail the pass), and returns the virtual times of passes.
 */
const runScheduler = (input: {
  readonly setting: EventCompactionSetting;
  readonly state?: CompactionState;
  readonly backlogs: ReadonlyArray<number | "receipts" | "fail" | "disk-full">;
  readonly forMs: number;
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START_MS);
    const calls: Array<{ readonly atMs: number; readonly mode: string }> = [];
    const compaction = EventLogCompaction.of({
      readState: () => Effect.succeed(input.state ?? EMPTY_COMPACTION_STATE),
      runPass: (options) =>
        Effect.gen(function* () {
          const atMs = (yield* Clock.currentTimeMillis) - START_MS;
          calls.push({ atMs, mode: options.mode });
          const outcome = input.backlogs[Math.min(calls.length, input.backlogs.length) - 1]!;
          if (outcome === "fail" || outcome === "disk-full") {
            return yield* new PersistenceSqlError({
              operation: "test",
              detail: outcome === "disk-full" ? "SQLITE_FULL: database or disk is full" : "boom",
            });
          }
          return outcome === "receipts"
            ? passResult(options, 0, true)
            : passResult(options, outcome);
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* makeDatabaseMaintenance({
          ...DEFAULT_DATABASE_MAINTENANCE_OPTIONS,
          setting: input.setting,
        }).pipe(Effect.provideService(EventLogCompaction, compaction));
        // Step in minutes so every due sleep wakes in order.
        yield* Effect.yieldNow;
        for (let elapsed = 0; elapsed < input.forMs; elapsed += MINUTE) {
          yield* TestClock.adjust(MINUTE);
          yield* Effect.yieldNow;
        }
      }),
    );
    return calls;
  });

const lastPass = (backlog: {
  readonly backlogSequences: number;
  readonly receiptBacklog: boolean;
}): CompactionLastPass => ({
  scannedSequences: 1,
  deletedEvents: 0,
  deletedBytes: 0,
  deletedReceipts: 0,
  maxBatchMs: 0,
  mainThreadMs: 0,
  durationMs: 0,
  horizon: 1,
  ...backlog,
});

describe("DatabaseMaintenance", () => {
  it("parses the kill switch", () => {
    assert.equal(parseEventCompactionSetting(undefined), "on");
    assert.equal(parseEventCompactionSetting("off"), "off");
    assert.equal(parseEventCompactionSetting(" OFF "), "off");
    assert.equal(parseEventCompactionSetting("0"), "off");
    assert.equal(parseEventCompactionSetting("dry-run"), "dry-run");
    assert.equal(parseEventCompactionSetting("on"), "on");
  });

  it.effect("waits for the startup delay, catches up every 2 minutes, then every 6 hours", () =>
    Effect.gen(function* () {
      const calls = yield* runScheduler({
        setting: "on",
        backlogs: [500, 200, 0],
        forMs: 13 * HOUR,
      });
      assert.deepEqual(
        calls.map((call) => call.atMs),
        [10 * MINUTE, 12 * MINUTE, 14 * MINUTE, 14 * MINUTE + 6 * HOUR, 14 * MINUTE + 12 * HOUR],
      );
      assert.isTrue(calls.every((call) => call.mode === "delete"));
    }),
  );

  it.effect("keeps the catch-up cadence while old receipts are still waiting", () =>
    Effect.gen(function* () {
      const calls = yield* runScheduler({
        setting: "on",
        backlogs: ["receipts", 0],
        forMs: HOUR,
      });
      assert.deepEqual(
        calls.map((call) => call.atMs),
        [10 * MINUTE, 12 * MINUTE],
      );
    }),
  );

  it.effect("after a restart, waits until the last pass is 6 hours old", () =>
    Effect.gen(function* () {
      const calls = yield* runScheduler({
        setting: "on",
        state: {
          ...EMPTY_COMPACTION_STATE,
          lastPassCompletedAt: new Date(START_MS - HOUR).toISOString(),
          lastPass: lastPass({ backlogSequences: 0, receiptBacklog: false }),
        },
        backlogs: [0],
        forMs: 6 * HOUR,
      });
      assert.deepEqual(
        calls.map((call) => call.atMs),
        [5 * HOUR],
      );
    }),
  );

  it.effect("after a restart, resumes the catch-up when old receipts were still waiting", () =>
    Effect.gen(function* () {
      const calls = yield* runScheduler({
        setting: "on",
        state: {
          ...EMPTY_COMPACTION_STATE,
          lastPassCompletedAt: new Date(START_MS - MINUTE).toISOString(),
          lastPass: lastPass({ backlogSequences: 0, receiptBacklog: true }),
        },
        backlogs: [0],
        forMs: HOUR,
      });
      assert.deepEqual(
        calls.map((call) => call.atMs),
        [10 * MINUTE],
      );
    }),
  );

  it.effect("never runs when switched off", () =>
    Effect.gen(function* () {
      const calls = yield* runScheduler({ setting: "off", backlogs: [0], forMs: 13 * HOUR });
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("only dry-runs when asked to", () =>
    Effect.gen(function* () {
      const calls = yield* runScheduler({ setting: "dry-run", backlogs: [0], forMs: HOUR });
      assert.deepEqual(calls, [{ atMs: 10 * MINUTE, mode: "dry-run" }]);
    }),
  );

  it.effect("backs off after failures, at least an hour when the disk is full", () =>
    Effect.gen(function* () {
      const calls = yield* runScheduler({
        setting: "on",
        backlogs: ["fail", "fail", "disk-full", 0],
        forMs: 3 * HOUR,
      });
      assert.deepEqual(
        calls.map((call) => call.atMs),
        [10 * MINUTE, 14 * MINUTE, 22 * MINUTE, 22 * MINUTE + HOUR],
      );
    }),
  );

  it("computes the first delay from the stored state", () => {
    const base = { nowMs: START_MS, startupDelayMs: 10 * MINUTE, idleIntervalMs: 6 * HOUR };
    const caughtUp = lastPass({ backlogSequences: 0, receiptBacklog: false });
    assert.equal(
      firstPassDelayMs({ ...base, lastPassCompletedAt: null, lastPass: null }),
      10 * MINUTE,
    );
    assert.equal(
      firstPassDelayMs({
        ...base,
        lastPassCompletedAt: new Date(START_MS - 10 * HOUR).toISOString(),
        lastPass: caughtUp,
      }),
      10 * MINUTE,
    );
    assert.equal(
      firstPassDelayMs({
        ...base,
        lastPassCompletedAt: new Date(START_MS - HOUR).toISOString(),
        lastPass: caughtUp,
      }),
      5 * HOUR,
    );
    for (const backlog of [
      { backlogSequences: 7, receiptBacklog: false },
      { backlogSequences: 0, receiptBacklog: true },
    ]) {
      assert.equal(
        firstPassDelayMs({
          ...base,
          lastPassCompletedAt: new Date(START_MS - HOUR).toISOString(),
          lastPass: lastPass(backlog),
        }),
        10 * MINUTE,
      );
    }
    assert.equal(
      firstPassDelayMs({ ...base, lastPassCompletedAt: "not a date", lastPass: caughtUp }),
      10 * MINUTE,
    );
  });
});

const freePages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  return Number(row?.freelist_count ?? 0);
});

/** Writes and deletes about `pages` pages of rows, which leaves them on the freelist. */
const leaveFreePages = (pages: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE reclaim_filler(id INTEGER PRIMARY KEY, body BLOB)`;
    // Roughly three 1,200-byte rows per 4 KiB page.
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${pages * 3})
      INSERT INTO reclaim_filler SELECT i, randomblob(1200) FROM n
    `;
    yield* sql`DELETE FROM reclaim_filler`;
    return yield* freePages;
  });

const withDatabase = <A, E>(
  kind: "incremental" | "none",
  test: Effect.Effect<A, E, SqlClient.SqlClient>,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-reclaim-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  // A new file through the persistence setup is incremental; a plain client leaves NONE.
  const layer =
    kind === "incremental"
      ? makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))
      : NodeSqliteClient.layer({ filename: dbPath });
  return test.pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
};

const TICK = { ...DEFAULT_FREE_PAGE_RECLAIM_OPTIONS, chunkPauseMs: 0, idleRatio: 0 };

describe("free-page reclaim", () => {
  it.live("returns at most 1,024 pages a tick, in chunks, down to the 256-page floor", () =>
    withDatabase(
      "incremental",
      Effect.gen(function* () {
        const before = yield* leaveFreePages(1_800);
        assert.isAbove(before, 1_024 + 256);

        const first = yield* reclaimFreePages(TICK);
        assert.equal(first.autoVacuum, "incremental");
        assert.equal(first.reclaimedPages, 1_024);
        assert.equal(first.chunkDurationsMs.length, 1_024 / 128);
        assert.equal(yield* freePages, before - 1_024);

        const second = yield* reclaimFreePages(TICK);
        assert.equal(second.reclaimedPages, before - 1_024 - 256);
        assert.equal(yield* freePages, 256);

        // At the floor nothing runs.
        const third = yield* reclaimFreePages(TICK);
        assert.equal(third.reclaimedPages, 0);
        assert.deepEqual(third.chunkDurationsMs, []);
        assert.equal(yield* freePages, 256);
      }),
    ),
  );

  it.live("never runs incremental_vacuum on a database without auto-vacuum", () =>
    withDatabase(
      "none",
      Effect.gen(function* () {
        const before = yield* leaveFreePages(600);
        assert.isAbove(before, 256);
        const result = yield* reclaimFreePages(TICK);
        assert.equal(result.autoVacuum, "none");
        assert.equal(result.reclaimedPages, 0);
        assert.deepEqual(result.chunkDurationsMs, []);
        assert.equal(yield* freePages, before);
      }),
    ),
  );

  it.live("does nothing while the freelist is at or below the floor", () =>
    withDatabase(
      "incremental",
      Effect.gen(function* () {
        const before = yield* leaveFreePages(60);
        assert.isAtMost(before, 256);
        assert.isAbove(before, 0);
        const result = yield* reclaimFreePages(TICK);
        assert.equal(result.reclaimedPages, 0);
        assert.deepEqual(result.chunkDurationsMs, []);
        assert.equal(yield* freePages, before);
      }),
    ),
  );

  it.live("reclaims on its interval in the background", () =>
    withDatabase(
      "incremental",
      Effect.gen(function* () {
        const before = yield* leaveFreePages(800);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* makeFreePageReclaim({ ...TICK, interval: "20 millis" });
            for (let attempt = 0; attempt < 200 && (yield* freePages) > 256; attempt += 1) {
              yield* Effect.sleep("10 millis");
            }
          }),
        );
        assert.isAbove(before, 256);
        assert.equal(yield* freePages, 256);
      }),
    ),
  );
});
