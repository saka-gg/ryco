import * as NodePath from "node:path";
import * as OS from "node:os";
import { Effect, Path } from "effect";
import type {
  CommandAvailabilityOptions,
  ShellEnvironmentReader,
  WindowsEnvironmentProbeOptions,
  WindowsShellEnvironmentReader,
} from "@ryco/shared/shell";
import {
  applyShellEnvironment,
  applyShellEnvironmentCache,
  boundedShellEnvironmentReaders,
  createShellEnvironmentCacheRecord,
  createShellEnvironmentProbeFailureRecord,
  isShellEnvironmentCacheForAnotherShell,
  readShellEnvironmentCache,
  resolveShellEnvironmentAsync,
  resolveShellEnvironmentSync,
  SHELL_ENVIRONMENT_CACHE_FILE_NAME,
  SHELL_ENVIRONMENT_PROBE_FAILED,
  SHELL_REFRESH_TIMEOUT_MS,
  type ShellEnvironment,
  writeShellEnvironmentCache,
} from "@ryco/shared/shellEnvironment";

type WindowsCommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => boolean;

/** Re-probe the login shell this long after start, off the boot path. */
const SHELL_ENVIRONMENT_REFRESH_DELAY_MS = 3_000;

function logPathHydrationWarning(message: string, error?: unknown): void {
  console.warn(`[server] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

/**
 * The login-shell result cache, shared with Ryco Desktop on the same state
 * directory. The shell environment belongs to the user, not to one server, so
 * only `RYCO_HOME` (never `--base-dir`, which is unknown this early) selects it.
 */
export function resolveShellEnvironmentCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RYCO_HOME?.trim();
  const baseDir =
    configured === undefined || configured.length === 0
      ? NodePath.join(OS.homedir(), ".ryco")
      : configured === "~"
        ? OS.homedir()
        : configured.startsWith("~/") || configured.startsWith("~\\")
          ? NodePath.join(OS.homedir(), configured.slice(2))
          : NodePath.resolve(configured);
  return NodePath.join(baseDir, "userdata", SHELL_ENVIRONMENT_CACHE_FILE_NAME);
}

function scheduleShellEnvironmentRefresh(refresh: () => Promise<void>): void {
  setTimeout(() => void refresh(), SHELL_ENVIRONMENT_REFRESH_DELAY_MS).unref();
}

/**
 * Give a web, CLI or service server the user's login-shell PATH (PowerShell's on
 * Windows).
 *
 * A cached result from an earlier start is applied synchronously (well under a
 * millisecond) and refreshed in the background once the server is up. Only a
 * start with no usable cache runs the shell before serving, and that probe is
 * bounded: SIGKILL after 1.5 s, stdin closed, run from the home directory. When
 * it delivers no PATH (a profile slower than the bound), that is remembered:
 * later starts skip the blocking probe, and every start retries in the
 * background with a longer bound until the shell answers. A failed or slow
 * refresh keeps the PATH already in effect.
 */
export function fixPath(
  options: {
    inheritedFromDesktop?: boolean;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    readWindowsEnvironment?: WindowsShellEnvironmentReader;
    isWindowsCommandAvailable?: WindowsCommandAvailabilityChecker;
    readLaunchctlPath?: () => string | undefined;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
    /** Where the last shell result is kept; `null` disables caching. */
    cachePath?: string | null;
    scheduleRefresh?: (refresh: () => Promise<void>) => void;
  } = {},
): void {
  // Desktop already resolves and passes its environment. Probing its profile a
  // second time can block the backend and repeat OS permission requests.
  if (options.inheritedFromDesktop) return;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return;
  const env = options.env ?? process.env;
  const logWarning = options.logWarning ?? logPathHydrationWarning;
  // Probes read the inherited environment so a refreshed cache never carries
  // forward entries that only came from an earlier cache.
  const inheritedEnv: NodeJS.ProcessEnv = { ...env };
  const injectedReaders = {
    ...(options.readEnvironment ? { readEnvironment: options.readEnvironment } : {}),
    ...(options.readLaunchctlPath ? { readLaunchctlPath: options.readLaunchctlPath } : {}),
    ...(options.userShell === undefined ? {} : { userShell: options.userShell }),
    platform,
    logWarning,
  };
  // Synchronous probes only run before serving; the refresh uses async probes.
  const syncReaders = {
    ...boundedShellEnvironmentReaders(inheritedEnv),
    ...(options.readWindowsEnvironment
      ? { readWindowsEnvironment: options.readWindowsEnvironment }
      : {}),
    ...(options.isWindowsCommandAvailable
      ? { isWindowsCommandAvailable: options.isWindowsCommandAvailable }
      : {}),
    ...injectedReaders,
  };
  const { readWindowsEnvironment, isWindowsCommandAvailable } = options;
  const asyncReaders = {
    ...injectedReaders,
    ...(readWindowsEnvironment
      ? {
          readWindowsEnvironment: async (
            names: ReadonlyArray<string>,
            probeOptions: WindowsEnvironmentProbeOptions,
          ) => readWindowsEnvironment(names, probeOptions),
        }
      : {}),
    ...(isWindowsCommandAvailable
      ? {
          isWindowsCommandAvailable: async (
            command: string,
            commandOptions: CommandAvailabilityOptions,
          ) => isWindowsCommandAvailable(command, commandOptions),
        }
      : {}),
    timeoutMs: SHELL_REFRESH_TIMEOUT_MS,
  };

  const cachePath =
    options.cachePath === undefined ? resolveShellEnvironmentCachePath(env) : options.cachePath;
  const writeCache = (record: Parameters<typeof writeShellEnvironmentCache>[1]) => {
    if (cachePath === null) return;
    try {
      writeShellEnvironmentCache(cachePath, record);
    } catch (error) {
      logWarning("Failed to write the shell environment cache.", error);
    }
  };
  const remember = (environment: ShellEnvironment) => {
    if (Object.keys(environment).length === 0) return;
    writeCache(
      createShellEnvironmentCacheRecord({ environment, shell: inheritedEnv.SHELL, platform }),
    );
  };
  // Off the startup path, so the slower bound applies; nothing is applied or
  // written unless the shell answered.
  const refresh = async () => {
    const environment = await resolveShellEnvironmentAsync(inheritedEnv, asyncReaders);
    if (Object.keys(environment).length === 0) return;
    applyShellEnvironment(env, environment, platform);
    remember(environment);
  };
  const scheduleRefresh = options.scheduleRefresh ?? scheduleShellEnvironmentRefresh;

  const cached =
    cachePath === null
      ? null
      : readShellEnvironmentCache(cachePath, { platform, currentShell: env.SHELL ?? null });
  if (cached?.kind === "hit") {
    applyShellEnvironmentCache(env, cached.record);
    scheduleRefresh(refresh);
    return;
  }
  if (cached?.kind === "miss" && cached.reason === SHELL_ENVIRONMENT_PROBE_FAILED) {
    // The last blocking probe got nothing in time; do not block this start on it again.
    scheduleRefresh(refresh);
    return;
  }

  try {
    const environment = resolveShellEnvironmentSync(inheritedEnv, syncReaders);
    applyShellEnvironment(env, environment, platform);
    if (Object.keys(environment).length > 0) {
      remember(environment);
    } else if (cached === null || !isShellEnvironmentCacheForAnotherShell(cached)) {
      writeCache(createShellEnvironmentProbeFailureRecord({ shell: inheritedEnv.SHELL, platform }));
    }
    if (!environment.PATH) scheduleRefresh(refresh);
  } catch (error) {
    logWarning("Failed to hydrate PATH from the user environment.", error);
  }
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(OS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(OS.homedir(), ".ryco");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
