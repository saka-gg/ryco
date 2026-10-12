/**
 * Login-shell environment discovery shared by the desktop main process and the
 * server CLI.
 *
 * GUI and service launches inherit a minimal PATH, so the user's login shell is
 * asked for it. That probe runs the user's profile, which can be slow (nvm,
 * conda) or hang (a prompt, a dead network mount), so it is:
 *
 * - bounded: SIGKILL after 1.5 s (interactive zsh ignores SIGTERM), stdin
 *   closed, and run from the home directory so project hooks (direnv, asdf)
 *   never fire;
 * - cached: the last result is applied synchronously at the next start and
 *   refreshed afterwards (stale-while-revalidate), so only a launch with no
 *   cache at all waits for a shell;
 * - additive: a failed or timed-out probe never removes a PATH entry that is
 *   already in effect.
 */
import { execFile, execFileSync } from "node:child_process";
import * as FS from "node:fs";
import { homedir } from "node:os";
import * as Path from "node:path";
import { parentPort, Worker, workerData } from "node:worker_threads";

import {
  type CommandAvailabilityOptions,
  type ExecFileSyncLike,
  LAUNCHCTL_PATH_COMMAND,
  listLoginShellCandidates,
  loginShellEnvironmentArgs,
  mergePathEntries,
  parseLaunchctlPathOutput,
  parseLoginShellEnvironmentOutput,
  readEnvironmentFromLoginShell,
  readEnvironmentFromWindowsShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
  type ShellEnvironmentReader,
  type WindowsShellEnvironmentReader,
} from "./shell.ts";

/** Every variable the shell environment can contribute, in cache order. */
export const SHELL_ENVIRONMENT_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
] as const;

/** The variables asked of a POSIX login shell. */
export const LOGIN_SHELL_ENVIRONMENT_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export type ShellEnvironmentName = (typeof SHELL_ENVIRONMENT_NAMES)[number];
export type ShellEnvironment = Partial<Record<ShellEnvironmentName, string>>;

/** Upper bound for one shell probe. Interactive zsh ignores SIGTERM, so SIGKILL. */
export const SHELL_PROBE_TIMEOUT_MS = 1_500;

export function pickShellEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const environment: ShellEnvironment = {};
  for (const name of SHELL_ENVIRONMENT_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      environment[name] = value;
    }
  }
  return environment;
}

/**
 * Merge shell-derived values into `env`: the shell's PATH entries come first,
 * every inherited entry is kept, and other variables only fill gaps so an
 * explicitly inherited value (an agent socket, say) always wins.
 */
export function applyShellEnvironment(
  env: NodeJS.ProcessEnv,
  environment: ShellEnvironment,
  platform: NodeJS.Platform = process.platform,
): void {
  const mergedPath = mergePathEntries(environment.PATH, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }

  for (const name of SHELL_ENVIRONMENT_NAMES) {
    if (name === "PATH") continue;
    const value = environment[name];
    if (value && !env[name]) {
      env[name] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution: one implementation, driven synchronously or asynchronously.
// ---------------------------------------------------------------------------

type ShellProbeRequest =
  | { readonly kind: "login-shell"; readonly shell: string }
  | { readonly kind: "launchctl-path" };

type MaybePromise<A> = A | Promise<A>;

export interface ShellEnvironmentResolveOptions {
  readonly platform?: NodeJS.Platform;
  readonly userShell?: string;
  readonly logWarning?: (message: string, error?: unknown) => void;
}

export interface ShellEnvironmentSyncReaders extends ShellEnvironmentResolveOptions {
  readonly readEnvironment?: ShellEnvironmentReader;
  readonly readLaunchctlPath?: () => string | undefined;
  readonly readWindowsEnvironment?: WindowsShellEnvironmentReader;
  readonly isWindowsCommandAvailable?: (
    command: string,
    options?: CommandAvailabilityOptions,
  ) => boolean;
}

export interface ShellEnvironmentAsyncReaders extends ShellEnvironmentResolveOptions {
  readonly readEnvironment?: (
    shell: string,
    names: ReadonlyArray<string>,
  ) => MaybePromise<Partial<Record<string, string>>>;
  readonly readLaunchctlPath?: () => MaybePromise<string | undefined>;
}

function defaultLogWarning(message: string, error?: unknown): void {
  console.warn(
    `[shell-environment] ${message}`,
    error instanceof Error ? error.message : (error ?? ""),
  );
}

/** The POSIX resolution steps; drivers answer each probe request. */
function* posixShellEnvironmentSteps(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: ShellEnvironmentResolveOptions,
): Generator<ShellProbeRequest, ShellEnvironment, unknown> {
  const logWarning = options.logWarning ?? defaultLogWarning;
  const shellEnvironment: Partial<Record<string, string>> = {};
  for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
    try {
      const result = (yield { kind: "login-shell", shell }) as Partial<Record<string, string>>;
      Object.assign(shellEnvironment, result);
      if (shellEnvironment.PATH) break;
    } catch (error) {
      logWarning(`Failed to read login shell environment from ${shell}.`, error);
    }
  }

  if (platform === "darwin" && !shellEnvironment.PATH) {
    try {
      const launchctlPath = (yield { kind: "launchctl-path" }) as string | undefined;
      if (launchctlPath) shellEnvironment.PATH = launchctlPath;
    } catch {
      // launchd has no PATH for this session.
    }
  }

  return pickShellEnvironment(shellEnvironment);
}

function isPosixShellPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function resolveWindowsShellEnvironment(
  env: NodeJS.ProcessEnv,
  options: ShellEnvironmentSyncReaders,
): ShellEnvironment {
  const repaired = resolveWindowsEnvironment(env, {
    ...(options.readWindowsEnvironment ? { readEnvironment: options.readWindowsEnvironment } : {}),
    ...(options.isWindowsCommandAvailable
      ? { commandAvailable: options.isWindowsCommandAvailable }
      : {}),
  });
  return pickShellEnvironment(repaired);
}

/**
 * Ask the user's login shell (or PowerShell on Windows) for its environment.
 * Returns only the shell-derived values; `applyShellEnvironment` merges them.
 * Never throws: a failed probe yields an empty result.
 */
export function resolveShellEnvironmentSync(
  env: NodeJS.ProcessEnv,
  options: ShellEnvironmentSyncReaders = {},
): ShellEnvironment {
  const platform = options.platform ?? process.platform;
  const logWarning = options.logWarning ?? defaultLogWarning;
  try {
    if (platform === "win32") return resolveWindowsShellEnvironment(env, options);
    if (!isPosixShellPlatform(platform)) return {};

    const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;
    const readLaunchctlPath = options.readLaunchctlPath ?? readPathFromLaunchctl;
    const steps = posixShellEnvironmentSteps(env, platform, options);
    let next = steps.next();
    while (!next.done) {
      const request = next.value;
      let result: unknown;
      try {
        result =
          request.kind === "login-shell"
            ? readEnvironment(request.shell, LOGIN_SHELL_ENVIRONMENT_NAMES)
            : readLaunchctlPath();
      } catch (error) {
        next = steps.throw(error);
        continue;
      }
      next = steps.next(result);
    }
    return next.value;
  } catch (error) {
    logWarning("Failed to resolve the shell environment.", error);
    return {};
  }
}

/**
 * Non-blocking POSIX resolution for refreshes on a live event loop. Windows
 * resolution runs PowerShell and executable discovery synchronously, so it
 * belongs in a worker (`captureShellEnvironment`) and is not offered here.
 */
export async function resolveShellEnvironmentAsync(
  env: NodeJS.ProcessEnv,
  options: ShellEnvironmentAsyncReaders = {},
): Promise<ShellEnvironment> {
  const platform = options.platform ?? process.platform;
  if (!isPosixShellPlatform(platform)) return {};
  const logWarning = options.logWarning ?? defaultLogWarning;
  const execFileAsync = createBoundedShellExecFile(env);
  const readEnvironment =
    options.readEnvironment ??
    (async (shell: string, names: ReadonlyArray<string>) =>
      parseLoginShellEnvironmentOutput(
        await execFileAsync(shell, loginShellEnvironmentArgs(names)),
        names,
      ));
  const readLaunchctlPath =
    options.readLaunchctlPath ??
    (async () =>
      parseLaunchctlPathOutput(
        await execFileAsync(LAUNCHCTL_PATH_COMMAND.file, LAUNCHCTL_PATH_COMMAND.args),
      ));
  try {
    const steps = posixShellEnvironmentSteps(env, platform, options);
    let next = steps.next();
    while (!next.done) {
      const request = next.value;
      let result: unknown;
      try {
        result = await (request.kind === "login-shell"
          ? readEnvironment(request.shell, LOGIN_SHELL_ENVIRONMENT_NAMES)
          : readLaunchctlPath());
      } catch (error) {
        next = steps.throw(error);
        continue;
      }
      next = steps.next(result);
    }
    return next.value;
  } catch (error) {
    logWarning("Failed to resolve the shell environment.", error);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Bounded executors
// ---------------------------------------------------------------------------

// Run from the home directory so project hooks (direnv, asdf) never fire, and
// SIGKILL on timeout because interactive zsh ignores SIGTERM.
function boundedShellProbeOptions(env: NodeJS.ProcessEnv) {
  return {
    env,
    cwd: homedir(),
    encoding: "utf8" as const,
    timeout: SHELL_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL" as const,
    windowsHide: true,
  };
}

/** A synchronous executor with the shell-probe bounds; for workers and cache misses. */
export function createBoundedShellExecFileSync(env: NodeJS.ProcessEnv): ExecFileSyncLike {
  return (file, args) =>
    execFileSync(file, args, {
      ...boundedShellProbeOptions(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
}

export function createBoundedShellExecFile(
  env: NodeJS.ProcessEnv,
): (file: string, args: ReadonlyArray<string>) => Promise<string> {
  return (file, args) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(file, args, boundedShellProbeOptions(env), (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      });
      // A profile waiting on input sees end-of-file instead of hanging.
      child.stdin?.destroy();
    });
}

/** Sync readers bounded the same way as the off-thread capture. */
export function boundedShellEnvironmentReaders(
  env: NodeJS.ProcessEnv,
): Pick<
  ShellEnvironmentSyncReaders,
  "readEnvironment" | "readLaunchctlPath" | "readWindowsEnvironment"
> {
  const execute = createBoundedShellExecFileSync(env);
  return {
    readEnvironment: (shell, names) => readEnvironmentFromLoginShell(shell, names, execute),
    readLaunchctlPath: () => readPathFromLaunchctl(execute),
    readWindowsEnvironment: (names, windowsOptions) =>
      readEnvironmentFromWindowsShell(names, windowsOptions, execute),
  };
}

// ---------------------------------------------------------------------------
// Cache (stale-while-revalidate)
// ---------------------------------------------------------------------------

const CACHE_VERSION = 1;

export const SHELL_ENVIRONMENT_CACHE_FILE_NAME = "shell-environment-cache.json";

export interface ShellEnvironmentCacheRecord {
  readonly version: typeof CACHE_VERSION;
  readonly capturedAt: string;
  readonly platform: NodeJS.Platform;
  readonly shell: string | null;
  readonly environment: ShellEnvironment;
}

export type ShellEnvironmentCacheReadResult =
  | {
      readonly kind: "hit";
      readonly record: ShellEnvironmentCacheRecord;
      /** How old the record is. Any age is usable; callers refresh it after start. */
      readonly ageMs: number;
    }
  | { readonly kind: "miss"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeShell(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function createShellEnvironmentCacheRecord(input: {
  readonly environment: ShellEnvironment;
  readonly shell: string | null | undefined;
  readonly platform?: NodeJS.Platform;
  readonly now?: Date;
}): ShellEnvironmentCacheRecord {
  return {
    version: CACHE_VERSION,
    capturedAt: (input.now ?? new Date()).toISOString(),
    platform: input.platform ?? process.platform,
    shell: normalizeShell(input.shell),
    environment: pickShellEnvironment(input.environment),
  };
}

/**
 * Read the last captured environment. Age never invalidates a record: a stale
 * PATH is still far better than the GUI default, and the caller refreshes it
 * once the application is running. A different platform, cache format or
 * login shell does.
 */
export function readShellEnvironmentCache(
  cachePath: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly currentShell?: string | null;
    readonly now?: Date;
  } = {},
): ShellEnvironmentCacheReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(FS.readFileSync(cachePath, "utf8"));
  } catch {
    return { kind: "miss", reason: "unreadable" };
  }

  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION) {
    return { kind: "miss", reason: "version" };
  }

  const platform = options.platform ?? process.platform;
  if (parsed.platform !== platform) {
    return { kind: "miss", reason: "platform" };
  }

  if (typeof parsed.capturedAt !== "string") {
    return { kind: "miss", reason: "capturedAt" };
  }
  const capturedAtMs = Date.parse(parsed.capturedAt);
  if (!Number.isFinite(capturedAtMs)) {
    return { kind: "miss", reason: "capturedAt" };
  }

  const environment = isRecord(parsed.environment)
    ? pickShellEnvironment(parsed.environment as Record<string, string | undefined>)
    : null;
  if (!environment || Object.keys(environment).length === 0) {
    return { kind: "miss", reason: "environment" };
  }

  const cachedShell = normalizeShell(parsed.shell);
  const currentShell = normalizeShell(options.currentShell);
  if (cachedShell !== null && currentShell !== null && cachedShell !== currentShell) {
    return { kind: "miss", reason: "shell" };
  }

  return {
    kind: "hit",
    record: {
      version: CACHE_VERSION,
      capturedAt: parsed.capturedAt,
      platform,
      shell: cachedShell,
      environment,
    },
    ageMs: Math.max(0, (options.now ?? new Date()).getTime() - capturedAtMs),
  };
}

export function applyShellEnvironmentCache(
  env: NodeJS.ProcessEnv,
  record: ShellEnvironmentCacheRecord,
): void {
  applyShellEnvironment(env, record.environment, record.platform);
}

export function writeShellEnvironmentCache(
  cachePath: string,
  record: ShellEnvironmentCacheRecord,
): void {
  FS.mkdirSync(Path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  FS.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  FS.renameSync(tempPath, cachePath);
}

// ---------------------------------------------------------------------------
// Off-thread capture (desktop main must never run a profile on its own thread)
// ---------------------------------------------------------------------------

export interface CapturedShellEnvironment {
  readonly environment: ShellEnvironment;
  readonly warnings: readonly string[];
}

/** Body of the capture worker. Only shell-derived values are posted back. */
export function runShellEnvironmentWorker(): void {
  const env: NodeJS.ProcessEnv = { ...(workerData as { env: NodeJS.ProcessEnv }).env };
  const warnings: string[] = [];
  const environment = resolveShellEnvironmentSync(env, {
    ...boundedShellEnvironmentReaders(env),
    logWarning: (message) => warnings.push(message),
  });
  parentPort?.postMessage({ environment, warnings } satisfies CapturedShellEnvironment);
}

/** A single bounded attempt; a broken profile must not freeze or hold up startup. */
export function captureShellEnvironment(options: {
  readonly workerPath: string | URL;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<CapturedShellEnvironment | null> {
  if (options.signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(options.workerPath, { workerData: { env: { ...options.env } } });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: CapturedShellEnvironment | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Do not await termination: an OS filesystem call may itself be stuck.
      worker.unref();
      void worker.terminate().catch(() => undefined);
      resolve(value);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, options.timeoutMs ?? 2_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: CapturedShellEnvironment) => finish(value));
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}
