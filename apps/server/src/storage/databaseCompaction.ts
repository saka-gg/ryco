/**
 * databaseCompaction - the one-click compaction Storage settings offers: the doctor's
 * copy-and-swap (`DatabaseDoctor.ts`, all of its checks unchanged) run while no server has the
 * database open, which a server cannot do to its own file.
 *
 * - **Desktop app**: the app stops its own server, runs `ryco doctor --apply` with progress and a
 *   Cancel that works until the swap, starts the server again and writes the run's record
 *   ({@link COMPACTION_RECORD_FILE}). The server only says whether it is idle.
 * - **Background service** (`RYCO_SERVICE_LABEL`): this module starts the doctor detached (on
 *   Linux as a transient systemd unit, outside the service's control group, which `systemctl
 *   stop` would end), and the doctor stops the service, compacts and starts it again. It writes
 *   its result document to {@link COMPACTION_RESULT_FILE}; the restarted server reads it.
 * - **Anything else** (a foreground `ryco serve`): no one-click run; Storage settings keeps
 *   showing the doctor command.
 *
 * Runs only while nothing it would cut off is running: agents working or about to continue,
 * terminals running a command, clones, checkouts and storage cleanup (the update window's
 * restart rules, `updateWindow.ts`).
 *
 * Loaded on first use (`import()` from `StorageService.ts`), off the server's boot path.
 *
 * @module databaseCompaction
 */
import * as ChildProcess from "node:child_process";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { DatabaseCompactionRun, DatabaseCompactionStatus } from "@ryco/contracts";
import { Effect } from "effect";

/** The record of the last run, next to the database (written by the desktop app too). */
export const COMPACTION_RECORD_FILE = "database-compaction.json";
/** The doctor's `--result-file` for a service run. */
export const COMPACTION_RESULT_FILE = "database-compaction-result.json";

export interface CompactionBusySources {
  /** Agents working, a session starting, a request waiting, or a thread to continue. */
  readonly agentWork: Effect.Effect<boolean>;
  readonly busyTerminals: Effect.Effect<boolean>;
  readonly restartSensitiveWork: Effect.Effect<number>;
}

/** What a run would cut off now, in words; empty when it may run. */
export const compactionBusyReasons = (sources: CompactionBusySources) =>
  Effect.gen(function* () {
    const reasons: Array<string> = [];
    if (yield* sources.agentWork) reasons.push("Agents are working or waiting for an answer.");
    if (yield* sources.busyTerminals) reasons.push("A terminal is running a command.");
    if ((yield* sources.restartSensitiveWork) > 0)
      reasons.push("A clone, checkout or storage cleanup is running.");
    return reasons;
  });

export type CompactionRunner = DatabaseCompactionStatus["runner"];

export const compactionRunner = (input: {
  readonly mode: "web" | "desktop";
  readonly serviceLabel: string | undefined;
  readonly platform: NodeJS.Platform;
}): CompactionRunner =>
  input.mode === "desktop"
    ? "desktop"
    : input.serviceLabel !== undefined &&
        input.serviceLabel.length > 0 &&
        (input.platform === "darwin" || input.platform === "linux")
      ? "service"
      : "none";

interface CompactionRecord {
  readonly version: 1;
  readonly runner: "desktop" | "service";
  readonly startedAt: string;
  /** The desktop app writes the whole run; a service run's result is in its result file. */
  readonly run?: DatabaseCompactionRun;
}

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

const wholeOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

const RUN_STATUSES = new Set<DatabaseCompactionRun["status"]>([
  "running",
  "repaired",
  "compacted",
  "already-compact",
  "refused",
  "failed",
  "cancelled",
]);

/** The doctor's `--json` result document, as a run (status, message, sizes). */
export function runFromDoctorDocument(
  document: unknown,
): Pick<DatabaseCompactionRun, "status" | "message" | "beforeBytes" | "afterBytes"> | null {
  const result = (document as { readonly result?: Record<string, unknown> } | undefined)?.result;
  if (result === undefined || result === null || typeof result !== "object") return null;
  const status = result.status as DatabaseCompactionRun["status"];
  if (!RUN_STATUSES.has(status) || status === "running" || status === "cancelled") return null;
  const sizeOf = (side: unknown) =>
    wholeOrNull((side as { readonly fileBytes?: unknown } | null | undefined)?.fileBytes);
  return {
    status,
    message: typeof result.message === "string" ? result.message : "",
    beforeBytes: sizeOf(result.before),
    afterBytes: sizeOf(result.after),
  };
}

/**
 * The last run: the desktop app's record, or a service run's record plus the doctor's result
 * file. A service run's downtime is from its start to this process's start (the service the
 * doctor started again).
 */
export const readLastCompactionRun = (input: {
  readonly stateDir: string;
  readonly processStartedAtMs: number;
}) =>
  Effect.promise(async (): Promise<DatabaseCompactionRun | null> => {
    const record = (await readJson(NodePath.join(input.stateDir, COMPACTION_RECORD_FILE))) as
      | CompactionRecord
      | undefined;
    if (record === undefined || record.version !== 1 || typeof record.startedAt !== "string") {
      return null;
    }
    if (record.run !== undefined) return record.run;
    const resultPath = NodePath.join(input.stateDir, COMPACTION_RESULT_FILE);
    const outcome = runFromDoctorDocument(await readJson(resultPath));
    const startedAtMs = Date.parse(record.startedAt);
    if (outcome === null) {
      return {
        runner: record.runner,
        startedAt: record.startedAt,
        finishedAt: null,
        status: "running",
        message: "The compaction has not reported a result yet.",
        beforeBytes: null,
        afterBytes: null,
        downtimeMs: null,
      };
    }
    const finishedAt = await stat(resultPath).then(
      (info) => info.mtime.toISOString(),
      () => null,
    );
    return {
      runner: record.runner,
      startedAt: record.startedAt,
      finishedAt,
      ...outcome,
      downtimeMs:
        Number.isFinite(startedAtMs) && input.processStartedAtMs > startedAtMs
          ? Math.round(input.processStartedAtMs - startedAtMs)
          : null,
    };
  });

/** The doctor command line for this server's own CLI entry and data directory. */
export function detachedDoctorCommand(input: {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly execArgv: ReadonlyArray<string>;
  readonly entryScript: string;
  readonly baseDir: string;
  readonly devUrl: string | null;
  readonly resultFile: string;
  readonly unitName: string;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const doctor = [
    ...input.execArgv,
    input.entryScript,
    "doctor",
    "--apply",
    "--yes",
    "--json",
    "--base-dir",
    input.baseDir,
    ...(input.devUrl === null ? [] : ["--dev-url", input.devUrl]),
    "--result-file",
    input.resultFile,
  ];
  // `systemctl stop` ends every process of the service's control group: run it as its own unit.
  return input.platform === "linux"
    ? {
        command: "systemd-run",
        args: [
          "--user",
          "--collect",
          "--quiet",
          `--unit=${input.unitName}`,
          input.execPath,
          ...doctor,
        ],
      }
    : { command: input.execPath, args: doctor };
}

/**
 * Starts a service run: writes its record, removes an old result, and starts the doctor detached.
 * The doctor stops this server shortly after.
 */
export const startServiceCompaction = (input: {
  readonly stateDir: string;
  readonly baseDir: string;
  readonly devUrl: string | null;
  readonly now: Date;
  readonly spawn?: typeof ChildProcess.spawn;
}) =>
  Effect.promise(async (): Promise<{ readonly started: boolean; readonly detail: string }> => {
    const resultFile = NodePath.join(input.stateDir, COMPACTION_RESULT_FILE);
    await unlink(resultFile).catch(() => undefined);
    const record: CompactionRecord = {
      version: 1,
      runner: "service",
      startedAt: input.now.toISOString(),
    };
    await writeFile(
      NodePath.join(input.stateDir, COMPACTION_RECORD_FILE),
      `${JSON.stringify(record)}\n`,
    );
    const entryScript = process.argv[1];
    if (entryScript === undefined) {
      return { started: false, detail: "This server's command could not be found." };
    }
    const { command, args } = detachedDoctorCommand({
      platform: process.platform,
      execPath: process.execPath,
      execArgv: process.execArgv,
      entryScript,
      baseDir: input.baseDir,
      devUrl: input.devUrl,
      resultFile,
      unitName: `ryco-doctor-${input.now.getTime()}`,
    });
    const spawn = input.spawn ?? ChildProcess.spawn;
    return await new Promise((resolve) => {
      try {
        const child = spawn(command, [...args], {
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
        child.once("error", (error) =>
          resolve({ started: false, detail: `The doctor could not start: ${error.message}` }),
        );
        child.once("spawn", () => {
          child.unref();
          resolve({
            started: true,
            detail:
              "The doctor is stopping this node's service to compact the database. It starts again when it is done.",
          });
        });
      } catch (error) {
        resolve({ started: false, detail: `The doctor could not start: ${String(error)}` });
      }
    });
  });
