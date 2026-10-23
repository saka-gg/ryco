/**
 * The one place that knows how a desktop backend child is started.
 *
 * Both the launch entry (which starts the first backend before the 2 MB main
 * bundle loads) and the main bundle (restarts, relaunches) use it, so spawn
 * arguments and the child environment cannot drift apart. Keep it free of
 * Electron and of heavy dependencies: it runs before the main bundle.
 */
import * as ChildProcess from "node:child_process";
import * as Path from "node:path";

import { deleteEnv } from "@ryco/shared/runtimeEnv";

import { removeDesktopOwnedHubEnvironment } from "./hubLaunchEnvironment.ts";

export const DESKTOP_BACKEND_BOOTSTRAP_FD = 3;
/**
 * Telemetry, lifecycle frames and the update channel, and the backend's tie to
 * this app: the backend shuts itself down when the pipe closes
 * (apps/server/src/desktopParentLifetime.ts). Keep it open for as long as the
 * backend should run; stop the backend instead of closing it.
 */
export const DESKTOP_BACKEND_TELEMETRY_FD = 4;

/**
 * V8 flags for a Node-mode (Electron) backend. A 16 MiB semi-space keeps the
 * young generation from growing to 128 MiB during boot and never shrinking,
 * which measured about 50 MiB lower idle RSS with no boot regression.
 */
export const DESKTOP_BACKEND_V8_FLAGS: ReadonlyArray<string> = ["--max-semi-space-size=16"];

const STDIO: ChildProcess.StdioOptions = ["ignore", "pipe", "pipe", "pipe", "pipe"];

export function resolveDesktopBackendEntry(appRoot: string): string {
  return Path.join(appRoot, "apps/server/dist/bin.mjs");
}

export function desktopBackendSpawnArgs(input: {
  readonly backendEntry: string;
  /** Electron in Node mode accepts V8 and `--require` flags; Bun (development) does not. */
  readonly nodeRuntime: boolean;
  readonly compileCacheHook: string | null;
}): string[] {
  return [
    ...(input.nodeRuntime ? DESKTOP_BACKEND_V8_FLAGS : []),
    ...(input.nodeRuntime && input.compileCacheHook !== null
      ? ["--require", input.compileCacheHook]
      : []),
    input.backendEntry,
    "--bootstrap-fd",
    String(DESKTOP_BACKEND_BOOTSTRAP_FD),
    // A desktop child is always a headless desktop backend, even if its
    // envelope never arrives: it must not boot as a web server and open a
    // browser. These equal what the envelope says, and as arguments (unlike
    // environment variables) they never reach the shells and CLIs it starts.
    "--mode",
    "desktop",
    "--no-browser",
  ];
}

/**
 * libuv threadpool size for the backend when the user's environment sets none.
 *
 * Node's default pool has 4 threads, shared by every async `fs` call, `dns.lookup`,
 * and async crypto/zlib work. The backend fans fs work out across project roots,
 * provider probes and git, and a few calls stuck on a slow volume (File Provider,
 * network or cloud-synced folders) or a slow resolver used to occupy all four, so
 * every other async fs call — including startup — queued behind them. 16 tolerates
 * a dozen stuck calls with the default 4 still free. The pool only does blocking
 * I/O and short CPU jobs, idle threads cost little (stacks are reserved, not
 * resident), and going much higher only adds contention for CPU-bound pool work.
 */
export const DESKTOP_BACKEND_UV_THREADPOOL_SIZE = "16";

export function createDesktopBackendChildEnv(
  base: NodeJS.ProcessEnv,
  input: {
    readonly isDevelopment: boolean;
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
    readonly resourcesPath: string;
  },
): NodeJS.ProcessEnv {
  const env = { ...base };
  deleteEnv(env, "RYCO_PORT");
  deleteEnv(env, "RYCO_MODE");
  deleteEnv(env, "RYCO_NO_BROWSER");
  deleteEnv(env, "RYCO_HOST");
  deleteEnv(env, "RYCO_DESKTOP_WS_URL");
  deleteEnv(env, "RYCO_DESKTOP_LAN_ACCESS");
  deleteEnv(env, "RYCO_DESKTOP_LAN_HOST");
  deleteEnv(env, "RYCO_DESKTOP_HTTPS_ENDPOINTS");
  deleteEnv(env, "RYCO_TAILSCALE_SERVE");
  deleteEnv(env, "RYCO_TAILSCALE_SERVE_PORT");
  // The desktop is the single owner of these values: it persists them and passes
  // them on the bootstrap channel. Leaving the environment able to override
  // would give the settings panel a toggle that silently does nothing, guarded
  // by a lock icon any same-user process could forge with `launchctl setenv`.
  // `ryco serve` is unaffected and stays fully env-configurable.
  removeDesktopOwnedHubEnvironment(env);
  // VITE_DEV_SERVER_URL must never reach the packaged backend: if a developer's
  // shell exports it, the server's Config.url parser throws and the backend
  // exits before HTTP listen, causing the desktop to spin in a restart loop.
  deleteEnv(env, "VITE_DEV_SERVER_URL");
  // Read by libuv when the child's pool starts. A value the user set wins; the
  // child's own children inherit it, which is harmless for them.
  if (!env.UV_THREADPOOL_SIZE?.trim()) env.UV_THREADPOOL_SIZE = DESKTOP_BACKEND_UV_THREADPOOL_SIZE;
  if (input.isPackaged && input.platform === "darwin") {
    env.RYCO_DEVICE_HELPER_SOURCE_DIR = Path.join(input.resourcesPath, "device-helper");
  }
  if (input.isDevelopment) {
    delete env.ELECTRON_RUN_AS_NODE;
  } else {
    // In Electron main, process.execPath points to the Electron binary. Run the
    // packaged child in Node mode so it does not become a GUI app instance.
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

export interface DesktopBackendChild {
  readonly child: ChildProcess.ChildProcess;
  /** `performance.now()` when the child was started. */
  readonly spawnedAtMs: number;
  /** A spawn failure reported before anyone else listened for it. */
  readonly spawnError: () => Error | null;
}

/**
 * Start a backend child with the bootstrap pipe left open for the envelope.
 * Errors that arrive before the owner attaches its own listeners are recorded
 * here instead of crashing the process.
 */
export function spawnDesktopBackend(input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn?: typeof ChildProcess.spawn;
}): DesktopBackendChild {
  const spawnedAtMs = performance.now();
  const child = (input.spawn ?? ChildProcess.spawn)(input.executable, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: STDIO,
  });
  let spawnError: Error | null = null;
  child.on("error", (error) => {
    spawnError ??= error;
  });
  // A child that dies before the envelope is written turns these writes into
  // EPIPE; that is reported through the child's own exit, never as a crash.
  for (const fd of [DESKTOP_BACKEND_BOOTSTRAP_FD, DESKTOP_BACKEND_TELEMETRY_FD]) {
    child.stdio[fd]?.on("error", () => undefined);
  }
  return { child, spawnedAtMs, spawnError: () => spawnError };
}

// ---------------------------------------------------------------------------
// Launch record: what the entry did before the main bundle loaded.
// ---------------------------------------------------------------------------

export interface EarlyDesktopBackend extends DesktopBackendChild {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

export interface DesktopLaunchRecord {
  /** `performance.now()` when the entry started (Electron's origin is process start). */
  readonly entryStartedAtMs: number;
  readonly compileCacheDir: string | null;
  /** PATH as inherited, before a cached shell environment was applied. */
  readonly inheritedPath: string | undefined;
  /** Whether the entry already applied a cached shell environment to `process.env`. */
  readonly shellEnvironmentApplied: boolean;
  earlyBackend: EarlyDesktopBackend | null;
}

const LAUNCH_RECORD_KEY = Symbol.for("ryco.desktop.launchRecord");

type LaunchRecordHolder = { [LAUNCH_RECORD_KEY]?: DesktopLaunchRecord };

export function publishDesktopLaunchRecord(record: DesktopLaunchRecord): void {
  (globalThis as LaunchRecordHolder)[LAUNCH_RECORD_KEY] = record;
}

export function readDesktopLaunchRecord(): DesktopLaunchRecord | null {
  return (globalThis as LaunchRecordHolder)[LAUNCH_RECORD_KEY] ?? null;
}

/** Hand the early backend to its owner exactly once. */
export function takeEarlyDesktopBackend(): EarlyDesktopBackend | null {
  const record = readDesktopLaunchRecord();
  const early = record?.earlyBackend ?? null;
  if (record) record.earlyBackend = null;
  return early;
}

/**
 * How long an early backend may wait for its bootstrap envelope. The backend
 * stops waiting after 10 s (apps/server/src/bootstrap.ts) and would then boot
 * without the desktop's port and tokens; an older child is replaced instead of
 * adopted. Its own module load comes first, so this leaves a margin.
 */
export const EARLY_DESKTOP_BACKEND_MAX_ADOPTION_DELAY_MS = 8_000;

export function isEarlyDesktopBackendStale(early: DesktopBackendChild, nowMs: number): boolean {
  return nowMs - early.spawnedAtMs > EARLY_DESKTOP_BACKEND_MAX_ADOPTION_DELAY_MS;
}

export function stopDesktopBackendChild(launched: DesktopBackendChild): void {
  if (launched.child.exitCode === null && launched.child.signalCode === null) {
    launched.child.kill("SIGTERM");
  }
}

/**
 * SIGTERM to SIGKILL grace for a backend that is shutting down. With an open
 * WebSocket a backend measured about 1.0-1.6 s from SIGTERM to exit, most of it
 * stopping provider children; a SIGKILL inside that window orphans them, so the
 * grace leaves a margin above the measured tail.
 */
export const DESKTOP_BACKEND_SIGTERM_GRACE_MS = 3_000;
/** How long a shutdown waits for the backend's exit at all before moving on. */
export const DESKTOP_BACKEND_EXIT_WAIT_MS = 5_000;

type TerminableChild = Pick<
  ChildProcess.ChildProcess,
  "exitCode" | "signalCode" | "kill" | "once" | "off"
>;

/**
 * SIGTERM a backend child, SIGKILL it after the grace, and resolve once it
 * exited or the wait is over. Never rejects.
 */
export function terminateDesktopBackendChild(
  child: TerminableChild,
  options: { readonly graceMs?: number; readonly timeoutMs?: number } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const graceMs = options.graceMs ?? DESKTOP_BACKEND_SIGTERM_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? DESKTOP_BACKEND_EXIT_WAIT_MS;
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      child.off("exit", settle);
      clearTimeout(forceKillTimer);
      clearTimeout(exitWaitTimer);
      resolve();
    };
    child.once("exit", settle);
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, graceMs);
    forceKillTimer.unref?.();
    const exitWaitTimer = setTimeout(settle, timeoutMs);
    exitWaitTimer.unref?.();
    child.kill("SIGTERM");
  });
}

/** Stop an early backend nobody adopted (startup failed or the app is quitting). */
export function discardEarlyDesktopBackend(): void {
  const early = takeEarlyDesktopBackend();
  if (early) stopDesktopBackendChild(early);
}
