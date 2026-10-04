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
  /**
   * The operator turned the connector off. Until they choose either way, a
   * configured Hub launches its connector in standby (see
   * `resolveDesktopHubConnectorLaunch`), so account sign-in and enrollment
   * need no relaunch.
   */
  readonly hubConnectorDisabledByUser: boolean;
  readonly hubOrigin: string | null;
  readonly hubNodeName: string | null;
  readonly hubAllowFileSecretStore: boolean;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  /**
   * Hold the machine awake while it is plugged in and other devices can reach
   * it. On by default; it has no effect until the node is reachable.
   */
  readonly keepAwakeWhileReachable: boolean;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser: boolean;
}

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  quitShortcutMode: "press-twice",
  serverExposureMode: "local-only",
  hubConnectorEnabled: false,
  hubConnectorDisabledByUser: false,
  hubOrigin: DEFAULT_HOSTED_APP_ORIGIN,
  hubNodeName: null,
  hubAllowFileSecretStore: false,
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  keepAwakeWhileReachable: true,
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

/** The Tailscale Serve configuration a backend is launched with. */
export interface DesktopTailscaleServeLaunch {
  readonly enabled: boolean;
  readonly port: number;
}

export function resolveDesktopTailscaleServeLaunch(
  settings: DesktopSettings,
): DesktopTailscaleServeLaunch {
  return { enabled: settings.tailscaleServeEnabled, port: settings.tailscaleServePort };
}

/** Whether two launches serve the same thing; the port only matters while serving. */
export function desktopTailscaleServeLaunchesMatch(
  left: DesktopTailscaleServeLaunch,
  right: DesktopTailscaleServeLaunch,
): boolean {
  return left.enabled === right.enabled && (!left.enabled || left.port === right.port);
}

/**
 * How a setting that applies only by relaunching Desktop lands.
 *
 * A change deferred until running turns finish is saved at once, so the saved
 * settings and the running backend can differ. A request is measured against
 * both: asking for what already runs withdraws a saved change without a
 * relaunch, and asking again for a saved change now still relaunches rather
 * than reading as already done.
 */
export interface DesktopRelaunchSettingPlan {
  /** The settings to persist; the same object when nothing needs saving. */
  readonly settings: DesktopSettings;
  /** Relaunch now: the running backend does not serve the request. */
  readonly relaunch: boolean;
}

export function planDesktopServerExposureChange(input: {
  readonly settings: DesktopSettings;
  readonly running: DesktopServerExposureMode;
  readonly requested: DesktopServerExposureMode;
  readonly deferRelaunch: boolean;
}): DesktopRelaunchSettingPlan {
  return {
    settings: setDesktopServerExposurePreference(input.settings, input.requested),
    relaunch: !input.deferRelaunch && input.requested !== input.running,
  };
}

/**
 * The network access mode the next launch binds, while it differs from the
 * running one: a change saved for a deferred relaunch, or one the network
 * could not serve when Ryco started. `null` when nothing is pending.
 */
export function pendingDesktopServerExposureMode(
  settings: DesktopSettings,
  running: DesktopServerExposureMode,
): DesktopServerExposureMode | null {
  return settings.serverExposureMode === running ? null : settings.serverExposureMode;
}

/** What the next launch serves through Tailscale, while it differs from what runs now. */
export function pendingDesktopTailscaleServe(
  settings: DesktopSettings,
  running: DesktopTailscaleServeLaunch,
): DesktopTailscaleServeLaunch | null {
  const saved = resolveDesktopTailscaleServeLaunch(settings);
  return desktopTailscaleServeLaunchesMatch(saved, running) ? null : saved;
}

export function planDesktopTailscaleServeChange(input: {
  readonly settings: DesktopSettings;
  readonly running: DesktopTailscaleServeLaunch;
  readonly requested: { readonly enabled: boolean; readonly port?: number };
  readonly deferRelaunch: boolean;
}): DesktopRelaunchSettingPlan {
  const settings = setDesktopTailscaleServePreference(input.settings, input.requested);
  return {
    settings,
    relaunch:
      !input.deferRelaunch &&
      !desktopTailscaleServeLaunchesMatch(
        resolveDesktopTailscaleServeLaunch(settings),
        input.running,
      ),
  };
}

export function setDesktopKeepAwakePreference(
  settings: DesktopSettings,
  enabled: boolean,
): DesktopSettings {
  return settings.keepAwakeWhileReachable === enabled
    ? settings
    : { ...settings, keepAwakeWhileReachable: enabled };
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
  // A newly selected Hub is an onboarding action, not a dormant launch
  // preference. Start its connector on the same relaunch so native account
  // sign-in can claim the colocated node without a second Enable step.
  // Callers can still preserve an intentionally disabled connector by
  // passing `enabled: false` explicitly.
  const choosesConnector =
    input.enabled !== undefined || (input.origin !== undefined && input.origin !== null);
  const hubConnectorEnabled =
    input.enabled ??
    (input.origin !== undefined && input.origin !== null ? true : settings.hubConnectorEnabled);
  const next = {
    ...settings,
    hubConnectorEnabled,
    hubConnectorDisabledByUser: choosesConnector
      ? !hubConnectorEnabled
      : settings.hubConnectorDisabledByUser,
    hubOrigin: input.origin === undefined ? settings.hubOrigin : input.origin,
    hubNodeName: nodeName,
    hubAllowFileSecretStore: input.allowFileSecretStore ?? settings.hubAllowFileSecretStore,
  };
  return next.hubConnectorEnabled === settings.hubConnectorEnabled &&
    next.hubConnectorDisabledByUser === settings.hubConnectorDisabledByUser &&
    next.hubOrigin === settings.hubOrigin &&
    next.hubNodeName === settings.hubNodeName &&
    next.hubAllowFileSecretStore === settings.hubAllowFileSecretStore
    ? settings
    : next;
}

/** The Hub connector configuration a backend is launched with. */
export interface DesktopHubConnectorLaunch {
  readonly enabled: boolean;
  /**
   * Run the connector only while the node holds no Hub identity. The backend
   * decides at launch from its own state files and resolves to disabled for
   * any existing identity, which may have been switched off on purpose.
   */
  readonly standby: boolean;
  readonly origin: string | null;
  readonly nodeName: string | null;
  readonly allowFileSecretStore: boolean;
}

/**
 * Enabled-but-idle unless the operator chose otherwise.
 *
 * An enabled connector with no identity parks in `enrolling` without opening a
 * socket or reading key custody, so a configured Hub no longer needs the
 * operator to turn it on, and a relaunch, before account sign-in can claim
 * the node. Settings written before the choice was recorded read as "not
 * chosen" unless they kept a connector off beside an account session (see
 * `readDesktopSettings`). Standby never claims the node by itself either:
 * only the user's own sign-in does (`desktopHubAllowsBackgroundNodeClaim`).
 */
export function resolveDesktopHubConnectorLaunch(
  settings: DesktopSettings,
): DesktopHubConnectorLaunch {
  const shared = {
    origin: settings.hubOrigin,
    nodeName: settings.hubNodeName,
    allowFileSecretStore: settings.hubAllowFileSecretStore,
  };
  if (settings.hubOrigin === null) return { ...shared, enabled: false, standby: false };
  if (settings.hubConnectorEnabled) return { ...shared, enabled: true, standby: false };
  if (settings.hubConnectorDisabledByUser) return { ...shared, enabled: false, standby: false };
  return { ...shared, enabled: true, standby: true };
}

/**
 * Whether a background resume may claim this machine's node onto the Hub.
 *
 * Standby only parks the connector so the user's own sign-in can claim the
 * node in place. Claiming without that action would put the machine on the Hub
 * against a choice the operator may have made before it was recorded, so only
 * a connector they turned on is claimed without asking.
 */
export function desktopHubAllowsBackgroundNodeClaim(settings: DesktopSettings): boolean {
  return settings.hubOrigin !== null && settings.hubConnectorEnabled;
}

/**
 * Whether persisted Hub settings need a relaunch to take effect.
 *
 * Promoting a standby connector to an explicit enable does not: the running
 * connector already serves the identity created in this process, and the next
 * launch simply stops asking the backend to check first.
 */
export function desktopHubLaunchNeedsRestart(
  persisted: DesktopHubConnectorLaunch,
  running: DesktopHubConnectorLaunch,
): boolean {
  return (
    persisted.enabled !== running.enabled ||
    persisted.origin !== running.origin ||
    persisted.nodeName !== running.nodeName ||
    persisted.allowFileSecretStore !== running.allowFileSecretStore
  );
}

export function isDesktopHubFileSecretStoreSupported(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/**
 * Whether Desktop main can run native Ryco account sign-in.
 *
 * Native account setup needs the macOS hardware-backed security helper. Every
 * other shipped desktop enrols its node through the Hub's device-code ceremony
 * instead, so the settings panel must not wait on an account flow that can
 * never start there.
 */
export function isDesktopHostedIdentitySupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
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

export function readDesktopSettings(
  settingsPath: string,
  appVersion: string,
  legacy?: {
    /**
     * Whether this installation retains a Hub account session. Asked only for
     * settings written before the connector choice was recorded.
     */
    readonly hasRetainedHubSession: () => boolean;
  },
): DesktopSettings {
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
      readonly keepAwakeWhileReachable?: unknown;
      readonly updateChannel?: unknown;
      readonly updateChannelConfiguredByUser?: unknown;
      readonly hubConnectorEnabled?: unknown;
      readonly hubConnectorDisabledByUser?: unknown;
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
      // Absent in settings written before the preference existed: keep the default.
      keepAwakeWhileReachable: parsed.keepAwakeWhileReachable !== false,
      updateChannel:
        updateChannelConfiguredByUser && parsedUpdateChannel !== null
          ? parsedUpdateChannel
          : defaultSettings.updateChannel,
      updateChannelConfiguredByUser,
      hubConnectorEnabled: parsed.hubConnectorEnabled === true,
      hubConnectorDisabledByUser:
        typeof parsed.hubConnectorDisabledByUser === "boolean"
          ? parsed.hubConnectorDisabledByUser
          : // Written before the choice was recorded. A connector that is off
            // beside a retained account session was turned off after sign-in,
            // or predates sign-in turning it on; either way the backend ran it
            // disabled, so standby must not start it now. Otherwise nothing
            // was chosen yet.
            parsed.hubConnectorEnabled !== true && (legacy?.hasRetainedHubSession() ?? false),
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
