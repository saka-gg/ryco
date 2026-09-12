import {
  type AgentControlChangeSettingsPlan,
  type AgentControlMcpSettingsChangeRequest,
  type AgentControlMcpSettingsSummaryResult,
  type ServerSettings,
} from "@ryco/contracts";

/**
 * Deliberately narrow, non-secret allowlist. These are presentation/runtime
 * preferences only; workspace, provider, credential, endpoint, and Agent
 * Control policy fields are structurally absent.
 */
export const agentControlSettingsSummary = (
  settings: ServerSettings,
): AgentControlMcpSettingsSummaryResult => ({
  settings: [
    {
      kind: "legacyTokenStreaming",
      label: "Legacy token streaming",
      value: settings.enableLegacyTokenStreaming,
      changeSupported: true,
      unsupportedReason: null,
    },
    {
      kind: "providerUpdateChecks",
      label: "Provider update checks",
      value: settings.enableProviderUpdateChecks,
      changeSupported: true,
      unsupportedReason: null,
    },
  ],
  redacted: true,
  omittedCategories: [
    "secrets-and-credentials",
    "provider-runtime-configuration",
    "mcp-server-configuration",
    "remote-relay-hosted-authentication",
    "filesystem-and-network-exposure",
    "agent-control-policy",
    "other-non-allowlisted-settings",
  ],
});

export const agentControlSettingsPlan = (
  settings: ServerSettings,
  change: AgentControlMcpSettingsChangeRequest,
): AgentControlChangeSettingsPlan => {
  switch (change.kind) {
    case "legacyTokenStreaming":
      return {
        kind: "changeSettings",
        change: {
          kind: change.kind,
          before: settings.enableLegacyTokenStreaming,
          after: change.value,
        },
      };
    case "providerUpdateChecks":
      return {
        kind: "changeSettings",
        change: {
          kind: change.kind,
          before: settings.enableProviderUpdateChecks,
          after: change.value,
        },
      };
  }
};
