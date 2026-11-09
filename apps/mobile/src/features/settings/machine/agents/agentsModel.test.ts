import { describe, expect, it } from "vite-plus/test";

import {
  buildAgentControlSectionView,
  buildMcpSectionView,
  buildPluginsSectionView,
  pluginStatusForAction,
} from "./agentsModel";
import {
  ALL_CAPABILITIES,
  installationFixture,
  pluginFixture,
  pluginStatusFixture,
  providerFixture,
  serverFixture,
  serversFixture,
  workspaceFixture,
} from "./agents.testSupport";
import type {
  AgentControlSectionState,
  McpSectionState,
  PluginsSectionState,
} from "./machineAgentsController";

const workspace = workspaceFixture();

function mcpState(overrides: Partial<McpSectionState> = {}): McpSectionState {
  return {
    phase: "ready",
    error: null,
    workspaces: [workspace],
    providers: [providerFixture()],
    issues: [],
    selectedWorkspaceId: workspace.id,
    servers: serversFixture(workspace, [serverFixture()]),
    serversLoading: false,
    serversError: null,
    busyServer: null,
    reloading: false,
    ...overrides,
  };
}

describe("MCP servers section", () => {
  it("lets the owner toggle, edit and remove a user server", () => {
    const view = buildMcpSectionView({ state: mcpState(), editable: true });
    expect(view.notice).toBeNull();
    expect(view.canAdd).toBe(true);
    expect(view.canReload).toBe(true);
    const [row] = view.servers;
    expect(row?.connection).toBe("npx -y github-mcp");
    expect(row?.status).toEqual({ label: "Ready", tone: "success" });
    expect(row?.toggle).toEqual({ value: true, disabled: false });
    expect(row?.actions.map((action) => action.id)).toEqual(["edit", "remove"]);
  });

  it("shows a viewer the servers with no controls", () => {
    const view = buildMcpSectionView({ state: mcpState(), editable: false });
    expect(view.canAdd).toBe(false);
    expect(view.canReload).toBe(false);
    expect(view.servers[0]?.toggle).toBeNull();
    expect(view.servers[0]?.actions).toEqual([]);
  });

  it("keeps managed servers and missing capabilities read-only", () => {
    const limited = workspaceFixture({
      capabilities: { ...ALL_CAPABILITIES, enableDisable: "unavailable", remove: "unavailable" },
    });
    const view = buildMcpSectionView({
      state: mcpState({
        workspaces: [limited],
        servers: serversFixture(limited, [
          serverFixture(),
          serverFixture({ name: "corp" as never, source: "managed" }),
        ]),
      }),
      editable: true,
    });
    expect(view.servers[0]?.toggle).toBeNull();
    expect(view.servers[0]?.actions.map((action) => action.id)).toEqual(["edit"]);
    expect(view.servers[1]?.actions).toEqual([]);
    expect(view.footer).toContain("no per-server toggle");
  });

  it("offers a picker only with more than one agent configuration", () => {
    expect(buildMcpSectionView({ state: mcpState(), editable: true }).picker).toBeNull();
    const claude = workspaceFixture({ id: "claude:home" as never, driver: "claudeAgent" as never });
    const view = buildMcpSectionView({
      state: mcpState({ workspaces: [workspace, claude] }),
      editable: true,
    });
    expect(view.picker?.value).toBe("Codex");
    expect(view.picker?.options.map((option) => [option.title, option.selected])).toEqual([
      ["Codex · user scope", true],
      ["Claude · user scope", false],
    ]);
  });

  it("explains loading, failure, emptiness and unmanaged providers", () => {
    expect(
      buildMcpSectionView({ state: mcpState({ phase: "loading", workspaces: [] }), editable: true })
        .notice,
    ).toBe("Loading MCP servers…");
    expect(
      buildMcpSectionView({ state: mcpState({ phase: "error", error: "boom" }), editable: true })
        .notice,
    ).toBe("boom");
    expect(
      buildMcpSectionView({ state: mcpState({ phase: "unavailable" }), editable: true }).notice,
    ).toMatch(/does not offer/);
    const empty = buildMcpSectionView({
      state: mcpState({
        servers: serversFixture(workspace, []),
        providers: [
          providerFixture(),
          providerFixture({
            instanceId: "cursor" as never,
            driver: "cursor" as never,
            status: "external",
            workspaceId: undefined,
          }),
        ],
      }),
      editable: true,
    });
    expect(empty.empty).toMatch(/No MCP servers yet/);
    expect(empty.unmanaged).toBe("Not managed here: Cursor (External config).");
  });
});

function pluginsState(overrides: Partial<PluginsSectionState> = {}): PluginsSectionState {
  return {
    phase: "ready",
    error: null,
    plugins: [pluginFixture()],
    statuses: [
      pluginStatusFixture(),
      pluginStatusFixture({
        targetKind: "provider-instance",
        providerInstanceId: "codex" as never,
        providerDisplayName: "Codex",
        state: "installed",
        version: "1.2.0",
      }),
    ],
    installingKey: null,
    ...overrides,
  };
}

describe("Plugins section", () => {
  it("lists targets and offers an install where one is missing", () => {
    const [row] = buildPluginsSectionView({ state: pluginsState(), editable: true }).rows;
    expect(row?.value).toBe("1 installed");
    expect(row?.targets.map((target) => target.text)).toEqual([
      "System: Not installed",
      "Codex: Installed · 1.2.0",
    ]);
    expect(row?.actions.map((action) => action.title)).toEqual(["Install for System", "Open docs"]);
    const install = row?.actions[0];
    expect(row && install ? pluginStatusForAction(row, install.id)?.targetKind : null).toBe(
      "global",
    );
    expect(row ? pluginStatusForAction(row, "docs") : "missing").toBeNull();
    expect(row?.docsUrl).toBe("https://example.com/rtk");
  });

  it("offers a viewer only the docs", () => {
    const [row] = buildPluginsSectionView({ state: pluginsState(), editable: false }).rows;
    expect(row?.actions.map((action) => action.id)).toEqual(["docs"]);
  });

  it("marks the plugin being installed", () => {
    const [row] = buildPluginsSectionView({
      state: pluginsState({ installingKey: "rtk:global:global" }),
      editable: true,
    }).rows;
    expect(row?.installing).toBe(true);
    expect(row?.value).toBe("Installing…");
  });
});

function agentControlState(
  overrides: Partial<AgentControlSectionState> = {},
): AgentControlSectionState {
  return {
    phase: "ready",
    error: null,
    installations: { installations: [] },
    topology: { available: true, reason: null },
    busyWorkspaceId: null,
    ...overrides,
  };
}

describe("Agent Control section", () => {
  it("installs where nothing is, removes a connected one and repairs a broken one", () => {
    const actionsFor = (state: AgentControlSectionState) =>
      buildAgentControlSectionView({ state, mcp: mcpState(), editable: true }).rows[0]?.actions.map(
        (action) => action.id,
      );
    expect(actionsFor(agentControlState())).toEqual(["connect"]);
    expect(
      actionsFor(agentControlState({ installations: { installations: [installationFixture()] } })),
    ).toEqual(["disconnect"]);
    expect(
      actionsFor(
        agentControlState({
          installations: {
            installations: [installationFixture({ state: "repair-needed", lastError: "gone" })],
          },
        }),
      ),
    ).toEqual(["repair"]);
  });

  it("names the automatic providers and blocks installs without a local topology", () => {
    const view = buildAgentControlSectionView({
      state: agentControlState({ topology: { available: false, reason: "Not loopback." } }),
      mcp: mcpState(),
      editable: true,
    });
    expect(view.automatic).toBe("Sessions Ryco starts with Codex get Agent Control automatically.");
    expect(view.notice).toBe("Not loopback.");
    expect(view.rows[0]?.actions).toEqual([]);
  });

  it("gives a viewer no actions and says when nothing can take it", () => {
    expect(
      buildAgentControlSectionView({ state: agentControlState(), mcp: mcpState(), editable: false })
        .rows[0]?.actions,
    ).toEqual([]);
    const none = buildAgentControlSectionView({
      state: agentControlState(),
      mcp: mcpState({
        workspaces: [
          workspaceFixture({
            capabilities: { ...ALL_CAPABILITIES, externalAgentControl: "unavailable" },
          }),
        ],
      }),
      editable: true,
    });
    expect(none.rows).toEqual([]);
    expect(none.notice).toMatch(/No installed agent/);
  });
});
