/**
 * databaseStorageReport - what the node's state database occupies and what could be returned,
 * for the Storage settings surface.
 *
 * File and WAL sizes come from the file system, page numbers from SQLite's header pragmas, and
 * compaction progress from the event-log compaction state. `reclaimableBytes` is the free space
 * inside the file plus an estimate of what compaction will still remove: the share of bytes it
 * removed per sequence scanned so far, applied to the history it has not examined yet (which
 * includes the last day, not yet eligible). Every read is a header field, a key lookup or a
 * `stat`, so the report costs about a millisecond; a part that fails reads as 0 or null and
 * the report never fails.
 *
 * @module databaseStorageReport
 */
import type { DatabaseStorageReport } from "@ryco/contracts";
import { readEnv } from "@ryco/shared/runtimeEnv";
import { Cause, Effect, FileSystem } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import {
  autoVacuumModeOf,
  EVENT_COMPACTION_ENV,
  type EventCompactionSetting,
  parseEventCompactionSetting,
} from "./Layers/DatabaseMaintenance.ts";
import { hasCompactionBacklog } from "./Layers/EventLogCompaction.ts";
import {
  type CompactionState,
  EMPTY_COMPACTION_STATE,
  EventLogCompaction,
} from "./Services/EventLogCompaction.ts";

const count = (value: unknown) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/** The share of examined history compaction removed, applied to what it has not examined. */
export const estimateCompactableBytes = (state: CompactionState, headSequence: number) => {
  if (state.totals.scannedSequences <= 0) return null;
  const remaining = Math.max(
    0,
    headSequence - Math.min(state.compactedThroughSequence, headSequence),
  );
  return count((state.totals.deletedBytes / state.totals.scannedSequences) * remaining);
};

export const readDatabaseStorageReport = (input?: {
  readonly compactionSetting?: EventCompactionSetting;
}): Effect.Effect<
  DatabaseStorageReport,
  never,
  SqlClient.SqlClient | ServerConfig | FileSystem.FileSystem | EventLogCompaction
> =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const compaction = yield* EventLogCompaction;
    const degrade =
      <B>(part: string, fallback: B) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.logDebug("database storage report part unavailable", { part, cause }).pipe(
                  Effect.as(fallback),
                ),
          ),
        );
    const fileBytes = (path: string) =>
      fs.stat(path).pipe(
        Effect.map((info) => count(info.size)),
        // A missing WAL (clean close, or never in WAL mode) is simply empty.
        Effect.orElseSucceed(() => 0),
      );

    const pages = yield* sql<{
      readonly pageSize: number;
      readonly pageCount: number;
      readonly freePages: number;
      readonly autoVacuum: number;
    }>`
      SELECT
        page_size AS "pageSize",
        page_count AS "pageCount",
        freelist_count AS "freePages",
        auto_vacuum AS "autoVacuum"
      FROM pragma_page_size(), pragma_page_count(), pragma_freelist_count(), pragma_auto_vacuum()
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      degrade("pages", null),
    );
    const headSequence = yield* sql<{ readonly head: number | null }>`
      SELECT MAX(sequence) AS head FROM orchestration_events
    `.pipe(
      Effect.map((rows) => count(rows[0]?.head)),
      degrade("head", 0),
    );
    const state = yield* compaction
      .readState("delete")
      .pipe(degrade("compaction", EMPTY_COMPACTION_STATE));

    const pageSize = count(pages?.pageSize);
    const freePages = count(pages?.freePages);
    const estimatedCompactableBytes = estimateCompactableBytes(state, headSequence);
    const setting =
      input?.compactionSetting ?? parseEventCompactionSetting(readEnv(EVENT_COMPACTION_ENV));
    return {
      fileBytes: yield* fileBytes(dbPath),
      walBytes: yield* fileBytes(`${dbPath}-wal`),
      pageSize,
      pageCount: count(pages?.pageCount),
      freePages,
      autoVacuum: autoVacuumModeOf(pages?.autoVacuum),
      compaction: {
        enabled: setting === "on",
        headSequence,
        compactedThroughSequence: Math.min(count(state.compactedThroughSequence), headSequence),
        caughtUp: state.lastPass !== null && !hasCompactionBacklog(state.lastPass),
        lastPassCompletedAt: state.lastPassCompletedAt,
        removedEvents: count(state.totals.deletedEvents),
        removedBytes: count(state.totals.deletedBytes),
        estimatedCompactableBytes,
      },
      reclaimableBytes: freePages * pageSize + (estimatedCompactableBytes ?? 0),
    } satisfies DatabaseStorageReport;
  });
