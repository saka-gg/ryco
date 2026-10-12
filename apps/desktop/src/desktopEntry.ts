import { spawn } from "node:child_process";
import * as FS from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { app } from "electron";
import {
  applyShellEnvironmentCache,
  readShellEnvironmentCache,
} from "@ryco/shared/shellEnvironment";

import {
  createDesktopBackendChildEnv,
  desktopBackendSpawnArgs,
  discardEarlyDesktopBackend,
  type EarlyDesktopBackend,
  publishDesktopLaunchRecord,
  resolveDesktopBackendEntry,
  spawnDesktopBackend,
} from "./backendLauncher.ts";
import {
  DESKTOP_COMPILE_CACHE_DIR_ENV,
  resolveDesktopCompileCacheDir,
  shouldUseDesktopCompileCache,
} from "./compileCacheDirectory.ts";
import { resolveDesktopPaths, resolveDesktopUserDataPath } from "./desktopPaths.ts";
import { externalBridgeLaunchArgs } from "./externalBridgeLaunch.ts";

// Electron's performance origin is process start, so this is the time Electron
// itself took before any Ryco code ran.
const entryStartedAtMs = performance.now();
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const compileCacheHook = resolve(__dirname, "compileCache.cjs");

/** Enable the V8 compile cache here and, through the environment, in Node-mode children. */
function enableDesktopCompileCache(): string | null {
  if (!shouldUseDesktopCompileCache({ isPackaged: app.isPackaged, env: process.env })) return null;
  try {
    const directory = resolveDesktopCompileCacheDir(
      resolveDesktopUserDataPath({ isDevelopment }),
      app.getVersion(),
    );
    process.env[DESKTOP_COMPILE_CACHE_DIR_ENV] = directory;
    require(compileCacheHook);
    return directory;
  } catch {
    return null;
  }
}

/**
 * Take the single-instance lock before anything expensive. It is keyed by the
 * userData directory, so that is set first. A refused second instance exits
 * here, without loading the main bundle or starting a backend.
 */
function claimPrimaryInstance(): boolean {
  app.setPath("userData", resolveDesktopUserDataPath({ isDevelopment }));
  if (app.requestSingleInstanceLock()) return true;
  app.exit(0);
  return false;
}

/**
 * Apply the last captured login-shell environment (PATH and friends) to this
 * process, so the early backend and everything it starts inherit it.
 */
function applyCachedShellEnvironment(): boolean {
  try {
    const { shellEnvironmentCachePath } = resolveDesktopPaths({
      configuredBaseDir: process.env.RYCO_HOME,
      isDevelopment: false,
    });
    const cached = readShellEnvironmentCache(shellEnvironmentCachePath, {
      currentShell: process.env.SHELL ?? null,
    });
    if (cached.kind !== "hit") return false;
    applyShellEnvironmentCache(process.env, cached.record);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the backend now: it is the critical path to a usable window, and none
 * of its inputs need Electron to be ready. The main bundle writes the bootstrap
 * envelope (port, tokens, computer-use binding) once it has them; the backend
 * spends its own module load waiting for it. A launch without a cached shell
 * environment starts it too: the main bundle captures the environment
 * meanwhile and delivers it in the envelope, which the backend applies before
 * it builds anything.
 */
function startEarlyBackend(input: {
  readonly compileCacheDir: string | null;
  readonly backendEntry: string;
}): EarlyDesktopBackend | null {
  try {
    if (!FS.existsSync(input.backendEntry)) return null;
    const executable = process.execPath;
    const args = desktopBackendSpawnArgs({
      backendEntry: input.backendEntry,
      nodeRuntime: true,
      compileCacheHook: input.compileCacheDir === null ? null : compileCacheHook,
    });
    const launched = spawnDesktopBackend({
      executable,
      args,
      cwd: homedir(),
      env: createDesktopBackendChildEnv(process.env, {
        isDevelopment: false,
        isPackaged: true,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
      }),
    });
    return { ...launched, executable, args };
  } catch {
    // The main bundle starts the backend itself and reports any failure.
    return null;
  }
}

// Installed MCP configurations invoke the runtime executable directly. For a
// packaged app that is Electron, so dispatch before loading any GUI services.
const bridgeArgs = app.isPackaged
  ? externalBridgeLaunchArgs(process.argv, resolveDesktopBackendEntry(app.getAppPath()))
  : null;

if (bridgeArgs !== null) {
  // Existing MCP configurations may launch Electron without RUN_AS_NODE. This
  // forwarding process must stay headless too, not just its Node-mode child.
  app.dock?.hide();
  const compileCacheDir = enableDesktopCompileCache();
  const bridge = spawn(
    process.execPath,
    compileCacheDir === null ? bridgeArgs : ["--require", compileCacheHook, ...bridgeArgs],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
    },
  );
  bridge.once("error", () => {
    process.stderr.write("Could not start the Ryco MCP bridge.\n");
    app.exit(1);
  });
  bridge.once("exit", (code) => app.exit(code ?? 1));
  app.on("before-quit", () => bridge.kill("SIGTERM"));
  process.once("SIGTERM", () => bridge.kill("SIGTERM"));
  process.once("SIGINT", () => bridge.kill("SIGINT"));
} else {
  const compileCacheDir = enableDesktopCompileCache();
  const inheritedPath = process.env.PATH;
  const packagedLaunch = app.isPackaged && !isDevelopment;
  if (!packagedLaunch || claimPrimaryInstance()) {
    let shellEnvironmentApplied = false;
    let earlyBackend: EarlyDesktopBackend | null = null;
    if (packagedLaunch) {
      shellEnvironmentApplied = applyCachedShellEnvironment();
      earlyBackend = startEarlyBackend({
        compileCacheDir,
        backendEntry: resolveDesktopBackendEntry(app.getAppPath()),
      });
    }
    publishDesktopLaunchRecord({
      entryStartedAtMs,
      compileCacheDir,
      inheritedPath,
      shellEnvironmentApplied,
      earlyBackend,
    });
    try {
      // Keep normal initialization synchronous: protocol registration must precede ready.
      require(resolve(__dirname, "desktopMain.cjs"));
    } catch (error) {
      discardEarlyDesktopBackend();
      throw error;
    }
  }
}
