/** Renderer-invoked SSH channels. Light, so main can register them before the bridge loads. */
export const DESKTOP_SSH_IPC = {
  discoverHosts: "desktop:discover-ssh-hosts",
  ensureEnvironment: "desktop:ensure-ssh-environment",
  disconnectEnvironment: "desktop:disconnect-ssh-environment",
  fetchEnvironmentDescriptor: "desktop:fetch-ssh-environment-descriptor",
  bootstrapBearerSession: "desktop:bootstrap-ssh-bearer-session",
  fetchSessionState: "desktop:fetch-ssh-session-state",
  issueWebSocketToken: "desktop:issue-ssh-websocket-token",
  resolvePasswordPrompt: "desktop:resolve-ssh-password-prompt",
} as const;

export const DESKTOP_SSH_INVOKE_CHANNELS: ReadonlyArray<string> = Object.values(DESKTOP_SSH_IPC);
