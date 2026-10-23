// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { DatabaseStorageReport } from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { estimateCompactableBytes, readDatabaseStorageReport } from "./databaseStorageReport.ts";
import { EVENT_COMPACTION_STATE_KEY, EventLogCompactionLive } from "./Layers/EventLogCompaction.ts";
import { layerConfig as SqlitePersistenceLayerConfig } from "./Layers/Sqlite.ts";
import { writeLifecycleMarker } from "./lifecycleMarkers.ts";
import { CompactionState, EMPTY_COMPACTION_STATE } from "./Services/EventLogCompaction.ts";

const encodeState = Schema.encodeSync(Schema.fromJsonString(CompactionState));

const TestLayer = EventLogCompactionLive.pipe(
  Layer.provideMerge(SqlitePersistenceLayerConfig),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-db-report-" })),
  Layer.provideMerge(NodeServices.layer),
);

const pragma = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Record<string, number>>(`PRAGMA ${name}`);
    return Number(rows[0]?.[name] ?? 0);
  });

/** Appends `count` events to a stream of their own and returns the log's head. */
const appendEvents = (streamId: string, count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
         actor_kind, payload_json, metadata_json)
      SELECT ${streamId} || ':' || i, 'thread', ${streamId}, i, 'thread.meta-updated',
             '2026-06-01T00:00:00.000Z', 'server', '{}', '{}'
      FROM n
    `;
    const [row] = yield* sql<{
      readonly head: number;
    }>`SELECT MAX(sequence) AS head FROM orchestration_events`;
    return Number(row?.head ?? 0);
  });

it.layer(TestLayer)("databaseStorageReport", (it) => {
  it.effect("reports the file, its pages and no compaction before the first pass", () =>
    Effect.gen(function* () {
      const { dbPath } = yield* ServerConfig;
      const head = yield* appendEvents("thread-report-a", 40);
      const report = yield* readDatabaseStorageReport({ compactionSetting: "on" });

      // Decodes as the wire schema (integers, literals).
      Schema.decodeUnknownSync(DatabaseStorageReport)(report);
      assert.equal(report.fileBytes, NodeFS.statSync(dbPath).size);
      assert.equal(
        report.walBytes,
        NodeFS.existsSync(`${dbPath}-wal`) ? NodeFS.statSync(`${dbPath}-wal`).size : 0,
      );
      assert.equal(report.pageSize, yield* pragma("page_size"));
      assert.equal(report.pageCount, yield* pragma("page_count"));
      assert.equal(report.freePages, yield* pragma("freelist_count"));
      // A database this code creates returns its free pages.
      assert.equal(report.autoVacuum, "incremental");
      assert.deepEqual(report.compaction, {
        enabled: true,
        headSequence: head,
        compactedThroughSequence: 0,
        caughtUp: false,
        lastPassCompletedAt: null,
        removedEvents: 0,
        removedBytes: 0,
        estimatedCompactableBytes: null,
      });
      assert.equal(report.reclaimableBytes, report.freePages * report.pageSize);
    }),
  );

  it.effect("estimates what compaction will still remove from what it removed so far", () =>
    Effect.gen(function* () {
      const head = yield* appendEvents("thread-report-b", 30);
      const state: CompactionState = {
        ...EMPTY_COMPACTION_STATE,
        compactedThroughSequence: 10,
        lastPassCompletedAt: "2026-10-20T12:00:00.000Z",
        totals: { scannedSequences: 10, deletedEvents: 4, deletedBytes: 1_000, deletedReceipts: 2 },
        lastPass: {
          scannedSequences: 10,
          deletedEvents: 4,
          deletedBytes: 1_000,
          deletedReceipts: 2,
          maxBatchMs: 1,
          mainThreadMs: 1,
          durationMs: 1,
          horizon: 10,
          backlogSequences: 0,
          receiptBacklog: false,
        },
      };
      yield* writeLifecycleMarker(EVENT_COMPACTION_STATE_KEY, encodeState(state));

      const report = yield* readDatabaseStorageReport({ compactionSetting: "off" });
      // 100 bytes per examined sequence, over the sequences not examined yet.
      const expected = 100 * (head - 10);
      assert.deepEqual(report.compaction, {
        enabled: false,
        headSequence: head,
        compactedThroughSequence: 10,
        caughtUp: true,
        lastPassCompletedAt: "2026-10-20T12:00:00.000Z",
        removedEvents: 4,
        removedBytes: 1_000,
        estimatedCompactableBytes: expected,
      });
      assert.equal(report.reclaimableBytes, report.freePages * report.pageSize + expected);
    }),
  );

  it.effect("counts free pages left by deleted rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE report_filler(id INTEGER PRIMARY KEY, body BLOB)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 900)
        INSERT INTO report_filler SELECT i, randomblob(1200) FROM n
      `;
      yield* sql`DELETE FROM report_filler`;
      const report = yield* readDatabaseStorageReport({ compactionSetting: "on" });
      assert.isAbove(report.freePages, 256);
      assert.equal(report.freePages, yield* pragma("freelist_count"));
      assert.isAtLeast(report.reclaimableBytes, report.freePages * report.pageSize);
    }),
  );
});

it("estimates nothing before a pass and in proportion after", () => {
  assert.isNull(estimateCompactableBytes(EMPTY_COMPACTION_STATE, 1_000));
  const state: CompactionState = {
    ...EMPTY_COMPACTION_STATE,
    compactedThroughSequence: 250,
    totals: { scannedSequences: 250, deletedEvents: 50, deletedBytes: 5_000, deletedReceipts: 0 },
  };
  assert.equal(estimateCompactableBytes(state, 1_000), 15_000);
  assert.equal(estimateCompactableBytes(state, 250), 0);
  // A cursor past the head (a restored file) estimates nothing left.
  assert.equal(estimateCompactableBytes(state, 100), 0);
});

it.effect("reads a missing WAL as empty and degrades parts it cannot read", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    assert.isFalse(NodeFS.existsSync(`${dbPath}-wal`));
    // No migrations ran: there is no event log and no compaction state to read.
    const report = yield* readDatabaseStorageReport({ compactionSetting: "on" });
    assert.equal(report.walBytes, 0);
    assert.equal(report.fileBytes, NodeFS.statSync(dbPath).size);
    assert.equal(report.autoVacuum, "none");
    assert.equal(report.compaction.headSequence, 0);
    assert.isNull(report.compaction.estimatedCompactableBytes);
    assert.isNull(report.compaction.lastPassCompletedAt);
  }).pipe(
    Effect.provide(
      EventLogCompactionLive.pipe(
        // A rollback-journal database (no WAL file) with one table, so the file exists.
        Layer.provideMerge(
          Layer.effectDiscard(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`CREATE TABLE legacy_probe(id INTEGER PRIMARY KEY)`;
            }),
          ).pipe(
            Layer.provideMerge(
              Layer.unwrap(
                Effect.map(Effect.service(ServerConfig), ({ dbPath }) =>
                  NodeSqliteClient.layer({ filename: dbPath }),
                ),
              ),
            ),
          ),
        ),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-db-report-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
