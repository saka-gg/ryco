import {
  applyMcpInstallationList,
  applyMcpInstallationMutation,
  emptyMcpInstallationSettingsState,
  type McpInstallationSettingsState,
} from "@ryco/client-runtime/state/settings";
import {
  configFromMcpServerForm,
  secretMutationsFromMcpServerForm,
  type McpServerFormState,
} from "@ryco/client-runtime/state/settings/mcpServers";
import {
  opinionatedPluginStatusKey,
  replaceOpinionatedPluginStatus,
  sortOpinionatedPlugins,
} from "@ryco/client-runtime/state/settings/opinionatedPlugins";
import type {
  AgentControlMcpInstallation,
  EnvironmentApi,
  McpListServersResult,
  McpProviderSupport,
  McpServerName,
  McpWorkspace,
  McpWorkspaceId,
  McpWorkspaceIssue,
  OpinionatedPluginCatalogItem,
  OpinionatedPluginStatus,
} from "@ryco/contracts";

/**
 * The phone's Agents screen state for one machine: its provider-native MCP servers, its
 * opinionated plugins and its Agent Control MCP installations, read and changed through the
 * same `EnvironmentApi` calls the web's settings pages make. A plain store, so the screen
 * reads it with `useSyncExternalStore` and the async work stays out of React components.
 */

type AgentControlApi = NonNullable<EnvironmentApi["agentControl"]>;

/** The parts of a machine's `EnvironmentApi` this screen calls. */
export interface MachineAgentsApi {
  readonly mcp?: EnvironmentApi["mcp"];
  readonly server?: Pick<
    NonNullable<EnvironmentApi["server"]>,
    "listOpinionatedPlugins" | "checkOpinionatedPlugins" | "installOpinionatedPlugin"
  >;
  readonly agentControl?: Pick<
    AgentControlApi,
    | "listIntegrations"
    | "listMcpInstallations"
    | "connectMcpInstallation"
    | "repairMcpInstallation"
    | "disconnectMcpInstallation"
  >;
}

/** `unavailable`: the machine is not connected, or its version has no such surface. */
export type AgentsSectionPhase = "loading" | "ready" | "unavailable" | "error";

export interface McpSectionState {
  readonly phase: AgentsSectionPhase;
  readonly error: string | null;
  readonly workspaces: ReadonlyArray<McpWorkspace>;
  readonly providers: ReadonlyArray<McpProviderSupport>;
  readonly issues: ReadonlyArray<McpWorkspaceIssue>;
  readonly selectedWorkspaceId: McpWorkspaceId | null;
  /** The selected workspace's servers, or null before they arrived. */
  readonly servers: McpListServersResult | null;
  readonly serversLoading: boolean;
  readonly serversError: string | null;
  /** The server a change is running for. */
  readonly busyServer: string | null;
  readonly reloading: boolean;
}

export interface PluginsSectionState {
  readonly phase: AgentsSectionPhase;
  readonly error: string | null;
  readonly plugins: ReadonlyArray<OpinionatedPluginCatalogItem>;
  readonly statuses: ReadonlyArray<OpinionatedPluginStatus>;
  /** `opinionatedPluginStatusKey` of the target being installed. */
  readonly installingKey: string | null;
}

export interface AgentControlSectionState {
  readonly phase: AgentsSectionPhase;
  readonly error: string | null;
  readonly installations: McpInstallationSettingsState;
  /** Whether the node can install locally at all (a direct loopback-only topology). */
  readonly topology: { readonly available: boolean; readonly reason: string | null } | null;
  readonly busyWorkspaceId: McpWorkspaceId | null;
}

export interface MachineAgentsState {
  readonly mcp: McpSectionState;
  readonly plugins: PluginsSectionState;
  readonly agentControl: AgentControlSectionState;
}

export type AgentsActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface MachineAgentsController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => MachineAgentsState;
  /** Reads all three sections again. */
  readonly load: () => Promise<void>;
  readonly selectWorkspace: (workspaceId: McpWorkspaceId) => Promise<void>;
  readonly reloadServers: () => Promise<AgentsActionResult>;
  readonly saveServer: (form: McpServerFormState) => Promise<AgentsActionResult>;
  readonly setServerEnabled: (name: McpServerName, enabled: boolean) => Promise<AgentsActionResult>;
  readonly removeServer: (name: McpServerName) => Promise<AgentsActionResult>;
  readonly installPlugin: (status: OpinionatedPluginStatus) => Promise<AgentsActionResult>;
  readonly connectAgentControl: (workspaceId: McpWorkspaceId) => Promise<AgentsActionResult>;
  readonly repairAgentControl: (
    workspaceId: McpWorkspaceId,
    installation: AgentControlMcpInstallation,
  ) => Promise<AgentsActionResult>;
  readonly disconnectAgentControl: (
    workspaceId: McpWorkspaceId,
    installation: AgentControlMcpInstallation,
  ) => Promise<AgentsActionResult>;
  /** Stops publishing until the next `load`: results that arrive meanwhile are dropped. */
  readonly dispose: () => void;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

function initialState(api: MachineAgentsApi | undefined): MachineAgentsState {
  const phase = (available: boolean): AgentsSectionPhase => (available ? "loading" : "unavailable");
  return {
    mcp: {
      phase: phase(api?.mcp !== undefined),
      error: null,
      workspaces: [],
      providers: [],
      issues: [],
      selectedWorkspaceId: null,
      servers: null,
      serversLoading: false,
      serversError: null,
      busyServer: null,
      reloading: false,
    },
    plugins: {
      phase: phase(api?.server !== undefined),
      error: null,
      plugins: [],
      statuses: [],
      installingKey: null,
    },
    agentControl: {
      // Its rows are the MCP workspaces, so it needs both surfaces.
      phase: phase(api?.agentControl !== undefined && api?.mcp !== undefined),
      error: null,
      installations: emptyMcpInstallationSettingsState(),
      topology: null,
      busyWorkspaceId: null,
    },
  };
}

export function createMachineAgentsController(
  api: MachineAgentsApi | undefined,
): MachineAgentsController {
  let state = initialState(api);
  let disposed = false;
  const listeners = new Set<() => void>();
  // Only the latest listing (or change result) for the selected workspace applies.
  let serversGeneration = 0;
  let loadGeneration = 0;

  const publish = (next: MachineAgentsState) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const patchMcp = (patch: Partial<McpSectionState>) =>
    publish({ ...state, mcp: { ...state.mcp, ...patch } });
  const patchPlugins = (patch: Partial<PluginsSectionState>) =>
    publish({ ...state, plugins: { ...state.plugins, ...patch } });
  const patchAgentControl = (patch: Partial<AgentControlSectionState>) =>
    publish({ ...state, agentControl: { ...state.agentControl, ...patch } });

  const applyServers = (workspaceId: McpWorkspaceId, result: McpListServersResult) => {
    if (state.mcp.selectedWorkspaceId !== workspaceId) return;
    serversGeneration += 1;
    patchMcp({ servers: result, serversError: null });
  };

  const loadServers = async (workspaceId: McpWorkspaceId) => {
    const mcp = api?.mcp;
    if (!mcp) return;
    const generation = ++serversGeneration;
    const current = () =>
      generation === serversGeneration && state.mcp.selectedWorkspaceId === workspaceId;
    patchMcp({ serversLoading: true, serversError: null });
    try {
      const result = await mcp.listServers({ workspaceId, detail: "full" });
      if (current()) patchMcp({ servers: result, serversLoading: false });
    } catch (cause) {
      if (current()) {
        patchMcp({
          serversLoading: false,
          serversError: errorMessage(cause, "The servers could not be read."),
        });
      }
    }
  };

  const loadMcp = async (generation: number) => {
    const mcp = api?.mcp;
    if (!mcp) return;
    patchMcp({ phase: "loading", error: null });
    try {
      const result = await mcp.listWorkspaces();
      if (generation !== loadGeneration) return;
      const selected =
        result.workspaces.find((workspace) => workspace.id === state.mcp.selectedWorkspaceId)?.id ??
        result.workspaces[0]?.id ??
        null;
      patchMcp({
        phase: "ready",
        workspaces: result.workspaces,
        providers: result.providers,
        issues: result.issues,
        selectedWorkspaceId: selected,
        servers: selected === state.mcp.selectedWorkspaceId ? state.mcp.servers : null,
      });
      if (selected) await loadServers(selected);
    } catch (cause) {
      if (generation !== loadGeneration) return;
      patchMcp({ phase: "error", error: errorMessage(cause, "MCP servers could not be read.") });
    }
  };

  const loadPlugins = async (generation: number) => {
    const server = api?.server;
    if (!server) return;
    patchPlugins({ phase: "loading", error: null });
    try {
      const [catalog, statuses] = await Promise.all([
        server.listOpinionatedPlugins(),
        server.checkOpinionatedPlugins(),
      ]);
      if (generation !== loadGeneration) return;
      patchPlugins({
        phase: "ready",
        plugins: sortOpinionatedPlugins(catalog.plugins),
        statuses: statuses.statuses,
      });
    } catch (cause) {
      if (generation !== loadGeneration) return;
      patchPlugins({ phase: "error", error: errorMessage(cause, "Plugins could not be read.") });
    }
  };

  const loadAgentControl = async (generation: number) => {
    const agentControl = api?.agentControl;
    if (!agentControl || !api?.mcp) return;
    patchAgentControl({ phase: "loading", error: null });
    try {
      const [installations, integrations] = await Promise.all([
        agentControl.listMcpInstallations(),
        agentControl.listIntegrations(),
      ]);
      if (generation !== loadGeneration) return;
      patchAgentControl({
        phase: "ready",
        installations: applyMcpInstallationList(state.agentControl.installations, installations),
        topology: integrations.topology,
      });
    } catch (cause) {
      if (generation !== loadGeneration) return;
      patchAgentControl({
        phase: "error",
        error: errorMessage(cause, "Agent Control could not be read."),
      });
    }
  };

  const mcpChange = async (
    name: string | null,
    change: (
      mcp: NonNullable<MachineAgentsApi["mcp"]>,
      workspaceId: McpWorkspaceId,
    ) => Promise<McpListServersResult>,
    fallback: string,
  ): Promise<AgentsActionResult> => {
    const mcp = api?.mcp;
    const workspaceId = state.mcp.selectedWorkspaceId;
    if (!mcp || !workspaceId) return { ok: false, error: "No MCP configuration is selected." };
    patchMcp({ busyServer: name });
    try {
      applyServers(workspaceId, await change(mcp, workspaceId));
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: errorMessage(cause, fallback) };
    } finally {
      patchMcp({ busyServer: null });
    }
  };

  const agentControlChange = async (
    workspaceId: McpWorkspaceId,
    change: (
      agentControl: NonNullable<MachineAgentsApi["agentControl"]>,
    ) => ReturnType<AgentControlApi["connectMcpInstallation"]>,
    fallback: string,
  ): Promise<AgentsActionResult> => {
    const agentControl = api?.agentControl;
    if (!agentControl) return { ok: false, error: "Agent Control is not available here." };
    patchAgentControl({ busyWorkspaceId: workspaceId });
    try {
      const result = await change(agentControl);
      patchAgentControl({
        installations: applyMcpInstallationMutation(state.agentControl.installations, result),
      });
      return { ok: true };
    } catch (cause) {
      // The node may have moved partway (written, then failed to verify): show where it is.
      void loadAgentControl(loadGeneration);
      return { ok: false, error: errorMessage(cause, fallback) };
    } finally {
      patchAgentControl({ busyWorkspaceId: null });
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    load: async () => {
      disposed = false;
      const generation = ++loadGeneration;
      await Promise.all([
        loadMcp(generation),
        loadPlugins(generation),
        loadAgentControl(generation),
      ]);
    },
    selectWorkspace: async (workspaceId) => {
      if (state.mcp.selectedWorkspaceId === workspaceId) return;
      patchMcp({ selectedWorkspaceId: workspaceId, servers: null });
      await loadServers(workspaceId);
    },
    reloadServers: async () => {
      const mcp = api?.mcp;
      const workspaceId = state.mcp.selectedWorkspaceId;
      if (!mcp || !workspaceId) return { ok: false, error: "No MCP configuration is selected." };
      patchMcp({ reloading: true });
      try {
        applyServers(workspaceId, await mcp.reloadServers({ workspaceId }));
        return { ok: true };
      } catch (cause) {
        return { ok: false, error: errorMessage(cause, "The servers could not be reloaded.") };
      } finally {
        patchMcp({ reloading: false });
      }
    },
    saveServer: (form) =>
      mcpChange(
        form.name.trim(),
        (mcp, workspaceId) =>
          mcp.upsertServer({
            workspaceId,
            // `validateMcpServerForm` checked the name; the node checks it again.
            name: form.name.trim() as McpServerName,
            config: configFromMcpServerForm(form),
            secretMutations: secretMutationsFromMcpServerForm(form),
          }),
        "The server could not be saved.",
      ),
    setServerEnabled: (name, enabled) =>
      mcpChange(
        name,
        (mcp, workspaceId) => mcp.setServerEnabled({ workspaceId, name, enabled }),
        "The server could not be changed.",
      ),
    removeServer: (name) =>
      mcpChange(
        name,
        (mcp, workspaceId) => mcp.removeServer({ workspaceId, name }),
        "The server could not be removed.",
      ),
    installPlugin: async (status) => {
      const server = api?.server;
      if (!server) return { ok: false, error: "Plugins are not available here." };
      patchPlugins({ installingKey: opinionatedPluginStatusKey(status) });
      try {
        const result = await server.installOpinionatedPlugin({
          pluginId: status.pluginId,
          ...(status.providerInstanceId ? { providerInstanceId: status.providerInstanceId } : {}),
        });
        patchPlugins({
          statuses: replaceOpinionatedPluginStatus(state.plugins.statuses, result.status),
        });
        return { ok: true };
      } catch (cause) {
        return { ok: false, error: errorMessage(cause, "The plugin could not be installed.") };
      } finally {
        patchPlugins({ installingKey: null });
      }
    },
    connectAgentControl: (workspaceId) =>
      agentControlChange(
        workspaceId,
        (agentControl) => agentControl.connectMcpInstallation({ workspaceId }),
        "Agent Control could not be connected.",
      ),
    repairAgentControl: (workspaceId, installation) =>
      agentControlChange(
        workspaceId,
        (agentControl) =>
          agentControl.repairMcpInstallation({ installationId: installation.installationId }),
        "Agent Control could not be repaired.",
      ),
    disconnectAgentControl: (workspaceId, installation) =>
      agentControlChange(
        workspaceId,
        (agentControl) =>
          agentControl.disconnectMcpInstallation({ installationId: installation.installationId }),
        "Agent Control could not be disconnected.",
      ),
    dispose: () => {
      disposed = true;
      loadGeneration += 1;
      serversGeneration += 1;
    },
  };
}
