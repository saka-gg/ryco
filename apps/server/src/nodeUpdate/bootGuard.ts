/**
 * nodeUpdate/bootGuard - Rolls back a node update whose release does not finish starting.
 *
 * Runs in the `ryco service` start of `ryco serve`, before the process entry imports the server
 * graph (bin.ts), so a release that crashes anywhere in that graph or while it boots is still
 * caught. Node builtins only (and updateProtocol.ts, which the entry already holds): it must not
 * load what it guards. The entry loads it for service starts only.
 *
 * An update restarts the node into its target with a marker in the state directory (marker.ts)
 * that records how to undo it: the command that reinstalls the previous release, and a snapshot
 * of the database taken right before the restart. Each start of the target counts one boot
 * attempt in the marker (rewritten through a temp file and a rename); the server marks it ready
 * once it is migrated, listening and connected to the Hub (cliUpdate.ts). The start after
 * {@link NODE_UPDATE_MAX_BOOT_ATTEMPTS} attempts that never got ready rolls back instead:
 *
 * 1. reinstalls the previous release with the recorded command (bounded by its timeout),
 * 2. moves the failed release's database (with its WAL) aside, into the update directory, and
 *    puts the snapshot in its place; nothing has the database open yet,
 * 3. rewrites the marker as rolled back and exits non-zero: the service manager starts the
 *    previous release, which reports the failed update from the marker.
 *
 * A reinstall that fails is tried again on the next {@link NODE_UPDATE_ROLLBACK_TRIES} starts;
 * after those the guard lets the release boot as it would have without it.
 *
 * @module nodeUpdate/bootGuard
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  NODE_UPDATE_MARKER_FILE_NAME,
  NODE_UPDATE_MARKER_MAX_AGE_MS,
  NODE_UPDATE_OUTPUT_MAX_CHARS,
} from "./updateProtocol.ts";

/** Starts of the target release that may end before it is ready; the next one rolls back. */
export const NODE_UPDATE_MAX_BOOT_ATTEMPTS = 2;
/** Further starts that retry a rollback whose reinstall failed, before the guard gives up. */
export const NODE_UPDATE_ROLLBACK_TRIES = 3;

/** A command an update recorded for the rollback, as `spawnSync` runs it. */
export interface NodeUpdateRecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

/** How to undo an update: `install` puts the previous release back. */
export interface NodeUpdateRollbackPlan {
  readonly install: NodeUpdateRecordedCommand;
  readonly databasePath: string;
  readonly snapshotPath: string;
}

/** What the guard reads from a marker; the rest of it is kept as it is when rewritten. */
export interface GuardedNodeUpdateMarker {
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly startedAt: string;
  readonly bootAttempts: number;
  /** `readyAt` or `rolledBack` is set: the update is settled. */
  readonly settled: boolean;
  /** `null` for markers without one (desktop updates, releases before the rollback). */
  readonly rollback: NodeUpdateRollbackPlan | null;
}

const presentString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const recordedCommand = (value: unknown): NodeUpdateRecordedCommand | null => {
  if (typeof value !== "object" || value === null) return null;
  const { command, args, timeoutMs } = value as Record<string, unknown>;
  if (!presentString(command) || !Array.isArray(args)) return null;
  if (!args.every((arg) => typeof arg === "string")) return null;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return { command, args: args as ReadonlyArray<string>, timeoutMs };
};

const rollbackPlan = (value: unknown): NodeUpdateRollbackPlan | null => {
  if (typeof value !== "object" || value === null) return null;
  const { install, databasePath, snapshotPath } = value as Record<string, unknown>;
  const command = recordedCommand(install);
  if (command === null || !presentString(databasePath) || !presentString(snapshotPath)) {
    return null;
  }
  return { install: command, databasePath, snapshotPath };
};

/** The parts of a decoded marker file the guard acts on; `null` when it is not a marker. */
export function readGuardedNodeUpdateMarker(value: unknown): GuardedNodeUpdateMarker | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  const { fromVersion, targetVersion, startedAt, bootAttempts } = marker;
  if (!presentString(fromVersion) || !presentString(targetVersion) || !presentString(startedAt)) {
    return null;
  }
  return {
    fromVersion,
    targetVersion,
    startedAt,
    bootAttempts:
      typeof bootAttempts === "number" && Number.isSafeInteger(bootAttempts) && bootAttempts > 0
        ? bootAttempts
        : 0,
    settled: marker.readyAt !== undefined || marker.rolledBack !== undefined,
    rollback: rollbackPlan(marker.rollback),
  };
}

export type NodeUpdateBootDecision =
  | { readonly action: "boot" }
  /** Record this start as attempt `bootAttempts`, then boot. */
  | { readonly action: "count"; readonly bootAttempts: number }
  /** Record attempt `bootAttempts` and roll back instead of booting. */
  | {
      readonly action: "roll-back";
      readonly bootAttempts: number;
      readonly plan: NodeUpdateRollbackPlan;
    };

/**
 * What this start does about `marker`. Only a start of the update's target counts: a node that
 * came back on another release is reported by the server, not rolled back.
 */
export function decideNodeUpdateBoot(input: {
  readonly marker: GuardedNodeUpdateMarker | null;
  readonly runningVersion: string | null;
  readonly nowMs: number;
}): NodeUpdateBootDecision {
  const { marker } = input;
  if (marker === null || marker.settled || marker.rollback === null) return { action: "boot" };
  if (input.runningVersion !== marker.targetVersion) return { action: "boot" };
  const startedAtMs = Date.parse(marker.startedAt);
  if (!Number.isFinite(startedAtMs) || input.nowMs - startedAtMs > NODE_UPDATE_MARKER_MAX_AGE_MS) {
    return { action: "boot" };
  }
  const bootAttempts = marker.bootAttempts + 1;
  if (
    bootAttempts > NODE_UPDATE_MAX_BOOT_ATTEMPTS &&
    bootAttempts <= NODE_UPDATE_MAX_BOOT_ATTEMPTS + NODE_UPDATE_ROLLBACK_TRIES
  ) {
    return { action: "roll-back", bootAttempts, plan: marker.rollback };
  }
  return { action: "count", bootAttempts };
}

const flagValue = (args: ReadonlyArray<string>, name: string): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
};

/**
 * The state directory `ryco serve <args>` uses: `--base-dir`, else `RYCO_HOME`, else `~/.ryco`,
 * then `dev` with a dev URL and `userdata` without, as the CLI resolves it (`resolveBaseDir`,
 * `deriveServerPaths`). A service passes `--base-dir` itself.
 */
export function serveStateDirectory(input: {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): string {
  const raw = (flagValue(input.args, "--base-dir") ?? input.env.RYCO_HOME ?? "").trim();
  const expanded =
    raw === "~"
      ? input.homeDirectory
      : raw.startsWith("~/") || raw.startsWith("~\\")
        ? join(input.homeDirectory, raw.slice(2))
        : raw;
  const baseDir = raw.length === 0 ? join(input.homeDirectory, ".ryco") : resolve(expanded);
  const devUrl = flagValue(input.args, "--dev-url") ?? input.env.VITE_DEV_SERVER_URL;
  return join(baseDir, devUrl !== undefined && devUrl.trim().length > 0 ? "dev" : "userdata");
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const outputTail = (stdout: string, stderr: string): string | null => {
  const output = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join("\n");
  if (output.length === 0) return null;
  return output.length <= NODE_UPDATE_OUTPUT_MAX_CHARS
    ? output
    : output.slice(output.length - NODE_UPDATE_OUTPUT_MAX_CHARS);
};

const syncDirectoryBestEffort = (directory: string) => {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // The rename is done; flushing it is only for a power loss right after.
  }
};

/** Through a temp file and a rename, so a crash leaves the old marker or the new one. */
function writeMarkerAtomically(markerPath: string, marker: Record<string, unknown>): void {
  const temporary = `${markerPath}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeFileSync(fd, `${JSON.stringify(marker)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, markerPath);
  syncDirectoryBestEffort(dirname(markerPath));
}

interface CommandOutcome {
  readonly ok: boolean;
  readonly reason: string;
  readonly output: string | null;
}

function runRecordedCommand(command: NodeUpdateRecordedCommand): CommandOutcome {
  const result = spawnSync(command.command, [...command.args], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: command.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  const output = outputTail(result.stdout ?? "", result.stderr ?? "");
  if (result.error !== undefined) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      ok: false,
      reason: timedOut
        ? `${command.command} timed out after ${Math.round(command.timeoutMs / 1_000)} s`
        : `could not run ${command.command}: ${errorText(result.error)}`,
      output,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `${command.command} exited with ${result.status === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.status}`}`,
      output,
    };
  }
  return { ok: true, reason: "", output };
}

const isFile = (filePath: string) => {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const moveIfPresent = (from: string, to: string) => {
  if (existsSync(from)) renameSync(from, to);
};

const fileSafe = (value: string) => value.replace(/[^A-Za-z0-9._-]/gu, "_");

/** Where a rollback leaves the database the failed release used. */
export const failedDatabasePath = (updateDirectory: string, targetVersion: string) =>
  join(updateDirectory, `failed-${fileSafe(targetVersion)}.sqlite`);

const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

/**
 * Puts the snapshot in place of the database. The failed release's database and its WAL move
 * together (they only open as one database), its `-shm` index is dropped, and the snapshot is
 * renamed into place last: a WAL left beside it would be replayed onto it.
 */
export function restoreNodeUpdateSnapshot(input: {
  readonly plan: NodeUpdateRollbackPlan;
  readonly targetVersion: string;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const { databasePath, snapshotPath } = input.plan;
  if (!isFile(snapshotPath))
    return { ok: false, reason: `the snapshot ${snapshotPath} is missing` };
  const failed = failedDatabasePath(dirname(snapshotPath), input.targetVersion);
  try {
    for (const suffix of ["", ...SQLITE_SIDECARS]) rmSync(`${failed}${suffix}`, { force: true });
    moveIfPresent(databasePath, failed);
    moveIfPresent(`${databasePath}-wal`, `${failed}-wal`);
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-journal`, { force: true });
    renameSync(snapshotPath, databasePath);
  } catch (cause) {
    // Never leave the node without a database: put the failed release's back.
    try {
      if (!existsSync(databasePath)) {
        moveIfPresent(failed, databasePath);
        moveIfPresent(`${failed}-wal`, `${databasePath}-wal`);
      }
    } catch {
      // Reported below; the files are still in the update directory.
    }
    return { ok: false, reason: errorText(cause) };
  }
  syncDirectoryBestEffort(dirname(databasePath));
  syncDirectoryBestEffort(dirname(snapshotPath));
  return { ok: true };
}

export interface NodeUpdateBootGuardOptions {
  readonly markerPath: string;
  /** Read only when a marker is there. */
  readonly runningVersion: () => string | null;
  readonly nowMs?: number;
  readonly log?: (line: string) => void;
}

/**
 * Checks the marker at `markerPath` for this start. `exit`: end without booting, because the
 * previous release is back (the service manager starts it) or its reinstall is to be retried.
 */
export function runNodeUpdateBootGuard(options: NodeUpdateBootGuardOptions): "boot" | "exit" {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.markerPath, "utf8"));
  } catch {
    // No marker (every ordinary start), or one the server will drop as unreadable.
    return "boot";
  }
  const marker = readGuardedNodeUpdateMarker(raw);
  if (marker === null || marker.settled || marker.rollback === null) return "boot";
  const nowMs = options.nowMs ?? Date.now();
  const decision = decideNodeUpdateBoot({
    marker,
    runningVersion: options.runningVersion(),
    nowMs,
  });
  if (decision.action === "boot") return "boot";
  const record = raw as Record<string, unknown>;
  // Counted before anything else, so a start that dies during a rollback moves on as well.
  writeMarkerAtomically(options.markerPath, { ...record, bootAttempts: decision.bootAttempts });
  if (decision.action === "count") {
    if (decision.bootAttempts === NODE_UPDATE_MAX_BOOT_ATTEMPTS + NODE_UPDATE_ROLLBACK_TRIES + 1) {
      log(
        `Ryco ${marker.targetVersion} has not finished starting since the update, and reinstalling ${marker.fromVersion} failed ${NODE_UPDATE_ROLLBACK_TRIES} times. Starting it anyway.`,
      );
    }
    return "boot";
  }

  const failedBoots = decision.bootAttempts - 1;
  log(
    `Ryco ${marker.targetVersion} did not finish starting after the update (${failedBoots} attempts). Reinstalling ${marker.fromVersion}.`,
  );
  const reinstall = runRecordedCommand(decision.plan.install);
  if (!reinstall.ok) {
    log(`Reinstalling ${marker.fromVersion} failed: ${reinstall.reason}.`);
    if (reinstall.output !== null) log(reinstall.output);
    return "exit";
  }
  const restore = restoreNodeUpdateSnapshot({
    plan: decision.plan,
    targetVersion: marker.targetVersion,
  });
  // The previous release is installed now, under this process: whatever happens next, this
  // start ends here. Without the record the previous release reports that it came back instead.
  try {
    writeMarkerAtomically(options.markerPath, {
      ...record,
      bootAttempts: decision.bootAttempts,
      rolledBack: {
        at: new Date(nowMs).toISOString(),
        failedBoots,
        databaseRestored: restore.ok,
        ...(restore.ok ? {} : { databaseError: restore.reason }),
        ...(reinstall.output === null ? {} : { output: reinstall.output }),
      },
    });
  } catch (cause) {
    log(`Could not record the rollback: ${errorText(cause)}.`);
  }
  log(
    restore.ok
      ? `Rolled back to Ryco ${marker.fromVersion} and restored the database from before the update.`
      : `Rolled back to Ryco ${marker.fromVersion}, but the database could not be restored: ${restore.reason}.`,
  );
  return "exit";
}

/** The release in the package manifest next to the entry script (`dist/bin.mjs`, `src/bin.ts`). */
const readPackageVersion = (entryUrl: string): string | null => {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", entryUrl), "utf8"));
  const version = (manifest as { readonly version?: unknown } | null)?.version;
  return typeof version === "string" ? version : null;
};

/**
 * The guard for this process, a `ryco service` start of `ryco serve` (bin.ts checks), given the
 * entry module's URL. Never throws: a guard that cannot run lets the node boot.
 */
export function guardNodeUpdateBoot(entryUrl: string): "boot" | "exit" {
  try {
    const stateDirectory = serveStateDirectory({
      args: process.argv.slice(3),
      env: process.env,
      homeDirectory: homedir(),
    });
    return runNodeUpdateBootGuard({
      markerPath: join(stateDirectory, NODE_UPDATE_MARKER_FILE_NAME),
      runningVersion: () => readPackageVersion(entryUrl),
    });
  } catch (cause) {
    process.stderr.write(`Ryco skipped its update check: ${errorText(cause)}\n`);
    return "boot";
  }
}
