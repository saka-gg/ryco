import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge } from "@ryco/contracts";
import { DESKTOP_WORKSPACE_IPC } from "./desktopWorkspaceChannels.ts";

const startupTimingEnabled = process.env.RYCO_DESKTOP_STARTUP_TIMING_STDOUT === "1";
const preloadStartMs = performance.now();
if (startupTimingEnabled) {
  console.info(`[desktop-startup] preload start elapsedMs=${Math.round(preloadStartMs)}`);
}

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_SET_CHANNEL_CHANNEL = "desktop:update-set-channel";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";
const GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL = "desktop:get-local-environment-bootstrap";
const GET_CLIENT_SETTINGS_CHANNEL = "desktop:get-client-settings";
const SET_CLIENT_SETTINGS_CHANNEL = "desktop:set-client-settings";
const GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:get-saved-environment-registry";
const SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:set-saved-environment-registry";
const GET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:get-saved-environment-secret";
const SET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:set-saved-environment-secret";
const REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:remove-saved-environment-secret";
const DISCOVER_SSH_HOSTS_CHANNEL = "desktop:discover-ssh-hosts";
const ENSURE_SSH_ENVIRONMENT_CHANNEL = "desktop:ensure-ssh-environment";
const DISCONNECT_SSH_ENVIRONMENT_CHANNEL = "desktop:disconnect-ssh-environment";
const FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL = "desktop:fetch-ssh-environment-descriptor";
const BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL = "desktop:bootstrap-ssh-bearer-session";
const FETCH_SSH_SESSION_STATE_CHANNEL = "desktop:fetch-ssh-session-state";
const ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL = "desktop:issue-ssh-websocket-token";
const SSH_PASSWORD_PROMPT_CHANNEL = "desktop:ssh-password-prompt";
const RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL = "desktop:resolve-ssh-password-prompt";
const GET_SERVER_EXPOSURE_STATE_CHANNEL = "desktop:get-server-exposure-state";
const SET_SERVER_EXPOSURE_MODE_CHANNEL = "desktop:set-server-exposure-mode";
const SET_TAILSCALE_SERVE_ENABLED_CHANNEL = "desktop:set-tailscale-serve-enabled";
const GET_HUB_LAUNCH_CONFIG_CHANNEL = "desktop:get-hub-launch-config";
const SET_HUB_LAUNCH_CONFIG_CHANNEL = "desktop:set-hub-launch-config";
const RESTART_APP_CHANNEL = "desktop:restart-app";
const VALIDATE_HUB_ORIGIN_CHANNEL = "desktop:validate-hub-origin";
const GET_HOSTED_IDENTITY_STATUS_CHANNEL = "desktop:get-hosted-identity-status";
const CONNECT_HOSTED_IDENTITY_CHANNEL = "desktop:connect-hosted-identity";
const DISCONNECT_HOSTED_IDENTITY_CHANNEL = "desktop:disconnect-hosted-identity";
const CONNECT_HOSTED_GITHUB_CHANNEL = "desktop:connect-hosted-github";
const DISCONNECT_HOSTED_GITHUB_CHANNEL = "desktop:disconnect-hosted-github";
const CANCEL_HOSTED_GITHUB_CONNECTION_CHANNEL = "desktop:cancel-hosted-github-connection";
const GET_ADVERTISED_ENDPOINTS_CHANNEL = "desktop:get-advertised-endpoints";
const NOTIFY_TURN_COMPLETE_CHANNEL = "desktop:notify-turn-complete";
const TURN_COMPLETE_NOTIFICATION_ACTIVATED_CHANNEL = "desktop:turn-complete-notification-activated";
const SSH_PASSWORD_PROMPT_CANCELLED_RESULT = "ssh-password-prompt-cancelled";

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
}

contextBridge.exposeInMainWorld("desktopBridge", {
  computerUse: {
    getState: () => ipcRenderer.invoke("desktop:computer-use:state"),
    refresh: (query) => ipcRenderer.invoke("desktop:computer-use:refresh", query),
    setPolicy: (policy) => ipcRenderer.invoke("desktop:computer-use:policy", policy),
    requestPermission: (kind) => ipcRenderer.invoke("desktop:computer-use:permission", kind),
    pairBrowser: (browser) => ipcRenderer.invoke("desktop:computer-use:pair", browser),
    showExtension: () => ipcRenderer.invoke("desktop:computer-use:extension"),
    openBrowserSetup: (browser) =>
      ipcRenderer.invoke("desktop:computer-use:browser-setup", browser),
    stop: () => ipcRenderer.invoke("desktop:computer-use:stop"),
    onState: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
        listener(state);
      ipcRenderer.on("desktop:computer-use:changed", wrapped);
      return () => ipcRenderer.removeListener("desktop:computer-use:changed", wrapped);
    },
  },
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppBranding"]>;
  },
  getLocalEnvironmentBootstrap: () => {
    const result = ipcRenderer.sendSync(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstrap"]>;
  },
  getClientSettings: () => ipcRenderer.invoke(GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) => ipcRenderer.invoke(SET_CLIENT_SETTINGS_CHANNEL, settings),
  getSavedEnvironmentRegistry: () => ipcRenderer.invoke(GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL),
  setSavedEnvironmentRegistry: (records) =>
    ipcRenderer.invoke(SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, records),
  getSavedEnvironmentSecret: (environmentId) =>
    ipcRenderer.invoke(GET_SAVED_ENVIRONMENT_SECRET_CHANNEL, environmentId),
  setSavedEnvironmentSecret: (environmentId, secret) =>
    ipcRenderer.invoke(SET_SAVED_ENVIRONMENT_SECRET_CHANNEL, environmentId, secret),
  removeSavedEnvironmentSecret: (environmentId) =>
    ipcRenderer.invoke(REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL, environmentId),
  discoverSshHosts: () => ipcRenderer.invoke(DISCOVER_SSH_HOSTS_CHANNEL),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await ipcRenderer.invoke(ENSURE_SSH_ENVIRONMENT_CHANNEL, target, options),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, httpBaseUrl),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, httpBaseUrl, credential),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(FETCH_SSH_SESSION_STATE_CHANNEL, httpBaseUrl, bearerToken),
  issueSshWebSocketToken: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL, httpBaseUrl, bearerToken),
  onSshPasswordPrompt: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    };
  },
  resolveSshPasswordPrompt: (requestId, password) =>
    ipcRenderer.invoke(RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, requestId, password),
  getServerExposureState: () => ipcRenderer.invoke(GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) => ipcRenderer.invoke(SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  setTailscaleServeEnabled: (input) =>
    ipcRenderer.invoke(SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getHubLaunchConfig: () => ipcRenderer.invoke(GET_HUB_LAUNCH_CONFIG_CHANNEL),
  restartApp: () => ipcRenderer.invoke(RESTART_APP_CHANNEL),
  getHostedIdentityState: () => ipcRenderer.invoke(GET_HOSTED_IDENTITY_STATUS_CHANNEL),
  connectHostedIdentity: () => ipcRenderer.invoke(CONNECT_HOSTED_IDENTITY_CHANNEL),
  disconnectHostedIdentity: () => ipcRenderer.invoke(DISCONNECT_HOSTED_IDENTITY_CHANNEL),
  connectHostedGitHub: (input) => ipcRenderer.invoke(CONNECT_HOSTED_GITHUB_CHANNEL, input),
  disconnectHostedGitHub: (input) => ipcRenderer.invoke(DISCONNECT_HOSTED_GITHUB_CHANNEL, input),
  cancelHostedGitHubConnection: () => ipcRenderer.invoke(CANCEL_HOSTED_GITHUB_CONNECTION_CHANNEL),
  getDesktopWorkspaceState: () => ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.getState),
  refreshDesktopWorkspaceCatalog: () => ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.refreshCatalog),
  publishDesktopWorkspaceSnapshot: (snapshot) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.publishSnapshot, snapshot),
  retainDesktopWorkspaceScope: (input) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.retainScope, input),
  renewDesktopWorkspaceScope: (leaseId) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.renewScope, leaseId),
  releaseDesktopWorkspaceScope: (leaseId) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.releaseScope, leaseId),
  setDesktopWorkspaceBackgrounded: (backgrounded) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.setBackgrounded, backgrounded),
  purgeDesktopWorkspaceCache: (environmentId) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.purgeCache, environmentId),
  beginDesktopWorkspaceVerification: (input) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.beginVerification, input),
  cancelDesktopWorkspaceVerification: (handle) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.cancelVerification, handle),
  verifyDesktopWorkspaceApproval: (input) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.verifyApproval, input),
  onDesktopWorkspaceState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(DESKTOP_WORKSPACE_IPC.stateChanged, wrappedListener);
    return () => ipcRenderer.removeListener(DESKTOP_WORKSPACE_IPC.stateChanged, wrappedListener);
  },
  onDesktopWorkspaceConnectionCommand: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (typeof command !== "object" || command === null) return;
      listener(command as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(DESKTOP_WORKSPACE_IPC.connectionCommand, wrappedListener);
    return () =>
      ipcRenderer.removeListener(DESKTOP_WORKSPACE_IPC.connectionCommand, wrappedListener);
  },
  prepareDesktopWorkspaceTransport: (environmentId) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.prepareTransport, environmentId),
  activateDesktopWorkspaceTransport: (transportId) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.activateTransport, transportId),
  sendDesktopWorkspaceTransport: (transportId, data) =>
    ipcRenderer.send(DESKTOP_WORKSPACE_IPC.sendTransport, transportId, data),
  closeDesktopWorkspaceTransport: (transportId) =>
    ipcRenderer.send(DESKTOP_WORKSPACE_IPC.closeTransport, transportId),
  reportDesktopWorkspaceConnection: (input) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.reportConnection, input),
  onDesktopWorkspaceTransportEvent: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, transportEvent: unknown) => {
      if (typeof transportEvent !== "object" || transportEvent === null) return;
      listener(transportEvent as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(DESKTOP_WORKSPACE_IPC.transportEvent, wrappedListener);
    return () => ipcRenderer.removeListener(DESKTOP_WORKSPACE_IPC.transportEvent, wrappedListener);
  },
  setHubLaunchConfig: (input: {
    readonly enabled?: boolean;
    readonly origin?: string | null;
    readonly nodeName?: string | null;
    readonly allowFileSecretStore?: boolean;
  }) => ipcRenderer.invoke(SET_HUB_LAUNCH_CONFIG_CHANNEL, input),
  validateHubOrigin: (raw: string) => ipcRenderer.invoke(VALIDATE_HUB_ORIGIN_CHANNEL, raw),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pickFolder: (options) => ipcRenderer.invoke(PICK_FOLDER_CHANNEL, options),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel) => ipcRenderer.invoke(UPDATE_SET_CHANNEL_CHANNEL, channel),
  checkForUpdate: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  notifyTurnComplete: (notification) =>
    ipcRenderer.invoke(NOTIFY_TURN_COMPLETE_CHANNEL, notification),
  onTurnCompleteNotificationActivated: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, notification: unknown) => {
      if (typeof notification !== "object" || notification === null) return;
      listener(notification as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(TURN_COMPLETE_NOTIFICATION_ACTIVATED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(TURN_COMPLETE_NOTIFICATION_ACTIVATED_CHANNEL, wrappedListener);
    };
  },
} satisfies DesktopBridge);

if (startupTimingEnabled) {
  console.info(
    `[desktop-startup] preload end elapsedMs=${Math.round(performance.now())} durationMs=${Math.round(
      performance.now() - preloadStartMs,
    )}`,
  );
}
