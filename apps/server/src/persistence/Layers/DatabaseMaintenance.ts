/**
 * DatabaseMaintenance - the server's background database upkeep.
 *
 * Runs event-log compaction (`EventLogCompaction`) in bounded passes: the first one 10 minutes
 * after startup (or when the previous pass is due, 6 hours after it completed), then every 2
 * minutes while settled history or old receipts are still waiting, and every 6 hours once caught
 * up. Each pass logs one summary line. Failures are logged and retried with backoff (4 minutes,
 * doubling, at most the idle interval); a full disk waits at least an hour.
 *
 * Server only: CLI processes never build this layer, so a `ryco project` or `ryco auth` command
 * never compacts. `RYCO_EVENT_COMPACTION` unset, empty, `on`, `1`, `true` or `yes` (default) runs
 * it; `off`, `0`, `false` or `no` disables it; `dry-run` selects and counts without deleting
 * (under its own state). Any other value disables it with a warning, so a mistyped kill switch
 * never deletes.
 *
 * It also returns free pages to the file system on databases created with
 * `auto_vacuum = INCREMENTAL` (every database created since that became the default in
 * `Sqlite.ts`): once a minute, when more than 256 pages (1 MiB at 4 KiB pages) are free, it frees
 * up to 1,024 of them down to that floor, in transactions of 128 single-page
 * `PRAGMA incremental_vacuum(1)` steps with a pause after each. Single steps on purpose: through
 * node:sqlite's `StatementSync.run()` an `incremental_vacuum(N)` frees one page while Bun's client
 * frees N, so one page per statement is the only bound both runtimes keep. The floor stays free
 * for new writes, which SQLite places in free pages before it grows the file. Older databases
 * (`NONE`) keep their free pages inside the file; changing the mode needs an offline VACUUM.
 * The file shrinks once the WAL is checkpointed. This runs regardless of the compaction setting.
 *
 * @module DatabaseMaintenance
 */
import { readEnv } from "@ryco/shared/runtimeEnv";
import { Cause, Clock, Duration, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  type CompactionLastPass,
  type CompactionPassResult,
  EventLogCompaction,
  type EventLogCompactionPassOptions,
} from "../Services/EventLogCompaction.ts";
import {
  EventLogCompactionDeferredLive,
  hasCompactionBacklog,
  ONLINE_COMPACTION_PASS_OPTIONS,
} from "./EventLogCompactionDeferred.ts";

export type EventCompactionSetting = "on" | "off" | "dry-run";

export const EVENT_COMPACTION_ENV = "RYCO_EVENT_COMPACTION";

const EVENT_COMPACTION_VALUES: ReadonlyMap<string, EventCompactionSetting> = new Map([
  ["", "on"],
  ["on", "on"],
  ["1", "on"],
  ["true", "on"],
  ["yes", "on"],
  ["off", "off"],
  ["0", "off"],
  ["false", "off"],
  ["no", "off"],
  ["dry-run", "dry-run"],
  ["dry_run", "dry-run"],
  ["dryrun", "dry-run"],
]);

/** Unset or empty means on; `undefined` means the value is not one of the accepted ones. */
export const parseEventCompactionSetting = (
  value: string | undefined,
): EventCompactionSetting | undefined =>
  EVENT_COMPACTION_VALUES.get(value?.trim().toLowerCase() ?? "");

/**
 * The kill switch never fails open: an unrecognized value (a typo of `off` or `dry-run`) turns
 * compaction off and logs a warning instead of deleting.
 */
export const resolveEventCompactionSetting = (value: string | undefined) => {
  const setting = parseEventCompactionSetting(value);
  if (setting !== undefined) return Effect.succeed(setting);
  return Effect.logWarning(
    `${EVENT_COMPACTION_ENV} has an unrecognized value; event log compaction stays off`,
    { value, accepted: "on|1|true|yes, off|0|false|no, dry-run" },
  ).pipe(Effect.as<EventCompactionSetting>("off"));
};

export interface DatabaseMaintenanceOptions {
  readonly setting: EventCompactionSetting;
  readonly startupDelay: Duration.Input;
  /** Cadence while settled history is still waiting to be scanned. */
  readonly catchUpInterval: Duration.Input;
  /** Cadence once caught up. */
  readonly idleInterval: Duration.Input;
  /** Shortest wait after the disk filled up. */
  readonly diskFullBackoff: Duration.Input;
  /** A pass whose longest delete transaction exceeds this logs a warning. */
  readonly slowBatchWarningMs: number;
  readonly passOptions: EventLogCompactionPassOptions;
}

export const DEFAULT_DATABASE_MAINTENANCE_OPTIONS: Omit<DatabaseMaintenanceOptions, "setting"> = {
  startupDelay: "10 minutes",
  catchUpInterval: "2 minutes",
  idleInterval: "6 hours",
  diskFullBackoff: "1 hour",
  slowBatchWarningMs: 50,
  passOptions: ONLINE_COMPACTION_PASS_OPTIONS,
};

const isDiskFull = (cause: Cause.Cause<unknown>) =>
  /SQLITE_FULL|database or disk is full/i.test(Cause.pretty(cause));

const passSummary = (result: CompactionPassResult) => ({
  mode: result.mode,
  scannedSequences: result.scannedSequences,
  deletedEvents: result.deletedEvents,
  deletedBytes: result.deletedBytes,
  deletedReceipts: result.deletedReceipts,
  durationMs: Math.round(result.durationMs),
  mainThreadMs: Math.round(result.mainThreadMs),
  maxBatchMs: Math.round(result.maxBatchMs * 100) / 100,
  backlogSequences: result.backlogSequences,
  receiptBacklog: result.receiptBacklog,
  stopReason: result.stopReason,
});

/**
 * The first wait after startup: the startup delay, or longer when the last pass completed less
 * than an idle interval ago and left nothing behind (no settled history, no old receipts).
 */
export const firstPassDelayMs = (input: {
  readonly nowMs: number;
  readonly startupDelayMs: number;
  readonly idleIntervalMs: number;
  readonly lastPassCompletedAt: string | null;
  readonly lastPass: CompactionLastPass | null;
}): number => {
  if (
    input.lastPassCompletedAt === null ||
    input.lastPass === null ||
    hasCompactionBacklog(input.lastPass)
  ) {
    return input.startupDelayMs;
  }
  const completedMs = Date.parse(input.lastPassCompletedAt);
  if (!Number.isFinite(completedMs)) return input.startupDelayMs;
  return Math.max(input.startupDelayMs, completedMs + input.idleIntervalMs - input.nowMs);
};

export const makeDatabaseMaintenance = (options: DatabaseMaintenanceOptions) =>
  Effect.gen(function* () {
    if (options.setting === "off") {
      yield* Effect.logInfo("event log compaction is off", { env: EVENT_COMPACTION_ENV });
      return;
    }
    const compaction = yield* EventLogCompaction;
    const mode = options.setting === "dry-run" ? "dry-run" : "delete";
    const passOptions: EventLogCompactionPassOptions = { ...options.passOptions, mode };
    const startupDelayMs = Duration.toMillis(Duration.fromInputUnsafe(options.startupDelay));
    const catchUpMs = Duration.toMillis(Duration.fromInputUnsafe(options.catchUpInterval));
    const idleMs = Duration.toMillis(Duration.fromInputUnsafe(options.idleInterval));
    const diskFullMs = Duration.toMillis(Duration.fromInputUnsafe(options.diskFullBackoff));

    const runOnce = (failures: number) =>
      compaction.runPass(passOptions).pipe(
        Effect.tap((result) => {
          const summary = passSummary(result);
          return result.maxBatchMs > options.slowBatchWarningMs
            ? Effect.logWarning("event log compaction pass had a slow delete batch", summary)
            : Effect.logInfo("event log compaction pass", summary);
        }),
        Effect.map((result) => ({
          nextDelayMs: hasCompactionBacklog(result) ? catchUpMs : idleMs,
          failures: 0,
        })),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          const nextFailures = failures + 1;
          const backoffMs = Math.min(idleMs, catchUpMs * 2 ** Math.min(nextFailures, 16));
          const nextDelayMs = isDiskFull(cause) ? Math.max(diskFullMs, backoffMs) : backoffMs;
          return Effect.logWarning("event log compaction pass failed; retrying later", {
            retryInMs: nextDelayMs,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ nextDelayMs, failures: nextFailures }));
        }),
      );

    const loop = Effect.gen(function* () {
      const state = yield* compaction.readState(mode).pipe(Effect.option);
      let delayMs = firstPassDelayMs({
        nowMs: yield* Clock.currentTimeMillis,
        startupDelayMs,
        idleIntervalMs: idleMs,
        lastPassCompletedAt: Option.isSome(state) ? state.value.lastPassCompletedAt : null,
        lastPass: Option.isSome(state) ? state.value.lastPass : null,
      });
      let failures = 0;
      while (true) {
        yield* Effect.sleep(Duration.millis(delayMs));
        const next = yield* runOnce(failures);
        delayMs = next.nextDelayMs;
        failures = next.failures;
      }
    });

    yield* Effect.forkScoped(loop);
  });

/** `PRAGMA auto_vacuum` as a name: 0 none, 1 full, 2 incremental. */
export type AutoVacuumMode = "none" | "full" | "incremental";

export const autoVacuumModeOf = (value: unknown): AutoVacuumMode =>
  Number(value) === 2 ? "incremental" : Number(value) === 1 ? "full" : "none";

export interface FreePageReclaimOptions {
  readonly interval: Duration.Input;
  /** Free pages that stay in the file for new writes; nothing runs at or below it. */
  readonly floorPages: number;
  readonly maxPagesPerTick: number;
  /** Single-page steps per transaction. */
  readonly chunkPages: number;
  /** Shortest pause after a chunk. */
  readonly chunkPauseMs: number;
  /** The pause after a chunk is also at least this many times its duration. */
  readonly idleRatio: number;
  /** A tick whose longest chunk exceeds this logs a warning. */
  readonly slowChunkWarningMs: number;
}

export const DEFAULT_FREE_PAGE_RECLAIM_OPTIONS: FreePageReclaimOptions = {
  interval: "1 minute",
  floorPages: 256,
  maxPagesPerTick: 1_024,
  chunkPages: 128,
  chunkPauseMs: 2,
  idleRatio: 3,
  slowChunkWarningMs: 50,
};

export interface FreePageReclaimResult {
  readonly autoVacuum: AutoVacuumMode;
  readonly freePagesBefore: number;
  readonly freePagesAfter: number;
  readonly reclaimedPages: number;
  /** Duration of each chunk transaction, in order (for measurements). */
  readonly chunkDurationsMs: ReadonlyArray<number>;
  readonly maxChunkMs: number;
}

const pragmaNumber = (rows: ReadonlyArray<Record<string, unknown>>, name: string) =>
  Number(rows[0]?.[name] ?? 0);

/**
 * One reclaim tick on the main connection: nothing unless the database is incremental and more
 * than `floorPages` pages are free; then single-page steps down to the floor, at most
 * `maxPagesPerTick`, `chunkPages` per transaction.
 */
export const reclaimFreePages = (
  options: Omit<FreePageReclaimOptions, "interval" | "slowChunkWarningMs">,
): Effect.Effect<FreePageReclaimResult, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const autoVacuum = autoVacuumModeOf(
      pragmaNumber(yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`, "auto_vacuum"),
    );
    const readFreePages = sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`.pipe(
      Effect.map((rows) => pragmaNumber(rows, "freelist_count")),
    );
    const freePagesBefore = yield* readFreePages;
    const chunkDurationsMs: Array<number> = [];
    let freePages = freePagesBefore;
    let reclaimedPages = 0;
    if (autoVacuum === "incremental" && freePages > options.floorPages) {
      while (reclaimedPages < options.maxPagesPerTick && freePages > options.floorPages) {
        // Timed from inside the transaction: waiting for the connection is contention.
        let startedAt = performance.now();
        const chunk = yield* sql.withTransaction(
          Effect.gen(function* () {
            startedAt = performance.now();
            // Read again under the transaction: other writes may have used free pages.
            const before = yield* readFreePages;
            const steps = Math.min(
              options.chunkPages,
              options.maxPagesPerTick - reclaimedPages,
              Math.max(0, before - options.floorPages),
            );
            for (let step = 0; step < steps; step += 1) {
              yield* sql`PRAGMA incremental_vacuum(1)`;
            }
            return { before, after: steps > 0 ? yield* readFreePages : before, steps };
          }),
        );
        const elapsedMs = performance.now() - startedAt;
        freePages = chunk.after;
        if (chunk.steps === 0) break;
        chunkDurationsMs.push(elapsedMs);
        reclaimedPages += Math.max(0, chunk.before - chunk.after);
        // A step that freed nothing (another writer took the pages) ends the tick.
        if (chunk.after >= chunk.before) break;
        if (reclaimedPages < options.maxPagesPerTick && freePages > options.floorPages) {
          yield* Effect.sleep(
            Math.ceil(Math.max(options.chunkPauseMs, elapsedMs * options.idleRatio)),
          );
        }
      }
    }
    return {
      autoVacuum,
      freePagesBefore,
      freePagesAfter: freePages,
      reclaimedPages,
      chunkDurationsMs,
      maxChunkMs: chunkDurationsMs.reduce((max, ms) => Math.max(max, ms), 0),
    } satisfies FreePageReclaimResult;
  });

/** Forks the reclaim loop: one tick per interval, failures logged and retried next tick. */
export const makeFreePageReclaim = (options: FreePageReclaimOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tick = reclaimFreePages(options).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.tap((result) => {
        if (result.chunkDurationsMs.length === 0) return Effect.void;
        const summary = {
          reclaimedPages: result.reclaimedPages,
          freePagesBefore: result.freePagesBefore,
          freePagesAfter: result.freePagesAfter,
          chunks: result.chunkDurationsMs.length,
          maxChunkMs: Math.round(result.maxChunkMs * 100) / 100,
        };
        return result.maxChunkMs > options.slowChunkWarningMs
          ? Effect.logWarning("database free-page reclaim had a slow chunk", summary)
          : Effect.logDebug("database free-page reclaim", summary);
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("database free-page reclaim failed; retrying later", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(options.interval).pipe(Effect.andThen(tick))),
    );
  });

export const DatabaseMaintenanceLive = Layer.effectDiscard(
  Effect.suspend(() => resolveEventCompactionSetting(readEnv(EVENT_COMPACTION_ENV))).pipe(
    Effect.flatMap((setting) =>
      Effect.all([
        makeDatabaseMaintenance({ ...DEFAULT_DATABASE_MAINTENANCE_OPTIONS, setting }),
        makeFreePageReclaim(DEFAULT_FREE_PAGE_RECLAIM_OPTIONS),
      ]),
    ),
  ),
).pipe(Layer.provide(EventLogCompactionDeferredLive));
