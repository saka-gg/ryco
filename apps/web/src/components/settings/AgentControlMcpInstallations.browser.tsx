import "../../index.css";

import {
  AgentControlIntegrationId,
  AgentControlMcpInstallationId,
  EnvironmentId,
  McpServerName,
  McpWorkspaceId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listIntegrations: vi.fn(),
  listMcpInstallations: vi.fn(),
  connectMcpInstallation: vi.fn(),
  repairMcpInstallation: vi.fn(),
  disconnectMcpInstallation: vi.fn(),
}));

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";

afterEach(() => resetPrimaryEnvironmentDescriptorForTests());

vi.mock("../../environmentApi", () => {
  const readEnvironmentApi = () => ({
    mcp: { listWorkspaces: harness.listWorkspaces },
    agentControl: {
      listIntegrations: harness.listIntegrations,
      listMcpInstallations: harness.listMcpInstallations,
      connectMcpInstallation: harness.connectMcpInstallation,
      repairMcpInstallation: harness.repairMcpInstallation,
      disconnectMcpInstallation: harness.disconnectMcpInstallation,
    },
  });
  return { readEnvironmentApi, ensureEnvironmentApi: readEnvironmentApi };
});

import { AgentControlMcpInstallations } from "./AgentControlMcpInstallations";

const workspaceId = McpWorkspaceId.make("codex:browser-test");
const instanceId = ProviderInstanceId.make("codex_default");
const capabilities = {
  readConfiguration: "available" as const,
  upsert: "available" as const,
  remove: "available" as const,
  enableDisable: "available" as const,
  reload: "available" as const,
  health: "available" as const,
  inventory: "available" as const,
  oauth: "available" as const,
  externalAgentControl: "available" as const,
  automaticAgentControl: "available" as const,
  scopes: ["user" as const],
};

const installation = {
  installationId: AgentControlMcpInstallationId.make("installation-browser"),
  integrationId: AgentControlIntegrationId.make("integration-browser"),
  workspaceId,
  driver: ProviderDriverKind.make("codex"),
  serverName: McpServerName.make("ryco"),
  state: "connected" as const,
  revision: 4,
  lastError: null,
  ownsNativeConfig: true,
  preservedUserChanges: false,
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:00:01.000Z",
  connectedAt: "2026-08-19T10:00:01.000Z",
};

describe("AgentControlMcpInstallations", () => {
  beforeEach(() => {
    writePrimaryEnvironmentDescriptor({
      environmentId: EnvironmentId.make("environment-local"),
      label: "Browser test node",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: false,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    });
    vi.clearAllMocks();
    harness.listWorkspaces.mockResolvedValue({
      providers: [
        {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Personal",
          enabled: true,
          status: "managed",
          capabilities,
          workspaceId,
          message: "Managed by Codex.",
        },
      ],
      workspaces: [
        {
          id: workspaceId,
          driver: ProviderDriverKind.make("codex"),
          providerDisplayName: "Codex",
          displayPath: "/Users/test/.codex/config.toml",
          nativeScope: "user",
          formatGeneration: "codex-app-server-v1",
          capabilities,
          providerMetadata: {},
          sharedHomePath: "/Users/test/.codex",
          mode: "direct",
          selectedInstanceId: instanceId,
          providerInstances: [{ instanceId, displayName: "Codex Personal" }],
        },
      ],
      issues: [],
    });
    harness.listIntegrations.mockResolvedValue({
      integrations: [],
      topology: { available: true, reason: null },
    });
    harness.listMcpInstallations.mockResolvedValue({ installations: [] });
    harness.connectMcpInstallation.mockResolvedValue({ installation });
  });

  it("shows automatic delivery and connects a detected profile without exposing a credential", async () => {
    render(<AgentControlMcpInstallations />);

    await expect.element(page.getByText("Automatic inside Ryco")).toBeVisible();
    await expect.element(page.getByText("Codex Personal")).toBeVisible();
    await page.getByRole("button", { name: "Connect" }).click();

    expect(harness.connectMcpInstallation).toHaveBeenCalledWith({ workspaceId });
    await expect.element(page.getByText("Connected")).toBeVisible();
    expect(document.body.textContent).not.toContain("rycoext_");
  });

  it("fails closed before provider mutation when local topology is unavailable", async () => {
    harness.listIntegrations.mockResolvedValue({
      integrations: [],
      topology: { available: false, reason: "Hub-connected runtime." },
    });
    render(<AgentControlMcpInstallations />);

    await expect.element(page.getByText("Local installation is unavailable")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeDisabled();
  });
});
