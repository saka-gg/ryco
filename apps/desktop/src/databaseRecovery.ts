/**
 * databaseRecovery - restores the newest usable database backup when the backend refused to
 * start because a newer Ryco upgraded its database (`database-schema-newer`).
 *
 * The desktop runs its own server CLI for it, the way it runs the backend (same executable,
 * environment and entry), with `db list --json` and `db restore <file> --replace --json`
 * (docs/database-backups.md). The restore keeps everything it replaces and refuses while anything
 * else uses the database, so the only thing decided here is which backup to offer: the newest one
 * this build can open whose check did not fail. Electron-free, so it is testable.
 *
 * @module databaseRecovery
 */
import * as ChildProcess from "node:child_process";

import { DESKTOP_BACKEND_V8_FLAGS } from "./backendLauncher.ts";

/** `db list` reads a directory; it answers in well under a second. */
export const DATABASE_LIST_TIMEOUT_MS = 30_000;
/** `db restore` decompresses and checks the whole database: tens of seconds for 10 GB. */
export const DATABASE_RESTORE_TIMEOUT_MS = 10 * 60_000;

export interface ServerCliLaunch {
  readonly executable: string;
  readonly backendEntry: string;
  /** Electron in Node mode takes V8 and `--require` flags; Bun (development) does not. */
  readonly nodeRuntime: boolean;
  readonly compileCacheHook: string | null;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** The backend's data directory (`--base-dir`). */
  readonly baseDir: string;
  /** Development: the dev server URL, which selects the `dev` state directory. */
  readonly devUrl: string | null;
}

/** The arguments that run `command` of the server CLI against the backend's data directory. */
export function serverCliArgs(launch: ServerCliLaunch, command: ReadonlyArray<string>): string[] {
  return [
    ...(launch.nodeRuntime ? DESKTOP_BACKEND_V8_FLAGS : []),
    ...(launch.nodeRuntime && launch.compileCacheHook !== null
      ? ["--require", launch.compileCacheHook]
      : []),
    launch.backendEntry,
    ...command,
    "--base-dir",
    launch.baseDir,
    ...(launch.devUrl === null ? [] : ["--dev-url", launch.devUrl]),
    "--json",
  ];
}

export interface ServerCliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Runs the server CLI and collects its output; a run past `timeoutMs` is killed. Never rejects. */
export function runServerCli(
  launch: ServerCliLaunch,
  command: ReadonlyArray<string>,
  timeoutMs: number,
  spawn: typeof ChildProcess.spawn = ChildProcess.spawn,
): Promise<ServerCliResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    let child: ChildProcess.ChildProcess;
    try {
      child = spawn(launch.executable, serverCliArgs(launch, command), {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
        timedOut,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += error.message;
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}

export interface RestorableBackup {
  readonly path: string;
  /** When it was taken (epoch ms). */
  readonly createdAt: number;
  readonly kind: string;
  /** The schema it holds. */
  readonly schema: number;
}

/** The last line of `--json` output: the one document the command printed. */
function lastJsonLine(stdout: string): unknown {
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined || line.length === 0) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * The newest backup in `db list --json` output that this build opens and whose integrity check
 * did not fail, or null.
 */
export function pickRestorableBackup(stdout: string): RestorableBackup | null {
  const document = lastJsonLine(stdout) as { readonly backups?: unknown } | undefined;
  if (!document || !Array.isArray(document.backups)) return null;
  const candidates: RestorableBackup[] = [];
  for (const entry of document.backups as ReadonlyArray<Record<string, unknown>>) {
    if (entry === null || typeof entry !== "object") continue;
    if (entry.opensWithThisBuild !== true) continue;
    if (entry.state !== "finalized" && entry.state !== "raw") continue;
    const createdAt = typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : NaN;
    if (typeof entry.path !== "string" || Number.isNaN(createdAt)) continue;
    candidates.push({
      path: entry.path,
      createdAt,
      kind: typeof entry.kind === "string" ? entry.kind : "unknown",
      schema: typeof entry.from === "number" ? entry.from : 0,
    });
  }
  return candidates.toSorted((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

export type RestoreOutcome =
  | {
      readonly ok: true;
      /** Where the replaced database, its WAL files and the signing key went. */
      readonly replacedDir: string;
      readonly signedOut: boolean;
      /** Unused pairing links and integration credentials revoked in the restored database. */
      readonly revoked: { readonly pairingLinks: number; readonly integrations: number };
      readonly warnings: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly message: string };

/** What `db restore --replace --json` did, from its output. */
export function readRestoreOutcome(result: ServerCliResult): RestoreOutcome {
  if (result.timedOut) {
    return { ok: false, message: "The restore did not finish in time and was stopped." };
  }
  const document = lastJsonLine(result.stdout) as Record<string, unknown> | undefined;
  if (result.exitCode === 0 && document && typeof document.replacedDir === "string") {
    const revoked = (document.revoked ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      replacedDir: document.replacedDir,
      signedOut: document.signedOut === true,
      revoked: {
        pairingLinks: typeof revoked.pairingLinks === "number" ? revoked.pairingLinks : 0,
        integrations: typeof revoked.integrations === "number" ? revoked.integrations : 0,
      },
      warnings: Array.isArray(document.warnings)
        ? document.warnings.filter((warning): warning is string => typeof warning === "string")
        : [],
    };
  }
  // A command that cannot go ahead prints one line starting with `Error:`.
  const errorLine = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
  return {
    ok: false,
    message:
      errorLine?.replace(/^Error:\s*/, "") ??
      `The restore stopped (exit code ${result.exitCode ?? "none"}).`,
  };
}
