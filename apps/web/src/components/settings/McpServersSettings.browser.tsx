import "../../index.css";

import {
  McpServerName,
  McpWorkspaceId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listServers: vi.fn(),
  upsertServer: vi.fn(),
  setServerEnabled: vi.fn(),
  removeServer: vi.fn(),
  reloadServers: vi.fn(),
  startOauthLogin: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    mcp: {
      listWorkspaces: harness.listWorkspaces,
      listServers: harness.listServers,
      upsertServer: harness.upsertServer,
      setServerEnabled: harness.setServerEnabled,
      removeServer: harness.removeServer,
      reloadServers: harness.reloadServers,
      startOauthLogin: harness.startOauthLogin,
    },
    dialogs: { confirm: harness.confirm },
    shell: { openExternal: vi.fn() },
  }),
}));

import { McpServersSettings } from "./McpServersSettings";

const workspaceId = McpWorkspaceId.make("claudeAgent:browser-test");
const instanceId = ProviderInstanceId.make("claude_personal");
const capabilities = {
  readConfiguration: "available" as const,
  upsert: "available" as const,
  remove: "available" as const,
  enableDisable: "unavailable" as const,
  reload: "unavailable" as const,
  health: "unknown" as const,
  inventory: "unavailable" as const,
  oauth: "unknown" as const,
  externalAgentControl: "available" as const,
  automaticAgentControl: "available" as const,
  scopes: ["user" as const],
};
const workspace = {
  id: workspaceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  providerDisplayName: "Claude",
  displayPath: "/Users/test/.claude.json",
  nativeScope: "user" as const,
  formatGeneration: "claude-cli-user-v1",
  capabilities,
  providerMetadata: {},
  sharedHomePath: "/Users/test",
  mode: "direct" as const,
  selectedInstanceId: instanceId,
  providerInstances: [{ instanceId, displayName: "Claude Personal" }],
};
const server = {
  name: McpServerName.make("tools"),
  config: {
    transport: "stdio" as const,
    command: "node",
    args: ["server.js"],
    cwd: null,
    env: {},
    envVars: [],
    httpHeaders: {},
    envHttpHeaders: {},
    enabled: true,
    enabledTools: [],
    disabledTools: [],
    oauthScopes: [],
    secretFields: { "env.API_TOKEN": "present" as const },
  },
  source: "user" as const,
  startupStatus: "unknown" as const,
  authStatus: "unknown" as const,
  tools: [],
  resources: [],
  resourceTemplates: [],
};
const snapshot = {
  workspace,
  servers: [server],
  configPath: workspace.displayPath,
  warnings: [],
};

describe("McpServersSettings provider capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.listWorkspaces.mockResolvedValue({
      workspaces: [workspace],
      providers: [
        {
          instanceId,
          driver: workspace.driver,
          displayName: "Claude Personal",
          enabled: true,
          status: "external",
          capabilities,
          workspaceId,
          message: "Claude user MCP configuration.",
        },
      ],
      issues: [],
    });
    harness.listServers.mockResolvedValue(snapshot);
    harness.upsertServer.mockResolvedValue(snapshot);
  });

  it("shows Claude management while hiding operations its capability matrix cannot prove", async () => {
    render(<McpServersSettings />);

    await expect.element(page.getByText("Claude Personal", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add server" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    await expect.element(page.getByLabelText("Enable tools")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Toggle tools inventory" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(/Claude doesn.t report live health/)).toBeVisible();
  });

  it("keeps stored secret values out of the form and sends an explicit clear mutation", async () => {
    render(<McpServersSettings />);

    await page.getByRole("button", { name: "Edit" }).click();
    await expect
      .element(page.getByText(/Values remain inside the provider configuration/))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("secret-canary");
    await page.getByLabelText("Clear env.API_TOKEN").click();
    await page.getByRole("button", { name: "Save" }).click();

    expect(harness.upsertServer).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        name: McpServerName.make("tools"),
        secretMutations: { "env.API_TOKEN": { action: "clear" } },
      }),
    );
  });
});
