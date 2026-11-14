import { isQuitShortcutChord } from "./quitShortcut.ts";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge, DesktopQuitGuardResponder } from "@ryco/contracts";
import { DESKTOP_WORKSPACE_IPC } from "./desktopWorkspaceChannels.ts";
import { PASTE_AS_TEXT_CHANNEL } from "./editMenu.ts";
import { answerQuitGuardRequest, DESKTOP_QUIT_GUARD_IPC } from "./quitGuardChannels.ts";
import { DESKTOP_SSH_IPC } from "./sshEnvironmentChannels.ts";
import { DESKTOP_STARTUP_MARKS_CHANNEL, observeRendererStartupMarks } from "./startupMarks.ts";
import { THREAD_NOTIFICATION_IPC } from "./threadNotificationChannels.ts";
import { WINDOW_CAPTURE_IPC } from "./windowCaptureChannels.ts";
import {
  GET_APP_BRANDING_CHANNEL,
  GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL,
  MENU_ACTION_CHANNEL,
  SYSTEM_RESUMED_CHANNEL,
  DATABASE_COMPACTION_STATE_CHANNEL,
  UPDATE_STATE_CHANNEL,
  QUIT_SHORTCUT_FEEDBACK_CHANNEL,
  APP_KEYBINDINGS_CHANGED_CHANNEL,
  SSH_PASSWORD_PROMPT_CHANNEL,
  PICK_FOLDER_CHANNEL,
  CONFIRM_CHANNEL,
  SET_THEME_CHANNEL,
  SET_WINDOW_MATERIAL_CHANNEL,
  CONTEXT_MENU_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_REMOTE_INSTALL_RESPONSE_CHANNEL,
  DATABASE_COMPACTION_GET_STATE_CHANNEL,
  DATABASE_COMPACTION_START_CHANNEL,
  DATABASE_COMPACTION_CANCEL_CHANNEL,
  SAVE_THREAD_EXPORT_CHANNEL,
  CLI_COMMAND_STATE_CHANNEL,
  CLI_COMMAND_INSTALL_CHANNEL,
  CLI_COMMAND_UNINSTALL_CHANNEL,
  NIGHTLY_STATE_CHANNEL,
  NIGHTLY_OPEN_CHANNEL,
  NIGHTLY_SWITCH_BACK_CHANNEL,
  APP_ICON_GET_CHANNEL,
  APP_ICON_SET_CHANNEL,
  QUIT_SHORTCUT_GET_CHANNEL,
  QUIT_SHORTCUT_SET_CHANNEL,
  APP_KEYBINDINGS_READ_CHANNEL,
  APP_KEYBINDINGS_WRITE_CHANNEL,
  GET_CLIENT_SETTINGS_CHANNEL,
  SET_CLIENT_SETTINGS_CHANNEL,
  GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
  SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
  GET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  SET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  GET_SERVER_EXPOSURE_STATE_CHANNEL,
  SET_SERVER_EXPOSURE_MODE_CHANNEL,
  SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
  GET_ADVERTISED_ENDPOINTS_CHANNEL,
  GET_KEEP_AWAKE_STATE_CHANNEL,
  SET_KEEP_AWAKE_MODE_CHANNEL,
  GET_HUB_LAUNCH_CONFIG_CHANNEL,
  SET_HUB_LAUNCH_CONFIG_CHANNEL,
  VALIDATE_HUB_ORIGIN_CHANNEL,
  RESTART_APP_CHANNEL,
  GET_HOSTED_IDENTITY_STATUS_CHANNEL,
  CONNECT_HOSTED_IDENTITY_CHANNEL,
  DISCONNECT_HOSTED_IDENTITY_CHANNEL,
  CONNECT_HOSTED_GITHUB_CHANNEL,
  DISCONNECT_HOSTED_GITHUB_CHANNEL,
  CANCEL_HOSTED_GITHUB_CONNECTION_CHANNEL,
  DESKTOP_BROWSER_IPC,
  DESKTOP_COMPUTER_USE_IPC,
} from "./desktopIpcChannels.ts";

// Capture before app/terminal listeners, without suppressing Electron key releases.
function suppressQuitShortcut(event: KeyboardEvent): void {
  if (
    !isQuitShortcutChord(
      {
        key: event.key,
        control: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
      },
      process.platform === "darwin",
    )
  )
    return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
window.addEventListener("keydown", suppressQuitShortcut, true);
window.addEventListener("keyup", suppressQuitShortcut, true);

const startupTimingEnabled = process.env.RYCO_DESKTOP_STARTUP_TIMING_STDOUT === "1";
const preloadStartMs = performance.now();
if (startupTimingEnabled) {
  console.info(`[desktop-startup] preload start elapsedMs=${Math.round(preloadStartMs)}`);
}

const SSH_PASSWORD_PROMPT_CANCELLED_RESULT = "ssh-password-prompt-cancelled";

// Fixed for the lifetime of a page: main creates the backend URL and token once
// per app run, and changing the exposure mode relaunches the app. Asking main
// synchronously on every call would block this renderer behind a busy main.
let cachedAppBranding: ReturnType<DesktopBridge["getAppBranding"]> | null = null;
let cachedLocalEnvironmentBootstrap: ReturnType<
  DesktopBridge["getLocalEnvironmentBootstrap"]
> | null = null;

// Report startup marks once the primary shell is usable and again once it
// painted, on every launch.
observeRendererStartupMarks({
  performance,
  PerformanceObserver: typeof PerformanceObserver === "function" ? PerformanceObserver : undefined,
  report: (report) => ipcRenderer.send(DESKTOP_STARTUP_MARKS_CHANNEL, report),
});

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// Window capture runs the macOS helper; elsewhere the bridge omits it, so the
// composer shows no capture entry.
const windowCaptureBridge: DesktopBridge["windowCapture"] =
  process.platform === "darwin"
    ? {
        getState: () => ipcRenderer.invoke(WINDOW_CAPTURE_IPC.getState),
        setup: (permissions) => ipcRenderer.invoke(WINDOW_CAPTURE_IPC.setup, permissions),
        setShortcut: (shortcut) => ipcRenderer.invoke(WINDOW_CAPTURE_IPC.setShortcut, shortcut),
        listWindows: () => ipcRenderer.invoke(WINDOW_CAPTURE_IPC.listWindows),
        captureWindow: (windowId) => ipcRenderer.invoke(WINDOW_CAPTURE_IPC.captureWindow, windowId),
        listPendingCaptures: () => ipcRenderer.invoke(WINDOW_CAPTURE_IPC.listPendingCaptures),
        readPendingCapture: (captureId) =>
          ipcRenderer.invoke(WINDOW_CAPTURE_IPC.readPendingCapture, captureId),
        acknowledgeCapture: (captureId) =>
          ipcRenderer.invoke(WINDOW_CAPTURE_IPC.acknowledgeCapture, captureId),
        onState: (listener) => subscribe(WINDOW_CAPTURE_IPC.state, listener),
        onCaptured: (listener) => subscribe(WINDOW_CAPTURE_IPC.captured, listener),
        onError: (listener) => subscribe(WINDOW_CAPTURE_IPC.error, listener),
      }
    : undefined;

// Main asks before a quit which chats quitting would stop. Answered here from the first
// request on: without a responder (the app has not loaded it yet) the answer is "unavailable",
// so main quits at once instead of waiting out its timeout.
let quitGuardResponder: DesktopQuitGuardResponder | null = null;
ipcRenderer.on(DESKTOP_QUIT_GUARD_IPC.request, (_event, raw: unknown) => {
  void answerQuitGuardRequest(quitGuardResponder, raw)
    .then((reply) => {
      if (reply !== null) ipcRenderer.send(DESKTOP_QUIT_GUARD_IPC.reply, reply);
    })
    .catch(() => undefined);
});

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
  saveThreadExport: (input) => ipcRenderer.invoke(SAVE_THREAD_EXPORT_CHANNEL, input),
  databaseCompaction: {
    getState: () => ipcRenderer.invoke(DATABASE_COMPACTION_GET_STATE_CHANNEL),
    start: () => ipcRenderer.invoke(DATABASE_COMPACTION_START_CHANNEL),
    cancel: () => ipcRenderer.invoke(DATABASE_COMPACTION_CANCEL_CHANNEL),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(DATABASE_COMPACTION_STATE_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(DATABASE_COMPACTION_STATE_CHANNEL, wrappedListener);
      };
    },
  },
  browser: {
    getState: () => ipcRenderer.invoke(DESKTOP_BROWSER_IPC.state),
    open: (input) => ipcRenderer.invoke(DESKTOP_BROWSER_IPC.open, input),
    command: (input) => ipcRenderer.invoke(DESKTOP_BROWSER_IPC.command, input),
    surface: (input) => ipcRenderer.invoke(DESKTOP_BROWSER_IPC.surface, input),
    capture: (tab) => ipcRenderer.invoke(DESKTOP_BROWSER_IPC.capture, tab),
    pick: (tab) => ipcRenderer.invoke(DESKTOP_BROWSER_IPC.pick, tab),
    discover: (cwd) => ipcRenderer.invoke(DESKTOP_BROWSER_IPC.discover, cwd),
    onFocusAddress: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, tab: string) => listener(tab);
      ipcRenderer.on(DESKTOP_BROWSER_IPC.focusAddress, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_BROWSER_IPC.focusAddress, wrapped);
    },
    onState: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
        listener(state);
      ipcRenderer.on(DESKTOP_BROWSER_IPC.changed, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_BROWSER_IPC.changed, wrapped);
    },
  },
  computerBeta: {
    getHistory: (input) => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaHistory, input),
    getState: () => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaState),
    checkPermissions: () => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaCheck),
    setup: () => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaSetup),
    turnOn: () => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaTurnOn),
    setupPermission: (permission) =>
      ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaSetupPermission, permission),
    revokeApp: (key) => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaRevokeApp, key),
    setPreferences: (value) => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaPreferences, value),
    prepare: (threadId, explicit) =>
      ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaPrepare, { threadId, explicit }),
    setPreview: (threadId, visible) =>
      ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaPreview, { threadId, visible }),
    stopTask: (threadId) => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.betaStop, { threadId }),
    onUpdate: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, update: Parameters<typeof listener>[0]) =>
        listener(update);
      ipcRenderer.on(DESKTOP_COMPUTER_USE_IPC.betaUpdate, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_COMPUTER_USE_IPC.betaUpdate, wrapped);
    },
  },
  computerUse: {
    getState: () => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.state),
    checkPermissions: () => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.checkPermissions),
    refresh: (query) => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.refresh, query),
    setPolicy: (policy) => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.policy, policy),
    requestPermission: (kind) => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.permission, kind),
    pairBrowser: (browser) => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.pair, browser),
    showExtension: () => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.extension),
    openBrowserSetup: (browser) =>
      ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.browserSetup, browser),
    stop: () => ipcRenderer.invoke(DESKTOP_COMPUTER_USE_IPC.stop),
    onState: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
        listener(state);
      ipcRenderer.on(DESKTOP_COMPUTER_USE_IPC.changed, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_COMPUTER_USE_IPC.changed, wrapped);
    },
  },
  ...(windowCaptureBridge ? { windowCapture: windowCaptureBridge } : {}),
  getAppBranding: () => {
    if (cachedAppBranding !== null) return cachedAppBranding;
    const result = ipcRenderer.sendSync(GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    cachedAppBranding = Object.freeze(result) as ReturnType<DesktopBridge["getAppBranding"]>;
    return cachedAppBranding;
  },
  getLocalEnvironmentBootstrap: () => {
    if (cachedLocalEnvironmentBootstrap !== null) return cachedLocalEnvironmentBootstrap;
    const result = ipcRenderer.sendSync(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    const bootstrap = Object.freeze(result) as ReturnType<
      DesktopBridge["getLocalEnvironmentBootstrap"]
    >;
    // Only a complete answer is final; before the backend is configured, ask again.
    if (bootstrap?.httpBaseUrl) cachedLocalEnvironmentBootstrap = bootstrap;
    return bootstrap;
  },
  cliCommand: {
    getState: () => ipcRenderer.invoke(CLI_COMMAND_STATE_CHANNEL),
    install: () => ipcRenderer.invoke(CLI_COMMAND_INSTALL_CHANNEL),
    uninstall: () => ipcRenderer.invoke(CLI_COMMAND_UNINSTALL_CHANNEL),
  },
  nightly: {
    getState: () => ipcRenderer.invoke(NIGHTLY_STATE_CHANNEL),
    open: (input) => ipcRenderer.invoke(NIGHTLY_OPEN_CHANNEL, input),
    switchBack: () => ipcRenderer.invoke(NIGHTLY_SWITCH_BACK_CHANNEL),
  },
  appIcon: {
    getVariant: () => ipcRenderer.invoke(APP_ICON_GET_CHANNEL),
    setVariant: (variant) => ipcRenderer.invoke(APP_ICON_SET_CHANNEL, variant),
  },
  quitShortcut: {
    getMode: () => ipcRenderer.invoke(QUIT_SHORTCUT_GET_CHANNEL),
    setMode: (mode) => ipcRenderer.invoke(QUIT_SHORTCUT_SET_CHANNEL, mode),
    onFeedback: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: "press-twice" | "hold" | null) =>
        listener(state);
      ipcRenderer.on(QUIT_SHORTCUT_FEEDBACK_CHANNEL, handler);
      return () => ipcRenderer.removeListener(QUIT_SHORTCUT_FEEDBACK_CHANNEL, handler);
    },
  },
  quitGuard: {
    register: (responder) => {
      quitGuardResponder = responder;
      return () => {
        if (quitGuardResponder === responder) quitGuardResponder = null;
      };
    },
  },
  appKeybindings: {
    read: () => ipcRenderer.invoke(APP_KEYBINDINGS_READ_CHANNEL),
    write: (document) => ipcRenderer.invoke(APP_KEYBINDINGS_WRITE_CHANNEL, document),
    onChanged: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(APP_KEYBINDINGS_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(APP_KEYBINDINGS_CHANGED_CHANNEL, handler);
    },
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
  discoverSshHosts: () => ipcRenderer.invoke(DESKTOP_SSH_IPC.discoverHosts),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await ipcRenderer.invoke(DESKTOP_SSH_IPC.ensureEnvironment, target, options),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(DESKTOP_SSH_IPC.disconnectEnvironment, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(DESKTOP_SSH_IPC.fetchEnvironmentDescriptor, httpBaseUrl),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(DESKTOP_SSH_IPC.bootstrapBearerSession, httpBaseUrl, credential),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(DESKTOP_SSH_IPC.fetchSessionState, httpBaseUrl, bearerToken),
  issueSshWebSocketToken: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(DESKTOP_SSH_IPC.issueWebSocketToken, httpBaseUrl, bearerToken),
  revokeSshClientSession: (httpBaseUrl, ownerBearerToken, sessionId) =>
    ipcRenderer.invoke(
      DESKTOP_SSH_IPC.revokeClientSession,
      httpBaseUrl,
      ownerBearerToken,
      sessionId,
    ),
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
    ipcRenderer.invoke(DESKTOP_SSH_IPC.resolvePasswordPrompt, requestId, password),
  getServerExposureState: () => ipcRenderer.invoke(GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode, options) =>
    ipcRenderer.invoke(SET_SERVER_EXPOSURE_MODE_CHANNEL, mode, options),
  setTailscaleServeEnabled: (input) =>
    ipcRenderer.invoke(SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getHubLaunchConfig: () => ipcRenderer.invoke(GET_HUB_LAUNCH_CONFIG_CHANNEL),
  getKeepAwakeState: () => ipcRenderer.invoke(GET_KEEP_AWAKE_STATE_CHANNEL),
  setKeepAwakeMode: (mode) => ipcRenderer.invoke(SET_KEEP_AWAKE_MODE_CHANNEL, mode),
  restartApp: () => ipcRenderer.invoke(RESTART_APP_CHANNEL),
  getHostedIdentityState: () => ipcRenderer.invoke(GET_HOSTED_IDENTITY_STATUS_CHANNEL),
  connectHostedIdentity: () => ipcRenderer.invoke(CONNECT_HOSTED_IDENTITY_CHANNEL),
  disconnectHostedIdentity: () => ipcRenderer.invoke(DISCONNECT_HOSTED_IDENTITY_CHANNEL),
  connectHostedGitHub: (input) => ipcRenderer.invoke(CONNECT_HOSTED_GITHUB_CHANNEL, input),
  disconnectHostedGitHub: (input) => ipcRenderer.invoke(DISCONNECT_HOSTED_GITHUB_CHANNEL, input),
  cancelHostedGitHubConnection: () => ipcRenderer.invoke(CANCEL_HOSTED_GITHUB_CONNECTION_CHANNEL),
  getDesktopWorkspaceState: () => ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.getState),
  renameDesktopWorkspaceDevice: (input) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.renameDevice, input),
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
  publishDesktopThreadContent: (environmentId, content) =>
    ipcRenderer.send(DESKTOP_WORKSPACE_IPC.publishThreadContent, environmentId, content),
  publishDesktopThreadContentChanges: (environmentId, changes) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.publishThreadContentChanges, environmentId, changes),
  publishDesktopTaskList: (environmentId, list) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.publishTaskList, environmentId, list),
  getDesktopTaskList: (environmentId) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.getTaskList, environmentId),
  getDesktopThreadContent: (environmentId) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.getThreadContent, environmentId),
  getDesktopThreadContentCacheEnabled: () =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.getThreadContentCacheEnabled),
  setDesktopThreadContentCacheEnabled: (enabled) =>
    ipcRenderer.invoke(DESKTOP_WORKSPACE_IPC.setThreadContentCacheEnabled, enabled),
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
  setHubLaunchConfig: (input) => ipcRenderer.invoke(SET_HUB_LAUNCH_CONFIG_CHANNEL, input),
  validateHubOrigin: (raw: string) => ipcRenderer.invoke(VALIDATE_HUB_ORIGIN_CHANNEL, raw),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pickFolder: (options) => ipcRenderer.invoke(PICK_FOLDER_CHANNEL, options),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  windowTranslucencySupported: process.platform === "darwin",
  setWindowMaterial: (input) => ipcRenderer.invoke(SET_WINDOW_MATERIAL_CHANNEL, input),
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
  pasteAsText: () => ipcRenderer.invoke(PASTE_AS_TEXT_CHANNEL),
  onSystemResume: (listener) => {
    const wrappedListener = () => {
      listener();
    };
    ipcRenderer.on(SYSTEM_RESUMED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(SYSTEM_RESUMED_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  checkForUpdate: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  respondToRemoteInstall: (action) =>
    ipcRenderer.invoke(UPDATE_REMOTE_INSTALL_RESPONSE_CHANNEL, action),
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
  notifyThread: (notification) => ipcRenderer.invoke(THREAD_NOTIFICATION_IPC.notify, notification),
  onThreadNotificationActivated: (listener) =>
    subscribe(THREAD_NOTIFICATION_IPC.activated, listener),
  setNotificationBadge: (badge) => ipcRenderer.invoke(THREAD_NOTIFICATION_IPC.setBadge, badge),
  onNotificationBadgeCleared: (listener) =>
    subscribe(THREAD_NOTIFICATION_IPC.badgeCleared, () => listener()),
} satisfies DesktopBridge);

if (startupTimingEnabled) {
  console.info(
    `[desktop-startup] preload end elapsedMs=${Math.round(performance.now())} durationMs=${Math.round(
      performance.now() - preloadStartMs,
    )}`,
  );
}
