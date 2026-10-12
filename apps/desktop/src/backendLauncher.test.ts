import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopBackendChildEnv,
  DESKTOP_BACKEND_EXIT_WAIT_MS,
  DESKTOP_BACKEND_SIGTERM_GRACE_MS,
  desktopBackendSpawnArgs,
  discardEarlyDesktopBackend,
  EARLY_DESKTOP_BACKEND_MAX_ADOPTION_DELAY_MS,
  type EarlyDesktopBackend,
  isEarlyDesktopBackendStale,
  publishDesktopLaunchRecord,
  readDesktopLaunchRecord,
  spawnDesktopBackend,
  takeEarlyDesktopBackend,
  terminateDesktopBackendChild,
} from "./backendLauncher.ts";

function makeChild() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stdio: [null, new EventEmitter(), new EventEmitter(), new EventEmitter(), new EventEmitter()],
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ryco.desktop.launchRecord")];
});

describe("desktopBackendSpawnArgs", () => {
  it("caps the young generation and preloads the compile cache in Node mode", () => {
    expect(
      desktopBackendSpawnArgs({
        backendEntry: "/app/apps/server/dist/bin.mjs",
        nodeRuntime: true,
        compileCacheHook: "/app/apps/desktop/dist-electron/compileCache.cjs",
      }),
    ).toEqual([
      "--max-semi-space-size=16",
      "--require",
      "/app/apps/desktop/dist-electron/compileCache.cjs",
      "/app/apps/server/dist/bin.mjs",
      "--bootstrap-fd",
      "3",
      "--mode",
      "desktop",
      "--no-browser",
    ]);
  });

  it("passes no Node flags to Bun in development", () => {
    expect(
      desktopBackendSpawnArgs({
        backendEntry: "/repo/apps/server/dist/bin.mjs",
        nodeRuntime: false,
        compileCacheHook: "/repo/compileCache.cjs",
      }),
    ).toEqual([
      "/repo/apps/server/dist/bin.mjs",
      "--bootstrap-fd",
      "3",
      "--mode",
      "desktop",
      "--no-browser",
    ]);
  });
});

describe("createDesktopBackendChildEnv", () => {
  const packaged = {
    isDevelopment: false,
    isPackaged: true,
    platform: "darwin" as const,
    resourcesPath: "/Applications/Ryco.app/Contents/Resources",
  };

  it("keeps desktop-owned settings out of the inherited environment", () => {
    const env = createDesktopBackendChildEnv(
      {
        PATH: "/usr/bin",
        RYCO_PORT: "1",
        RYCO_MODE: "web",
        RYCO_NO_BROWSER: "false",
        RYCO_HUB_ORIGIN: "https://evil.example",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
      },
      packaged,
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
      RYCO_DEVICE_HELPER_SOURCE_DIR: "/Applications/Ryco.app/Contents/Resources/device-helper",
    });
  });

  it("runs development children under Bun rather than Electron's Node mode", () => {
    const env = createDesktopBackendChildEnv(
      { ELECTRON_RUN_AS_NODE: "1" },
      { ...packaged, isDevelopment: true, isPackaged: false },
    );
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.RYCO_DEVICE_HELPER_SOURCE_DIR).toBeUndefined();
  });
});

describe("spawnDesktopBackend", () => {
  it("records failures that arrive before an owner listens, without crashing", () => {
    const child = makeChild();
    const spawn = vi.fn(() => child);
    const launched = spawnDesktopBackend({
      executable: "/electron",
      args: ["bin.mjs", "--bootstrap-fd", "3"],
      cwd: "/home/me",
      env: { PATH: "/usr/bin" },
      spawn: spawn as never,
    });

    expect(spawn).toHaveBeenCalledWith("/electron", ["bin.mjs", "--bootstrap-fd", "3"], {
      cwd: "/home/me",
      env: { PATH: "/usr/bin" },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    expect(() => child.stdio[3]!.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(() => child.stdio[4]!.emit("error", new Error("EPIPE"))).not.toThrow();
    const failure = new Error("spawn ENOENT");
    child.emit("error", failure);
    child.emit("error", new Error("later"));
    expect(launched.spawnError()).toBe(failure);
    expect(launched.spawnedAtMs).toBeGreaterThan(0);
  });
});

describe("desktop launch record", () => {
  function publishEarly(child: ReturnType<typeof makeChild>) {
    const early = {
      child,
      spawnedAtMs: 12,
      spawnError: () => null,
      executable: "/electron",
      args: [],
    } as unknown as EarlyDesktopBackend;
    publishDesktopLaunchRecord({
      entryStartedAtMs: 5,
      compileCacheDir: null,
      inheritedPath: "/usr/bin",
      shellEnvironmentApplied: true,
      earlyBackend: early,
    });
    return early;
  }

  it("hands the early backend to exactly one owner", () => {
    const early = publishEarly(makeChild());
    expect(readDesktopLaunchRecord()?.inheritedPath).toBe("/usr/bin");
    expect(takeEarlyDesktopBackend()).toBe(early);
    expect(takeEarlyDesktopBackend()).toBeNull();
    expect(readDesktopLaunchRecord()?.shellEnvironmentApplied).toBe(true);
  });

  it("stops an early backend nobody adopted", () => {
    const child = makeChild();
    publishEarly(child);
    discardEarlyDesktopBackend();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    discardEarlyDesktopBackend();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("replaces an early backend whose envelope would arrive after it stops waiting", () => {
    const early = publishEarly(makeChild());
    const spawnedAt = early.spawnedAtMs;
    expect(isEarlyDesktopBackendStale(early, spawnedAt + 1_000)).toBe(false);
    expect(
      isEarlyDesktopBackendStale(early, spawnedAt + EARLY_DESKTOP_BACKEND_MAX_ADOPTION_DELAY_MS),
    ).toBe(false);
    // The backend gives up on its envelope after 10 s and boots on defaults.
    expect(isEarlyDesktopBackendStale(early, spawnedAt + 9_000)).toBe(true);
    expect(EARLY_DESKTOP_BACKEND_MAX_ADOPTION_DELAY_MS).toBeLessThan(10_000);
  });

  it("is absent when the entry did not run", () => {
    expect(readDesktopLaunchRecord()).toBeNull();
    expect(takeEarlyDesktopBackend()).toBeNull();
    expect(() => discardEarlyDesktopBackend()).not.toThrow();
  });
});

describe("terminateDesktopBackendChild", () => {
  it("resolves on the child's exit after SIGTERM without escalating", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const stopped = terminateDesktopBackendChild(child as never);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    // A provider-heavy shutdown measured up to ~1.6 s; that must not be cut short.
    vi.advanceTimersByTime(1_600);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stopped;
    vi.advanceTimersByTime(DESKTOP_BACKEND_EXIT_WAIT_MS);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("escalates to SIGKILL after the grace and stops waiting after the bound", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    let resolved = false;
    const stopped = terminateDesktopBackendChild(child as never).then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(DESKTOP_BACKEND_SIGTERM_GRACE_MS - 1);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    vi.advanceTimersByTime(DESKTOP_BACKEND_EXIT_WAIT_MS - DESKTOP_BACKEND_SIGTERM_GRACE_MS);
    await stopped;
    expect(resolved).toBe(true);
  });

  it("does nothing for a child that already exited", async () => {
    const child = makeChild();
    child.exitCode = 1;
    await terminateDesktopBackendChild(child as never);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
