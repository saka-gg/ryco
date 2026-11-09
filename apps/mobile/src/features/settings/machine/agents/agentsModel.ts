import {
  automaticAgentControlStatus,
  installableAgentControlWorkspaces,
  latestMcpInstallation,
  mcpInstallationStatus,
} from "@ryco/client-runtime/state/settings";
import {
  isMcpServerWritable,
  mcpProviderSupportStatus,
  mcpServerAuthLabel,
  mcpServerInventoryLabel,
  mcpServerSourceLabel,
  mcpServerStatus,
  mcpWorkspaceLimits,
  summarizeMcpServerConnection,
  type SettingsStatusTone,
} from "@ryco/client-runtime/state/settings/mcpServers";
import {
  canInstallOpinionatedPlugin,
  groupOpinionatedPluginStatuses,
  opinionatedPluginStatus,
  opinionatedPluginStatusKey,
  opinionatedPluginTargetLabel,
} from "@ryco/client-runtime/state/settings/opinionatedPlugins";
import type {
  AgentControlMcpInstallation,
  McpProviderSupport,
  McpServer,
  McpWorkspace,
  McpWorkspaceId,
  OpinionatedPluginStatus,
} from "@ryco/contracts";

import { providerDisplayLabel } from "../../../../lib/providerDisplay";
import type {
  AgentControlSectionState,
  McpSectionState,
  PluginsSectionState,
} from "./machineAgentsController";

/** Rows the Agents screen draws, worked out from the controller state with no React. */

export interface AgentsMenuAction {
  readonly id: string;
  readonly title: string;
  readonly destructive?: boolean;
}

/** The tone's text color class on the phone's dark grouped lists. */
export const STATUS_TONE_CLASS: Readonly<Record<SettingsStatusTone, string>> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-danger-foreground",
  outline: "text-foreground-muted",
};

export function mcpWorkspaceLabel(workspace: McpWorkspace): string {
  return providerDisplayLabel(workspace.driver, workspace.providerDisplayName) ?? "Agent";
}

function mcpProviderLabel(provider: McpProviderSupport): string {
  return providerDisplayLabel(provider.driver, provider.displayName) ?? provider.instanceId;
}

// ---------------------------------------------------------------- MCP servers

export interface McpServerRowView {
  readonly server: McpServer;
  readonly title: string;
  readonly connection: string;
  readonly meta: string;
  readonly status: { readonly label: string; readonly tone: SettingsStatusTone };
  readonly error: string | null;
  /** The on/off switch, when the agent can toggle one server and Ryco may change it. */
  readonly toggle: { readonly value: boolean; readonly disabled: boolean } | null;
  readonly actions: ReadonlyArray<AgentsMenuAction>;
  readonly busy: boolean;
}

export interface McpSectionView {
  /** A line in place of the rows (loading, unavailable, an error), or null. */
  readonly notice: string | null;
  readonly picker: {
    readonly value: string;
    readonly options: ReadonlyArray<AgentsMenuAction & { readonly selected: boolean }>;
  } | null;
  /** The selected configuration's path, scope and limits. */
  readonly footer: string | null;
  readonly servers: ReadonlyArray<McpServerRowView>;
  readonly empty: string | null;
  readonly canAdd: boolean;
  readonly canReload: boolean;
  readonly warnings: ReadonlyArray<string>;
  /** Providers whose MCP servers Ryco does not manage here. */
  readonly unmanaged: string | null;
  readonly selectedWorkspace: McpWorkspace | null;
  readonly providerName: string;
}

export function mcpServerActions(input: {
  readonly server: McpServer;
  readonly workspace: McpWorkspace;
  readonly editable: boolean;
}): ReadonlyArray<AgentsMenuAction> {
  const { capabilities } = input.workspace;
  const writable = input.editable && isMcpServerWritable(input.server, input.workspace);
  if (!writable) return [];
  return [
    ...(capabilities.upsert === "available" ? [{ id: "edit", title: "Edit" }] : []),
    ...(capabilities.remove === "available"
      ? [{ id: "remove", title: "Remove", destructive: true }]
      : []),
  ];
}

export function buildMcpSectionView(input: {
  readonly state: McpSectionState;
  readonly editable: boolean;
}): McpSectionView {
  const { state, editable } = input;
  const selectedWorkspace =
    state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId) ?? null;
  const providerName = selectedWorkspace ? mcpWorkspaceLabel(selectedWorkspace) : "the agent";
  const capabilities = selectedWorkspace?.capabilities;
  const unmanagedProviders = state.providers.filter((provider) => !provider.workspaceId);
  const base = {
    picker: null,
    footer: null,
    servers: [],
    empty: null,
    canAdd: false,
    canReload: false,
    warnings: state.issues.map((issue) => `${issue.instanceId}: ${issue.message}`),
    unmanaged:
      unmanagedProviders.length === 0
        ? null
        : `Not managed here: ${unmanagedProviders
            .map(
              (provider) =>
                `${mcpProviderLabel(provider)} (${mcpProviderSupportStatus(provider).label})`,
            )
            .join(", ")}.`,
    selectedWorkspace,
    providerName,
  } satisfies Omit<McpSectionView, "notice">;
  if (state.phase === "unavailable") {
    return { ...base, notice: "This machine does not offer MCP settings right now." };
  }
  if (state.phase === "loading" && state.workspaces.length === 0) {
    return { ...base, notice: "Loading MCP servers…" };
  }
  if (state.phase === "error") return { ...base, notice: state.error };
  if (!selectedWorkspace || !capabilities) {
    return {
      ...base,
      notice: "No agent here keeps an MCP configuration Ryco can read.",
    };
  }
  const servers = (state.servers?.servers ?? []).map((server): McpServerRowView => {
    const writable = editable && isMcpServerWritable(server, selectedWorkspace);
    const busy = state.busyServer === server.name;
    return {
      server,
      title: server.name,
      connection: summarizeMcpServerConnection(server),
      meta: [
        server.config.transport.toUpperCase(),
        mcpServerSourceLabel(server.source),
        mcpServerInventoryLabel(server, capabilities),
        mcpServerAuthLabel(server),
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
      status: mcpServerStatus(server),
      error: server.error ? server.error : null,
      toggle:
        writable && capabilities.enableDisable === "available"
          ? { value: server.config.enabled, disabled: busy }
          : null,
      actions: mcpServerActions({ server, workspace: selectedWorkspace, editable }),
      busy,
    };
  });
  const canAdd = editable && capabilities.upsert === "available";
  return {
    ...base,
    notice: null,
    picker:
      state.workspaces.length > 1
        ? {
            value: providerName,
            options: state.workspaces.map((workspace) => ({
              id: workspace.id,
              title: `${mcpWorkspaceLabel(workspace)} · ${workspace.nativeScope} scope`,
              selected: workspace.id === selectedWorkspace.id,
            })),
          }
        : null,
    footer: [
      state.servers?.configPath ?? selectedWorkspace.displayPath,
      [
        `${selectedWorkspace.nativeScope} scope`,
        ...mcpWorkspaceLimits(selectedWorkspace, providerName),
      ].join(" · "),
    ].join("\n"),
    servers,
    empty:
      state.serversError ??
      (state.servers === null
        ? "Loading servers…"
        : servers.length === 0
          ? `No MCP servers yet. Add one to give ${providerName} its tools.`
          : null),
    canAdd,
    canReload: editable && capabilities.reload === "available",
    warnings: [...base.warnings, ...(state.servers?.warnings ?? [])],
  };
}

// ---------------------------------------------------------------- Plugins

export interface PluginRowView {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly value: string;
  readonly valueTone: SettingsStatusTone;
  /** One line per target: where it is installed and how. */
  readonly targets: ReadonlyArray<{
    readonly key: string;
    readonly text: string;
    readonly tone: SettingsStatusTone;
  }>;
  readonly actions: ReadonlyArray<AgentsMenuAction>;
  readonly installable: ReadonlyArray<OpinionatedPluginStatus>;
  readonly docsUrl: string;
  readonly installing: boolean;
}

export interface PluginsSectionView {
  readonly notice: string | null;
  readonly rows: ReadonlyArray<PluginRowView>;
}

export const PLUGIN_DOCS_ACTION = "docs";
const INSTALL_ACTION_PREFIX = "install:";

/** The target an install menu action names, or null for another action. */
export function pluginStatusForAction(
  row: PluginRowView,
  actionId: string,
): OpinionatedPluginStatus | null {
  if (!actionId.startsWith(INSTALL_ACTION_PREFIX)) return null;
  const key = actionId.slice(INSTALL_ACTION_PREFIX.length);
  return row.installable.find((status) => opinionatedPluginStatusKey(status) === key) ?? null;
}

export function buildPluginsSectionView(input: {
  readonly state: PluginsSectionState;
  readonly editable: boolean;
}): PluginsSectionView {
  const { state, editable } = input;
  if (state.phase === "unavailable") {
    return { notice: "This machine does not offer plugins right now.", rows: [] };
  }
  if (state.phase === "error") return { notice: state.error, rows: [] };
  if (state.phase === "loading" && state.plugins.length === 0) {
    return { notice: "Loading plugins…", rows: [] };
  }
  if (state.plugins.length === 0) return { notice: "No plugins offered.", rows: [] };
  const grouped = groupOpinionatedPluginStatuses(state.statuses);
  const rows = state.plugins.map((plugin): PluginRowView => {
    const statuses = grouped.get(plugin.id) ?? [];
    const installedCount = statuses.filter((status) => status.state === "installed").length;
    const installable = editable ? statuses.filter(canInstallOpinionatedPlugin) : [];
    const installing = statuses.some(
      (status) => opinionatedPluginStatusKey(status) === state.installingKey,
    );
    return {
      key: plugin.id,
      title: plugin.name,
      summary: plugin.summary,
      value: installing
        ? "Installing…"
        : installedCount > 0
          ? `${installedCount} installed`
          : "Off",
      valueTone: installedCount > 0 ? "success" : "outline",
      targets:
        statuses.length === 0
          ? [{ key: "none", text: "No compatible agent found.", tone: "outline" }]
          : statuses.map((status) => {
              const presentation = opinionatedPluginStatus(status);
              return {
                key: opinionatedPluginStatusKey(status),
                text: [
                  `${opinionatedPluginTargetLabel(status)}: ${presentation.label}`,
                  status.version ?? null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(" · "),
                tone: presentation.tone,
              };
            }),
      actions: [
        ...installable.map((status) => ({
          id: `${INSTALL_ACTION_PREFIX}${opinionatedPluginStatusKey(status)}`,
          title: `Install for ${opinionatedPluginTargetLabel(status)}`,
        })),
        { id: PLUGIN_DOCS_ACTION, title: "Open docs" },
      ],
      installable,
      docsUrl: plugin.docsUrl ?? plugin.homepageUrl,
      installing,
    };
  });
  return { notice: null, rows };
}

// ---------------------------------------------------------------- Agent Control

export interface AgentControlRowView {
  readonly workspaceId: McpWorkspaceId;
  readonly title: string;
  readonly detail: string;
  readonly status: { readonly label: string; readonly tone: SettingsStatusTone };
  readonly installation: AgentControlMcpInstallation | undefined;
  readonly notes: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<AgentsMenuAction>;
  readonly busy: boolean;
}

export interface AgentControlSectionView {
  readonly notice: string | null;
  readonly rows: ReadonlyArray<AgentControlRowView>;
  /** The providers whose Ryco sessions get Agent Control with nothing installed. */
  readonly automatic: string | null;
}

export function buildAgentControlSectionView(input: {
  readonly state: AgentControlSectionState;
  readonly mcp: McpSectionState;
  readonly editable: boolean;
}): AgentControlSectionView {
  const { state, mcp, editable } = input;
  const automaticProviders = mcp.providers.filter(
    (provider) => automaticAgentControlStatus(provider).automatic,
  );
  const automatic =
    automaticProviders.length === 0
      ? null
      : `Sessions Ryco starts with ${automaticProviders.map(mcpProviderLabel).join(", ")} get Agent Control automatically.`;
  if (state.phase === "unavailable") {
    return {
      notice: "This machine does not offer Agent Control installs right now.",
      rows: [],
      automatic,
    };
  }
  if (state.phase === "error") return { notice: state.error, rows: [], automatic };
  if (mcp.phase === "error") return { notice: mcp.error, rows: [], automatic };
  if (state.phase === "loading" || mcp.phase === "loading") {
    return { notice: "Loading Agent Control…", rows: [], automatic };
  }
  const topologyBlocked = state.topology !== null && !state.topology.available;
  const workspaces = installableAgentControlWorkspaces(mcp.workspaces);
  if (workspaces.length === 0) {
    return {
      notice: "No installed agent here can take the Agent Control MCP server.",
      rows: [],
      automatic,
    };
  }
  const rows = workspaces.map((workspace): AgentControlRowView => {
    const installation = latestMcpInstallation(state.installations.installations, workspace.id);
    const connected = installation?.state === "connected";
    const repairNeeded = installation?.state === "repair-needed";
    const actions: AgentsMenuAction[] = !editable
      ? []
      : repairNeeded
        ? topologyBlocked
          ? []
          : [{ id: "repair", title: "Repair" }]
        : connected
          ? [{ id: "disconnect", title: "Remove", destructive: true }]
          : topologyBlocked
            ? []
            : [{ id: "connect", title: "Install" }];
    return {
      workspaceId: workspace.id,
      title: mcpWorkspaceLabel(workspace),
      detail: [workspace.displayPath, installation ? `MCP name ${installation.serverName}` : null]
        .filter((part): part is string => part !== null)
        .join(" · "),
      status: mcpInstallationStatus(installation),
      installation,
      notes: [
        installation?.lastError ?? null,
        installation?.preservedUserChanges
          ? "Ryco left this agent's MCP entry untouched because it was edited after installation."
          : null,
      ].filter((note): note is string => Boolean(note)),
      actions,
      busy: state.busyWorkspaceId === workspace.id,
    };
  });
  return {
    notice: topologyBlocked
      ? (state.topology?.reason ?? "Ryco could not prove a direct loopback-only topology.")
      : null,
    rows,
    automatic,
  };
}
