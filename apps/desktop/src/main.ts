import { Duplex } from "node:stream";
import { attachDesktopResourceTelemetry } from "./desktopResourceTelemetry.ts";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopComputerUseRuntime } from "./computerUse/runtime.ts";
import { registerComputerUseIpc } from "./computerUse/ipc.ts";

import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  safeStorage,
  shell,
} from "electron";
import type { MenuItemConstructorOptions, OpenDialogOptions } from "electron";
import {
  EnvironmentId,
  type ClientSettings,
  type DesktopTheme,
  type DesktopAppBranding,
  type DesktopHostedIdentityActionResult,
  type DesktopHostedIdentityState,
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
  type DesktopUpdateChannel,
  type PersistedSavedEnvironmentRecord,
  type DesktopUpdateActionResult,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@ryco/contracts";
import { autoUpdater, type UpdateDownloadedEvent } from "electron-updater";

import type { ContextMenuItem } from "@ryco/contracts";
import { RotatingFileSink } from "@ryco/shared/logging";
import { normalizeHubNodeName } from "@ryco/shared/nodeIdentity";
import { deleteEnv, readEnv } from "@ryco/shared/runtimeEnv";
import { parsePersistedServerObservabilitySettings } from "@ryco/shared/serverSettings";
import type { RemoteRycoRunnerOptions } from "@ryco/ssh/tunnel";
import { DEFAULT_DESKTOP_BACKEND_PORT, resolveDesktopBackendPort } from "./backendPort.ts";
import {
  type DesktopSettings,
  DEFAULT_DESKTOP_SETTINGS,
  isDesktopHubFileSecretStoreSupported,
  readDesktopSettings,
  setDesktopServerExposurePreference,
  setDesktopTailscaleServePreference,
  setDesktopUpdateChannelPreference,
  resolveDefaultDesktopSettings,
  setDesktopHubPreference,
  writeDesktopSettings,
} from "./desktopSettings.ts";
import {
  readClientSettings,
  readSavedEnvironmentRegistry,
  readSavedEnvironmentSecret,
  removeSavedEnvironmentSecret,
  writeClientSettings,
  writeSavedEnvironmentRegistry,
  writeSavedEnvironmentSecret,
} from "./clientPersistence.ts";
import { isBackendReadinessAborted, waitForHttpReady } from "./backendReadiness.ts";
import { createBackendRestartBackoff } from "./backendRestartBackoff.ts";
import { showDesktopConfirmDialog } from "./confirmDialog.ts";
import {
  resolveDesktopCoreAdvertisedEndpoints,
  resolveDesktopServerExposure,
} from "./serverExposure.ts";
import { DesktopSshEnvironmentBridge, resolveRemoteRycoCliPackageSpec } from "./sshEnvironment.ts";
import { syncShellEnvironment } from "./syncShellEnvironment.ts";
import {
  applyShellEnvironmentCache,
  createShellEnvironmentCacheRecord,
  readShellEnvironmentCache,
  writeShellEnvironmentCache,
} from "./shellEnvironmentCache.ts";
import { createStartupTiming, formatStartupTimingEntry } from "./startupTiming.ts";
import { waitForBackendStartupReady } from "./backendStartupReadiness.ts";
import { getAutoUpdateDisabledReason, shouldBroadcastDownloadProgress } from "./updateState.ts";
import { doesVersionMatchDesktopUpdateChannel } from "./updateChannels.ts";
import { ServerListeningDetector } from "./serverListeningDetector.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch.ts";
import { resolveDesktopAppBranding } from "./appBranding.ts";
import { bindFirstRevealTrigger, type RevealSubscription } from "./windowReveal.ts";
import { resolveBundledRelayGuidePath } from "./bundledGuide.ts";
import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";
import { validateHubOrigin } from "./hubOrigin.ts";
import { removeDesktopOwnedHubEnvironment } from "./hubLaunchEnvironment.ts";
import {
  parseTurnCompleteNotification,
  shouldShowTurnCompleteNotification,
} from "./turnCompleteNotification.ts";
import {
  createUnsignedMacUpdateInstallScript,
  parseMacCodeSignatureKind,
  resolveMacAppBundlePath,
  resolveMacUpdateTargetAppPath,
  shouldUseUnsignedMacUpdateInstaller,
  type MacCodeSignatureKind,
} from "./unsignedMacUpdateInstaller.ts";
import { createDesktopProtectedRecordStore } from "./protectedRecordStore.ts";
import { createDesktopNativeSecretStore } from "./nativeSecretStore.ts";
import { resolveDesktopDataHomes } from "./desktopDataHomes.ts";
import {
  createNativeSecurityHelperRunner,
  desktopNativeInstallationNamespace,
  DesktopNativeSecurityHelper,
  desktopNativeSecurityNamespace,
  resolveDesktopNativeSecurityHelperPath,
} from "./nativeSecurityHelper.ts";
import {
  createDesktopNativeAuthorization,
  DesktopAuthorizationCallbackBroker,
  desktopAuthorizationCallbackUri,
  findDesktopAuthorizationCallback,
  resolveDesktopAuthorizationCallback,
  type DesktopAuthorizationVariant,
} from "./nativeAuthorization.ts";
import {
  createDesktopHostedSessionCredentials,
  getOrCreateDesktopInstallationId,
} from "./hostedCredentials.ts";
import { createDesktopHubControlClient } from "./desktopHubControl.ts";
import {
  createDesktopDpopSigner,
  createDesktopHostedHubApi,
  DesktopHostedIdentityCoordinator,
  shouldEnableDesktopHubConnectorForAccountSetup,
  type DesktopHostedGitHubActionResult,
  type DesktopHostedIdentityStatus,
} from "./desktopHostedIdentity.ts";
import { DesktopE2eeTrustStore } from "./desktopE2eeTrust.ts";
import { DesktopE2eePrekeyIssuer } from "./desktopE2eePrekey.ts";
import { createDesktopNativeE2eePlatform } from "./desktopNativeE2ee.ts";
import { DesktopNativeE2eeHandshakeService } from "./desktopNativeE2eeHandshake.ts";
import { createDesktopWorkspaceMetadataCache } from "./desktopWorkspaceCache.ts";
import {
  DesktopWorkspaceClient,
  type DesktopWorkspaceClientSnapshot,
} from "./desktopWorkspaceClient.ts";
import {
  createDesktopWorkspaceIpcHandlers,
  projectDesktopWorkspaceState,
} from "./desktopWorkspaceIpc.ts";
import { DESKTOP_WORKSPACE_IPC } from "./desktopWorkspaceChannels.ts";
import {
  DESKTOP_WORKSPACE_MAX_RPC_FRAME_BYTES,
  DesktopWorkspaceRelayManager,
} from "./desktopWorkspaceRelay.ts";
import { createResilientStdIoWriter } from "./resilientStdIo.ts";

const desktopStartupTiming = createStartupTiming();
desktopStartupTiming.mark("desktop.launch");
const STARTUP_TIMING_STDOUT = readEnv("RYCO_DESKTOP_STARTUP_TIMING_STDOUT")?.trim() === "1";
const DESKTOP_OPEN_DEVTOOLS = readEnv("RYCO_DESKTOP_OPEN_DEVTOOLS")?.trim() === "1";
const DESKTOP_DISABLE_GPU = readEnv("RYCO_DESKTOP_DISABLE_GPU")?.trim() === "1";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_SET_CHANNEL_CHANNEL = "desktop:update-set-channel";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";
const GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL = "desktop:get-local-environment-bootstrap";
const GET_CLIENT_SETTINGS_CHANNEL = "desktop:get-client-settings";
const SET_CLIENT_SETTINGS_CHANNEL = "desktop:set-client-settings";
const GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:get-saved-environment-registry";
const SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:set-saved-environment-registry";
const GET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:get-saved-environment-secret";
const SET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:set-saved-environment-secret";
const REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:remove-saved-environment-secret";
const GET_SERVER_EXPOSURE_STATE_CHANNEL = "desktop:get-server-exposure-state";
const SET_SERVER_EXPOSURE_MODE_CHANNEL = "desktop:set-server-exposure-mode";
const SET_TAILSCALE_SERVE_ENABLED_CHANNEL = "desktop:set-tailscale-serve-enabled";
const GET_HUB_LAUNCH_CONFIG_CHANNEL = "desktop:get-hub-launch-config";
const SET_HUB_LAUNCH_CONFIG_CHANNEL = "desktop:set-hub-launch-config";
const RESTART_APP_CHANNEL = "desktop:restart-app";
const VALIDATE_HUB_ORIGIN_CHANNEL = "desktop:validate-hub-origin";
const GET_ADVERTISED_ENDPOINTS_CHANNEL = "desktop:get-advertised-endpoints";
const NOTIFY_TURN_COMPLETE_CHANNEL = "desktop:notify-turn-complete";
const GET_HOSTED_IDENTITY_STATUS_CHANNEL = "desktop:get-hosted-identity-status";
const CONNECT_HOSTED_IDENTITY_CHANNEL = "desktop:connect-hosted-identity";
const DISCONNECT_HOSTED_IDENTITY_CHANNEL = "desktop:disconnect-hosted-identity";
const CONNECT_HOSTED_GITHUB_CHANNEL = "desktop:connect-hosted-github";
const DISCONNECT_HOSTED_GITHUB_CHANNEL = "desktop:disconnect-hosted-github";
const CANCEL_HOSTED_GITHUB_CONNECTION_CHANNEL = "desktop:cancel-hosted-github-connection";
const TURN_COMPLETE_NOTIFICATION_ACTIVATED_CHANNEL = "desktop:turn-complete-notification-activated";
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const isDesktopAuthorizationCallbackRelay =
  isDevelopment && process.env.RYCO_DESKTOP_CALLBACK_RELAY === "1";
const DEFAULT_BASE_DIR = Path.join(OS.homedir(), ".ryco");
const { backendBaseDir: BACKEND_BASE_DIR, desktopBaseDir: DESKTOP_BASE_DIR } =
  resolveDesktopDataHomes({
    configuredBaseDir: readEnv("RYCO_HOME"),
    defaultBaseDir: DEFAULT_BASE_DIR,
    isDevelopment,
  });
const STATE_DIR = Path.join(DESKTOP_BASE_DIR, "userdata");
const DESKTOP_SETTINGS_PATH = Path.join(STATE_DIR, "desktop-settings.json");
const CLIENT_SETTINGS_PATH = Path.join(STATE_DIR, "client-settings.json");
const SAVED_ENVIRONMENT_REGISTRY_PATH = Path.join(STATE_DIR, "saved-environments.json");
const SHELL_ENVIRONMENT_CACHE_PATH = Path.join(STATE_DIR, "shell-environment-cache.json");
const DESKTOP_WORKSPACE_CACHE_PATH = Path.join(
  STATE_DIR,
  "desktop-workspace-client",
  "metadata-v1.json",
);
const DESKTOP_SCHEME = "ryco";
const DESKTOP_BOOT_HOST = "app";
const DESKTOP_BOOT_PATH = "/desktop-boot.html";
const ROOT_DIR = Path.resolve(__dirname, "../../..");
// Dev-only SSH launcher override. Set this to an absolute path on the SSH host
// for a built server entry, for example:
// "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs"
const DEV_REMOTE_SERVER_ENTRY_PATH = readEnv("RYCO_DEV_REMOTE_SERVER_ENTRY_PATH")?.trim() ?? "";
const desktopAppBranding: DesktopAppBranding = resolveDesktopAppBranding({
  isDevelopment,
  appVersion: app.getVersion(),
});
const APP_DISPLAY_NAME = desktopAppBranding.displayName;
const APP_USER_MODEL_ID = isDevelopment ? "com.sak0a.ryco.dev" : "com.sak0a.ryco";
const LINUX_DESKTOP_ENTRY_NAME = isDevelopment ? "ryco-dev.desktop" : "ryco.desktop";
const LINUX_WM_CLASS = isDevelopment ? "ryco-dev" : "ryco";
const USER_DATA_DIR_NAME = isDevelopment ? "ryco-dev" : "ryco";
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const SERVER_SETTINGS_PATH = Path.join(STATE_DIR, "settings.json");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const UNSIGNED_MAC_UPDATE_INSTALLER_DIR = Path.join(STATE_DIR, "update-installers");
const UNSIGNED_MAC_UPDATE_INSTALLER_LOG_PATH = Path.join(LOG_DIR, "unsigned-mac-update.log");
const NATIVE_SECURITY_DIR = Path.join(STATE_DIR, "native-security");

if (!isDevelopment) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
  ]);
}

function resolvePickFolderDefaultPath(rawOptions: unknown): string | undefined {
  if (typeof rawOptions !== "object" || rawOptions === null) {
    return undefined;
  }

  const { initialPath } = rawOptions as { initialPath?: unknown };
  if (typeof initialPath !== "string") {
    return undefined;
  }

  const trimmedPath = initialPath.trim();
  if (trimmedPath.length === 0) {
    return undefined;
  }

  if (trimmedPath === "~") {
    return OS.homedir();
  }

  if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
    return Path.join(OS.homedir(), trimmedPath.slice(2));
  }

  return Path.resolve(trimmedPath);
}
const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_REQUIRED_PORT_PROBE_HOSTS = ["0.0.0.0", "::"] as const;
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";

function normalizeContextMenuItems(source: readonly ContextMenuItem[]): ContextMenuItem[] {
  const normalizedItems: ContextMenuItem[] = [];

  for (const sourceItem of source) {
    if (typeof sourceItem.id !== "string" || typeof sourceItem.label !== "string") {
      continue;
    }

    const normalizedItem: ContextMenuItem = {
      id: sourceItem.id,
      label: sourceItem.label,
      destructive: sourceItem.destructive === true,
      disabled: sourceItem.disabled === true,
    };

    if (sourceItem.children) {
      const normalizedChildren = normalizeContextMenuItems(sourceItem.children);
      if (normalizedChildren.length === 0) {
        continue;
      }
      normalizedItem.children = normalizedChildren;
    }

    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

type WindowTitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];
type LinuxDesktopNamedApp = Electron.App & {
  setDesktopName?: (desktopName: string) => void;
};

let mainWindow: BrowserWindow | null = null;
let computerUseRuntime: DesktopComputerUseRuntime | null = null;
const desktopAuthorizationBroker = new DesktopAuthorizationCallbackBroker();
let desktopHostedIdentityCoordinator: DesktopHostedIdentityCoordinator | null = null;
let desktopHostedIdentityStatus: DesktopHostedIdentityStatus = {
  status: "signed-out",
};
let desktopHostedIdentityControlGeneration = "";
let desktopNativeIdentityContext: {
  readonly origin: string;
  readonly installationId: string;
  readonly records: ReturnType<typeof createDesktopProtectedRecordStore>;
  readonly security: DesktopNativeSecurityHelper;
  readonly trust: DesktopE2eeTrustStore;
  readonly prekey: DesktopE2eePrekeyIssuer;
  readonly nativeE2eePlatform: ReturnType<typeof createDesktopNativeE2eePlatform>;
} | null = null;
let desktopNativeE2eeHandshakeService: DesktopNativeE2eeHandshakeService | null = null;
let desktopWorkspaceClient: DesktopWorkspaceClient | null = null;
let desktopWorkspaceRelayManager: DesktopWorkspaceRelayManager | null = null;
let disposeDesktopWorkspaceSubscription: (() => void) | null = null;
// Retain live turn-complete notifications: Electron GCs Notification objects once
// the creating scope returns, which would drop their `click`/`close` handlers.
const activeTurnCompleteNotifications = new Set<Notification>();
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendBindHost = DESKTOP_LOOPBACK_HOST;
let backendBootstrapToken = "";
// Never exposed through preload or renderer IPC. A fresh value belongs to one
// exact backend child and authenticates Desktop-main-only local control calls.
let backendControlToken = "";
let backendHttpUrl = "";
let backendWsUrl = "";
let backendEndpointUrl: string | null = null;
let backendAdvertisedHost: string | null = null;
let backendReadinessAbortController: AbortController | null = null;
let backendInitialWindowOpenInFlight: Promise<void> | null = null;
let developmentInitialWindowOpenInFlight: Promise<void> | null = null;
let backendListeningDetector: ServerListeningDetector | null = null;
const backendRestartBackoff = createBackendRestartBackoff({
  initialDelayMs: 500,
  maxDelayMs: 10_000,
});
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let backendObservabilitySettings = readPersistedBackendObservabilitySettings();
/**
 * Read settings without letting a corrupt file stop the app from starting.
 *
 * `readDesktopSettings` throws rather than silently resetting, so a damaged file
 * is never quietly overwritten with defaults. That is the right contract, but it
 * runs at module scope: letting it escape would make an unparseable settings file
 * an unbootable app with no in-product way back.
 *
 * So: fall back to defaults in memory, and record that the on-disk file was not
 * understood. Nothing writes over it until the user changes a setting, which is
 * an explicit act.
 */
let desktopSettingsUnreadable = false;
let desktopSettings = ((): DesktopSettings => {
  try {
    return readDesktopSettings(DESKTOP_SETTINGS_PATH, app.getVersion());
  } catch {
    desktopSettingsUnreadable = true;
    return resolveDefaultDesktopSettings(app.getVersion());
  }
})();
let desktopServerExposureMode: DesktopServerExposureMode = desktopSettings.serverExposureMode;

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const expectedBackendExitChildren = new WeakSet<ChildProcess.ChildProcess>();
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(
    app.getVersion(),
    desktopRuntimeInfo,
    desktopSettings.updateChannel,
  );

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readPersistedBackendObservabilitySettings(): {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
} {
  try {
    if (!FS.existsSync(SERVER_SETTINGS_PATH)) {
      return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
    }
    return parsePersistedServerObservabilitySettings(FS.readFileSync(SERVER_SETTINGS_PATH, "utf8"));
  } catch (error) {
    console.warn("[desktop] failed to read persisted backend observability settings", error);
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }
}

function resolveConfiguredDesktopBackendPort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined;
  }

  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    return undefined;
  }

  return parsedPort;
}

function resolveDesktopDevServerUrl(): string {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
  if (!devServerUrl) {
    throw new Error("VITE_DEV_SERVER_URL is required in desktop development.");
  }

  return devServerUrl;
}

function resolveDesktopBootUrl(): string {
  return `${DESKTOP_SCHEME}://${DESKTOP_BOOT_HOST}${DESKTOP_BOOT_PATH}`;
}

function resolveDesktopBootFilePath(): string | null {
  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    return null;
  }
  const bootPath = Path.join(staticRoot, DESKTOP_BOOT_PATH.replace(/^\/+/, ""));
  return FS.existsSync(bootPath) ? bootPath : null;
}

function isDesktopBootUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      return Path.basename(fileURLToPath(url)) === Path.basename(DESKTOP_BOOT_PATH);
    }
    return (
      url.protocol === `${DESKTOP_SCHEME}:` &&
      url.hostname === DESKTOP_BOOT_HOST &&
      url.pathname === DESKTOP_BOOT_PATH
    );
  } catch {
    return false;
  }
}

function isDesktopAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === `${DESKTOP_SCHEME}:` &&
      url.hostname === DESKTOP_BOOT_HOST &&
      url.pathname !== DESKTOP_BOOT_PATH
    );
  } catch {
    return false;
  }
}

function warnIfDesktopSettingsUnreadable(): void {
  if (!desktopSettingsUnreadable) return;
  writeDesktopLogHeader(
    "desktop settings file could not be parsed; running with defaults and leaving the file untouched",
  );
}

function backendChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  deleteEnv(env, "RYCO_PORT");
  deleteEnv(env, "RYCO_MODE");
  deleteEnv(env, "RYCO_NO_BROWSER");
  deleteEnv(env, "RYCO_HOST");
  deleteEnv(env, "RYCO_DESKTOP_WS_URL");
  deleteEnv(env, "RYCO_DESKTOP_LAN_ACCESS");
  deleteEnv(env, "RYCO_DESKTOP_LAN_HOST");
  deleteEnv(env, "RYCO_DESKTOP_HTTPS_ENDPOINTS");
  deleteEnv(env, "RYCO_TAILSCALE_SERVE");
  deleteEnv(env, "RYCO_TAILSCALE_SERVE_PORT");
  // The desktop is the single owner of these values: it persists them and passes
  // them on the bootstrap channel. Leaving the environment able to override
  // would give the settings panel a toggle that silently does nothing, guarded
  // by a lock icon any same-user process could forge with `launchctl setenv`.
  // `ryco serve` is unaffected and stays fully env-configurable.
  removeDesktopOwnedHubEnvironment(env);
  // VITE_DEV_SERVER_URL must never reach the packaged backend: if a developer's
  // shell exports it, the server's Config.url parser throws and the backend
  // exits before HTTP listen, causing the desktop to spin in a restart loop.
  deleteEnv(env, "VITE_DEV_SERVER_URL");
  if (app.isPackaged && process.platform === "darwin") {
    env.RYCO_DEVICE_HELPER_SOURCE_DIR = Path.join(process.resourcesPath, "device-helper");
  }
  return env;
}

function synchronizeDesktopShellEnvironment(reason: string): void {
  markDesktopStartupPhase("desktop.shell-env.refresh.start", `reason=${reason}`);
  syncShellEnvironment(process.env, {
    logWarning: (message, error) => {
      writeDesktopLogHeader(
        `shell environment warning message=${sanitizeLogValue(message)} detail=${sanitizeLogValue(formatErrorMessage(error))}`,
      );
      console.warn(`[desktop] ${message}`, error instanceof Error ? error.message : (error ?? ""));
    },
  });
  try {
    writeShellEnvironmentCache(
      SHELL_ENVIRONMENT_CACHE_PATH,
      createShellEnvironmentCacheRecord({ env: process.env }),
    );
  } catch (error) {
    writeDesktopLogHeader(
      `shell environment cache write failed message=${sanitizeLogValue(formatErrorMessage(error))}`,
    );
  }
  markDesktopStartupPhase("desktop.shell-env.refresh.end", `reason=${reason}`);
}

function prepareDesktopShellEnvironmentForBackend(): "cache-hit" | "cache-miss" {
  markDesktopStartupPhase("desktop.shell-env.prepare.start");
  const cached = readShellEnvironmentCache(SHELL_ENVIRONMENT_CACHE_PATH, {
    currentShell: process.env.SHELL ?? null,
  });
  if (cached.kind === "hit") {
    applyShellEnvironmentCache(process.env, cached.record);
    markDesktopStartupPhase(
      "desktop.shell-env.cache.hit",
      `capturedAt=${cached.record.capturedAt}`,
    );
    return "cache-hit";
  }

  markDesktopStartupPhase("desktop.shell-env.cache.miss", `reason=${cached.reason}`);
  synchronizeDesktopShellEnvironment("cache-miss");
  return "cache-miss";
}

function scheduleDesktopShellEnvironmentRefresh(reason: string): void {
  setTimeout(() => {
    try {
      synchronizeDesktopShellEnvironment(reason);
    } catch (error) {
      writeDesktopLogHeader(
        `shell environment refresh failed reason=${reason} message=${sanitizeLogValue(formatErrorMessage(error))}`,
      );
    }
  }, 5000);
}

function getDesktopServerExposureState(): DesktopServerExposureState {
  return {
    mode: desktopServerExposureMode,
    endpointUrl: backendEndpointUrl,
    advertisedHost: backendAdvertisedHost,
    tailscaleServeEnabled: desktopSettings.tailscaleServeEnabled,
    tailscaleServePort: desktopSettings.tailscaleServePort,
  };
}

async function getDesktopAdvertisedEndpoints() {
  const networkInterfaces = OS.networkInterfaces();
  const exposure = resolveDesktopServerExposure({
    mode: desktopServerExposureMode,
    port: backendPort,
    networkInterfaces,
    ...(backendAdvertisedHost ? { advertisedHostOverride: backendAdvertisedHost } : {}),
  });
  const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
    port: backendPort,
    exposure,
    customHttpsEndpointUrls: resolveCustomHttpsEndpointUrls(),
  });
  if (
    desktopServerExposureMode !== "network-accessible" &&
    !desktopSettings.tailscaleServeEnabled
  ) {
    return coreEndpoints;
  }

  const tailscaleEndpoints = await resolveTailscaleAdvertisedEndpoints({
    port: backendPort,
    serveEnabled: desktopSettings.tailscaleServeEnabled,
    servePort: desktopSettings.tailscaleServePort,
    networkInterfaces,
  });
  return [...coreEndpoints, ...tailscaleEndpoints];
}

function getDesktopSecretStorage() {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value: string) => safeStorage.encryptString(value),
    decryptString: (value: Buffer) => safeStorage.decryptString(value),
  } as const;
}

function desktopAuthorizationVariant(): DesktopAuthorizationVariant {
  if (isDevelopment) return "development";
  return desktopAppBranding.stageLabel === "Nightly" ? "preview" : "production";
}

function desktopHostedDeviceLabel(): string {
  const hostname = OS.hostname()
    .replace(/\.local$/i, "")
    .trim();
  return hostname.length > 0 ? hostname : APP_DISPLAY_NAME;
}

async function ensureDesktopNativeIdentityContext(): Promise<
  NonNullable<typeof desktopNativeIdentityContext>
> {
  if (desktopNativeIdentityContext !== null) return desktopNativeIdentityContext;
  if (process.platform !== "darwin" || desktopSettings.hubOrigin === null) {
    throw new Error("Desktop native Hub identity is unavailable.");
  }
  const protection = getDesktopSecretStorage();
  const installationRecords = createDesktopProtectedRecordStore({
    directory: NATIVE_SECURITY_DIR,
    namespace: desktopNativeInstallationNamespace(desktopAuthorizationVariant()),
    protection,
  });
  const installationId = await getOrCreateDesktopInstallationId(installationRecords);
  const namespace = desktopNativeSecurityNamespace(
    `${desktopSettings.hubOrigin}\0${installationId}`,
  );
  const records = createDesktopProtectedRecordStore({
    directory: NATIVE_SECURITY_DIR,
    namespace,
    protection,
  });
  const security = new DesktopNativeSecurityHelper({
    run: createNativeSecurityHelperRunner(
      resolveDesktopNativeSecurityHelperPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        moduleDirectory: __dirname,
      }),
    ),
    store: createDesktopNativeSecretStore({
      directory: NATIVE_SECURITY_DIR,
      namespace,
      protection,
    }),
  });
  const prekey = new DesktopE2eePrekeyIssuer({
    origin: desktopSettings.hubOrigin,
    security,
    records,
  });
  const context = {
    origin: desktopSettings.hubOrigin,
    installationId,
    records,
    security,
    trust: new DesktopE2eeTrustStore(records),
    prekey,
    nativeE2eePlatform: createDesktopNativeE2eePlatform({
      origin: desktopSettings.hubOrigin,
      installationId,
      appVersion: app.getVersion(),
      deviceLabel: desktopHostedDeviceLabel,
      security,
      records,
      prekey,
      platform: "darwin",
    }),
  };
  desktopNativeIdentityContext = context;
  return context;
}

async function ensureDesktopHostedIdentityCoordinator(): Promise<DesktopHostedIdentityCoordinator> {
  if (desktopHostedIdentityCoordinator !== null) return desktopHostedIdentityCoordinator;
  const context = await ensureDesktopNativeIdentityContext();
  const credentials = createDesktopHostedSessionCredentials(context.records);
  const nativeAuthorization = createDesktopNativeAuthorization({
    variant: desktopAuthorizationVariant(),
    deviceLabel: desktopHostedDeviceLabel,
    broker: desktopAuthorizationBroker,
    openExternal: async (url) => await shell.openExternal(url, { activate: true }),
  });
  const api = await createDesktopHostedHubApi({
    origin: context.origin,
    credentials,
    security: context.security,
    nativeAuthorization,
  });
  const coordinator = new DesktopHostedIdentityCoordinator({
    origin: context.origin,
    installationId: context.installationId,
    api,
    credentials,
    security: context.security,
    records: context.records,
    trust: context.trust,
    nativeE2eePlatform: context.nativeE2eePlatform,
    relayDpopSigner: await createDesktopDpopSigner(context.security),
    control: createDesktopHubControlClient({
      baseUrl: () => backendHttpUrl,
      controlToken: () => backendControlToken,
    }),
  });
  desktopHostedIdentityCoordinator = coordinator;
  return coordinator;
}

async function ensureDesktopWorkspaceRelayManager(): Promise<DesktopWorkspaceRelayManager> {
  if (desktopWorkspaceRelayManager !== null) return desktopWorkspaceRelayManager;
  const context = await ensureDesktopNativeIdentityContext();
  const coordinator = await ensureDesktopHostedIdentityCoordinator();
  const manager = new DesktopWorkspaceRelayManager({
    authority: {
      resolveTarget: async (environmentId, pairingOnly) => {
        const client = await ensureDesktopWorkspaceClient();
        const snapshot = client.snapshot();
        if (snapshot.status !== "ready" || snapshot.accountId === null) return null;
        const machine = snapshot.catalog.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        const eligible = pairingOnly
          ? machine?.presence.online === true &&
            (machine.nativeTrust === "unverified" ||
              machine.nativeTrust === "unknown" ||
              machine.nativeTrust === "account-trusted") &&
            machine.revokedAt === null &&
            !machine.removed
          : machine?.canConnect === true &&
            (machine.nativeTrust === "verified" || machine.nativeTrust === "account-trusted");
        if (!machine?.nodeId || !eligible) {
          return null;
        }
        const relayUrl = new URL("/v1/relay/client", context.origin);
        relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
        return {
          accountId: snapshot.accountId,
          nodeId: machine.nodeId,
          environmentId,
          relayUrl: relayUrl.toString(),
          nativeTrust: machine.nativeTrust,
        };
      },
      prepareE2ee: async (target, pairingOnly) =>
        (await ensureDesktopNativeE2eeHandshakeService()).prepare({
          accountId: target.accountId,
          nodeId: target.nodeId,
          allowPairing: pairingOnly,
          expectedTrust: pairingOnly
            ? target.nativeTrust === "account-trusted"
              ? "account-trusted"
              : "unverified"
            : target.nativeTrust === "account-trusted"
              ? "account-trusted"
              : "verified",
        }),
      handshake: ensureDesktopNativeE2eeHandshakeService,
      issueTicket: (target) => coordinator.issueRelayTicket(target.nodeId),
      authorizeUpgrade: (target) => coordinator.authorizeRelayUpgrade(target.relayUrl),
      onAccountAuthorizationRevoked: invalidateDesktopNativeE2eeAccess,
    },
    emit: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(DESKTOP_WORKSPACE_IPC.transportEvent, event);
    },
  });
  desktopWorkspaceRelayManager = manager;
  return manager;
}

function emitDesktopWorkspaceState(snapshot: DesktopWorkspaceClientSnapshot): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(
    DESKTOP_WORKSPACE_IPC.stateChanged,
    projectDesktopWorkspaceState(snapshot),
  );
}

async function ensureDesktopWorkspaceClient(): Promise<DesktopWorkspaceClient> {
  if (desktopWorkspaceClient !== null) return desktopWorkspaceClient;
  const context = await ensureDesktopNativeIdentityContext();
  const coordinator = await ensureDesktopHostedIdentityCoordinator();
  const client = new DesktopWorkspaceClient({
    hubOrigin: context.origin,
    identity: {
      resume: async () => {
        desktopHostedIdentityStatus = await coordinator.resume();
        return desktopHostedIdentityStatus;
      },
      connect: async () => {
        desktopHostedIdentityStatus = await coordinator.connect();
        return desktopHostedIdentityStatus;
      },
      disconnect: async () => {
        desktopWorkspaceRelayManager?.dispose();
        desktopNativeE2eeHandshakeService?.dispose();
        await coordinator.disconnect();
        desktopHostedIdentityStatus = { status: "signed-out" };
      },
      listNodes: () => coordinator.listNodes(),
    },
    trust: context.trust,
    cache: createDesktopWorkspaceMetadataCache(DESKTOP_WORKSPACE_CACHE_PATH),
    connection: {
      connect: async ({ environmentId, delayMs }) => {
        mainWindow?.webContents.send(DESKTOP_WORKSPACE_IPC.connectionCommand, {
          action: "connect",
          environmentId,
          delayMs,
        });
      },
      release: async (environmentId) => {
        mainWindow?.webContents.send(DESKTOP_WORKSPACE_IPC.connectionCommand, {
          action: "release",
          environmentId,
          delayMs: 0,
        });
      },
    },
    verification: {
      begin: async ({ environmentId }) => {
        const manager = await ensureDesktopWorkspaceRelayManager();
        const handle = manager.prepareVerification(environmentId);
        await manager.activate(handle);
        return { handle };
      },
      cancel: async (handle) => {
        desktopWorkspaceRelayManager?.close(handle);
      },
      verifyApproval: async ({ accountId, nodeId, environmentId, payload }) => {
        await context.trust.promoteCrossDeviceApproval({
          payload,
          hubOrigin: context.origin,
          accountId,
          nodeId,
          environmentId,
          clientIdentityPublicKey: await context.security.getSigningPublicKey(),
          now: Date.now(),
        });
      },
    },
  });
  disposeDesktopWorkspaceSubscription?.();
  disposeDesktopWorkspaceSubscription = client.subscribe(emitDesktopWorkspaceState);
  desktopWorkspaceClient = client;
  return client;
}

async function ensureDesktopNativeE2eeHandshakeService(): Promise<DesktopNativeE2eeHandshakeService> {
  if (desktopNativeE2eeHandshakeService !== null) return desktopNativeE2eeHandshakeService;
  const context = await ensureDesktopNativeIdentityContext();
  const service = new DesktopNativeE2eeHandshakeService({
    origin: context.origin,
    security: context.security,
    records: context.records,
    trust: context.trust,
    prekey: context.prekey,
    identityStatus: () => desktopHostedIdentityStatus,
    accountAuthority: {
      enrollmentState: () => desktopHostedIdentityCoordinator?.nativeE2eeEnrollmentState ?? null,
      resolve: (input) =>
        ensureDesktopHostedIdentityCoordinator().then((coordinator) =>
          coordinator.resolveNativeE2eeTrust(input),
        ),
      revoked: invalidateDesktopNativeE2eeAccess,
    },
  });
  desktopNativeE2eeHandshakeService = service;
  return service;
}

function invalidateDesktopNativeE2eeAccess(): void {
  desktopHostedIdentityStatus = { status: "unavailable" };
  desktopWorkspaceClient?.invalidateAccess();
  desktopNativeE2eeHandshakeService?.dispose();
  desktopWorkspaceRelayManager?.dispose();
  void desktopHostedIdentityCoordinator?.invalidateNativeE2ee("revoked");
}

async function runDesktopHostedIdentity(
  interactive: boolean,
): Promise<DesktopHostedIdentityStatus> {
  try {
    const coordinator = await ensureDesktopHostedIdentityCoordinator();
    desktopHostedIdentityStatus = interactive
      ? await coordinator.connect()
      : await coordinator.resume();
  } catch {
    desktopHostedIdentityStatus =
      desktopSettings.hubOrigin !== null ? { status: "unavailable" } : { status: "signed-out" };
  }
  writeDesktopLogHeader(`native hosted identity status=${desktopHostedIdentityStatus.status}`);
  return desktopHostedIdentityStatus;
}

function resumeDesktopHostedIdentityForBackend(): void {
  if (
    backendControlToken.length === 0 ||
    desktopHostedIdentityControlGeneration === backendControlToken
  ) {
    return;
  }
  desktopNativeE2eeHandshakeService?.dispose();
  desktopWorkspaceRelayManager?.dispose();
  desktopHostedIdentityControlGeneration = backendControlToken;
  void ensureDesktopWorkspaceClient()
    .then((client) => client.resume())
    .catch(() => runDesktopHostedIdentity(false));
}

function resolveAdvertisedHostOverride(): string | undefined {
  const override = readEnv("RYCO_DESKTOP_LAN_HOST")?.trim();
  return override && override.length > 0 ? override : undefined;
}

function resolveCustomHttpsEndpointUrls(): readonly string[] {
  return (readEnv("RYCO_DESKTOP_HTTPS_ENDPOINTS") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function applyDesktopServerExposureMode(
  mode: DesktopServerExposureMode,
  options?: {
    readonly persist?: boolean;
    readonly rejectIfUnavailable?: boolean;
  },
): Promise<DesktopServerExposureState> {
  const advertisedHostOverride = resolveAdvertisedHostOverride();
  const requestedMode = mode;
  let exposure = resolveDesktopServerExposure({
    mode,
    port: backendPort,
    networkInterfaces: OS.networkInterfaces(),
    ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
  });

  if (requestedMode === "network-accessible" && exposure.endpointUrl === null) {
    if (options?.rejectIfUnavailable) {
      throw new Error("No reachable network address is available for this desktop right now.");
    }
    exposure = resolveDesktopServerExposure({
      mode: "local-only",
      port: backendPort,
      networkInterfaces: OS.networkInterfaces(),
      ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
    });
  }

  desktopServerExposureMode = exposure.mode;
  desktopSettings = setDesktopServerExposurePreference(desktopSettings, requestedMode);
  backendBindHost = exposure.bindHost;
  backendHttpUrl = exposure.localHttpUrl;
  backendWsUrl = exposure.localWsUrl;
  backendEndpointUrl = exposure.endpointUrl;
  backendAdvertisedHost = exposure.advertisedHost;

  if (options?.persist) {
    writeDesktopSettings(DESKTOP_SETTINGS_PATH, desktopSettings);
  }

  return getDesktopServerExposureState();
}

async function applyDesktopTailscaleServeEnabled(
  nextSettings: DesktopSettings,
): Promise<DesktopServerExposureState> {
  desktopSettings = nextSettings;
  writeDesktopSettings(DESKTOP_SETTINGS_PATH, desktopSettings);
  relaunchDesktopApp(
    desktopSettings.tailscaleServeEnabled ? "tailscale-serve-enabled" : "tailscale-serve-disabled",
  );
  return getDesktopServerExposureState();
}

function relaunchDesktopApp(reason: string): void {
  writeDesktopLogHeader(`desktop relaunch requested reason=${reason}`);
  setImmediate(() => {
    isQuitting = true;
    clearUpdatePollTimer();
    cancelBackendReadinessWait();
    void stopBackendAndWaitForExit()
      .catch((error) => {
        writeDesktopLogHeader(
          `desktop relaunch backend shutdown warning message=${formatErrorMessage(error)}`,
        );
      })
      .then(() => desktopSshEnvironmentBridge.dispose().catch(() => undefined))
      .finally(() => {
        restoreStdIoCapture?.();
        if (isDevelopment) {
          app.exit(75);
          return;
        }
        app.relaunch({
          execPath: process.execPath,
          args: process.argv.slice(1),
        });
        app.exit(0);
      });
  });
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeDesktopStartupTimingEntry(entry: ReturnType<typeof desktopStartupTiming.mark>): void {
  const formatted = formatStartupTimingEntry(entry);
  writeDesktopLogHeader(formatted);
  if (STARTUP_TIMING_STDOUT) {
    console.log(`[desktop-startup] ${formatted}`);
  }
}

function markDesktopStartupPhase(phase: string, detail?: string): void {
  writeDesktopStartupTimingEntry(desktopStartupTiming.mark(phase, detail));
}

function flushDesktopStartupTimingEntries(): void {
  for (const entry of desktopStartupTiming.entries()) {
    writeDesktopStartupTimingEntry(entry);
  }
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

async function waitForBackendHttpReady(
  baseUrl: string,
  options?: Parameters<typeof waitForHttpReady>[1],
): Promise<void> {
  cancelBackendReadinessWait();
  const controller = new AbortController();
  backendReadinessAbortController = controller;

  try {
    await waitForHttpReady(baseUrl, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    if (backendReadinessAbortController === controller) {
      backendReadinessAbortController = null;
    }
  }
}

function cancelBackendReadinessWait(): void {
  backendReadinessAbortController?.abort();
  backendReadinessAbortController = null;
}

async function waitForBackendWindowReady(baseUrl: string): Promise<"listening" | "http"> {
  const readySource = await waitForBackendStartupReady({
    listeningPromise: backendListeningDetector?.promise ?? null,
    waitForHttpReady: () =>
      waitForBackendHttpReady(baseUrl, {
        timeoutMs: 60_000,
        path: "/.well-known/ryco/environment",
      }),
    cancelHttpWait: cancelBackendReadinessWait,
  });
  backendRestartBackoff.reset();
  return readySource;
}

async function waitForDevelopmentWindowReady(): Promise<"listening" | "http"> {
  const [backendReadySource] = await Promise.all([
    waitForBackendWindowReady(backendHttpUrl),
    waitForHttpReady(resolveDesktopDevServerUrl(), {
      timeoutMs: 60_000,
    }),
  ]);
  return backendReadySource;
}

function ensureDevelopmentInitialWindowOpen(): void {
  const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!isDevelopment || existingWindow !== null || developmentInitialWindowOpenInFlight !== null) {
    return;
  }

  const nextOpen = waitForDevelopmentWindowReady()
    .then((source) => {
      markDesktopStartupPhase("desktop.backend.listening", `source=${source}`);
      writeDesktopLogHeader(`bootstrap development resources ready backendSource=${source}`);
      resumeDesktopHostedIdentityForBackend();
    })
    .catch((error) => {
      if (isBackendReadinessAborted(error)) {
        return;
      }
      writeDesktopLogHeader(
        `bootstrap development readiness warning message=${formatErrorMessage(error)}`,
      );
      console.warn("[desktop] readiness check timed out during dev bootstrap", error);
    })
    .finally(() => {
      if (!(mainWindow ?? BrowserWindow.getAllWindows()[0])) {
        mainWindow = createWindow();
        writeDesktopLogHeader("bootstrap main window created");
      }
      if (developmentInitialWindowOpenInFlight === nextOpen) {
        developmentInitialWindowOpenInFlight = null;
      }
    });

  developmentInitialWindowOpenInFlight = nextOpen;
}

function ensurePackagedBootstrapWindowOpen(reason: string): BrowserWindow | null {
  if (isDevelopment) {
    return null;
  }

  const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (existingWindow !== null) {
    return existingWindow;
  }

  mainWindow = createWindow();
  writeDesktopLogHeader(`bootstrap main window created reason=${reason}`);
  return mainWindow;
}

function loadPackagedBackendAppWindow(window: BrowserWindow, reason: string): void {
  if (isDevelopment || window.isDestroyed() || backendHttpUrl.length === 0) {
    return;
  }

  const currentUrl = window.webContents.getURL();
  if (
    currentUrl &&
    currentUrl !== "about:blank" &&
    !isDesktopBootUrl(currentUrl) &&
    !currentUrl.startsWith(backendHttpUrl)
  ) {
    return;
  }

  writeDesktopLogHeader(`bootstrap backend app load requested reason=${reason}`);
  markDesktopStartupPhase("desktop.window.app.load-request", `reason=${reason}`);
  void window.loadURL(backendHttpUrl);
}

function ensureInitialBackendWindowOpen(): void {
  if (isDevelopment || backendInitialWindowOpenInFlight !== null) {
    return;
  }

  ensurePackagedBootstrapWindowOpen("backend-bootstrap");

  const nextOpen = waitForBackendWindowReady(backendHttpUrl)
    .then((source) => {
      markDesktopStartupPhase("desktop.backend.listening", `source=${source}`);
      writeDesktopLogHeader(`bootstrap backend ready source=${source}`);
      resumeDesktopHostedIdentityForBackend();
      const window = ensurePackagedBootstrapWindowOpen("backend-ready");
      if (window) {
        loadPackagedBackendAppWindow(window, "backend-ready");
      }
    })
    .catch((error) => {
      if (isBackendReadinessAborted(error)) {
        return;
      }
      writeDesktopLogHeader(
        `bootstrap backend readiness warning message=${formatErrorMessage(error)}`,
      );
      console.warn("[desktop] backend readiness check timed out during packaged bootstrap", error);
    })
    .finally(() => {
      if (backendInitialWindowOpenInFlight === nextOpen) {
        backendInitialWindowOpenInFlight = null;
      }
    });

  backendInitialWindowOpenInFlight = nextOpen;
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const createWriter = (streamName: "stdout" | "stderr") => {
    const stream = process[streamName];
    return createResilientStdIoWriter({
      stream,
      originalWrite: streamName === "stdout" ? originalStdoutWrite : originalStderrWrite,
      capture: (chunk, encoding) => writeDesktopStreamChunk(streamName, chunk, encoding),
      onUnavailable: (error) => {
        desktopLogSink?.write(
          `[${logTimestamp()}] [${logScope("desktop")}] ${streamName} unavailable; continuing with file logging message=${formatErrorMessage(error)}\n`,
        );
      },
    });
  };

  const stdoutWriter = createWriter("stdout");
  const stderrWriter = createWriter("stderr");
  process.stdout.write = stdoutWriter.write;
  process.stderr.write = stderrWriter.write;

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    stdoutWriter.dispose();
    stderrWriter.dispose();
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
    flushDesktopStartupTimingEntries();
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

function captureBackendOutput(child: ChildProcess.ChildProcess): void {
  const attachStream = (
    stream: NodeJS.ReadableStream | null | undefined,
    streamName: "stdout" | "stderr",
  ): void => {
    stream?.on("data", (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      backendLogSink?.write(buffer);
      backendListeningDetector?.push(buffer);
      if (isDevelopment || STARTUP_TIMING_STDOUT) {
        process[streamName].write(buffer);
      }
    });
  };

  attachStream(child.stdout, "stdout");
  attachStream(child.stderr, "stderr");
}

initializePackagedLogging();

if (DESKTOP_DISABLE_GPU) {
  app.disableHardwareAcceleration();
  writeDesktopLogHeader("chromium hardware acceleration disabled via RYCO_DESKTOP_DISABLE_GPU=1");
}

if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", LINUX_WM_CLASS);
}

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updateInstallInFlight = false;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();
let downloadedUpdateFilePath: string | null = null;
let macCodeSignatureKindCache: MacCodeSignatureKind | null = null;

const desktopSshEnvironmentBridge = new DesktopSshEnvironmentBridge({
  getMainWindow: () => mainWindow,
  resolveCliRunner: (): RemoteRycoRunnerOptions => {
    if (isDevelopment && DEV_REMOTE_SERVER_ENTRY_PATH.length > 0) {
      return { nodeScriptPath: DEV_REMOTE_SERVER_ENTRY_PATH };
    }
    return {
      packageSpec: resolveRemoteRycoCliPackageSpec({
        appVersion: app.getVersion(),
        updateChannel: desktopSettings.updateChannel,
        isDevelopment,
      }),
    };
  },
});

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateInstallInFlight) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { rycoCommitHash?: unknown };
    return normalizeCommitHash(parsed.rycoCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(readEnv("RYCO_COMMIT_HASH"));
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/bin.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("Ryco failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    revealWindow(targetWindow);
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function handleCheckForUpdatesMenuClick(): void {
  const hasUpdateFeedConfig =
    readAppUpdateYml() !== null || Boolean(readEnv("RYCO_DESKTOP_MOCK_UPDATES"));
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: readEnv("RYCO_DISABLE_AUTO_UPDATE") === "1",
    hasUpdateFeedConfig,
  });
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  if (updateState.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `Ryco ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  if (isDevelopment && process.platform === "darwin" && ext === "png") {
    const developmentDockIconPath = Path.join(ROOT_DIR, "assets", "dev", "ryco-macos-1024.png");
    if (FS.existsSync(developmentDockIconPath)) {
      return developmentDockIconPath;
    }
  }

  return resolveResourcePath(`icon.${ext}`);
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json. We override it to a clean lowercase `ryco` so the
 * directory is shell-friendly and isolated from any other installs
 * (including upstream Ryco) on the same machine.
 */
function resolveUserDataPath(): string {
  const appDataBase =
    process.platform === "win32"
      ? process.env.APPDATA || Path.join(OS.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? Path.join(OS.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || Path.join(OS.homedir(), ".config");

  return Path.join(appDataBase, USER_DATA_DIR_NAME);
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  if (process.platform === "linux") {
    (app as LinuxDesktopNamedApp).setDesktopName?.(LINUX_DESKTOP_ENTRY_NAME);
  }

  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveIconPath("png");
    if (iconPath) {
      app.dock.setIcon(iconPath);
    }
  }
}

function registerDesktopAuthorizationProtocol(): void {
  const callback = desktopAuthorizationCallbackUri(desktopAuthorizationVariant());
  const scheme = new URL(callback).protocol.slice(0, -1);
  app.setAsDefaultProtocolClient(scheme);
}

function handleDesktopAuthorizationCallback(rawUrl: string): boolean {
  if (!desktopAuthorizationBroker.accept(rawUrl)) return false;
  const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (window) revealWindow(window);
  return true;
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function revealWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isVisible()) {
    markDesktopStartupPhase("desktop.window.first-reveal");
    window.show();
  }

  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }

  window.focus();
}

function schedulePackagedBootReveal(window: BrowserWindow): void {
  const timer = setTimeout(() => {
    if (window.isDestroyed() || window.isVisible()) {
      return;
    }

    const currentUrl = window.webContents.getURL();
    const urlKind = classifyDesktopWindowStartupUrl(currentUrl);
    if (
      urlKind === "blank" ||
      urlKind === "boot" ||
      (urlKind === "app" && isDesktopAppUrl(currentUrl))
    ) {
      markDesktopStartupPhase("desktop.window.boot.reveal-fallback", `urlKind=${urlKind}`);
      revealWindow(window);
    }
  }, 250);
  timer.unref?.();
}

function classifyDesktopWindowStartupUrl(rawUrl: string): "app" | "blank" | "boot" | "other" {
  if (!rawUrl || rawUrl === "about:blank") {
    return "blank";
  }
  if (isDesktopBootUrl(rawUrl)) {
    return "boot";
  }
  if (isDesktopAppUrl(rawUrl)) {
    return "app";
  }
  if (backendHttpUrl.length > 0 && rawUrl.startsWith(backendHttpUrl)) {
    return "app";
  }
  if (isDevelopment) {
    try {
      if (rawUrl.startsWith(resolveDesktopDevServerUrl())) {
        return "app";
      }
    } catch {
      return "other";
    }
  }
  return "other";
}

type DesktopWindowStartupUrlKind = "app" | "blank" | "boot" | "other";

function markDesktopWindowStartupLoad(
  eventName: "did-finish-load" | "dom-ready",
  url: string,
): DesktopWindowStartupUrlKind {
  const urlKind = classifyDesktopWindowStartupUrl(url);
  markDesktopStartupPhase(`desktop.window.${urlKind}.${eventName}`);
  return urlKind;
}

function logDesktopRendererStartupPerformance(
  window: BrowserWindow,
  urlKind: string,
): Promise<void> | null {
  if (!STARTUP_TIMING_STDOUT || urlKind !== "app" || window.isDestroyed()) {
    return null;
  }

  return window.webContents
    .executeJavaScript(
      `(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const resources = performance
          .getEntriesByType("resource")
          .map((entry) => ({
            name: entry.name.replace(location.origin, ""),
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
          }))
          .sort((left, right) => right.duration - left.duration)
          .slice(0, 12);
        const startup = performance
          .getEntries()
          .filter((entry) => entry.name.startsWith("ryco:startup:"))
          .map((entry) => ({
            name: entry.name,
            entryType: entry.entryType,
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
          }));
        return {
          nav: nav
            ? {
                start: Math.round(nav.startTime),
                redirect: Math.round(nav.redirectEnd - nav.redirectStart),
                dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
                connect: Math.round(nav.connectEnd - nav.connectStart),
                requestStart: Math.round(nav.requestStart),
                responseStart: Math.round(nav.responseStart),
                responseEnd: Math.round(nav.responseEnd),
                domInteractive: Math.round(nav.domInteractive),
                domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
                load: Math.round(nav.loadEventEnd),
                transferSize: nav.transferSize,
              }
            : null,
          resources,
          startup,
        };
      })()`,
      true,
    )
    .then((performanceSummary: unknown) => {
      console.info(`[desktop-startup] renderer performance ${JSON.stringify(performanceSummary)}`);
    })
    .catch((error: unknown) => {
      writeDesktopLogHeader(
        `startup renderer performance failed message=${sanitizeLogValue(formatErrorMessage(error))}`,
      );
    });
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

function applyAutoUpdaterChannel(channel: DesktopUpdateChannel): void {
  autoUpdater.channel = channel;
  autoUpdater.allowPrerelease = channel === "nightly";
  autoUpdater.allowDowngrade = channel === "nightly";
  console.info(
    `[desktop-updater] Using update channel '${channel}' (allowPrerelease=${channel === "nightly"}, allowDowngrade=${channel === "nightly"}).`,
  );
}

function shouldEnableAutoUpdates(): boolean {
  const hasUpdateFeedConfig =
    readAppUpdateYml() !== null || Boolean(readEnv("RYCO_DESKTOP_MOCK_UPDATES"));
  return (
    getAutoUpdateDisabledReason({
      isDevelopment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv: readEnv("RYCO_DISABLE_AUTO_UPDATE") === "1",
      hasUpdateFeedConfig,
    }) === null
  );
}

async function checkForUpdates(reason: string): Promise<boolean> {
  if (isQuitting || !updaterConfigured || updateCheckInFlight) return false;
  if (updateState.status === "downloading" || updateState.status === "downloaded") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return false;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
    return true;
  } finally {
    updateCheckInFlight = false;
  }
}

async function downloadAvailableUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  downloadedUpdateFilePath = null;
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  console.info("[desktop-updater] Downloading update...");

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    downloadedUpdateFilePath = null;
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

function resolveCurrentMacAppBundlePath(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  return resolveMacAppBundlePath(process.execPath);
}

function resolveCurrentMacCodeSignatureKind(): MacCodeSignatureKind {
  if (macCodeSignatureKindCache !== null) {
    return macCodeSignatureKindCache;
  }

  const appBundlePath = resolveCurrentMacAppBundlePath();
  if (!appBundlePath) {
    macCodeSignatureKindCache = "unknown";
    return macCodeSignatureKindCache;
  }

  const result = ChildProcess.spawnSync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", appBundlePath],
    {
      encoding: "utf8",
    },
  );
  macCodeSignatureKindCache = parseMacCodeSignatureKind({
    exitCode: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  });
  console.info(
    `[desktop-updater] macOS code signature kind for ${appBundlePath}: ${macCodeSignatureKindCache}`,
  );
  return macCodeSignatureKindCache;
}

function shouldInstallUpdateWithUnsignedMacInstaller(): boolean {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return false;
  }

  return shouldUseUnsignedMacUpdateInstaller({
    platform: process.platform,
    isPackaged: app.isPackaged,
    signatureKind: resolveCurrentMacCodeSignatureKind(),
    disabledByEnv: readEnv("RYCO_DISABLE_UNSIGNED_MAC_UPDATE_INSTALLER") === "1",
    forcedByEnv: readEnv("RYCO_FORCE_UNSIGNED_MAC_UPDATE_INSTALLER") === "1",
  });
}

function prepareUnsignedMacUpdateInstaller(): {
  readonly scriptPath: string;
  readonly targetAppPath: string;
} {
  if (!downloadedUpdateFilePath) {
    throw new Error("Downloaded update file path is not available.");
  }
  if (!FS.existsSync(downloadedUpdateFilePath)) {
    throw new Error(`Downloaded update file no longer exists: ${downloadedUpdateFilePath}`);
  }

  const currentAppBundlePath = resolveCurrentMacAppBundlePath();
  if (!currentAppBundlePath) {
    throw new Error("Could not resolve the current macOS app bundle path.");
  }

  const targetAppPath = resolveMacUpdateTargetAppPath(currentAppBundlePath);
  const targetParent = Path.dirname(targetAppPath);
  try {
    FS.accessSync(targetParent, FS.constants.W_OK);
  } catch {
    throw new Error(
      `Cannot install update to ${targetAppPath} because ${targetParent} is not writable. Install the update manually from the latest GitHub release.`,
    );
  }

  FS.mkdirSync(UNSIGNED_MAC_UPDATE_INSTALLER_DIR, { recursive: true });
  const scriptPath = Path.join(UNSIGNED_MAC_UPDATE_INSTALLER_DIR, `install-${APP_RUN_ID}.zsh`);
  FS.writeFileSync(
    scriptPath,
    createUnsignedMacUpdateInstallScript({
      appLabel: APP_DISPLAY_NAME,
      updateZipPath: downloadedUpdateFilePath,
      targetAppPath,
      waitPid: process.pid,
      logPath: UNSIGNED_MAC_UPDATE_INSTALLER_LOG_PATH,
    }),
    "utf8",
  );
  FS.chmodSync(scriptPath, 0o755);

  return { scriptPath, targetAppPath };
}

function launchUnsignedMacUpdateInstaller(input: {
  readonly scriptPath: string;
  readonly targetAppPath: string;
}): void {
  const child = ChildProcess.spawn("/bin/zsh", [input.scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.info(
    `[desktop-updater] Launched unsigned macOS update installer pid=${child.pid ?? "unknown"} target=${input.targetAppPath}`,
  );
}

async function installDownloadedUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }

  isQuitting = true;
  updateInstallInFlight = true;
  clearUpdatePollTimer();
  try {
    const unsignedMacInstallPlan = shouldInstallUpdateWithUnsignedMacInstaller()
      ? prepareUnsignedMacUpdateInstaller()
      : null;

    await stopBackendAndWaitForExit();
    if (unsignedMacInstallPlan) {
      launchUnsignedMacUpdateInstaller(unsignedMacInstallPlan);
      for (const win of BrowserWindow.getAllWindows()) {
        win.destroy();
      }
      console.info(
        `[desktop-updater] Quitting to let unsigned macOS update installer replace ${unsignedMacInstallPlan.targetAppPath}.`,
      );
      app.quit();
      return { accepted: true, completed: false };
    }

    // Destroy all windows before launching the NSIS installer to avoid the installer finding live windows it needs to close.
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
    // `quitAndInstall()` only starts the handoff to the updater. The actual
    // install may still fail asynchronously, so keep the action incomplete
    // until we either quit or receive an updater error.
    autoUpdater.quitAndInstall(true, true);
    return { accepted: true, completed: false };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    updateInstallInFlight = false;
    isQuitting = false;
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

function configureAutoUpdater(): void {
  const githubToken =
    readEnv("RYCO_DESKTOP_UPDATE_GITHUB_TOKEN")?.trim() || process.env.GH_TOKEN?.trim() || "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  if (readEnv("RYCO_DESKTOP_MOCK_UPDATES")) {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: `http://localhost:${readEnv("RYCO_DESKTOP_MOCK_UPDATE_SERVER_PORT") ?? 3000}`,
    });
  }

  const enabled = shouldEnableAutoUpdates();
  setUpdateState(createBaseUpdateState(desktopSettings.updateChannel, enabled));
  if (!enabled) {
    return;
  }
  updaterConfigured = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  applyAutoUpdaterChannel(desktopSettings.updateChannel);
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    downloadedUpdateFilePath = null;
    if (!doesVersionMatchDesktopUpdateChannel(info.version, updateState.channel)) {
      console.info(
        `[desktop-updater] Ignoring ${info.version} because it does not match the selected '${updateState.channel}' channel.`,
      );
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
      lastLoggedDownloadMilestone = -1;
      return;
    }

    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    downloadedUpdateFilePath = null;
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    const message = formatErrorMessage(error);
    if (updateInstallInFlight) {
      updateInstallInFlight = false;
      isQuitting = false;
      setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
      console.error(`[desktop-updater] Updater error: ${message}`);
      return;
    }
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
    downloadedUpdateFilePath = info.downloadedFile;
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(
      `[desktop-updater] Update downloaded: ${info.version} file=${info.downloadedFile}`,
    );
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}
function scheduleBackendRestart(reason: string): void {
  if (isQuitting || restartTimer) return;

  const delayMs = backendRestartBackoff.nextDelayMs();
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

function resolveDevelopmentBunExecutable(): string {
  const lifecycleExecutable = readEnv("npm_execpath")?.trim();
  if (lifecycleExecutable && /^bun(?:\.exe)?$/iu.test(Path.basename(lifecycleExecutable))) {
    return lifecycleExecutable;
  }
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function startBackend(): void {
  if (isQuitting || backendProcess) return;

  backendObservabilitySettings = readPersistedBackendObservabilitySettings();
  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  markDesktopStartupPhase("desktop.backend.spawn", `port=${backendPort}`);
  const childControlToken = Crypto.randomBytes(32).toString("base64url");
  backendControlToken = childControlToken;
  const backendExecutable = isDevelopment ? resolveDevelopmentBunExecutable() : process.execPath;
  const childEnvironment = backendChildEnv();
  if (isDevelopment) {
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
  } else {
    // In Electron main, process.execPath points to the Electron binary. Run the
    // packaged child in Node mode so it does not become a GUI app instance.
    childEnvironment.ELECTRON_RUN_AS_NODE = "1";
  }
  const child = ChildProcess.spawn(backendExecutable, [backendEntry, "--bootstrap-fd", "3"], {
    cwd: resolveBackendCwd(),
    // Development intentionally uses the pinned Bun runtime. Besides matching
    // the repository toolchain, this keeps Bun.secrets keychain custody stable
    // instead of switching the same dev identity to Electron/keytar at startup.
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const telemetryPipe = child.stdio[4];
  if (telemetryPipe instanceof Duplex) {
    const stopTelemetry = attachDesktopResourceTelemetry(telemetryPipe);
    child.once("exit", stopTelemetry);
  }
  const bootstrapStream = child.stdio[3];
  if (bootstrapStream && "write" in bootstrapStream) {
    bootstrapStream.write(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port: backendPort,
        rycoHome: BACKEND_BASE_DIR,
        host: backendBindHost,
        ...(isDevelopment ? { devUrl: resolveDesktopDevServerUrl() } : {}),
        desktopBootstrapToken: backendBootstrapToken,
        desktopTelemetryFd: 4,
        desktopControlToken: childControlToken,
        ...(computerUseRuntime ? { computerUseBridge: computerUseRuntime.backendBinding() } : {}),
        tailscaleServeEnabled: desktopSettings.tailscaleServeEnabled,
        tailscaleServePort: desktopSettings.tailscaleServePort,
        hubConnectorEnabled: desktopSettings.hubConnectorEnabled,
        ...(desktopSettings.hubOrigin === null ? {} : { hubOrigin: desktopSettings.hubOrigin }),
        ...(desktopSettings.hubNodeName === null
          ? {}
          : { hubNodeName: desktopSettings.hubNodeName }),
        hubAllowFileSecretStore: desktopSettings.hubAllowFileSecretStore,
        ...(backendObservabilitySettings.otlpTracesUrl
          ? { otlpTracesUrl: backendObservabilitySettings.otlpTracesUrl }
          : {}),
        ...(backendObservabilitySettings.otlpMetricsUrl
          ? { otlpMetricsUrl: backendObservabilitySettings.otlpMetricsUrl }
          : {}),
      })}\n`,
    );
    bootstrapStream.end();
  } else {
    if (backendControlToken === childControlToken) backendControlToken = "";
    child.kill("SIGTERM");
    scheduleBackendRestart("missing desktop bootstrap pipe");
    return;
  }
  const listeningDetector = new ServerListeningDetector();
  backendListeningDetector = listeningDetector;
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  captureBackendOutput(child);

  child.once("spawn", () => {
    markDesktopStartupPhase("desktop.backend.spawned", `pid=${child.pid ?? "unknown"}`);
  });

  child.on("error", (error) => {
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(error);
      backendListeningDetector = null;
    }
    const wasExpected = expectedBackendExitChildren.has(child);
    if (backendProcess === child) {
      backendProcess = null;
    }
    if (backendControlToken === childControlToken) backendControlToken = "";
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    if (wasExpected) {
      return;
    }
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(
        new Error(
          `backend exited before logging readiness (code=${code ?? "null"} signal=${signal ?? "null"})`,
        ),
      );
      backendListeningDetector = null;
    }
    const wasExpected = expectedBackendExitChildren.has(child);
    if (backendProcess === child) {
      backendProcess = null;
    }
    if (backendControlToken === childControlToken) backendControlToken = "";
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (isQuitting || wasExpected) return;
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    scheduleBackendRestart(reason);
  });

  ensureInitialBackendWindowOpen();
}

function stopBackend(): void {
  cancelBackendReadinessWait();
  backendListeningDetector = null;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  backendControlToken = "";
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    expectedBackendExitChildren.add(child);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}

async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  cancelBackendReadinessWait();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  backendControlToken = "";
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;
  expectedBackendExitChildren.add(backendChild);

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(): void {
      if (settled) return;
      settled = true;
      backendChild.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve();
    }

    function onExit(): void {
      settle();
    }

    backendChild.once("exit", onExit);
    backendChild.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (backendChild.exitCode === null && backendChild.signalCode === null) {
        backendChild.kill("SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      settle();
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

function registerIpcHandlers(): void {
  ipcMain.removeAllListeners(GET_APP_BRANDING_CHANNEL);
  ipcMain.on(GET_APP_BRANDING_CHANNEL, (event) => {
    event.returnValue = desktopAppBranding;
  });

  ipcMain.removeAllListeners(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
  ipcMain.on(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL, (event) => {
    event.returnValue = {
      label: "Local environment",
      httpBaseUrl: backendHttpUrl || null,
      wsBaseUrl: backendWsUrl || null,
      bootstrapToken: backendBootstrapToken || undefined,
    } as const;
  });

  ipcMain.removeHandler(GET_CLIENT_SETTINGS_CHANNEL);
  ipcMain.handle(GET_CLIENT_SETTINGS_CHANNEL, async () => readClientSettings(CLIENT_SETTINGS_PATH));

  ipcMain.removeHandler(SET_CLIENT_SETTINGS_CHANNEL);
  ipcMain.handle(SET_CLIENT_SETTINGS_CHANNEL, async (_event, rawSettings: unknown) => {
    if (typeof rawSettings !== "object" || rawSettings === null) {
      throw new Error("Invalid client settings payload.");
    }

    writeClientSettings(CLIENT_SETTINGS_PATH, rawSettings as ClientSettings);
  });

  ipcMain.removeHandler(GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL);
  ipcMain.handle(GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, async () =>
    readSavedEnvironmentRegistry(SAVED_ENVIRONMENT_REGISTRY_PATH),
  );

  ipcMain.removeHandler(SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL);
  ipcMain.handle(SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, async (_event, rawRecords: unknown) => {
    if (!Array.isArray(rawRecords)) {
      throw new Error("Invalid saved environment registry payload.");
    }

    writeSavedEnvironmentRegistry(
      SAVED_ENVIRONMENT_REGISTRY_PATH,
      rawRecords as readonly PersistedSavedEnvironmentRecord[],
    );
  });

  ipcMain.removeHandler(GET_SAVED_ENVIRONMENT_SECRET_CHANNEL);
  ipcMain.handle(
    GET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        return null;
      }

      return readSavedEnvironmentSecret({
        registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
        environmentId: rawEnvironmentId,
        secretStorage: getDesktopSecretStorage(),
      });
    },
  );

  ipcMain.removeHandler(SET_SAVED_ENVIRONMENT_SECRET_CHANNEL);
  ipcMain.handle(
    SET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown, rawSecret: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        throw new Error("Invalid saved environment id.");
      }
      if (typeof rawSecret !== "string" || rawSecret.trim().length === 0) {
        throw new Error("Invalid saved environment secret.");
      }

      return writeSavedEnvironmentSecret({
        registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
        environmentId: rawEnvironmentId,
        secret: rawSecret,
        secretStorage: getDesktopSecretStorage(),
      });
    },
  );

  ipcMain.removeHandler(REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL);
  ipcMain.handle(
    REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        return;
      }

      removeSavedEnvironmentSecret({
        registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
        environmentId: rawEnvironmentId,
      });
    },
  );

  desktopSshEnvironmentBridge.registerIpcHandlers(ipcMain);

  ipcMain.removeHandler(GET_SERVER_EXPOSURE_STATE_CHANNEL);
  ipcMain.handle(GET_SERVER_EXPOSURE_STATE_CHANNEL, async () => getDesktopServerExposureState());

  ipcMain.removeHandler(SET_SERVER_EXPOSURE_MODE_CHANNEL);
  ipcMain.handle(SET_SERVER_EXPOSURE_MODE_CHANNEL, async (_event, rawMode: unknown) => {
    if (rawMode !== "local-only" && rawMode !== "network-accessible") {
      throw new Error("Invalid desktop server exposure input.");
    }

    const nextMode = rawMode as DesktopServerExposureMode;
    if (nextMode === desktopServerExposureMode) {
      return getDesktopServerExposureState();
    }

    const nextState = await applyDesktopServerExposureMode(nextMode, {
      persist: true,
      rejectIfUnavailable: true,
    });
    relaunchDesktopApp(`serverExposureMode=${nextMode}`);
    return nextState;
  });

  ipcMain.removeHandler(GET_HUB_LAUNCH_CONFIG_CHANNEL);
  ipcMain.handle(GET_HUB_LAUNCH_CONFIG_CHANNEL, () => ({
    enabled: desktopSettings.hubConnectorEnabled,
    origin: desktopSettings.hubOrigin,
    nodeName: desktopSettings.hubNodeName,
    allowFileSecretStore: desktopSettings.hubAllowFileSecretStore,
    fileSecretStoreFallbackSupported: isDesktopHubFileSecretStoreSupported(process.platform),
  }));

  const hostedIdentityView = (): DesktopHostedIdentityState =>
    desktopHostedIdentityStatus.status === "ready" && desktopHostedIdentityStatus.github
      ? {
          status: desktopHostedIdentityStatus.status,
          github: desktopHostedIdentityStatus.github,
        }
      : { status: desktopHostedIdentityStatus.status };
  const hostedIdentityStepUp = (rawInput: unknown): { readonly totpCode?: string } => {
    if (rawInput === undefined || rawInput === null) return {};
    if (typeof rawInput !== "object" || Array.isArray(rawInput)) {
      throw new Error("Desktop hosted account action is unavailable.");
    }
    const totpCode = (rawInput as { readonly totpCode?: unknown }).totpCode;
    if (totpCode === undefined) return {};
    if (typeof totpCode !== "string" || !/^\d{6,16}$/u.test(totpCode)) {
      throw new Error("Desktop hosted account action is unavailable.");
    }
    return { totpCode };
  };
  const adoptHostedGitHubAction = (
    result: DesktopHostedGitHubActionResult,
  ): DesktopHostedIdentityActionResult => {
    if (result.signedOut) {
      desktopHostedIdentityStatus = { status: "signed-out" };
    } else if (desktopHostedIdentityStatus.status === "ready" && result.github !== undefined) {
      desktopHostedIdentityStatus = {
        ...desktopHostedIdentityStatus,
        github: result.github,
      };
    }
    return { outcome: result.outcome, state: hostedIdentityView() };
  };
  ipcMain.removeHandler(GET_HOSTED_IDENTITY_STATUS_CHANNEL);
  ipcMain.handle(GET_HOSTED_IDENTITY_STATUS_CHANNEL, hostedIdentityView);
  ipcMain.removeHandler(CONNECT_HOSTED_IDENTITY_CHANNEL);
  ipcMain.handle(CONNECT_HOSTED_IDENTITY_CHANNEL, async () => {
    try {
      await (await ensureDesktopWorkspaceClient()).connectIdentity();
    } catch {
      await runDesktopHostedIdentity(true);
    }
    // Interactive account connection is the Desktop onboarding action: once
    // browser sign-in produced a retained session, make the colocated node
    // connector part of the same transaction. Older settings could retain
    // trust and report the client as `ready` while this launch preference was
    // still false, so readiness cannot gate this repair. Startup resumes the
    // node claim after relaunch. A cancelled sign-in has no session material
    // and therefore never enables or restarts anything.
    if (
      shouldEnableDesktopHubConnectorForAccountSetup({
        hubOrigin: desktopSettings.hubOrigin,
        connectorEnabled: desktopSettings.hubConnectorEnabled,
        hasSessionMaterial: desktopHostedIdentityCoordinator?.hasSessionMaterial === true,
      })
    ) {
      const nextSettings = setDesktopHubPreference(desktopSettings, {
        enabled: true,
      });
      writeDesktopSettings(DESKTOP_SETTINGS_PATH, nextSettings);
      desktopSettings = nextSettings;
      relaunchDesktopApp("hub-account-setup-enabling-connector");
    }
    return hostedIdentityView();
  });
  ipcMain.removeHandler(DISCONNECT_HOSTED_IDENTITY_CHANNEL);
  ipcMain.handle(DISCONNECT_HOSTED_IDENTITY_CHANNEL, async () => {
    if (desktopWorkspaceClient) {
      await desktopWorkspaceClient.signOut().catch(() => undefined);
    } else {
      desktopNativeE2eeHandshakeService?.dispose();
      await desktopHostedIdentityCoordinator?.disconnect().catch(() => undefined);
      desktopHostedIdentityStatus = { status: "signed-out" };
    }
    return hostedIdentityView();
  });
  ipcMain.removeHandler(CONNECT_HOSTED_GITHUB_CHANNEL);
  ipcMain.handle(CONNECT_HOSTED_GITHUB_CHANNEL, async (_event, rawInput: unknown) => {
    const coordinator = await ensureDesktopHostedIdentityCoordinator();
    return adoptHostedGitHubAction(await coordinator.connectGitHub(hostedIdentityStepUp(rawInput)));
  });
  ipcMain.removeHandler(DISCONNECT_HOSTED_GITHUB_CHANNEL);
  ipcMain.handle(DISCONNECT_HOSTED_GITHUB_CHANNEL, async (_event, rawInput: unknown) => {
    const coordinator = await ensureDesktopHostedIdentityCoordinator();
    return adoptHostedGitHubAction(
      await coordinator.disconnectGitHub(hostedIdentityStepUp(rawInput)),
    );
  });
  ipcMain.removeHandler(CANCEL_HOSTED_GITHUB_CONNECTION_CHANNEL);
  ipcMain.handle(CANCEL_HOSTED_GITHUB_CONNECTION_CHANNEL, async () => {
    desktopHostedIdentityCoordinator?.cancelGitHubConnection();
  });

  const withDesktopWorkspace = async <A>(
    operation: (handlers: ReturnType<typeof createDesktopWorkspaceIpcHandlers>) => Promise<A>,
  ): Promise<A> =>
    operation(createDesktopWorkspaceIpcHandlers(await ensureDesktopWorkspaceClient()));
  for (const channel of [
    DESKTOP_WORKSPACE_IPC.getState,
    DESKTOP_WORKSPACE_IPC.refreshCatalog,
    DESKTOP_WORKSPACE_IPC.publishSnapshot,
    DESKTOP_WORKSPACE_IPC.retainScope,
    DESKTOP_WORKSPACE_IPC.renewScope,
    DESKTOP_WORKSPACE_IPC.releaseScope,
    DESKTOP_WORKSPACE_IPC.setBackgrounded,
    DESKTOP_WORKSPACE_IPC.purgeCache,
    DESKTOP_WORKSPACE_IPC.beginVerification,
    DESKTOP_WORKSPACE_IPC.cancelVerification,
    DESKTOP_WORKSPACE_IPC.verifyApproval,
  ]) {
    ipcMain.removeHandler(channel);
  }
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.getState, () =>
    withDesktopWorkspace((handlers) => handlers.getState()),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.refreshCatalog, () =>
    withDesktopWorkspace((handlers) => handlers.refreshCatalog()),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.publishSnapshot, (_event, raw: unknown) =>
    withDesktopWorkspace((handlers) => handlers.publishSnapshot(raw)),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.retainScope, (_event, raw: unknown) =>
    withDesktopWorkspace((handlers) => handlers.retainScope(raw)),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.renewScope, (_event, raw: unknown) =>
    withDesktopWorkspace((handlers) => handlers.renewScope(raw)),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.releaseScope, (_event, raw: unknown) =>
    withDesktopWorkspace((handlers) => handlers.releaseScope(raw)),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.setBackgrounded, (_event, raw: unknown) =>
    withDesktopWorkspace((handlers) => handlers.setBackgrounded(raw)),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.purgeCache, (_event, raw?: unknown) =>
    withDesktopWorkspace((handlers) => handlers.purgeCache(raw)),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.beginVerification, (_event, raw: unknown) =>
    withDesktopWorkspace((handlers) => handlers.beginVerification(raw)),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.cancelVerification, (_event, raw: unknown) =>
    withDesktopWorkspace((handlers) => handlers.cancelVerification(raw)),
  );
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.verifyApproval, (_event, raw: unknown) =>
    withDesktopWorkspace((handlers) => handlers.verifyApproval(raw)),
  );
  for (const channel of [
    DESKTOP_WORKSPACE_IPC.prepareTransport,
    DESKTOP_WORKSPACE_IPC.activateTransport,
    DESKTOP_WORKSPACE_IPC.reportConnection,
  ]) {
    ipcMain.removeHandler(channel);
  }
  for (const channel of [
    DESKTOP_WORKSPACE_IPC.sendTransport,
    DESKTOP_WORKSPACE_IPC.closeTransport,
  ]) {
    ipcMain.removeAllListeners(channel);
  }
  const workspaceEnvironmentId = (raw: unknown): EnvironmentId => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) {
      throw new Error("Desktop workspace environment is invalid.");
    }
    return EnvironmentId.make(raw);
  };
  const workspaceTransportId = (raw: unknown): string => {
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{32}$/u.test(raw)) {
      throw new Error("Desktop workspace transport is invalid.");
    }
    return raw;
  };
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.prepareTransport, async (_event, raw: unknown) => ({
    transportId: (await ensureDesktopWorkspaceRelayManager()).prepare(workspaceEnvironmentId(raw)),
  }));
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.activateTransport, async (_event, raw: unknown) =>
    (await ensureDesktopWorkspaceRelayManager()).activate(workspaceTransportId(raw)),
  );
  ipcMain.on(
    DESKTOP_WORKSPACE_IPC.sendTransport,
    (_event, rawTransportId: unknown, rawData: unknown) => {
      if (
        !(rawData instanceof Uint8Array) ||
        rawData.byteLength > DESKTOP_WORKSPACE_MAX_RPC_FRAME_BYTES
      ) {
        return;
      }
      try {
        desktopWorkspaceRelayManager?.send(
          workspaceTransportId(rawTransportId),
          Uint8Array.from(rawData),
        );
      } catch {
        // The transport emits its own bounded close; never surface relay details over IPC.
      }
    },
  );
  ipcMain.on(DESKTOP_WORKSPACE_IPC.closeTransport, (_event, raw: unknown) => {
    try {
      desktopWorkspaceRelayManager?.close(workspaceTransportId(raw));
    } catch {
      // Closing an already-expired opaque handle is idempotent.
    }
  });
  ipcMain.handle(DESKTOP_WORKSPACE_IPC.reportConnection, async (_event, raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("Desktop workspace connection report is invalid.");
    }
    const report = raw as {
      readonly environmentId?: unknown;
      readonly connected?: unknown;
    };
    if (typeof report.connected !== "boolean") {
      throw new Error("Desktop workspace connection report is invalid.");
    }
    (await ensureDesktopWorkspaceClient()).reportConnection(
      workspaceEnvironmentId(report.environmentId),
      report.connected,
    );
  });

  ipcMain.removeHandler(VALIDATE_HUB_ORIGIN_CHANNEL);
  ipcMain.handle(VALIDATE_HUB_ORIGIN_CHANNEL, (_event, raw: unknown) =>
    validateHubOrigin(typeof raw === "string" ? raw : ""),
  );

  ipcMain.removeHandler(SET_HUB_LAUNCH_CONFIG_CHANNEL);
  ipcMain.handle(SET_HUB_LAUNCH_CONFIG_CHANNEL, async (_event, rawInput: unknown) => {
    if (typeof rawInput !== "object" || rawInput === null) {
      throw new Error("Invalid Hub launch configuration input.");
    }
    const input = rawInput as {
      readonly enabled?: unknown;
      readonly origin?: unknown;
      readonly nodeName?: unknown;
      readonly allowFileSecretStore?: unknown;
    };
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new Error("Invalid Hub launch configuration input.");
    }
    if (
      input.allowFileSecretStore !== undefined &&
      typeof input.allowFileSecretStore !== "boolean"
    ) {
      throw new Error("Invalid Hub launch configuration input.");
    }
    if (
      input.allowFileSecretStore === true &&
      !isDesktopHubFileSecretStoreSupported(process.platform)
    ) {
      throw new Error("Permissioned-file Hub key storage is unavailable on this platform.");
    }

    let origin: string | null | undefined;
    if (input.origin === null) {
      origin = null;
    } else if (typeof input.origin === "string") {
      // Validate in main, not in the renderer: the renderer cannot import
      // `@ryco/shared/nodeIdentity` because it pulls in `node:crypto`, and a
      // value that reaches the connector unvalidated fails closed at startup
      // with an opaque `configuration_invalid`.
      const validation = validateHubOrigin(input.origin);
      if (!validation.ok) throw new Error("Invalid Hub address.");
      origin = validation.origin;
    } else if (input.origin !== undefined) {
      throw new Error("Invalid Hub launch configuration input.");
    }

    let nodeName: string | null | undefined;
    if (input.nodeName === null) {
      nodeName = null;
    } else if (typeof input.nodeName === "string") {
      try {
        nodeName = normalizeHubNodeName(input.nodeName);
      } catch {
        throw new Error("Invalid Hub node name.");
      }
    } else if (input.nodeName !== undefined) {
      throw new Error("Invalid Hub launch configuration input.");
    }

    const nextSettings = setDesktopHubPreference(desktopSettings, {
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(origin === undefined ? {} : { origin }),
      ...(nodeName === undefined ? {} : { nodeName }),
      ...(input.allowFileSecretStore === undefined
        ? {}
        : { allowFileSecretStore: input.allowFileSecretStore }),
    });
    if (nextSettings === desktopSettings) return;

    // Persist before publishing the new in-memory value. If the atomic write
    // fails, an identical retry must still attempt the write and relaunch.
    writeDesktopSettings(DESKTOP_SETTINGS_PATH, nextSettings);
    desktopSettings = nextSettings;
    // Never log the origin or node name: together they identify this machine.
    relaunchDesktopApp("hub-launch-config-changed");
  });

  ipcMain.removeHandler(RESTART_APP_CHANNEL);
  ipcMain.handle(RESTART_APP_CHANNEL, () => {
    relaunchDesktopApp("renderer-requested-restart");
  });

  ipcMain.removeHandler(SET_TAILSCALE_SERVE_ENABLED_CHANNEL);
  ipcMain.handle(SET_TAILSCALE_SERVE_ENABLED_CHANNEL, async (_event, rawInput: unknown) => {
    if (typeof rawInput !== "object" || rawInput === null) {
      throw new Error("Invalid Tailscale Serve input.");
    }
    const input = rawInput as {
      readonly enabled?: unknown;
      readonly port?: unknown;
    };
    if (typeof input.enabled !== "boolean") {
      throw new Error("Invalid Tailscale Serve input.");
    }
    const nextSettings = setDesktopTailscaleServePreference(desktopSettings, {
      enabled: input.enabled,
      ...(typeof input.port === "number" ? { port: input.port } : {}),
    });
    if (nextSettings === desktopSettings) {
      return getDesktopServerExposureState();
    }
    return applyDesktopTailscaleServeEnabled(nextSettings);
  });

  ipcMain.removeHandler(GET_ADVERTISED_ENDPOINTS_CHANNEL);
  ipcMain.handle(GET_ADVERTISED_ENDPOINTS_CHANNEL, async () => getDesktopAdvertisedEndpoints());

  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async (_event, rawOptions: unknown) => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const defaultPath = resolvePickFolderDefaultPath(rawOptions);
    const openDialogOptions: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      ...(defaultPath ? { defaultPath } : {}),
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions);
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(SET_THEME_CHANNEL);
  ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(NOTIFY_TURN_COMPLETE_CHANNEL);
  ipcMain.handle(NOTIFY_TURN_COMPLETE_CHANNEL, async (_event, rawNotification: unknown) => {
    const notification = parseTurnCompleteNotification(rawNotification);
    if (!notification) {
      return;
    }
    if (
      !shouldShowTurnCompleteNotification({
        windowFocused: mainWindow?.isFocused() ?? false,
        notificationsSupported: Notification.isSupported(),
      })
    ) {
      return;
    }

    const native = new Notification({
      title: notification.title,
      ...(notification.body ? { body: notification.body } : {}),
    });
    activeTurnCompleteNotifications.add(native);
    native.on("click", () => {
      activeTurnCompleteNotifications.delete(native);
      const targetWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (!targetWindow || targetWindow.isDestroyed()) {
        return;
      }
      revealWindow(targetWindow);
      targetWindow.webContents.send(TURN_COMPLETE_NOTIFICATION_ACTIVATED_CHANNEL, notification);
    });
    native.on("close", () => {
      activeTurnCompleteNotifications.delete(native);
    });
    native.show();
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = normalizeContextMenuItems(items);
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const buildTemplate = (
          entries: readonly ContextMenuItem[],
        ): MenuItemConstructorOptions[] => {
          const template: MenuItemConstructorOptions[] = [];
          let hasInsertedDestructiveSeparator = false;
          for (const item of entries) {
            if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
              template.push({ type: "separator" });
              hasInsertedDestructiveSeparator = true;
            }
            const itemOption: MenuItemConstructorOptions = {
              label: item.label,
              enabled: !item.disabled,
            };
            if (item.children && item.children.length > 0) {
              itemOption.submenu = buildTemplate(item.children);
            } else {
              itemOption.click = () => resolve(item.id);
            }
            if (item.destructive && (!item.children || item.children.length === 0)) {
              const destructiveIcon = getDestructiveMenuIcon();
              if (destructiveIcon) {
                itemOption.icon = destructiveIcon;
              }
            }
            template.push(itemOption);
          }
          return template;
        };

        const menu = Menu.buildFromTemplate(buildTemplate(normalizedItems));
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (externalUrl) {
      try {
        await shell.openExternal(externalUrl);
        return true;
      } catch {
        return false;
      }
    }

    const guidePath = resolveBundledRelayGuidePath(rawUrl, event.sender.getURL());
    if (guidePath === null) return false;
    return (await shell.openPath(guidePath)) === "";
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

  ipcMain.removeHandler(UPDATE_SET_CHANNEL_CHANNEL);
  ipcMain.handle(UPDATE_SET_CHANNEL_CHANNEL, async (_event, rawChannel: unknown) => {
    if (rawChannel !== "latest" && rawChannel !== "nightly") {
      throw new Error("Invalid desktop update channel input.");
    }
    if (updateCheckInFlight || updateDownloadInFlight || updateInstallInFlight) {
      throw new Error("Cannot change update tracks while an update action is in progress.");
    }

    const nextChannel = rawChannel as DesktopUpdateChannel;

    desktopSettings = setDesktopUpdateChannelPreference(desktopSettings, nextChannel);
    writeDesktopSettings(DESKTOP_SETTINGS_PATH, desktopSettings);

    if (nextChannel === updateState.channel) {
      return updateState;
    }

    const enabled = shouldEnableAutoUpdates();
    downloadedUpdateFilePath = null;
    setUpdateState(createBaseUpdateState(nextChannel, enabled));

    if (!enabled || !updaterConfigured) {
      return updateState;
    }

    applyAutoUpdaterChannel(nextChannel);
    const allowDowngrade = autoUpdater.allowDowngrade;
    // An explicit channel switch should allow the immediate nightly->stable rollback path.
    autoUpdater.allowDowngrade = true;
    try {
      await checkForUpdates("channel-change");
    } finally {
      autoUpdater.allowDowngrade = allowDowngrade;
    }
    return updateState;
  });

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
    if (!updaterConfigured) {
      return {
        checked: false,
        state: updateState,
      } satisfies DesktopUpdateCheckResult;
    }
    const checked = await checkForUpdates("web-ui");
    return {
      checked,
      state: updateState,
    } satisfies DesktopUpdateCheckResult;
  });
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

function getInitialWindowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0b0b0c" : "#ffffff";
}

function getWindowTitleBarOptions(): WindowTitleBarOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: nativeTheme.shouldUseDarkColors
        ? TITLEBAR_DARK_SYMBOL_COLOR
        : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  window.setBackgroundColor(getInitialWindowBackgroundColor());
  const { titleBarOverlay } = getWindowTitleBarOptions();
  if (typeof titleBarOverlay === "object") {
    window.setTitleBarOverlay(titleBarOverlay);
  }
}

function syncAllWindowAppearance(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    syncWindowAppearance(window);
  }
}

nativeTheme.on("updated", syncAllWindowAppearance);

function createWindow(): BrowserWindow {
  markDesktopStartupPhase("desktop.window.create");
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: getInitialWindowBackgroundColor(),
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    ...getWindowTitleBarOptions(),
    webPreferences: {
      preload: Path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    const externalUrl = getSafeExternalUrl(params.linkURL);
    if (externalUrl) {
      menuTemplate.push(
        {
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
        },
        { type: "separator" },
      );
    }

    if (params.mediaType === "image") {
      menuTemplate.push({
        label: "Copy Image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      });
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.on("blur", () => {
    void desktopWorkspaceClient?.setBackgrounded(true);
  });
  window.on("focus", () => {
    void desktopWorkspaceClient?.setBackgrounded(false);
  });
  window.webContents.on("dom-ready", () => {
    const currentUrl = window.webContents.getURL();
    markDesktopWindowStartupLoad("dom-ready", currentUrl);
    if (!isDevelopment && isDesktopBootUrl(currentUrl)) {
      revealWindow(window);
    }
  });
  window.webContents.on("did-finish-load", () => {
    const currentUrl = window.webContents.getURL();
    const urlKind = classifyDesktopWindowStartupUrl(currentUrl);
    markDesktopStartupPhase(`desktop.window.${urlKind}.did-finish-load`);
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
    if (desktopWorkspaceClient) emitDesktopWorkspaceState(desktopWorkspaceClient.snapshot());
    void logDesktopRendererStartupPerformance(window, urlKind);
  });

  // On Linux/Wayland with `show: false`, Electron's `ready-to-show` only
  // fires after `show()` is called, deadlocking the standard "wait for
  // ready, then show" pattern. In dev, also fall back to `did-finish-load`
  // so startup remains visible even if Vite/Electron misses ready-to-show.
  // Packaged non-Linux builds keep the no-flash `ready-to-show` path.
  const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
  if (process.platform === "linux" || isDevelopment) {
    revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
  }
  bindFirstRevealTrigger(revealSubscribers, () => revealWindow(window));

  if (isDevelopment) {
    const devUrl = resolveDesktopDevServerUrl();
    void window.loadURL(devUrl);
    if (DESKTOP_OPEN_DEVTOOLS) {
      window.webContents.openDevTools({ mode: "detach" });
    }
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3 || window.isDestroyed()) {
        return;
      }
      writeDesktopLogHeader(
        `dev renderer load failed code=${errorCode} desc=${errorDescription} url=${validatedURL} — retrying in 1s`,
      );
      setTimeout(() => {
        if (!window.isDestroyed()) {
          void window.loadURL(devUrl);
        }
      }, 1000);
    });
  } else {
    const bootFilePath = resolveDesktopBootFilePath();
    markDesktopStartupPhase("desktop.window.boot.load-request");
    if (bootFilePath) {
      void window.loadFile(bootFilePath);
    } else {
      void window.loadURL(resolveDesktopBootUrl());
    }
    schedulePackagedBootReveal(window);
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (errorCode === -3 || window.isDestroyed()) {
          return;
        }
        writeDesktopLogHeader(
          `packaged renderer load failed code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
        );
        if (
          isMainFrame &&
          backendHttpUrl.length > 0 &&
          (isDesktopBootUrl(validatedURL) || isDesktopAppUrl(validatedURL))
        ) {
          writeDesktopLogHeader(
            "packaged desktop protocol load failed; falling back to backend URL",
          );
          void window.loadURL(backendHttpUrl);
        }
      },
    );
  }

  window.on("closed", () => {
    desktopSshEnvironmentBridge.cancelPendingPasswordPrompts(
      "SSH authentication was cancelled because the app window closed.",
    );
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath("userData", resolveUserDataPath());

configureAppIdentity();

/**
 * Refuse to run a second copy of this app against the same state directory.
 *
 * Two backends sharing one `RYCO_HOME` contend over a single node identity, and
 * the loser can land in `connection_replaced` — an operator-action failure with
 * no retry timer, so it never clears on its own.
 *
 * This is a UX guard, not the correctness fix. It coordinates only instances of
 * this Electron application: a headless `ryco serve` or any other process
 * sharing the state directory is unaffected, and the identity writer lock
 * remains the actual arbiter. Desktop Dev also owns this lock so a macOS
 * `ryco-dev://` callback is delivered to the running broker instead of turning
 * the raw callback Electron process into a second hidden primary instance.
 */
if (!isDesktopAuthorizationCallbackRelay && !app.requestSingleInstanceLock()) {
  writeDesktopLogHeader("second instance refused; focusing the existing window");
  app.exit(0);
}

app.on("open-url", (event, url) => {
  if (isDesktopAuthorizationCallbackRelay) {
    event.preventDefault();
    const callback = findDesktopAuthorizationCallback(
      [url],
      desktopAuthorizationCallbackUri(desktopAuthorizationVariant()),
    );
    if (callback !== null) {
      const acquired = app.requestSingleInstanceLock({
        desktopAuthorizationCallback: callback,
      });
      if (acquired) app.releaseSingleInstanceLock();
    }
    app.exit(0);
    return;
  }
  if (!handleDesktopAuthorizationCallback(url)) return;
  event.preventDefault();
});

app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
  const callback = resolveDesktopAuthorizationCallback({
    commandLine,
    additionalData,
    callbackUri: desktopAuthorizationCallbackUri(desktopAuthorizationVariant()),
  });
  if (callback !== null) handleDesktopAuthorizationCallback(callback);
  const [existing] = BrowserWindow.getAllWindows();
  if (existing === undefined) return;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
});

async function bootstrap(): Promise<void> {
  markDesktopStartupPhase("desktop.bootstrap.start");
  warnIfDesktopSettingsUnreadable();
  const configuredBackendPort = resolveConfiguredDesktopBackendPort(readEnv("RYCO_PORT"));
  if (isDevelopment && configuredBackendPort === undefined) {
    throw new Error("RYCO_PORT is required in desktop development.");
  }

  backendPort =
    configuredBackendPort ??
    (await resolveDesktopBackendPort({
      host: DESKTOP_LOOPBACK_HOST,
      startPort: DEFAULT_DESKTOP_BACKEND_PORT,
      requiredHosts: DESKTOP_REQUIRED_PORT_PROBE_HOSTS,
    }));
  writeDesktopLogHeader(
    configuredBackendPort === undefined
      ? `selected backend port via sequential scan startPort=${DEFAULT_DESKTOP_BACKEND_PORT} port=${backendPort}`
      : `using configured backend port port=${backendPort}`,
  );
  backendBootstrapToken = Crypto.randomBytes(24).toString("hex");
  if (desktopSettings.serverExposureMode !== DEFAULT_DESKTOP_SETTINGS.serverExposureMode) {
    writeDesktopLogHeader(
      `bootstrap restoring persisted server exposure mode mode=${desktopSettings.serverExposureMode}`,
    );
  }
  const serverExposureState = await applyDesktopServerExposureMode(
    desktopSettings.serverExposureMode,
    {
      persist: desktopSettings.serverExposureMode !== DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
    },
  );
  writeDesktopLogHeader(`bootstrap resolved backend endpoint baseUrl=${backendHttpUrl}`);
  if (serverExposureState.endpointUrl) {
    writeDesktopLogHeader(
      `bootstrap enabled network access endpointUrl=${serverExposureState.endpointUrl}`,
    );
  } else if (desktopSettings.serverExposureMode === "network-accessible") {
    writeDesktopLogHeader(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  registerIpcHandlers();
  try {
    computerUseRuntime = new DesktopComputerUseRuntime({
      stateDir: STATE_DIR,
      helperPath: Path.join(
        app.isPackaged ? process.resourcesPath : Path.join(__dirname, "../resources"),
        `ryco-computer-use-helper${process.platform === "win32" ? ".exe" : ""}`,
      ),
      extensionPath: app.isPackaged
        ? Path.join(process.resourcesPath, "browser-extension")
        : Path.join(__dirname, "../browser-extension"),
      getWindow: () => mainWindow,
      changed: (state) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send("desktop:computer-use:changed", state);
      },
    });
    await computerUseRuntime.start();
    registerComputerUseIpc(computerUseRuntime, () => mainWindow);
  } catch {
    computerUseRuntime?.dispose();
    computerUseRuntime = null;
    writeDesktopLogHeader("Computer-use bridge unavailable; continuing without desktop control.");
  }
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  if (!isDevelopment) {
    ensurePackagedBootstrapWindowOpen("pre-backend-bootstrap");
  }
  const shellEnvironmentPrepareResult = prepareDesktopShellEnvironmentForBackend();
  startBackend();
  if (shellEnvironmentPrepareResult === "cache-hit") {
    scheduleDesktopShellEnvironmentRefresh("deferred-refresh");
  }
  writeDesktopLogHeader("bootstrap backend start requested");

  if (isDevelopment) {
    ensureDevelopmentInitialWindowOpen();
    return;
  }

  ensureInitialBackendWindowOpen();
}

app.on("before-quit", () => {
  isQuitting = true;
  computerUseRuntime?.dispose();
  updateInstallInFlight = false;
  writeDesktopLogHeader("before-quit received");
  clearUpdatePollTimer();
  cancelBackendReadinessWait();
  stopBackend();
  desktopAuthorizationBroker.cancel();
  desktopNativeE2eeHandshakeService?.dispose();
  disposeDesktopWorkspaceSubscription?.();
  disposeDesktopWorkspaceSubscription = null;
  void desktopSshEnvironmentBridge.dispose().catch(() => undefined);
  restoreStdIoCapture?.();
});

app
  .whenReady()
  .then(() => {
    if (isDesktopAuthorizationCallbackRelay) {
      setTimeout(() => app.exit(0), 5_000).unref();
      return;
    }
    markDesktopStartupPhase("desktop.ready");
    configureAppIdentity();
    configureApplicationMenu();
    registerDesktopProtocol();
    registerDesktopAuthorizationProtocol();
    configureAutoUpdater();
    void bootstrap().catch((error) => {
      if (isBackendReadinessAborted(error) && isQuitting) {
        return;
      }
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (existingWindow) {
        revealWindow(existingWindow);
        return;
      }
      if (isDevelopment) {
        ensureDevelopmentInitialWindowOpen();
        return;
      }
      ensureInitialBackendWindowOpen();
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isQuitting) {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGINT received");
    clearUpdatePollTimer();
    cancelBackendReadinessWait();
    stopBackend();
    void desktopSshEnvironmentBridge.dispose().catch(() => undefined);
    restoreStdIoCapture?.();
    app.quit();
  });

  process.on("SIGTERM", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGTERM received");
    clearUpdatePollTimer();
    stopBackend();
    void desktopSshEnvironmentBridge.dispose().catch(() => undefined);
    restoreStdIoCapture?.();
    app.quit();
  });
}
