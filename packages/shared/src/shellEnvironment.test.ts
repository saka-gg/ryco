import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyShellEnvironmentCache,
  captureShellEnvironment,
  createBoundedShellExecFile,
  createShellEnvironmentCacheRecord,
  LOGIN_SHELL_ENVIRONMENT_NAMES,
  readShellEnvironmentCache,
  resolveShellEnvironmentAsync,
  applyShellEnvironment,
  resolveShellEnvironmentSync,
  type ShellEnvironmentSyncReaders,
  writeShellEnvironmentCache,
} from "./shellEnvironment.ts";

/** Resolve and merge in one step, as the desktop and server callers do. */
function syncShellEnvironment(env: NodeJS.ProcessEnv, options: ShellEnvironmentSyncReaders): void {
  applyShellEnvironment(env, resolveShellEnvironmentSync(env, options), options.platform);
}

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempPath(fileName: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-shell-env-cache-test-"));
  tempDirectories.push(directory);
  return path.join(directory, fileName);
}

describe("shell environment cache", () => {
  it("writes and reads a valid cache record", () => {
    const cachePath = makeTempPath("shell-env.json");
    const record = createShellEnvironmentCacheRecord({
      environment: { PATH: "/opt/homebrew/bin:/usr/bin", SSH_AUTH_SOCK: "/tmp/socket" },
      shell: "/bin/zsh",
      platform: "darwin",
      now: new Date("2026-05-12T00:00:00.000Z"),
    });

    writeShellEnvironmentCache(cachePath, record);

    expect(
      readShellEnvironmentCache(cachePath, {
        platform: "darwin",
        now: new Date("2026-05-12T01:00:00.000Z"),
      }),
    ).toEqual({ kind: "hit", record, ageMs: 60 * 60 * 1000 });
  });

  it("keeps serving an old record instead of blocking on a fresh capture", () => {
    const cachePath = makeTempPath("old.json");
    writeShellEnvironmentCache(
      cachePath,
      createShellEnvironmentCacheRecord({
        environment: { PATH: "/bin" },
        shell: null,
        platform: "darwin",
        now: new Date("2025-01-01T00:00:00.000Z"),
      }),
    );
    const result = readShellEnvironmentCache(cachePath, {
      platform: "darwin",
      now: new Date("2026-05-12T00:00:00.000Z"),
    });
    expect(result.kind).toBe("hit");
  });

  it("misses unreadable, foreign-platform and empty cache files", () => {
    const invalidPath = makeTempPath("invalid.json");
    fs.writeFileSync(invalidPath, "{", "utf8");
    expect(readShellEnvironmentCache(invalidPath)).toEqual({ kind: "miss", reason: "unreadable" });

    const linuxPath = makeTempPath("linux.json");
    writeShellEnvironmentCache(
      linuxPath,
      createShellEnvironmentCacheRecord({
        environment: { PATH: "/bin" },
        shell: null,
        platform: "linux",
      }),
    );
    expect(readShellEnvironmentCache(linuxPath, { platform: "darwin" })).toEqual({
      kind: "miss",
      reason: "platform",
    });

    const emptyPath = makeTempPath("empty.json");
    writeShellEnvironmentCache(
      emptyPath,
      createShellEnvironmentCacheRecord({ environment: {}, shell: null, platform: "darwin" }),
    );
    expect(readShellEnvironmentCache(emptyPath, { platform: "darwin" })).toEqual({
      kind: "miss",
      reason: "environment",
    });
  });

  it("misses cache records captured from a different known shell", () => {
    const cachePath = makeTempPath("shell-env.json");
    writeShellEnvironmentCache(
      cachePath,
      createShellEnvironmentCacheRecord({
        environment: { PATH: "/usr/bin" },
        shell: "/bin/zsh",
        platform: "darwin",
      }),
    );

    expect(
      readShellEnvironmentCache(cachePath, { platform: "darwin", currentShell: "/bin/fish" }),
    ).toEqual({ kind: "miss", reason: "shell" });
  });

  it("applies cached values without overwriting existing non-PATH values", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    applyShellEnvironmentCache(env, {
      version: 1,
      capturedAt: "2026-05-12T00:00:00.000Z",
      platform: "darwin",
      shell: "/bin/zsh",
      environment: {
        PATH: "/opt/homebrew/bin:/usr/bin",
        SSH_AUTH_SOCK: "/tmp/cached.sock",
        HOMEBREW_PREFIX: "/opt/homebrew",
      },
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
    expect(env.HOMEBREW_PREFIX).toBe("/opt/homebrew");
  });

  it("never drops a PATH entry that is already in effect", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/cached/bin:/usr/bin" };
    syncShellEnvironment(env, { platform: "darwin", readEnvironment: () => ({}) });
    expect(env.PATH).toBe("/cached/bin:/usr/bin");
  });
});

describe("resolveShellEnvironmentSync", () => {
  it("returns only shell-derived values so callers can cache them without inherited entries", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/inherited/bin" };
    expect(
      resolveShellEnvironmentSync(env, {
        platform: "darwin",
        readEnvironment: () => ({ PATH: "/opt/homebrew/bin", HOMEBREW_PREFIX: "/opt/homebrew" }),
      }),
    ).toEqual({ PATH: "/opt/homebrew/bin", HOMEBREW_PREFIX: "/opt/homebrew" });
    expect(env.PATH).toBe("/inherited/bin");
  });

  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/Users/test/.local/bin:/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
      HOMEBREW_PREFIX: "/opt/homebrew",
    }));

    syncShellEnvironment(env, { platform: "darwin", readEnvironment });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", LOGIN_SHELL_ENVIRONMENT_NAMES);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
    expect(env.HOMEBREW_PREFIX).toBe("/opt/homebrew");
  });

  it("preserves inherited values the login shell also or never provides", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    syncShellEnvironment(env, {
      platform: "linux",
      readEnvironment: () => ({
        PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
        SSH_AUTH_SOCK: "/tmp/login-shell.sock",
      }),
    });

    expect(env.PATH).toBe("/home/linuxbrew/.linuxbrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("falls back to launchctl PATH on macOS when shell probing does not return one", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/opt/homebrew/bin/nu",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("unknown flag");
      })
      .mockImplementationOnce(() => ({}));
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");
    const logWarning = vi.fn();

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(readEnvironment).toHaveBeenNthCalledWith(
      1,
      "/opt/homebrew/bin/nu",
      LOGIN_SHELL_ENVIRONMENT_NAMES,
    );
    expect(readEnvironment).toHaveBeenNthCalledWith(2, "/bin/zsh", LOGIN_SHELL_ENVIRONMENT_NAMES);
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read login shell environment from /opt/homebrew/bin/nu.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("does nothing on unsupported platforms", () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" };
    const readEnvironment = vi.fn(() => ({ PATH: "/usr/local/bin" }));

    syncShellEnvironment(env, { platform: "freebsd", readEnvironment });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });

  it("hydrates PATH on Windows by merging PowerShell PATH with inherited PATH", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
      USERPROFILE: "C:\\Users\\testuser",
    };
    const readWindowsEnvironment = vi.fn(() => ({
      PATH: "C:\\Custom\\Bin;C:\\Windows\\System32",
    }));
    const isWindowsCommandAvailable = vi.fn(() => true);

    syncShellEnvironment(env, {
      platform: "win32",
      readWindowsEnvironment,
      isWindowsCommandAvailable,
    });

    expect(readWindowsEnvironment).toHaveBeenCalledWith(["PATH"], { loadProfile: false });
    expect(env.PATH).toBe(
      [
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
        "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
        "C:\\Users\\testuser\\AppData\\Local\\pnpm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Custom\\Bin",
        "C:\\Windows\\System32",
      ].join(";"),
    );
  });

  it("loads the PowerShell profile on Windows when node is not available", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\testuser",
    };
    const readWindowsEnvironment = vi.fn(
      (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
        options?.loadProfile
          ? {
              PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
              FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
            }
          : { PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" },
    );
    const isWindowsCommandAvailable = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    syncShellEnvironment(env, {
      platform: "win32",
      readWindowsEnvironment,
      isWindowsCommandAvailable,
    });

    expect(env.PATH?.split(";")[0]).toBe("C:\\Profile\\Node");
    expect(env.FNM_DIR).toBe("C:\\Users\\testuser\\AppData\\Roaming\\fnm");
  });
});

describe("resolveShellEnvironmentAsync", () => {
  it("resolves with the same candidate and fallback rules without blocking", async () => {
    const readEnvironment = vi
      .fn()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce({});
    const readLaunchctlPath = vi.fn(async () => "/opt/homebrew/bin");
    const logWarning = vi.fn();

    await expect(
      resolveShellEnvironmentAsync(
        { SHELL: "/opt/homebrew/bin/fish" },
        {
          platform: "darwin",
          userShell: "/bin/zsh",
          readEnvironment,
          readLaunchctlPath,
          logWarning,
        },
      ),
    ).resolves.toEqual({ PATH: "/opt/homebrew/bin" });
    expect(readEnvironment).toHaveBeenCalledTimes(2);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read login shell environment from /opt/homebrew/bin/fish.",
      expect.any(Error),
    );
  });

  it("is not offered on Windows, where resolution must run in a worker", async () => {
    const readEnvironment = vi.fn();
    await expect(
      resolveShellEnvironmentAsync({}, { platform: "win32", readEnvironment }),
    ).resolves.toEqual({});
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("bounded shell executor", () => {
  it("kills a profile that ignores SIGTERM within the probe bound", async () => {
    const execute = createBoundedShellExecFile(process.env);
    const startedAt = Date.now();
    await expect(execute("/bin/sh", ["-c", "trap '' TERM; sleep 10"])).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("runs from the home directory with stdin closed", async () => {
    const execute = createBoundedShellExecFile(process.env);
    const output = await execute("/bin/sh", ["-c", "pwd; cat; echo done"]);
    expect(output.trim().split("\n")).toEqual([fs.realpathSync(os.homedir()), "done"]);
  });
});

const worker = (source: string) => new URL(`data:text/javascript,${encodeURIComponent(source)}`);

describe("captureShellEnvironment", () => {
  it("continues startup if the worker cannot be constructed", async () => {
    await expect(
      captureShellEnvironment({ env: {}, workerPath: "invalid-relative-path" }),
    ).resolves.toBeNull();
  });

  it("returns a captured environment without changing the caller's environment", async () => {
    const env = { PATH: "/original" };
    const result = await captureShellEnvironment({
      env,
      workerPath: worker(`
        import { parentPort, workerData } from 'node:worker_threads';
        workerData.env.PATH = '/captured';
        parentPort.postMessage({ environment: workerData.env, warnings: [] });
      `),
    });
    expect(result).toEqual({ environment: { PATH: "/captured" }, warnings: [] });
    expect(env.PATH).toBe("/original");
  });

  it("keeps timers responsive and releases startup when shell discovery blocks", async () => {
    let responsive = false;
    const timer = setTimeout(() => {
      responsive = true;
    }, 10);
    try {
      const result = await captureShellEnvironment({
        env: {},
        workerPath: worker("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);"),
        timeoutMs: 100,
      });
      expect(result).toBeNull();
      expect(responsive).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("abandons startup work on quit and tolerates a failed worker", async () => {
    const controller = new AbortController();
    const result = captureShellEnvironment({
      env: {},
      workerPath: worker("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);"),
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).resolves.toBeNull();
    await expect(
      captureShellEnvironment({
        env: {},
        workerPath: worker("throw new Error('broken profile');"),
      }),
    ).resolves.toBeNull();
  });
});
