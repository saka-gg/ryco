/**
 * Startup recovery of the child processes an import job left behind when its server crashed.
 *
 * Steps spawn git and the setup command detached, as their own process group, and record the
 * child (`ProjectCopyChildProcess`) before it does any work. After a crash those children keep
 * running and writing into the job's staging directory, so recovery stops them before it deletes
 * anything: it signals the group only when the pid still belongs to the same process (its start
 * time matches the recorded one), so a reused pid is never signalled.
 *
 * @module projectImportProcesses
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Effect } from "effect";

import type { ProjectCopyChildProcess } from "./Services/ProjectCopyProcess.ts";

const execFileAsync = promisify(execFile);

/** How the recorded child turned out: stopped by us, already gone, or not provably ours. */
export type RecordedChildOutcome = "stopped" | "gone" | "not-ours";

export interface ProjectImportProcessControl {
  /**
   * Stops a recorded child's process group when it still runs and is the same process: SIGTERM,
   * then SIGKILL after the grace period; completes once it exited (or was given up on). Never
   * fails.
   */
  readonly stopRecordedChild: (
    child: ProjectCopyChildProcess,
  ) => Effect.Effect<RecordedChildOutcome>;
}

/** The recorded start is read right after the spawn: the OS's start is at most this much earlier. */
const START_TIME_EARLIEST_MS = 10_000;
/** `ps` reports whole seconds, truncated. */
const START_TIME_LATEST_MS = 1_000;
const TERMINATE_GRACE_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const POLL_INTERVAL_MS = 100;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but someone else's, which a job's child never is; treat it as not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** When the OS says `pid` started (ms since the epoch), or null when it cannot tell. */
const osStartTime = async (pid: number): Promise<number | null> => {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { timeout: 10_000, windowsHide: true },
      );
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    // `lstart` is local time in the C locale's format, e.g. "Thu Oct 22 14:03:12 2026".
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: 5_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const signalGroup = (child: ProjectCopyChildProcess, signal: NodeJS.Signals): void => {
  try {
    // A negative pid signals the whole group: git's helpers (index-pack, ssh) die with it.
    process.kill(child.pgid !== null && child.pgid > 0 ? -child.pgid : child.pid, signal);
  } catch {
    // Already gone.
  }
};

const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return !isAlive(pid);
};

const stopRecordedChild = async (child: ProjectCopyChildProcess): Promise<RecordedChildOutcome> => {
  if (!Number.isInteger(child.pid) || child.pid <= 0 || !isAlive(child.pid)) return "gone";
  const recorded = Date.parse(child.startedAt);
  const started = await osStartTime(child.pid);
  if (
    started === null ||
    !Number.isFinite(recorded) ||
    started < recorded - START_TIME_EARLIEST_MS ||
    started > recorded + START_TIME_LATEST_MS
  ) {
    return isAlive(child.pid) ? "not-ours" : "gone";
  }
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      timeout: 10_000,
      windowsHide: true,
    }).catch(() => undefined);
    await waitForExit(child.pid, KILL_WAIT_MS);
    return "stopped";
  }
  signalGroup(child, "SIGTERM");
  if (!(await waitForExit(child.pid, TERMINATE_GRACE_MS))) {
    signalGroup(child, "SIGKILL");
    await waitForExit(child.pid, KILL_WAIT_MS);
  }
  return "stopped";
};

/** The operating system's processes. */
export const osProjectImportProcessControl: ProjectImportProcessControl = {
  stopRecordedChild: (child) =>
    Effect.promise(() => stopRecordedChild(child).catch(() => "gone" as const)),
};
