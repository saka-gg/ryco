import { DEFAULT_HOSTED_APP_ORIGIN } from "@ryco/shared/hostedApp";
import * as FS from "node:fs";
import * as Path from "node:path";
import type {
  DesktopQuitShortcutMode,
  DesktopServerExposureMode,
  DesktopUpdateChannel,
} from "@ryco/contracts";
import { normalizeHubNodeName } from "@ryco/shared/nodeIdentity";

import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

export interface DesktopSettings {
  readonly quitShortcutMode: DesktopQuitShortcutMode;
  readonly serverExposureMode: DesktopServerExposureMode;
  /**
   * Hub launch configuration, owned by the desktop.
   *
   * The connector is constructed during server startup from `ServerConfig`, so
   * its origin must be known before the settings store is usable — launch
   * configuration belongs on the launch channel, not in `ServerSettings`.
   * Keeping it out of `ServerSettings` also keeps it off `server.getSettings`,
   * which is viewer-classified and therefore readable by a relayed viewer.
   *
   * Not a secret: a public HTTPS origin. It is still excluded from logs,
   * diagnostics, and support bundles, because a Hub address identifies where
   * this machine can be reached.
   */
  readonly hubConnectorEnabled: boolean;
  readonly hubOrigin: string | null;
  readonly hubNodeName: string | null;
  readonly hubAllowFileSecretStore: boolean;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser: boolean;
}

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  quitShortcutMode: "press-twice",
  serverExposureMode: "local-only",
  hubConnectorEnabled: false,
  hubOrigin: DEFAULT_HOSTED_APP_ORIGIN,
  hubNodeName: null,
  hubAllowFileSecretStore: false,
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
};

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  };
}

export function setDesktopServerExposurePreference(
  settings: DesktopSettings,
  requestedMode: DesktopServerExposureMode,
): DesktopSettings {
  return settings.serverExposureMode === requestedMode
    ? settings
    : {
        ...settings,
        serverExposureMode: requestedMode,
      };
}

export function setDesktopTailscaleServePreference(
  settings: DesktopSettings,
  input: { readonly enabled: boolean; readonly port?: number },
): DesktopSettings {
  const port =
    input.port === undefined
      ? settings.tailscaleServePort
      : normalizeTailscaleServePort(input.port);
  return settings.tailscaleServeEnabled === input.enabled && settings.tailscaleServePort === port
    ? settings
    : {
        ...settings,
        tailscaleServeEnabled: input.enabled,
        tailscaleServePort: port,
      };
}

export function normalizeTailscaleServePort(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : DEFAULT_TAILSCALE_SERVE_PORT;
}

export function setDesktopHubPreference(
  settings: DesktopSettings,
  input: {
    readonly enabled?: boolean;
    readonly origin?: string | null;
    readonly nodeName?: string | null;
    readonly allowFileSecretStore?: boolean;
  },
): DesktopSettings {
  const nodeName =
    input.nodeName === undefined
      ? settings.hubNodeName
      : input.nodeName === null
        ? null
        : normalizeHubNodeName(input.nodeName);
  const next = {
    ...settings,
    // A newly selected Hub is an onboarding action, not a dormant launch
    // preference. Start its connector on the same relaunch so native account
    // sign-in can claim the colocated node without a second Enable step.
    // Callers can still preserve an intentionally disabled connector by
    // passing `enabled: false` explicitly.
    hubConnectorEnabled:
      input.enabled ??
      (input.origin !== undefined && input.origin !== null ? true : settings.hubConnectorEnabled),
    hubOrigin: input.origin === undefined ? settings.hubOrigin : input.origin,
    hubNodeName: nodeName,
    hubAllowFileSecretStore: input.allowFileSecretStore ?? settings.hubAllowFileSecretStore,
  };
  return next.hubConnectorEnabled === settings.hubConnectorEnabled &&
    next.hubOrigin === settings.hubOrigin &&
    next.hubNodeName === settings.hubNodeName &&
    next.hubAllowFileSecretStore === settings.hubAllowFileSecretStore
    ? settings
    : next;
}

export function isDesktopHubFileSecretStoreSupported(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

export function setDesktopUpdateChannelPreference(
  settings: DesktopSettings,
  requestedChannel: DesktopUpdateChannel,
): DesktopSettings {
  return {
    ...settings,
    updateChannel: requestedChannel,
    updateChannelConfiguredByUser: true,
  };
}

/** A settings file exists but could not be understood. */
export class DesktopSettingsReadError extends Error {
  constructor(cause: unknown) {
    super("Desktop settings could not be read.", { cause });
    this.name = "DesktopSettingsReadError";
  }
}

export function readDesktopSettings(settingsPath: string, appVersion: string): DesktopSettings {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);

  try {
    if (!FS.existsSync(settingsPath)) {
      return defaultSettings;
    }

    const raw = FS.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      readonly quitShortcutMode?: unknown;
      readonly serverExposureMode?: unknown;
      readonly tailscaleServeEnabled?: unknown;
      readonly tailscaleServePort?: unknown;
      readonly updateChannel?: unknown;
      readonly updateChannelConfiguredByUser?: unknown;
      readonly hubConnectorEnabled?: unknown;
      readonly hubOrigin?: unknown;
      readonly hubNodeName?: unknown;
      readonly hubAllowFileSecretStore?: unknown;
    };
    const parsedUpdateChannel =
      parsed.updateChannel === "nightly" || parsed.updateChannel === "latest"
        ? parsed.updateChannel
        : null;
    const isLegacySettings = parsed.updateChannelConfiguredByUser === undefined;
    const updateChannelConfiguredByUser =
      parsed.updateChannelConfiguredByUser === true ||
      (isLegacySettings && parsedUpdateChannel === "nightly");

    let hubNodeName: string | null = null;
    if (parsed.hubNodeName !== undefined && parsed.hubNodeName !== null) {
      if (typeof parsed.hubNodeName !== "string") {
        throw new Error("Invalid Hub node name.");
      }
      hubNodeName = normalizeHubNodeName(parsed.hubNodeName);
      if (hubNodeName !== parsed.hubNodeName) {
        throw new Error("Invalid Hub node name.");
      }
    }

    return {
      quitShortcutMode:
        parsed.quitShortcutMode === "hold" || parsed.quitShortcutMode === "immediately"
          ? parsed.quitShortcutMode
          : "press-twice",
      serverExposureMode:
        parsed.serverExposureMode === "network-accessible" ? "network-accessible" : "local-only",
      tailscaleServeEnabled: parsed.tailscaleServeEnabled === true,
      tailscaleServePort: normalizeTailscaleServePort(parsed.tailscaleServePort),
      updateChannel:
        updateChannelConfiguredByUser && parsedUpdateChannel !== null
          ? parsedUpdateChannel
          : defaultSettings.updateChannel,
      updateChannelConfiguredByUser,
      hubConnectorEnabled: parsed.hubConnectorEnabled === true,
      hubOrigin:
        typeof parsed.hubOrigin === "string" && parsed.hubOrigin.length > 0
          ? parsed.hubOrigin
          : defaultSettings.hubOrigin,
      hubNodeName,
      hubAllowFileSecretStore: parsed.hubAllowFileSecretStore === true,
    };
  } catch (error) {
    // A corrupt file must not silently revert to defaults: the next write would
    // persist those defaults, quietly turning off a Hub connection the operator
    // configured. Surface it and let the caller decide.
    throw new DesktopSettingsReadError(error);
  }
}

export function writeDesktopSettings(settingsPath: string, settings: DesktopSettings): void {
  const directory = Path.dirname(settingsPath);
  const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  // The Hub address says where this machine is reachable, so the file is
  // owner-only — matching the 0700/0600 posture the identity state already uses,
  // rather than the world-readable default.
  FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  FS.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  FS.renameSync(tempPath, settingsPath);
}
