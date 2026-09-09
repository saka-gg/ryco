import "../../index.css";

import { AgentControlIntegrationId, EnvironmentId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  listIntegrations: vi.fn(),
  createIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  resumeIntegrationPairing: vi.fn(),
  revokeIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
}));

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";

afterEach(() => resetPrimaryEnvironmentDescriptorForTests());

vi.mock("../../environmentApi", () => {
  const readEnvironmentApi = () => ({ agentControl: harness });
  return { readEnvironmentApi, ensureEnvironmentApi: readEnvironmentApi };
});

import { ExternalIntegrationsSettings } from "./IntegrationsSettings";

const detail = {
  integration: {
    integrationId: AgentControlIntegrationId.make("integration-browser"),
    displayName: "Browser test Codex",
    clientKind: "codex" as const,
    projectScope: { kind: "all" as const },
    capabilities: [
      "external.projects.list",
      "external.tasks.create",
      "external.tasks.read",
    ] as never,
    rateLimitPerMinute: 60,
    activeTaskLimit: 1,
    activeTaskCount: 0,
    expiresAt: null,
    revokedAt: null,
    pairingState: "pending" as const,
    pairingCodeExpiresAt: "2099-08-18T01:00:00.000Z",
    pairedAt: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    lastUsedAt: null,
  },
  setup: {
    pairCommand: {
      command: "/actual/runtime/node",
      args: ["/actual/ryco/bin.mjs", "mcp", "pair", "--integration", "integration-browser"],
    },
    serveCommand: {
      command: "/actual/runtime/node",
      args: ["/actual/ryco/bin.mjs", "mcp", "serve", "--integration", "integration-browser"],
    },
    configuration:
      '[mcp_servers.ryco]\ncommand = "/actual/runtime/node"\nargs = ["/actual/ryco/bin.mjs", "mcp", "serve"]',
  },
  topology: { available: true, reason: null },
};

describe("ExternalIntegrationsSettings", () => {
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
    harness.listIntegrations.mockResolvedValue({
      integrations: [],
      topology: { available: true, reason: null },
    });
    harness.createIntegration.mockResolvedValue({ detail, pairingCode: "ABCD234567" });
  });

  it("explains approval and renders pairing data without a raw credential", async () => {
    render(<ExternalIntegrationsSettings />);
    await expect.element(page.getByText(/Every task request waits in Ryco/)).toBeVisible();
    await page.getByRole("button", { name: "New integration" }).click();
    await page.getByLabelText("Display name").fill("Browser test Codex");
    await page.getByRole("button", { name: "Create and pair" }).click();

    await expect.element(page.getByTestId("external-pairing-code")).toHaveTextContent("ABCD234567");
    await expect
      .element(page.getByTestId("external-mcp-configuration"))
      .toHaveTextContent("/actual/runtime/node");
    expect(document.body.textContent).not.toContain("rycoext_");
    expect(harness.createIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Browser test Codex",
        projectScope: { kind: "all" },
        expiresAt: null,
      }),
    );
  });

  it("fails closed in the UI when local topology cannot be proven", async () => {
    harness.listIntegrations.mockResolvedValue({
      integrations: [],
      topology: { available: false, reason: "Hub-connected runtime." },
    });
    render(<ExternalIntegrationsSettings />);
    await expect.element(page.getByText("Local pairing is unavailable")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "New integration" })).toBeDisabled();
  });
});
