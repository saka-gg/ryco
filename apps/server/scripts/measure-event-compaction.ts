// @effect-diagnostics nodeBuiltinImport:off
/**
 * Measures event-log compaction on a copy of a database; run with Node (server runtime).
 *
 *   node apps/server/scripts/measure-event-compaction.ts --db <state.sqlite> \
 *     [--mode online|offline] [--no-read-worker] [--verify-replay] [--pre-093-indexes] [--keep] \
 *     [--out result.json]
 *
 * The source file is never written: the script copies it (with its WAL) through SQLite's backup
 * API into a temporary directory next to it and works on the copy. It reports, as one JSON object:
 *
 * - before/after: file and WAL bytes, page and freelist counts, events by type and activity kind,
 *   receipts by command-id class;
 * - the passes: `online` runs the server's online passes back to back until nothing is left
 *   (each one bounded like a real pass), `offline` one pass over the whole log from the beginning
 *   with an unbounded carry (what `ryco doctor` will run);
 * - main-thread cost: event-loop delay (`monitorEventLoopDelay`, 1 ms resolution) and the largest
 *   gap of a 1 ms heartbeat during the passes, delete-transaction durations (max, p50, p99);
 * - `--no-read-worker`: selection on the main connection, as on Bun or without a worker;
 * - `--pre-093-indexes`: recreates the two event indexes migration 093 dropped, as a database
 *   that has not reached v0.1.33 still carries them (deletes maintain them);
 * - `--verify-replay`: rebuilds every projection from scratch on a copy of the original and on a
 *   copy of the compacted log and compares them (sha256 per table), with rebuild durations;
 * - `--no-autocheckpoint`: diagnostic; the main connection does not checkpoint at commit (as with
 *   a checkpoint worker), to separate delete cost from commit-time checkpoint cost;
 * - `VACUUM INTO` of the compacted copy: the size the file would shrink to.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../src/orchestration/Services/ProjectionPipeline.ts";
import {
  hasCompactionBacklog,
  isPrunableReceiptCommandId,
  makeEventLogCompaction,
  ONLINE_COMPACTION_PASS_OPTIONS,
} from "../src/persistence/Layers/EventLogCompaction.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import type {
  CompactionPassResult,
  EventLogCompactionPassOptions,
} from "../src/persistence/Services/EventLogCompaction.ts";
import { SqliteReadClient } from "../src/persistence/SqliteReadClient.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    mode: { type: "string", default: "online" },
    "no-read-worker": { type: "boolean", default: false },
    "verify-replay": { type: "boolean", default: false },
    "pre-093-indexes": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "no-autocheckpoint": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
if (!values.db || !existsSync(values.db) || !["online", "offline"].includes(values.mode ?? "")) {
  console.error(
    "Usage: node apps/server/scripts/measure-event-compaction.ts --db <state.sqlite> [--mode online|offline] [--no-read-worker] [--verify-replay] [--pre-093-indexes] [--keep]",
  );
  process.exit(2);
}
const source = resolve(values.db);
const workDir = mkdtempSync(join(dirname(source), ".measure-event-compaction-"));
const original = join(workDir, "original.sqlite");
const compacted = join(workDir, "compacted.sqlite");

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const percentile = (sorted: ReadonlyArray<number>, share: number) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(share * (sorted.length - 1)))]!;

/**
 * A consistent page-for-page copy through SQLite's backup API, read-only on the source and
 * including its WAL (`VACUUM INTO` would compact the copy, hiding the free pages).
 */
async function copyDatabase(from: string, to: string) {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(db, to);
  } finally {
    db.close();
  }
}

function fileStats(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const pragma = (name: string) =>
      Number((db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]);
    const byType = db
      .prepare(
        `SELECT event_type AS type,
            CASE WHEN event_type = 'thread.activity-appended'
              THEN json_extract(payload_json, '$.activity.kind') END AS kind,
            COUNT(*) AS events,
            SUM(length(CAST(payload_json AS BLOB)) + length(CAST(metadata_json AS BLOB))) AS bytes
          FROM orchestration_events GROUP BY 1, 2 ORDER BY events DESC`,
      )
      .all() as Array<{ type: string; kind: string | null; events: number; bytes: number }>;
    const receipts = db
      .prepare("SELECT command_id AS commandId FROM orchestration_command_receipts")
      .all() as Array<{ commandId: string }>;
    const receiptClasses: Record<string, number> = {};
    for (const { commandId } of receipts) {
      const name = isPrunableReceiptCommandId(commandId)
        ? `${commandId.split(":")[0]}:<uuid> (prunable)`
        : commandId.includes(":")
          ? `${commandId.split(":")[0]}:…`
          : "other";
      receiptClasses[name] = (receiptClasses[name] ?? 0) + 1;
    }
    return {
      fileBytes: statSync(path).size,
      walBytes: existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0,
      pageSize: pragma("page_size"),
      pageCount: pragma("page_count"),
      freelistCount: pragma("freelist_count"),
      events: byType.reduce((total, row) => total + row.events, 0),
      eventBytes: byType.reduce((total, row) => total + row.bytes, 0),
      eventsByKind: Object.fromEntries(
        byType.map((row) => [row.kind ?? row.type, { events: row.events, bytes: row.bytes }]),
      ),
      receipts: receipts.length,
      receiptsByClass: receiptClasses,
    };
  } finally {
    db.close();
  }
}

const avatarStore = Layer.succeed(ProjectAvatarStore, {
  write: () => Effect.die("unused"),
  read: () => Effect.succeed(null),
  remove: () => Effect.void,
});

const runtimeFor = (dbPath: string) =>
  ManagedRuntime.make(
    Layer.mergeAll(OrchestrationProjectionPipelineLive).pipe(
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(avatarStore),
      Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), workDir)),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

async function compact(dbPath: string) {
  if (values["pre-093-indexes"]) {
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_orch_events_command_id ON orchestration_events(command_id)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_orch_events_correlation_id ON orchestration_events(correlation_id)",
    );
    db.close();
  }
  const runtime = runtimeFor(dbPath);
  const noReadWorker = values["no-read-worker"] === true;
  const offline = values.mode === "offline";
  const options: EventLogCompactionPassOptions = offline
    ? {
        ...ONLINE_COMPACTION_PASS_OPTIONS,
        horizon: "head",
        fromBeginning: true,
        maxScanSequences: Number.POSITIVE_INFINITY,
        maxWallMs: Number.POSITIVE_INFINITY,
        deleteBatch: { initial: 200, min: 50, max: 2_000, targetMs: 8 },
        interBatchPauseMs: 0,
        idleRatio: 0,
        carryCapacity: Number.POSITIVE_INFINITY,
        receipts: {
          ...ONLINE_COMPACTION_PASS_OPTIONS.receipts!,
          maxScanRows: Number.POSITIVE_INFINITY,
        },
      }
    : // Without a read worker, runPass itself caps the selection windows.
      ONLINE_COMPACTION_PASS_OPTIONS;
  try {
    const compaction = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* noReadWorker
          ? makeEventLogCompaction.pipe(Effect.provideService(SqliteReadClient, sql))
          : makeEventLogCompaction;
      }),
    );
    // Warm the read worker and caches outside the measured window like a running server.
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT COUNT(*) FROM orchestration_events`;
        if (values["no-autocheckpoint"]) yield* sql`PRAGMA wal_autocheckpoint = 0`;
      }),
    );

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    let lastBeat = performance.now();
    let maxHeartbeatGapMs = 0;
    // Stalls over 100 ms with the WAL size right after: a commit-time checkpoint shows up as a
    // stall followed by a small or reset WAL.
    const stalls: Array<{ readonly gapMs: number; readonly walBytesAfter: number }> = [];
    const walPath = `${dbPath}-wal`;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      const gap = now - lastBeat;
      maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, gap);
      if (gap > 100 && stalls.length < 50) {
        stalls.push({
          gapMs: round(gap, 0),
          walBytesAfter: existsSync(walPath) ? statSync(walPath).size : 0,
        });
      }
      lastBeat = now;
    }, 1);
    histogram.enable();
    const passes: Array<CompactionPassResult> = [];
    const startedAt = performance.now();
    for (;;) {
      const result = await runtime.runPromise(compaction.runPass(options));
      passes.push(result);
      if (offline || !hasCompactionBacklog(result) || passes.length >= 200) break;
    }
    const wallMs = performance.now() - startedAt;
    histogram.disable();
    clearInterval(heartbeat);
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
      }),
    );
    const batches = passes.flatMap((pass) => pass.batchDurationsMs).toSorted((a, b) => a - b);
    const receiptBatches = passes
      .flatMap((pass) => pass.receiptBatchDurationsMs)
      .toSorted((a, b) => a - b);
    return {
      mode: offline ? "offline" : "online",
      selection: noReadWorker ? "main connection" : "read worker",
      pre093Indexes: values["pre-093-indexes"] === true,
      passes: passes.length,
      wallMs: round(wallMs, 0),
      perPass: passes.map((pass) => ({
        scannedSequences: pass.scannedSequences,
        deletedEvents: pass.deletedEvents,
        deletedReceipts: pass.deletedReceipts,
        durationMs: round(pass.durationMs, 0),
        mainThreadMs: round(pass.mainThreadMs, 0),
        maxBatchMs: round(pass.maxBatchMs),
        stopReason: pass.stopReason,
      })),
      deletedEvents: passes.reduce((total, pass) => total + pass.deletedEvents, 0),
      deletedBytes: passes.reduce((total, pass) => total + pass.deletedBytes, 0),
      deletedReceipts: passes.reduce((total, pass) => total + pass.deletedReceipts, 0),
      skippedBatches: passes.reduce((total, pass) => total + pass.skippedBatches, 0),
      mainThreadMs: round(
        passes.reduce((total, pass) => total + pass.mainThreadMs, 0),
        0,
      ),
      autocheckpoint: values["no-autocheckpoint"] !== true,
      deleteTransactions: batches.length,
      deleteTransactionMs: {
        max: round(batches.at(-1) ?? 0),
        p50: round(percentile(batches, 0.5)),
        p99: round(percentile(batches, 0.99)),
        over20: batches.filter((ms) => ms > 20).length,
        over50: batches.filter((ms) => ms > 50).length,
      },
      receiptDeleteTransactions: receiptBatches.length,
      receiptDeleteTransactionMs: {
        max: round(receiptBatches.at(-1) ?? 0),
        p50: round(percentile(receiptBatches, 0.5)),
        p99: round(percentile(receiptBatches, 0.99)),
        over20: receiptBatches.filter((ms) => ms > 20).length,
        over50: receiptBatches.filter((ms) => ms > 50).length,
      },
      eventLoopDelayMs: {
        max: round(histogram.max / 1e6),
        p99: round(histogram.percentile(99) / 1e6),
        mean: round(histogram.mean / 1e6),
      },
      maxHeartbeatGapMs: round(maxHeartbeatGapMs),
      stallsOver100Ms: stalls,
    };
  } finally {
    await runtime.dispose();
  }
}

/** Rebuilds every projection from the log and hashes each table. */
async function rebuild(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'projection_%'
           AND name NOT LIKE 'projection_message_search%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  for (const table of tables) db.exec(`DELETE FROM "${table}"`);
  db.close();
  const runtime = runtimeFor(dbPath);
  const startedAt = performance.now();
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const pipeline = yield* OrchestrationProjectionPipeline;
        yield* pipeline.bootstrap;
      }),
    );
  } finally {
    await runtime.dispose();
  }
  const rebuildMs = performance.now() - startedAt;
  const hashDb = new DatabaseSync(dbPath, { readOnly: true });
  const hashes: Record<string, string> = {};
  try {
    for (const table of tables.filter((name) => name !== "projection_state")) {
      const rows = hashDb.prepare(`SELECT * FROM "${table}"`).all();
      const lines = rows
        .map((row) =>
          JSON.stringify(
            Object.entries(row as Record<string, unknown>).toSorted(),
            (_key, value) => (typeof value === "bigint" ? value.toString() : value),
          ),
        )
        .toSorted();
      hashes[table] = createHash("sha256").update(lines.join("\n")).digest("hex");
    }
  } finally {
    hashDb.close();
  }
  return { rebuildMs: round(rebuildMs, 0), hashes };
}

function vacuumInto(dbPath: string) {
  const target = join(workDir, "vacuumed.sqlite");
  const db = new DatabaseSync(dbPath);
  const startedAt = performance.now();
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  const ms = performance.now() - startedAt;
  const bytes = statSync(target).size;
  rmSync(target, { force: true });
  return { vacuumIntoMs: round(ms, 0), vacuumedBytes: bytes };
}

try {
  await copyDatabase(source, original);
  copyFileSync(original, compacted);
  // Flush the copies before measuring, so the first checkpoint's fsync does not pay for them.
  for (const path of [original, compacted]) {
    const fd = openSync(path, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const before = fileStats(compacted);
  const run = await compact(compacted);
  const after = fileStats(compacted);
  const vacuum = vacuumInto(compacted);
  let replay: Record<string, unknown> | undefined;
  if (values["verify-replay"]) {
    const originalCopy = join(workDir, "rebuild-original.sqlite");
    const compactedCopy = join(workDir, "rebuild-compacted.sqlite");
    copyFileSync(original, originalCopy);
    copyFileSync(compacted, compactedCopy);
    const fromOriginal = await rebuild(originalCopy);
    const fromCompacted = await rebuild(compactedCopy);
    const differing = Object.keys(fromOriginal.hashes).filter(
      (table) => fromOriginal.hashes[table] !== fromCompacted.hashes[table],
    );
    replay = {
      replayVerified: differing.length === 0,
      differingTables: differing,
      tablesCompared: Object.keys(fromOriginal.hashes).length,
      rebuildFromOriginalMs: fromOriginal.rebuildMs,
      rebuildFromCompactedMs: fromCompacted.rebuildMs,
    };
  }
  const report = JSON.stringify(
    {
      source,
      node: process.version,
      before,
      run,
      after,
      removed: {
        eventShare: round(1 - after.events / Math.max(1, before.events), 4),
        eventByteShare: round(1 - after.eventBytes / Math.max(1, before.eventBytes), 4),
        freedPages: after.freelistCount - before.freelistCount,
      },
      vacuum,
      ...(replay ? { replay } : {}),
    },
    null,
    2,
  );
  if (values.out) writeFileSync(values.out, `${report}\n`);
  console.log(report);
} finally {
  if (!values.keep) rmSync(workDir, { recursive: true, force: true });
}
