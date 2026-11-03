import { EnvironmentId } from "@ryco/contracts";
import { SettingsEditingScopeProvider, SettingsTargetProvider } from "../../settingsTarget";
import "../../index.css";
import type { ReactNode } from "react";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  enabled: false,
  delegation: { maxDepth: null as number | null, maxTasksPerTree: null as number | null },
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
  useSettings: <T,>(
    selector: (settings: {
      agentControl: { enabled: boolean; delegation: typeof harness.delegation };
    }) => T,
  ): T => selector({ agentControl: { enabled: harness.enabled, delegation: harness.delegation } }),
  useUpdateSettings: () => ({ updateSettings: harness.updateSettings }),
}));

vi.mock("../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({
    allowed: harness.settingsAllowed,
    reason: harness.settingsReason,
  }),
  readHostedRpcCapability: () => ({ allowed: harness.settingsAllowed }),
  subscribeHostedRpcCapabilities: () => () => undefined,
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

import {
  AgentControlSettingsPanel,
  DeviceComputerUseSettings,
  loadDeviceComputerUseSettings,
} from "./IntegrationsSettingsPanel";
import { SharedSettingsSourceProvider } from "./sharedSettings/sharedSettingsSource";
import {
  createTestSharedSettings,
  TestDeviceTarget,
} from "./sharedSettings/sharedSettingsTestSource";

/** Agent Control on one simulated device, shared-settings rows and all. */
function renderAgentControl() {
  const network = createTestSharedSettings([
    {
      id: "local",
      label: "Studio Mac",
      settings: { agentControl: { enabled: harness.enabled, delegation: harness.delegation } },
    },
  ]);
  render(
    <SharedSettingsSourceProvider value={network.source}>
      <TestDeviceTarget network={network} id="local">
        <AgentControlSettingsPanel />
      </TestDeviceTarget>
    </SharedSettingsSourceProvider>,
  );
  return network;
}

const LOCAL_TARGET = {
  environmentId: EnvironmentId.make("local"),
  nodeLabel: "Studio Mac",
  serverConfig: null,
  primary: true,
  connected: true,
};

function OnDevice(props: { readonly target: typeof LOCAL_TARGET; readonly children: ReactNode }) {
  return (
    <SettingsEditingScopeProvider value="node">
      <SettingsTargetProvider value={props.target}>{props.children}</SettingsTargetProvider>
    </SettingsEditingScopeProvider>
  );
}

// Runs before anything else in this file loads the Computer Use chunk: the
// part keeps it once loaded.
describe("loadDeviceComputerUseSettings", () => {
  afterEach(() => {
    delete window.desktopBridge;
  });

  it("resolves with the desktop Computer Use controls loaded, so they render in the first commit", async () => {
    let releaseChunk = () => undefined as void;
    harness.computerUseChunk = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { computerUse: {} },
    });

    let settled = false;
    const loading = loadDeviceComputerUseSettings().then((part) => {
      settled = true;
      return part;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    releaseChunk();
    const Part = await loading;
    expect(Part).toBe(DeviceComputerUseSettings);
    const mounted = await render(
      <OnDevice target={LOCAL_TARGET}>
        <Part />
      </OnDevice>,
    );
    // Synchronously after the first commit: no loading state in between.
    expect(mounted.container.querySelector('[data-testid="computer-use"]')).not.toBeNull();
    expect(mounted.container.textContent).not.toContain("Loading device integrations");
    await mounted.unmount();
  });
});

describe("DeviceComputerUseSettings", () => {
  beforeEach(() => {
    delete window.desktopBridge;
    harness.hosted = false;
  });

  afterEach(() => {
    delete window.desktopBridge;
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
        <OnDevice
          target={{
            ...LOCAL_TARGET,
            environmentId: EnvironmentId.make("remote"),
            nodeLabel: "Build Mac",
            primary: !desktop,
          }}
        >
          <DeviceComputerUseSettings />
        </OnDevice>,
      );
      await expect.element(page.getByTestId("computer-use")).not.toBeInTheDocument();
      await expect.element(page.getByText(/Build Mac/)).toBeVisible();
    },
  );

  it("exposes native permissions for this computer in the desktop app", async () => {
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { computerUse: {} },
    });
    await render(
      <OnDevice target={LOCAL_TARGET}>
        <DeviceComputerUseSettings />
      </OnDevice>,
    );
    await expect.element(page.getByTestId("computer-use")).toBeVisible();
    await expect
      .element(page.getByText("Device permissions", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("says where computer use lives when this app has none", async () => {
    await render(
      <OnDevice target={LOCAL_TARGET}>
        <DeviceComputerUseSettings />
      </OnDevice>,
    );
    await expect.element(page.getByTestId("computer-use")).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Computer use needs the Ryco desktop app on Studio Mac."))
      .toBeVisible();
  });
});

describe("AgentControlSettingsPanel", () => {
  beforeEach(() => {
    harness.enabled = false;
    harness.delegation = { maxDepth: null, maxTasksPerTree: null };
    harness.hosted = false;
    harness.settingsAllowed = true;
    harness.settingsReason = null;
    vi.clearAllMocks();
  });

  it("persists the Agent Control feature gate from Settings", async () => {
    const network = renderAgentControl();

    const toggle = page.getByLabelText("Enable Agent Control");
    await expect.element(toggle).not.toBeChecked();
    await expect.element(page.getByTestId("external-integrations")).not.toBeInTheDocument();

    await toggle.click();

    await expect
      .poll(() => network.settings("local").agentControl)
      .toEqual({ enabled: true, delegation: { maxDepth: null, maxTasksPerTree: null } });
  });

  it("keeps the toggle disabled when Settings writes are unavailable", async () => {
    harness.settingsAllowed = false;
    harness.settingsReason = "Only an owner can change this setting.";
    renderAgentControl();

    await expect.element(page.getByLabelText("Enable Agent Control")).toBeDisabled();
    await expect.element(page.getByText("Only an owner can change this setting.")).toBeVisible();
  });

  it("separates automatic and external setup when Agent Control is enabled", async () => {
    harness.enabled = true;
    render(<AgentControlSettingsPanel />);

    await expect.element(page.getByTestId("agent-control-installations")).toBeVisible();
    await expect.element(page.getByText("Advanced manual setup")).toBeVisible();
    await expect
      .element(page.getByText(/Ryco sessions receive the tools automatically/))
      .toBeVisible();
  });

  it("sets the delegation limits once Agent Control is on, keeping the other limit", async () => {
    harness.enabled = true;
    harness.delegation = { maxDepth: null, maxTasksPerTree: 50 };
    const network = renderAgentControl();

    // Three rows of one setting, each with its own element id; "Open" reveals the first.
    await expect.element(page.getByLabelText("How deep tasks can go")).toBeVisible();
    const ids = Array.from(document.querySelectorAll('[id^="shared-setting-agentControl"]')).map(
      (element) => element.id,
    );
    expect(ids).toEqual([
      "shared-setting-agentControl",
      "shared-setting-agentControl-maxDepth",
      "shared-setting-agentControl-maxTasksPerTree",
    ]);

    await page.getByLabelText("How deep tasks can go").click();
    await page.getByRole("option", { name: "1 level: tasks can't delegate" }).click();
    // The other limit and `enabled` stay as the device holds them.
    await expect
      .poll(() => network.settings("local").agentControl)
      .toEqual({ enabled: true, delegation: { maxDepth: 1, maxTasksPerTree: 50 } });

    await page.getByLabelText("Tasks per chat").click();
    await page.getByRole("option", { name: "250 tasks" }).click();
    await expect
      .poll(() => network.settings("local").agentControl)
      .toEqual({ enabled: true, delegation: { maxDepth: 1, maxTasksPerTree: 250 } });
  });

  it("hides the delegation limits while Agent Control is off", async () => {
    render(<AgentControlSettingsPanel />);
    await expect.element(page.getByText("Delegation limits")).not.toBeInTheDocument();
  });
});
