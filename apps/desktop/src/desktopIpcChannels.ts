/**
 * IPC channel names between the app window's preload and main, declared once
 * and imported by both sides. Constants only: the sandboxed preload imports
 * this module, and a preload can require nothing besides `electron`.
 *
 * Areas with their own light table keep it: `DESKTOP_SSH_IPC`
 * (`sshEnvironmentChannels.ts`), `DESKTOP_WORKSPACE_IPC`
 * (`desktopWorkspaceChannels.ts`), `WINDOW_CAPTURE_IPC`
 * (`windowCaptureChannels.ts`), `THREAD_NOTIFICATION_IPC`
 * (`threadNotificationChannels.ts`), `DESKTOP_QUIT_GUARD_IPC`
 * (`quitGuardChannels.ts`), `DESKTOP_STARTUP_MARKS_CHANNEL` (`startupMarks.ts`)
 * and `PASTE_AS_TEXT_CHANNEL` (`editMenu.ts`).
 */

// Synchronous (`sendSync`) reads.
export const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";
export const GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL = "desktop:get-local-environment-bootstrap";

// Main -> renderer pushes.
export const MENU_ACTION_CHANNEL = "desktop:menu-action";
export const SYSTEM_RESUMED_CHANNEL = "desktop:system-resumed";
export const DATABASE_COMPACTION_STATE_CHANNEL = "desktop:database-compaction-state";
export const UPDATE_STATE_CHANNEL = "desktop:update-state";
export const QUIT_SHORTCUT_FEEDBACK_CHANNEL = "desktop:quit-shortcut-feedback";
export const APP_KEYBINDINGS_CHANGED_CHANNEL = "desktop:app-keybindings-changed";
export const SSH_PASSWORD_PROMPT_CHANNEL = "desktop:ssh-password-prompt";

// Window and shell.
export const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
export const CONFIRM_CHANNEL = "desktop:confirm";
export const SET_THEME_CHANNEL = "desktop:set-theme";
export const SET_WINDOW_MATERIAL_CHANNEL = "desktop:set-window-material";
export const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
export const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";

// Updates.
export const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
export const UPDATE_CHECK_CHANNEL = "desktop:update-check";
export const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
export const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
export const UPDATE_REMOTE_INSTALL_RESPONSE_CHANNEL = "desktop:update-remote-install-response";

// Database compaction, thread export, command line tool, Ryco Nightly.
export const DATABASE_COMPACTION_GET_STATE_CHANNEL = "desktop:database-compaction-get-state";
export const DATABASE_COMPACTION_START_CHANNEL = "desktop:database-compaction-start";
export const DATABASE_COMPACTION_CANCEL_CHANNEL = "desktop:database-compaction-cancel";
export const SAVE_THREAD_EXPORT_CHANNEL = "desktop:save-thread-export";
export const CLI_COMMAND_STATE_CHANNEL = "desktop:cli-command-state";
export const CLI_COMMAND_INSTALL_CHANNEL = "desktop:cli-command-install";
export const CLI_COMMAND_UNINSTALL_CHANNEL = "desktop:cli-command-uninstall";
export const NIGHTLY_STATE_CHANNEL = "desktop:nightly-state";
export const NIGHTLY_OPEN_CHANNEL = "desktop:nightly-open";
export const NIGHTLY_SWITCH_BACK_CHANNEL = "desktop:nightly-switch-back";

// App preferences kept by main.
export const APP_ICON_GET_CHANNEL = "desktop:app-icon-get";
export const APP_ICON_SET_CHANNEL = "desktop:app-icon-set";
export const QUIT_SHORTCUT_GET_CHANNEL = "desktop:quit-shortcut-get";
export const QUIT_SHORTCUT_SET_CHANNEL = "desktop:quit-shortcut-set";
export const APP_KEYBINDINGS_READ_CHANNEL = "desktop:app-keybindings-read";
export const APP_KEYBINDINGS_WRITE_CHANNEL = "desktop:app-keybindings-write";

// Client settings and saved environments.
export const GET_CLIENT_SETTINGS_CHANNEL = "desktop:get-client-settings";
export const SET_CLIENT_SETTINGS_CHANNEL = "desktop:set-client-settings";
export const GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:get-saved-environment-registry";
export const SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:set-saved-environment-registry";
export const GET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:get-saved-environment-secret";
export const SET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:set-saved-environment-secret";
export const REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:remove-saved-environment-secret";

// Server exposure, keep-awake, Hub launch configuration.
export const GET_SERVER_EXPOSURE_STATE_CHANNEL = "desktop:get-server-exposure-state";
export const SET_SERVER_EXPOSURE_MODE_CHANNEL = "desktop:set-server-exposure-mode";
export const SET_TAILSCALE_SERVE_ENABLED_CHANNEL = "desktop:set-tailscale-serve-enabled";
export const GET_ADVERTISED_ENDPOINTS_CHANNEL = "desktop:get-advertised-endpoints";
export const GET_KEEP_AWAKE_STATE_CHANNEL = "desktop:get-keep-awake-state";
export const SET_KEEP_AWAKE_MODE_CHANNEL = "desktop:set-keep-awake-mode";
export const GET_HUB_LAUNCH_CONFIG_CHANNEL = "desktop:get-hub-launch-config";
export const SET_HUB_LAUNCH_CONFIG_CHANNEL = "desktop:set-hub-launch-config";
export const VALIDATE_HUB_ORIGIN_CHANNEL = "desktop:validate-hub-origin";
export const RESTART_APP_CHANNEL = "desktop:restart-app";

// Hosted account.
export const GET_HOSTED_IDENTITY_STATUS_CHANNEL = "desktop:get-hosted-identity-status";
export const CONNECT_HOSTED_IDENTITY_CHANNEL = "desktop:connect-hosted-identity";
export const DISCONNECT_HOSTED_IDENTITY_CHANNEL = "desktop:disconnect-hosted-identity";
export const CONNECT_HOSTED_GITHUB_CHANNEL = "desktop:connect-hosted-github";
export const DISCONNECT_HOSTED_GITHUB_CHANNEL = "desktop:disconnect-hosted-github";
export const CANCEL_HOSTED_GITHUB_CONNECTION_CHANNEL = "desktop:cancel-hosted-github-connection";

/** The project browser (`browser/ipc.ts`). */
export const DESKTOP_BROWSER_IPC = {
  state: "desktop:browser:state",
  open: "desktop:browser:open",
  command: "desktop:browser:command",
  surface: "desktop:browser:surface",
  capture: "desktop:browser:capture",
  pick: "desktop:browser:pick",
  discover: "desktop:browser:discover",
  focusAddress: "desktop:browser:focus-address",
  changed: "desktop:browser:changed",
} as const;

/** Computer use and its beta (`computerUse/ipc.ts`, `computerUse/beta.ts`). */
export const DESKTOP_COMPUTER_USE_IPC = {
  betaHistory: "desktop:computer-use:beta-history",
  betaState: "desktop:computer-use:beta-state",
  betaCheck: "desktop:computer-use:beta-check",
  betaSetup: "desktop:computer-use:beta-setup",
  betaTurnOn: "desktop:computer-use:beta-turn-on",
  betaSetupPermission: "desktop:computer-use:beta-setup-permission",
  betaRevokeApp: "desktop:computer-use:beta-revoke-app",
  betaPreferences: "desktop:computer-use:beta-preferences",
  betaPrepare: "desktop:computer-use:beta-prepare",
  betaPreview: "desktop:computer-use:beta-preview",
  betaStop: "desktop:computer-use:beta-stop",
  betaUpdate: "desktop:computer-beta:update",
  state: "desktop:computer-use:state",
  checkPermissions: "desktop:computer-use:check-permissions",
  refresh: "desktop:computer-use:refresh",
  policy: "desktop:computer-use:policy",
  permission: "desktop:computer-use:permission",
  pair: "desktop:computer-use:pair",
  extension: "desktop:computer-use:extension",
  browserSetup: "desktop:computer-use:browser-setup",
  stop: "desktop:computer-use:stop",
  changed: "desktop:computer-use:changed",
} as const;
