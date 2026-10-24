import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";

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
  type EventCompactionSetting,
  firstPassDelayMs,
  makeDatabaseMaintenance,
  parseEventCompactionSetting,
} from "./DatabaseMaintenance.ts";

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
