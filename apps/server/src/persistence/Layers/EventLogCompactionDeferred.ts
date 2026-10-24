/**
 * EventLogCompactionDeferred - the part of event-log compaction the server needs at boot.
 *
 * The stored state (`lifecycle_markers`), the online pass defaults, and
 * {@link EventLogCompactionDeferredLive}, the server's `EventLogCompaction`: `readState` reads
 * the stored state directly, while the pass itself (`EventLogCompaction.ts`, with the shared
 * selection rules) is loaded with `import()` when the first pass runs. Background upkeep runs
 * that 10 minutes after boot at the earliest, so the pass stays off the boot path
 * (serverBundleBoundaries.test.ts).
 *
 * @module EventLogCompactionDeferred
 */
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { readLifecycleMarker } from "../lifecycleMarkers.ts";
import {
  CompactionState,
  EMPTY_COMPACTION_STATE,
  EventLogCompaction,
  type EventLogCompactionMode,
  type EventLogCompactionPassOptions,
} from "../Services/EventLogCompaction.ts";
import { SqliteReadClient } from "../SqliteReadClient.ts";

export const EVENT_COMPACTION_STATE_KEY = "orchestration_event_compaction";
export const EVENT_COMPACTION_DRY_RUN_STATE_KEY = "orchestration_event_compaction_dry_run";

/** Dry runs keep their own state, so switching one to deleting never skips what it only counted. */
export const compactionStateKey = (mode: EventLogCompactionMode) =>
  mode === "delete" ? EVENT_COMPACTION_STATE_KEY : EVENT_COMPACTION_DRY_RUN_STATE_KEY;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Online defaults: a bounded slice every few minutes, never competing with live streaming. */
export const ONLINE_COMPACTION_PASS_OPTIONS: EventLogCompactionPassOptions = {
  horizon: "settled",
  settleAgeMs: DAY_MS,
  maxScanSequences: 250_000,
  maxWallMs: 120_000,
  selectionPageSequences: 2_000,
  // Deleting costs ~75 µs per event on the main connection (indexes, the statistics partial
  // index reads each payload, overflow pages): 200 events stay near 15 ms even when a batch of
  // large payloads follows a fast one.
  deleteBatch: { initial: 100, min: 20, max: 200, targetMs: 8 },
  interBatchPauseMs: 8,
  idleRatio: 3,
  carryCapacity: 50_000,
  receipts: { cutoffMs: 7 * DAY_MS, pageRows: 1_000, deleteBatch: 500, maxScanRows: 250_000 },
  mode: "delete",
};

/** Whether a pass left work behind: settled history or old receipts still to examine. */
export const hasCompactionBacklog = (pass: {
  readonly backlogSequences: number;
  readonly receiptBacklog: boolean;
}): boolean => pass.backlogSequences > 0 || pass.receiptBacklog;

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(CompactionState));

/** The stored state of a mode; the empty state when none (or an undecodable one) is stored. */
export const readCompactionState = (mode: EventLogCompactionMode) =>
  readLifecycleMarker(compactionStateKey(mode)).pipe(
    Effect.map((stored) =>
      Option.isNone(stored)
        ? EMPTY_COMPACTION_STATE
        : Option.getOrElse(decodeState(stored.value), () => EMPTY_COMPACTION_STATE),
    ),
    Effect.mapError(toPersistenceSqlError("EventLogCompaction.readState")),
  );

/**
 * `EventLogCompaction` with the pass loaded on first use. The pass is built once per layer and
 * shared (concurrent first callers wait for the same build), so its lock keeps passes apart
 * exactly as an eagerly built one does. It sees the services this layer was built with: the
 * main connection, and the read worker when there is one.
 */
export const EventLogCompactionDeferredLive = Layer.effect(
  EventLogCompaction,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reader = yield* Effect.serviceOption(SqliteReadClient);
    const build = Effect.promise(() => import("./EventLogCompaction.ts")).pipe(
      Effect.flatMap((module) => module.makeEventLogCompaction),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const pass = yield* Effect.cached(
      Option.isSome(reader)
        ? build.pipe(Effect.provideService(SqliteReadClient, reader.value))
        : build,
    );
    return EventLogCompaction.of({
      runPass: (options) => Effect.flatMap(pass, (compaction) => compaction.runPass(options)),
      readState: (mode) =>
        readCompactionState(mode).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    });
  }),
);
