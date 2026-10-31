import {
  type AgentControlChangeSettingsPlan,
  type AgentControlMcpSettingsChangeRequest,
  type AgentControlMcpSettingsSummaryResult,
  type ServerSettings,
} from "@ryco/contracts";

/** Agent Control's legacy boolean view of `responseStreamingMode`: on only in token mode. */
export const legacyTokenStreamingEnabled = (settings: ServerSettings): boolean =>
  settings.responseStreamingMode === "token";

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
      value: legacyTokenStreamingEnabled(settings),
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
          before: legacyTokenStreamingEnabled(settings),
          after: change.value,
        },
      };
    case "providerUpdateChecks": {
      const before = settings.enableProviderUpdateChecks;
      return {
        kind: "changeSettings",
        change: {
          kind: change.kind,
          before,
          after: change.value,
          // The setting itself stays out of the summary and out of reach; only this approval
          // gate reads it.
          ...(!before && change.value && settings.automaticUpdates
            ? { startsAutomaticUpdates: true as const }
            : {}),
        },
      };
    }
  }
};
