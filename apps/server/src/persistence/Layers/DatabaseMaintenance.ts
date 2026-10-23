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
 * never compacts. `RYCO_EVENT_COMPACTION=off` disables it, `dry-run` selects and counts without
 * deleting (under its own state), anything else (default) runs it.
 *
 * @module DatabaseMaintenance
 */
import { readEnv } from "@ryco/shared/runtimeEnv";
import { Cause, Clock, Duration, Effect, Layer, Option } from "effect";

import {
  type CompactionLastPass,
  type CompactionPassResult,
  EventLogCompaction,
  type EventLogCompactionPassOptions,
} from "../Services/EventLogCompaction.ts";
import {
  EventLogCompactionLive,
  hasCompactionBacklog,
  ONLINE_COMPACTION_PASS_OPTIONS,
} from "./EventLogCompaction.ts";

export type EventCompactionSetting = "on" | "off" | "dry-run";

export const EVENT_COMPACTION_ENV = "RYCO_EVENT_COMPACTION";

export const parseEventCompactionSetting = (value: string | undefined): EventCompactionSetting => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "0" || normalized === "false") return "off";
  if (normalized === "dry-run") return "dry-run";
  return "on";
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

export const DatabaseMaintenanceLive = Layer.effectDiscard(
  Effect.suspend(() =>
    makeDatabaseMaintenance({
      ...DEFAULT_DATABASE_MAINTENANCE_OPTIONS,
      setting: parseEventCompactionSetting(readEnv(EVENT_COMPACTION_ENV)),
    }),
  ),
).pipe(Layer.provide(EventLogCompactionLive));
