import * as NodePath from "node:path";
import * as OS from "node:os";
import { Effect, Path } from "effect";
import type {
  CommandAvailabilityOptions,
  ShellEnvironmentReader,
  WindowsShellEnvironmentReader,
} from "@ryco/shared/shell";
import {
  applyShellEnvironment,
  applyShellEnvironmentCache,
  boundedShellEnvironmentReaders,
  createShellEnvironmentCacheRecord,
  readShellEnvironmentCache,
  resolveShellEnvironmentAsync,
  resolveShellEnvironmentSync,
  SHELL_ENVIRONMENT_CACHE_FILE_NAME,
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
 * Give a web, CLI or service server the user's login-shell PATH.
 *
 * A cached result from an earlier start is applied synchronously (well under a
 * millisecond) and refreshed in the background once the server is up. Only the
 * very first start runs the shell before serving, and that probe is bounded:
 * SIGKILL after 1.5 s, stdin closed, run from the home directory. A failed or
 * slow refresh keeps the cached PATH in effect.
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

  if (platform === "win32") {
    applyShellEnvironment(env, resolveShellEnvironmentSync(inheritedEnv, syncReaders), platform);
    return;
  }
  if (platform !== "darwin" && platform !== "linux") return;

  const cachePath =
    options.cachePath === undefined ? resolveShellEnvironmentCachePath(env) : options.cachePath;
  const remember = (environment: ShellEnvironment) => {
    if (cachePath === null || Object.keys(environment).length === 0) return;
    try {
      writeShellEnvironmentCache(
        cachePath,
        createShellEnvironmentCacheRecord({ environment, shell: inheritedEnv.SHELL, platform }),
      );
    } catch (error) {
      logWarning("Failed to write the shell environment cache.", error);
    }
  };

  const cached =
    cachePath === null
      ? null
      : readShellEnvironmentCache(cachePath, { platform, currentShell: env.SHELL ?? null });
  if (cached?.kind === "hit") {
    applyShellEnvironmentCache(env, cached.record);
    (options.scheduleRefresh ?? scheduleShellEnvironmentRefresh)(async () => {
      const environment = await resolveShellEnvironmentAsync(inheritedEnv, injectedReaders);
      if (Object.keys(environment).length === 0) return;
      applyShellEnvironment(env, environment, platform);
      remember(environment);
    });
    return;
  }

  try {
    const environment = resolveShellEnvironmentSync(inheritedEnv, syncReaders);
    applyShellEnvironment(env, environment, platform);
    remember(environment);
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
