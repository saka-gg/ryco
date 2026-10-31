import { describe, expect, it } from "vite-plus/test";

import {
  configuredDesktopBaseDir,
  resolveDesktopPaths,
  resolveDesktopUserDataPath,
} from "./desktopPaths.ts";

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

describe("Ryco Nightly paths", () => {
  it("keeps its data and profile apart from Ryco's", () => {
    expect(
      resolveDesktopPaths({
        configuredBaseDir: undefined,
        isDevelopment: false,
        flavor: "nightly",
        homeDir: "/Users/me",
      }).stateDir,
    ).toBe("/Users/me/.ryco-nightly/userdata");
    expect(
      resolveDesktopUserDataPath({
        isDevelopment: false,
        flavor: "nightly",
        platform: "darwin",
        homeDir: "/Users/me",
      }),
    ).toBe("/Users/me/Library/Application Support/ryco-nightly");
  });

  it("moves only with RYCO_NIGHTLY_HOME, never with the stable RYCO_HOME", () => {
    const env = { RYCO_HOME: "/Users/me/.ryco", RYCO_NIGHTLY_HOME: undefined };
    expect(configuredDesktopBaseDir("nightly", env)).toBeUndefined();
    expect(configuredDesktopBaseDir("stable", env)).toBe("/Users/me/.ryco");
    expect(configuredDesktopBaseDir("nightly", { RYCO_NIGHTLY_HOME: "/srv/nightly" })).toBe(
      "/srv/nightly",
    );
    expect(
      configuredDesktopBaseDir("nightly", { RYCO_NIGHTLY_HOME: "/Users/me/.ryco/" }, "/Users/me"),
    ).toBeUndefined();
  });
});
