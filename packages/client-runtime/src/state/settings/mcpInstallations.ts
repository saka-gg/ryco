import type {
  AgentControlMcpInstallation,
  AgentControlMcpInstallationListResult,
  AgentControlMcpInstallationMutationResult,
  McpProviderSupport,
  McpWorkspace,
} from "@ryco/contracts";

import type { SettingsStatus } from "./mcpServers.ts";

export interface McpInstallationSettingsState {
  readonly installations: ReadonlyArray<AgentControlMcpInstallation>;
}

export const emptyMcpInstallationSettingsState = (): McpInstallationSettingsState => ({
  installations: [],
});

const sortInstallations = (
  installations: ReadonlyArray<AgentControlMcpInstallation>,
): ReadonlyArray<AgentControlMcpInstallation> =>
  [...installations].toSorted(
    (left, right) =>
      left.driver.localeCompare(right.driver) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.installationId.localeCompare(right.installationId),
  );

export const applyMcpInstallationList = (
  _state: McpInstallationSettingsState,
  result: AgentControlMcpInstallationListResult,
): McpInstallationSettingsState => ({
  installations: sortInstallations(result.installations),
});

export const applyMcpInstallationMutation = (
  state: McpInstallationSettingsState,
  result: AgentControlMcpInstallationMutationResult,
): McpInstallationSettingsState => {
  const existing = state.installations.find(
    (entry) => entry.installationId === result.installation.installationId,
  );
  if (existing && existing.revision > result.installation.revision) return state;
  return {
    installations: sortInstallations([
      ...state.installations.filter(
        (entry) => entry.installationId !== result.installation.installationId,
      ),
      result.installation,
    ]),
  };
};

/** The workspace's current installation: its most recently updated one. */
export const latestMcpInstallation = (
  installations: ReadonlyArray<AgentControlMcpInstallation>,
  workspaceId: McpWorkspace["id"],
): AgentControlMcpInstallation | undefined =>
  installations
    .filter((entry) => entry.workspaceId === workspaceId)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

export const mcpInstallationStatus = (
  installation: AgentControlMcpInstallation | undefined,
): SettingsStatus => {
  if (!installation) return { label: "Not connected", tone: "outline" };
  switch (installation.state) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "repair-needed":
      return { label: "Needs repair", tone: "error" };
    case "disconnected":
    case "revoked":
      return { label: "Disconnected", tone: "outline" };
    case "disconnecting":
      return { label: "Disconnecting", tone: "warning" };
    case "planned":
    case "credential-written":
    case "provider-written":
    case "verifying":
      return { label: "Connecting", tone: "warning" };
  }
};

/** Provider profiles Ryco can install its Agent Control MCP server into. */
export const installableAgentControlWorkspaces = (
  workspaces: ReadonlyArray<McpWorkspace>,
): ReadonlyArray<McpWorkspace> =>
  workspaces.filter((workspace) => workspace.capabilities.externalAgentControl === "available");

/** Whether Ryco-started sessions of this provider get Agent Control without an install. */
export const automaticAgentControlStatus = (
  provider: McpProviderSupport,
): SettingsStatus & { readonly automatic: boolean; readonly description: string } => {
  const automatic = provider.enabled && provider.capabilities.automaticAgentControl === "available";
  if (automatic) {
    return {
      automatic,
      label: "Automatic",
      tone: "success",
      description: "Available in every new Ryco-managed session.",
    };
  }
  return provider.enabled
    ? {
        automatic,
        label: "Unavailable",
        tone: "outline",
        description: "This provider does not expose automatic Agent Control yet.",
      }
    : {
        automatic,
        label: "Disabled",
        tone: "outline",
        description: "This provider instance is disabled.",
      };
};
