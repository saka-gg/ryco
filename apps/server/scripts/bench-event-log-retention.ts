/**
 * Measures how long the event-log retention pass blocks the event loop
 * on a real database; run with Node on a private COPY, never on a live server's file:
 *
 *   sqlite3 ~/.ryco/userdata/state.sqlite "VACUUM INTO '/scratch/state-copy.sqlite'"
 *   node apps/server/scripts/bench-event-log-retention.ts --db /scratch/state-copy.sqlite \
 *     [--mode dry-run|delete] [--days-ahead 0] [--no-read-worker] [--full-pass]
 *
 * `--full-pass` runs the whole online pass (compaction, receipts, retention). Without it, retention
 * alone starts at the file's stored compaction cursor, like the online pass after compaction caught
 * up. `delete` removes events from the copy (and raises its floors).
 *
 * `--days-ahead` runs the pass as if that many days had passed, so retention has work on a log
 * it already trimmed. The probe is a 1 ms interval: its largest gap is the longest stretch the
 * pass held the event loop (a statement on the main connection, or JS between yields).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { Clock, Effect, Layer, Tracer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ONLINE_COMPACTION_PASS_OPTIONS } from "../src/persistence/Layers/EventLogCompactionDeferred.ts";
import { makeEventLogCompactionWith } from "../src/persistence/Layers/EventLogCompaction.ts";
import { runRetentionPass } from "../src/persistence/Layers/EventLogRetention.ts";
import { makeRuntimeSqliteLayer } from "../src/persistence/Layers/Sqlite.ts";
import * as SqliteReadClient from "../src/persistence/SqliteReadClient.ts";
import { readStatisticsThreadPartial } from "../src/statistics/statisticsRows.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    mode: { type: "string", default: "dry-run" },
    "days-ahead": { type: "string", default: "0" },
    "no-read-worker": { type: "boolean", default: false },
    "full-pass": { type: "boolean", default: false },
    "checkpoint-each-batch": { type: "boolean", default: false },
    /** The writer's wal_autocheckpoint (SQLite's default 1,000, as in the macOS desktop app). */
    autocheckpoint: { type: "string", default: "1000" },
  },
});
if (values.db === undefined) throw new Error("--db <copy of state.sqlite> is required");
const dbPath = values.db;
const mode = values.mode === "delete" ? "delete" : "dry-run";
const daysAhead = Number(values["days-ahead"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Main-connection statements over 20 ms, by their SQL (`--trace`). */
const slowStatements: Array<{ readonly ms: number; readonly sql: string }> = [];
const tracer = Tracer.make({
  span: (options) => {
    const span = new Tracer.NativeSpan(options);
    const end = span.end.bind(span);
    span.end = (endTime, exit) => {
      end(endTime, exit);
      const ms = Number(endTime - span.startTime) / 1e6;
      const text = span.attributes.get("db.query.text");
      const worker = span.attributes.get("db.connection") === "read-worker";
      if (ms > 20 && !worker) {
        const label = typeof text === "string" ? text : span.name;
        slowStatements.push({ ms: Math.round(ms), sql: label.replace(/\s+/g, " ").slice(0, 140) });
      }
    };
    return span;
  },
});

const main = Layer.unwrap(Effect.sync(() => makeRuntimeSqliteLayer({ filename: dbPath })));
const reader = values["no-read-worker"]
  ? SqliteReadClient.layerMain
  : SqliteReadClient.layer(dbPath);
const layer = reader.pipe(Layer.provideMerge(main));

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA mmap_size = 268435456`;
  yield* sql`PRAGMA cache_size = -32768`;
  yield* sql.unsafe(`PRAGMA wal_autocheckpoint = ${Number(values.autocheckpoint)}`);
  const reader = yield* SqliteReadClient.SqliteReadClient;
  const [state] = yield* sql<{ readonly value: string }>`
    SELECT value FROM lifecycle_markers WHERE key = 'orchestration_event_compaction'
  `;
  const compactedThroughSequence = Number(
    state === undefined ? 0 : JSON.parse(state.value).compactedThroughSequence,
  );
  const nowMs = Date.now() + daysAhead * DAY_MS;
  const retention = ONLINE_COMPACTION_PASS_OPTIONS.retention!;
  let maxGapMs = 0;
  let last = performance.now();
  const gaps: Array<number> = [];
  const probe = setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    if (gap > 20) gaps.push(Math.round(gap));
    maxGapMs = Math.max(maxGapMs, gap);
    last = now;
  }, 1);
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  // Let the probe start before the pass does.
  yield* Effect.sleep(50);
  last = performance.now();
  const startedAt = performance.now();
  let maxBatchMs = 0;
  let batches = 0;
  let checkpointMs = 0;
  const full = values["full-pass"]
    ? yield* Effect.gen(function* () {
        const compaction = yield* makeEventLogCompactionWith({
          readThreadUsage: readStatisticsThreadPartial,
        });
        const clock = yield* Clock.Clock;
        const offsetMs = daysAhead * DAY_MS;
        const shifted: Clock.Clock = {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + offsetMs,
          currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + offsetMs),
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: (duration) => clock.sleep(duration),
        };
        return yield* compaction
          .runPass({ ...ONLINE_COMPACTION_PASS_OPTIONS, mode, persistState: mode === "delete" })
          .pipe(Effect.provideService(Clock.Clock, shifted));
      })
    : null;
  const result =
    full !== null
      ? full.retention
      : yield* runRetentionPass({
          options: retention,
          mode,
          nowMs,
          compactedThroughSequence,
          overTime: () => false,
          readThreadUsage: readStatisticsThreadPartial,
          reader,
          // The online pacing (EventLogCompaction.ts pauseAfter with the online options).
          afterBatch: (elapsedMs) => {
            batches += 1;
            maxBatchMs = Math.max(maxBatchMs, elapsedMs);
            if (values["checkpoint-each-batch"]) {
              const startedAt = performance.now();
              return sql`PRAGMA wal_checkpoint(PASSIVE)`.pipe(
                Effect.orDie,
                Effect.tap(() =>
                  Effect.sync(() => {
                    checkpointMs = Math.max(checkpointMs, performance.now() - startedAt);
                  }),
                ),
                Effect.andThen(Effect.sleep(Math.ceil(Math.max(8, elapsedMs * 3)))),
              );
            }
            const { interBatchPauseMs, idleRatio = 0 } = ONLINE_COMPACTION_PASS_OPTIONS;
            return Effect.sleep(Math.ceil(Math.max(interBatchPauseMs, elapsedMs * idleRatio)));
          },
          batchTiming: ONLINE_COMPACTION_PASS_OPTIONS.deleteBatch,
        });
  clearInterval(probe);
  // A synchronous stretch at the end never lets the interval fire again: count it too.
  const tail = performance.now() - last;
  if (tail > 20) gaps.push(Math.round(tail));
  maxGapMs = Math.max(maxGapMs, tail);
  histogram.disable();
  return {
    wallMs: Math.round(performance.now() - startedAt),
    maxEventLoopGapMs: Math.round(maxGapMs),
    gapsOver20Ms: gaps.length,
    largestGaps: gaps.sort((a, b) => b - a).slice(0, 8),
    maxDelayMs: Math.round(histogram.max / 1e6),
    maxCheckpointMs: Math.round(checkpointMs),
    batches: full === null ? batches : full.batchDurationsMs.length,
    maxBatchMs: Math.round((full === null ? maxBatchMs : full.maxBatchMs) * 100) / 100,
    ...(full === null
      ? {}
      : {
          compaction: {
            scannedSequences: full.scannedSequences,
            deletedEvents: full.deletedEvents,
            deletedReceipts: full.deletedReceipts,
            mainThreadMs: Math.round(full.mainThreadMs),
            stopReason: full.stopReason,
            slowestBatchesMs: [...full.batchDurationsMs, ...full.receiptBatchDurationsMs]
              .sort((a, b) => b - a)
              .slice(0, 8)
              .map((ms) => Math.round(ms)),
          },
        }),
    retention: result,
    // A transaction's span includes its commit, where SQLite runs its automatic WAL checkpoint
    // when the writer owns checkpoints (the macOS desktop runtime, this script's default).
    slowestMainStatementMs: Math.max(
      0,
      ...slowStatements.filter((entry) => entry.sql !== "sql.transaction").map((entry) => entry.ms),
    ),
    slowMainStatements: slowStatements.sort((a, b) => b.ms - a.ms).slice(0, 12),
  };
});

Effect.runPromise(
  Effect.scoped(program.pipe(Effect.provide(layer), Effect.withTracer(tracer))),
).then(
  (out) => console.log(JSON.stringify(out, null, 2)),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
