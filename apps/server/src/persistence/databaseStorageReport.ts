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
 * `doctor` says whether an offline `ryco doctor --apply` is worth it (`doctorSuggestion.ts`);
 * {@link DoctorSuggestionLogLive} also logs that once per boot, for nodes nobody opens the
 * Storage settings of.
 *
 * @module databaseStorageReport
 */
import type { DatabaseStorageReport } from "@ryco/contracts";
import { readEnv } from "@ryco/shared/runtimeEnv";
import { Cause, Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import { doctorSuggestion } from "../doctor/doctorSuggestion.ts";
import { defaultBaseDir } from "../os-jank.ts";
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

/** A SQLite count or size as a whole non-negative number; anything else reads as 0. */
export const wholeNonNegative = (value: unknown) => {
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
  return wholeNonNegative((state.totals.deletedBytes / state.totals.scannedSequences) * remaining);
};

export const readDatabaseStorageReport = (input?: {
  readonly compactionSetting?: EventCompactionSetting;
  /** The Ryco version the desktop command names (tests). */
  readonly version?: string;
  /** The data directory commands may omit `--base-dir` for (tests); `~/.ryco` otherwise. */
  readonly defaultBaseDir?: string;
}): Effect.Effect<
  DatabaseStorageReport,
  never,
  SqlClient.SqlClient | ServerConfig | FileSystem.FileSystem | EventLogCompaction
> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const { dbPath } = config;
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
        Effect.map((info) => wholeNonNegative(info.size)),
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
      Effect.map((rows) => wholeNonNegative(rows[0]?.head)),
      degrade("head", 0),
    );
    const state = yield* compaction
      .readState("delete")
      .pipe(degrade("compaction", EMPTY_COMPACTION_STATE));

    const pageSize = wholeNonNegative(pages?.pageSize);
    const freePages = wholeNonNegative(pages?.freePages);
    const estimatedCompactableBytes = estimateCompactableBytes(state, headSequence);
    const setting =
      input?.compactionSetting ?? parseEventCompactionSetting(readEnv(EVENT_COMPACTION_ENV));
    const autoVacuum = autoVacuumModeOf(pages?.autoVacuum);
    const reclaimableBytes = freePages * pageSize + (estimatedCompactableBytes ?? 0);
    return {
      fileBytes: yield* fileBytes(dbPath),
      walBytes: yield* fileBytes(`${dbPath}-wal`),
      pageSize,
      pageCount: wholeNonNegative(pages?.pageCount),
      freePages,
      autoVacuum,
      compaction: {
        enabled: setting === "on",
        headSequence,
        compactedThroughSequence: Math.min(
          wholeNonNegative(state.compactedThroughSequence),
          headSequence,
        ),
        caughtUp: state.lastPass !== null && !hasCompactionBacklog(state.lastPass),
        lastPassCompletedAt: state.lastPassCompletedAt,
        removedEvents: wholeNonNegative(state.totals.deletedEvents),
        removedBytes: wholeNonNegative(state.totals.deletedBytes),
        estimatedCompactableBytes,
      },
      reclaimableBytes,
      doctor: doctorSuggestion({
        autoVacuum,
        reclaimableBytes,
        mode: config.mode,
        baseDir: config.baseDir,
        dbPath,
        defaultBaseDir: input?.defaultBaseDir ?? defaultBaseDir(),
        version: input?.version ?? packageJson.version,
      }),
    } satisfies DatabaseStorageReport;
  });

/** When the boot log looks: after the first compaction pass (10 minutes), which sets the estimate. */
export const DOCTOR_SUGGESTION_LOG_DELAY = "15 minutes";

/**
 * Logs once per boot, at info, when `ryco doctor --apply` would shrink the database a lot: a
 * headless node's operator reads the service log, not the Storage settings.
 */
export const logDoctorSuggestionOnce = Effect.gen(function* () {
  const report = yield* readDatabaseStorageReport();
  if (report.doctor?.recommended !== true) return;
  yield* Effect.logInfo(
    "the database could shrink a lot offline: stop this server and run the doctor",
    {
      command: report.doctor.command,
      fileBytes: report.fileBytes,
      reclaimableBytes: report.reclaimableBytes,
      docs: "docs/storage-management.md",
    },
  );
});

export const DoctorSuggestionLogLive = Layer.effectDiscard(
  Effect.forkScoped(Effect.delay(logDoctorSuggestionOnce, DOCTOR_SUGGESTION_LOG_DELAY)),
);
