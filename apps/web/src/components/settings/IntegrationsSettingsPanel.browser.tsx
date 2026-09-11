import { EnvironmentId } from "@ryco/contracts";
import { SettingsEditingScopeProvider, SettingsTargetProvider } from "../../settingsTarget";
import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  enabled: false,
  hosted: false,
  updateSettings: vi.fn(),
  settingsAllowed: true,
  settingsReason: null as string | null,
}));

vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
  isHostedHubMode: () => harness.hosted,
}));

vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({}),
  useSettings: <T,>(selector: (settings: { agentControl: { enabled: boolean } }) => T): T =>
    selector({ agentControl: { enabled: harness.enabled } }),
  useUpdateSettings: () => ({ updateSettings: harness.updateSettings }),
}));

vi.mock("../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({
    allowed: harness.settingsAllowed,
    reason: harness.settingsReason,
  }),
}));

vi.mock("./IntegrationsSettings", () => ({
  ExternalIntegrationsSettings: () => <div data-testid="external-integrations">External MCP</div>,
}));

vi.mock("./AgentControlMcpInstallations", () => ({
  AgentControlMcpInstallations: () => (
    <div data-testid="agent-control-installations">Provider installation</div>
  ),
}));

vi.mock("./ComputerUseSettings", () => ({
  ComputerUseSettings: () => <div data-testid="computer-use">Computer Use and Browser Use</div>,
}));

vi.mock("./McpServersSettings", () => ({
  McpServersSettings: () => <div data-testid="mcp-servers">MCP servers</div>,
}));

import { IntegrationsSettingsPanel } from "./IntegrationsSettingsPanel";

describe("IntegrationsSettingsPanel", () => {
  beforeEach(() => {
    delete window.desktopBridge;
    harness.enabled = false;
    harness.hosted = false;
    harness.settingsAllowed = true;
    harness.settingsReason = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete window.desktopBridge;
  });

  it("separates MCP servers and only mounts local integrations when available", async () => {
    const mounted = await render(<IntegrationsSettingsPanel />);
    await expect.element(page.getByTestId("mcp-servers")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("computer-use")).not.toBeInTheDocument();
    await mounted.unmount();
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { computerUse: {} },
    });
    await render(<IntegrationsSettingsPanel />);
    await expect.element(page.getByTestId("computer-use")).toBeInTheDocument();
    await expect.element(page.getByTestId("mcp-servers")).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "never mounts local permission controls for a remote device (desktop=%s)",
    async (desktop) => {
      harness.hosted = !desktop;
      Object.defineProperty(window, "desktopBridge", {
        configurable: true,
        value: { computerUse: {} },
      });
      await render(
        <SettingsEditingScopeProvider value="node">
          <SettingsTargetProvider
            value={{
              environmentId: EnvironmentId.make("remote"),
              nodeLabel: "Build Mac",
              serverConfig: null,
              primary: !desktop,
              connected: true,
            }}
          >
            <IntegrationsSettingsPanel />
          </SettingsTargetProvider>
        </SettingsEditingScopeProvider>,
      );
      await expect.element(page.getByTestId("computer-use")).not.toBeInTheDocument();
      await expect
        .element(
          page.getByText(/To enable screen recording, accessibility, or computer use on Build Mac/),
        )
        .toBeVisible();
    },
  );

  it("exposes native permissions for the named local desktop device", async () => {
    harness.hosted = false;
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { computerUse: {} },
    });
    await render(
      <SettingsEditingScopeProvider value="node">
        <SettingsTargetProvider
          value={{
            environmentId: EnvironmentId.make("local"),
            nodeLabel: "Studio Mac",
            serverConfig: null,
            primary: true,
            connected: true,
          }}
        >
          <IntegrationsSettingsPanel />
        </SettingsTargetProvider>
      </SettingsEditingScopeProvider>,
    );
    await expect.element(page.getByTestId("computer-use")).toBeVisible();
    await expect
      .element(page.getByText("Device permissions", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("persists the Agent Control feature gate from Settings", async () => {
    render(<IntegrationsSettingsPanel />);

    const toggle = page.getByLabelText("Enable Agent Control");
    await expect.element(toggle).not.toBeChecked();
    await expect.element(page.getByTestId("external-integrations")).not.toBeInTheDocument();

    await toggle.click();

    expect(harness.updateSettings).toHaveBeenCalledWith({ agentControl: { enabled: true } });
  });

  it("keeps the toggle disabled when Settings writes are unavailable", async () => {
    harness.settingsAllowed = false;
    harness.settingsReason = "Only an owner can change this setting.";
    render(<IntegrationsSettingsPanel />);

    await expect.element(page.getByLabelText("Enable Agent Control")).toBeDisabled();
    await expect.element(page.getByText("Only an owner can change this setting.")).toBeVisible();
  });

  it("separates automatic and external setup when Agent Control is enabled", async () => {
    harness.enabled = true;
    render(<IntegrationsSettingsPanel />);

    await expect.element(page.getByTestId("agent-control-installations")).toBeVisible();
    await expect.element(page.getByText("Advanced manual setup")).toBeVisible();
    await expect
      .element(page.getByText(/Ryco sessions receive the tools automatically/))
      .toBeVisible();
  });
});
