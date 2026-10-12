import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopPaths, resolveDesktopUserDataPath } from "./desktopPaths.ts";

describe("desktop paths", () => {
  it("derives the state files from RYCO_HOME or the default home", () => {
    expect(
      resolveDesktopPaths({
        configuredBaseDir: undefined,
        isDevelopment: false,
        homeDir: "/Users/me",
      }),
    ).toEqual({
      backendBaseDir: "/Users/me/.ryco",
      desktopBaseDir: "/Users/me/.ryco",
      stateDir: "/Users/me/.ryco/userdata",
      desktopSettingsPath: "/Users/me/.ryco/userdata/desktop-settings.json",
      shellEnvironmentCachePath: "/Users/me/.ryco/userdata/shell-environment-cache.json",
      logDir: "/Users/me/.ryco/userdata/logs",
    });
    expect(
      resolveDesktopPaths({ configuredBaseDir: "/srv/ryco", isDevelopment: true }).stateDir,
    ).toBe("/srv/ryco/desktop-dev/userdata");
  });

  it("keeps Electron's userData in a lowercase, per-channel directory", () => {
    expect(
      resolveDesktopUserDataPath({
        isDevelopment: false,
        platform: "darwin",
        homeDir: "/Users/me",
      }),
    ).toBe("/Users/me/Library/Application Support/ryco");
    expect(
      resolveDesktopUserDataPath({
        isDevelopment: true,
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/cfg" },
        homeDir: "/home/me",
      }),
    ).toBe("/cfg/ryco-dev");
  });
});
