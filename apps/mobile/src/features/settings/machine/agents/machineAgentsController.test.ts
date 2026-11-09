import {
  formFromMcpServer,
  setMcpFormSecretValue,
} from "@ryco/client-runtime/state/settings/mcpServers";
import type { McpServerName, McpWorkspaceId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  installationFixture,
  pluginFixture,
  pluginStatusFixture,
  providerFixture,
  serverFixture,
  serversFixture,
  workspaceFixture,
} from "./agents.testSupport";
import { createMachineAgentsController, type MachineAgentsApi } from "./machineAgentsController";

const workspace = workspaceFixture();
const claude = workspaceFixture({
  id: "claude:home" as McpWorkspaceId,
  driver: "claudeAgent" as never,
});

function fakeApi() {
  const servers = serversFixture(workspace, [serverFixture()]);
  const mcp = {
    listWorkspaces: vi.fn(async () => ({
      workspaces: [workspace, claude],
      providers: [providerFixture()],
      issues: [],
    })),
    listServers: vi.fn(async (input: { workspaceId: McpWorkspaceId }) =>
      input.workspaceId === workspace.id ? servers : serversFixture(claude, []),
    ),
    upsertServer: vi.fn(async () => servers),
    setServerEnabled: vi.fn(async () =>
      serversFixture(workspace, [
        serverFixture({ config: { ...serverFixture().config, enabled: false } }),
      ]),
    ),
    removeServer: vi.fn(async () => serversFixture(workspace, [])),
    reloadServers: vi.fn(async () => servers),
    startOauthLogin: vi.fn(),
  };
  const server = {
    listOpinionatedPlugins: vi.fn(async () => ({ plugins: [pluginFixture()] })),
    checkOpinionatedPlugins: vi.fn(async () => ({ statuses: [pluginStatusFixture()] })),
    installOpinionatedPlugin: vi.fn(async () => ({
      pluginId: "rtk" as const,
      status: pluginStatusFixture({ state: "installed" }),
      commands: [],
    })),
  };
  const agentControl = {
    listMcpInstallations: vi.fn(async () => ({ installations: [] })),
    listIntegrations: vi.fn(async () => ({
      integrations: [],
      topology: { available: true, reason: null },
    })),
    connectMcpInstallation: vi.fn(async () => ({ installation: installationFixture() })),
    repairMcpInstallation: vi.fn(),
    disconnectMcpInstallation: vi.fn(async () => ({
      installation: installationFixture({ state: "disconnected", revision: 2 }),
    })),
  };
  return {
    mcp,
    server,
    agentControl,
    api: { mcp, server, agentControl } as unknown as MachineAgentsApi,
  };
}

describe("machine agents controller", () => {
  it("marks every section unavailable without a connection", () => {
    const state = createMachineAgentsController(undefined).getSnapshot();
    expect([state.mcp.phase, state.plugins.phase, state.agentControl.phase]).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  it("loads the first configuration's servers, the plugins and the installations", async () => {
    const { api, mcp } = fakeApi();
    const controller = createMachineAgentsController(api);
    await controller.load();
    const state = controller.getSnapshot();
    expect(state.mcp.phase).toBe("ready");
    expect(state.mcp.selectedWorkspaceId).toBe(workspace.id);
    expect(state.mcp.servers?.servers.map((server) => server.name)).toEqual(["github"]);
    expect(mcp.listServers).toHaveBeenCalledWith({ workspaceId: workspace.id, detail: "full" });
    expect(state.plugins.plugins.map((plugin) => plugin.id)).toEqual(["rtk"]);
    expect(state.agentControl.phase).toBe("ready");
    expect(state.agentControl.topology).toEqual({ available: true, reason: null });
  });

  it("switches configuration and drops a slower listing of the previous one", async () => {
    const { api, mcp } = fakeApi();
    const controller = createMachineAgentsController(api);
    await controller.load();
    let release: () => void = () => {};
    mcp.listServers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(serversFixture(claude, [serverFixture({ name: "late" as never })]));
        }),
    );
    const slow = controller.selectWorkspace(claude.id);
    await controller.selectWorkspace(workspace.id);
    release();
    await slow;
    const state = controller.getSnapshot().mcp;
    expect(state.selectedWorkspaceId).toBe(workspace.id);
    expect(state.servers?.servers.map((server) => server.name)).toEqual(["github"]);
  });

  it("saves a server with write-only secret mutations and applies the result", async () => {
    const { api, mcp } = fakeApi();
    const controller = createMachineAgentsController(api);
    await controller.load();
    const form = setMcpFormSecretValue(formFromMcpServer(serverFixture()), "env", "NEW", "s3cret");
    expect(await controller.saveServer(form)).toEqual({ ok: true });
    expect(mcp.upsertServer).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      name: "github",
      config: expect.objectContaining({ env: { NEW: "s3cret" } }),
      secretMutations: { "env.GITHUB_TOKEN": { action: "retain" } },
    });
  });

  it("toggles and removes a server, reporting a failure without changing the list", async () => {
    const { api, mcp } = fakeApi();
    const controller = createMachineAgentsController(api);
    await controller.load();
    const name = "github" as McpServerName;
    expect(await controller.setServerEnabled(name, false)).toEqual({ ok: true });
    expect(controller.getSnapshot().mcp.servers?.servers[0]?.config.enabled).toBe(false);
    mcp.removeServer.mockRejectedValueOnce(new Error("Config is read-only."));
    expect(await controller.removeServer(name)).toEqual({
      ok: false,
      error: "Config is read-only.",
    });
    expect(controller.getSnapshot().mcp.servers?.servers).toHaveLength(1);
    expect(controller.getSnapshot().mcp.busyServer).toBeNull();
  });

  it("installs a plugin and replaces that target's status", async () => {
    const { api, server } = fakeApi();
    const controller = createMachineAgentsController(api);
    await controller.load();
    expect(await controller.installPlugin(pluginStatusFixture())).toEqual({ ok: true });
    expect(server.installOpinionatedPlugin).toHaveBeenCalledWith({ pluginId: "rtk" });
    expect(controller.getSnapshot().plugins.statuses.map((status) => status.state)).toEqual([
      "installed",
    ]);
  });

  it("connects and disconnects Agent Control, re-reading after a failure", async () => {
    const { api, agentControl } = fakeApi();
    const controller = createMachineAgentsController(api);
    await controller.load();
    expect(await controller.connectAgentControl(workspace.id)).toEqual({ ok: true });
    expect(controller.getSnapshot().agentControl.installations.installations[0]?.state).toBe(
      "connected",
    );
    expect(await controller.disconnectAgentControl(workspace.id, installationFixture())).toEqual({
      ok: true,
    });
    expect(controller.getSnapshot().agentControl.installations.installations[0]?.state).toBe(
      "disconnected",
    );
    agentControl.connectMcpInstallation.mockRejectedValueOnce(new Error("Verify failed."));
    const listsBefore = agentControl.listMcpInstallations.mock.calls.length;
    expect(await controller.connectAgentControl(workspace.id)).toEqual({
      ok: false,
      error: "Verify failed.",
    });
    expect(agentControl.listMcpInstallations.mock.calls.length).toBe(listsBefore + 1);
  });

  it("publishes nothing after dispose", async () => {
    const { api } = fakeApi();
    const controller = createMachineAgentsController(api);
    const listener = vi.fn();
    controller.subscribe(listener);
    const loading = controller.load();
    controller.dispose();
    listener.mockClear();
    await loading;
    expect(listener).not.toHaveBeenCalled();
  });
});
