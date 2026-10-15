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
  // Holds the Computer Use chunk's first load while a test keeps it pending.
  computerUseChunk: Promise.resolve() as Promise<void>,
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

vi.mock("./ComputerUseSettings", async () => {
  await harness.computerUseChunk;
  return {
    ComputerUseSettings: () => <div data-testid="computer-use">Computer Use and Browser Use</div>,
  };
});

vi.mock("./McpServersSettings", () => ({
  McpServersSettings: () => <div data-testid="mcp-servers">MCP servers</div>,
}));

import {
  IntegrationsSettingsPanel,
  loadIntegrationsSettingsPanel,
} from "./IntegrationsSettingsPanel";

// Runs before anything else in this file loads the Computer Use chunk: the
// panel keeps it once loaded.
describe("loadIntegrationsSettingsPanel", () => {
  afterEach(() => {
    delete window.desktopBridge;
  });

  it("resolves with the desktop Computer Use subsection loaded, so it renders in the first commit", async () => {
    let releaseChunk = () => undefined as void;
    harness.computerUseChunk = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { computerUse: {} },
    });

    let settled = false;
    const loading = loadIntegrationsSettingsPanel().then((panel) => {
      settled = true;
      return panel;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    releaseChunk();
    const Panel = await loading;
    expect(Panel).toBe(IntegrationsSettingsPanel);
    const mounted = await render(<Panel />);
    // Synchronously after the first commit: no loading state in between.
    expect(mounted.container.querySelector('[data-testid="computer-use"]')).not.toBeNull();
    expect(mounted.container.textContent).not.toContain("Loading device integrations");
    await mounted.unmount();
  });
});

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
