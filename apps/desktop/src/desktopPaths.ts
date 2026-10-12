import * as OS from "node:os";
import * as Path from "node:path";

import { resolveDesktopDataHomes } from "./desktopDataHomes.ts";

/**
 * Paths both the launch entry and the main bundle need. The entry resolves them
 * before loading the main bundle, so this module stays free of Electron and of
 * anything heavier than `node:path`.
 */
export interface DesktopPaths {
  readonly backendBaseDir: string;
  readonly desktopBaseDir: string;
  readonly stateDir: string;
  readonly desktopSettingsPath: string;
  readonly shellEnvironmentCachePath: string;
  readonly logDir: string;
}

export function resolveDesktopPaths(input: {
  readonly configuredBaseDir: string | undefined;
  readonly isDevelopment: boolean;
  readonly homeDir?: string;
}): DesktopPaths {
  const { backendBaseDir, desktopBaseDir } = resolveDesktopDataHomes({
    configuredBaseDir: input.configuredBaseDir,
    defaultBaseDir: Path.join(input.homeDir ?? OS.homedir(), ".ryco"),
    isDevelopment: input.isDevelopment,
  });
  const stateDir = Path.join(desktopBaseDir, "userdata");
  return {
    backendBaseDir,
    desktopBaseDir,
    stateDir,
    desktopSettingsPath: Path.join(stateDir, "desktop-settings.json"),
    shellEnvironmentCachePath: Path.join(stateDir, "shell-environment-cache.json"),
    logDir: Path.join(stateDir, "logs"),
  };
}

/**
 * Electron's userData directory.
 *
 * Electron derives the default from `productName`. It is overridden to a clean
 * lowercase `ryco` so the directory is shell-friendly and isolated from any
 * other installs on the same machine. It must be set before `ready` and before
 * the single-instance lock, which is keyed by it.
 */
export function resolveDesktopUserDataPath(input: {
  readonly isDevelopment: boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? OS.homedir();
  const appDataBase =
    platform === "win32"
      ? env.APPDATA || Path.join(homeDir, "AppData", "Roaming")
      : platform === "darwin"
        ? Path.join(homeDir, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || Path.join(homeDir, ".config");

  return Path.join(appDataBase, input.isDevelopment ? "ryco-dev" : "ryco");
}
