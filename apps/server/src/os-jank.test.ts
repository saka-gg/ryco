import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createShellEnvironmentCacheRecord,
  readShellEnvironmentCache,
  writeShellEnvironmentCache,
} from "@ryco/shared/shellEnvironment";

import { fixPath, resolveShellEnvironmentCachePath } from "./os-jank.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
function makeCachePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-fix-path-test-"));
  tempDirectories.push(directory);
  return path.join(directory, "userdata", "shell-environment-cache.json");
}

describe("fixPath", () => {
  it("preserves the desktop environment without running another shell", () => {
    const env = { PATH: "/desktop/tools:/usr/bin" };
    const readEnvironment = vi.fn();
    const readWindowsEnvironment = vi.fn();
    for (const platform of ["darwin", "linux", "win32"] as const) {
      fixPath({
        env,
        platform,
        inheritedFromDesktop: true,
        readEnvironment,
        readWindowsEnvironment,
        cachePath: null,
      });
    }
    expect(readEnvironment).not.toHaveBeenCalled();
    expect(readWindowsEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/desktop/tools:/usr/bin");
  });
  it("hydrates PATH on linux using the resolved login shell", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/Users/test/.local/bin:/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({ PATH: "/opt/homebrew/bin:/usr/bin" }));

    fixPath({
      env,
      platform: "linux",
      readEnvironment,
      cachePath: null,
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", expect.arrayContaining(["PATH"]));
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("falls back to launchctl PATH on macOS when shell probing fails", () => {
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

    fixPath({
      env,
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      logWarning,
      cachePath: null,
    });

    expect(readEnvironment).toHaveBeenNthCalledWith(1, "/opt/homebrew/bin/nu", expect.any(Array));
    expect(readEnvironment).toHaveBeenNthCalledWith(2, "/bin/zsh", expect.any(Array));
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read login shell environment from /opt/homebrew/bin/nu.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("repairs PATH on Windows by merging PowerShell PATH with inherited PATH", () => {
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

    fixPath({
      env,
      platform: "win32",
      readWindowsEnvironment,
      isWindowsCommandAvailable,
      cachePath: null,
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

  it("applies profile-derived fnm variables on Windows when node is missing", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
      USERPROFILE: "C:\\Users\\testuser",
    };
    const readWindowsEnvironment = vi.fn(
      (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
        options?.loadProfile
          ? {
              PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
              FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
              FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
            }
          : { PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" },
    );
    const isWindowsCommandAvailable = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    fixPath({
      env,
      platform: "win32",
      readWindowsEnvironment,
      isWindowsCommandAvailable,
      cachePath: null,
    });

    expect(env.PATH).toBe(
      [
        "C:\\Profile\\Node",
        "C:\\Windows\\System32",
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
        "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
        "C:\\Users\\testuser\\AppData\\Local\\pnpm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Custom\\Bin",
      ].join(";"),
    );
    expect(env.FNM_DIR).toBe("C:\\Users\\testuser\\AppData\\Roaming\\fnm");
    expect(env.FNM_MULTISHELL_PATH).toBe(
      "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
    );
  });

  it("preserves baseline PATH on Windows when the profile probe fails", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\testuser",
    };
    const readWindowsEnvironment = vi.fn(
      (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) => {
        if (options?.loadProfile) {
          throw new Error("profile load failed");
        }
        return { PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" };
      },
    );
    const isWindowsCommandAvailable = vi.fn(() => false);

    fixPath({
      env,
      platform: "win32",
      readWindowsEnvironment,
      isWindowsCommandAvailable,
      cachePath: null,
    });

    expect(env.PATH).toBe(
      [
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Custom\\Bin",
        "C:\\Windows\\System32",
      ].join(";"),
    );
  });

  it("does nothing on unsupported platforms", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
    };
    const readEnvironment = vi.fn(() => ({ PATH: "/usr/local/bin:/usr/bin" }));

    fixPath({
      env,
      platform: "freebsd",
      readEnvironment,
      cachePath: null,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });

  it("applies a cached shell PATH without running a shell, then refreshes it after start", async () => {
    const cachePath = makeCachePath();
    writeShellEnvironmentCache(
      cachePath,
      createShellEnvironmentCacheRecord({
        environment: { PATH: "/opt/homebrew/bin:/usr/bin" },
        shell: "/bin/zsh",
        platform: "darwin",
        now: new Date("2020-01-01T00:00:00.000Z"),
      }),
    );
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
    const readEnvironment = vi.fn(() => ({ PATH: "/Users/me/.local/bin:/usr/bin:/bin" }));
    let refresh: (() => Promise<void>) | null = null;

    fixPath({
      env,
      platform: "darwin",
      readEnvironment,
      cachePath,
      scheduleRefresh: (run) => {
        refresh = run;
      },
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");

    await refresh!();

    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(env.PATH).toBe("/Users/me/.local/bin:/usr/bin:/bin:/opt/homebrew/bin");
    const rewritten = readShellEnvironmentCache(cachePath, { platform: "darwin" });
    expect(rewritten.kind === "hit" && rewritten.record.environment.PATH).toBe(
      "/Users/me/.local/bin:/usr/bin:/bin",
    );
  });

  it("keeps the cached PATH when the refresh cannot reach the shell", async () => {
    const cachePath = makeCachePath();
    writeShellEnvironmentCache(
      cachePath,
      createShellEnvironmentCacheRecord({
        environment: { PATH: "/opt/homebrew/bin" },
        shell: null,
        platform: "linux",
      }),
    );
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    let refresh: (() => Promise<void>) | null = null;
    fixPath({
      env,
      platform: "linux",
      readEnvironment: () => {
        throw new Error("timed out");
      },
      logWarning: () => undefined,
      cachePath,
      scheduleRefresh: (run) => {
        refresh = run;
      },
    });
    await refresh!();
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("probes once and remembers the result when there is no cache yet", () => {
    const cachePath = makeCachePath();
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };
    const scheduleRefresh = vi.fn();
    fixPath({
      env,
      platform: "linux",
      readEnvironment: () => ({ PATH: "/home/me/bin:/usr/bin" }),
      cachePath,
      scheduleRefresh,
    });
    expect(env.PATH).toBe("/home/me/bin:/usr/bin");
    expect(scheduleRefresh).not.toHaveBeenCalled();
    const cached = readShellEnvironmentCache(cachePath, {
      platform: "linux",
      currentShell: "/bin/bash",
    });
    expect(cached.kind).toBe("hit");
  });

  it("keeps the cache under RYCO_HOME, independent of the working directory", () => {
    expect(resolveShellEnvironmentCachePath({ RYCO_HOME: "/srv/ryco" })).toBe(
      path.join("/srv/ryco", "userdata", "shell-environment-cache.json"),
    );
    expect(resolveShellEnvironmentCachePath({})).toBe(
      path.join(os.homedir(), ".ryco", "userdata", "shell-environment-cache.json"),
    );
  });
});
