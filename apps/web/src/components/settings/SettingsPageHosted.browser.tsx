// Hosted settings choose their device through the selection cursor.
//
// THE FILE EXISTS BECAUSE THE MODE IS READ AT MODULE SCOPE. `isHostedHubMode()`
// answers a build-time flag, so the hoisted `vi.mock` below applies to the whole
// file — the same reason `NodeSecuritySettingsHosted.browser.tsx` is its own
// file.
//
// What is pinned here: hosted settings edit the selected node, and with the
// global node menu gone from the header, the node header's "Switch device"
// control is how a hosted reader chooses which node's settings they edit. The
// settings address names no node: the control moves the selection cursor, the
// page stays where it is, and the header names the node it lands on. The
// cursor itself follows the last opened thread across the pages no node owns.
import "../../index.css";

import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
// Rendered outside a `RouterProvider`: the page reads route params only for the
// standard client's routed thread, and leaves settings through the router.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => null,
  useRouter: () => ({ navigate, history: { canGoBack: () => false, back: () => undefined } }),
}));

// Hosted mode, which no browser test gets by default: there is no `.env` in
// this harness, so `isHostedHubMode()` answers false and every hosted gate runs
// as the standard client.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
}));

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { hostedWebConnectionScopes } from "../../hostedHub/hostedConnectionScopes";
import {
  getRoutedHostedNode,
  installHostedNodeHistory,
  resetHostedNodeRoutesForTests,
  setHostedNodeRouteEnvironmentResolver,
} from "../../hostedHub/nodeRoutes";
import {
  resetHostedNodeRouteOrchestratorForTests,
  startHostedNodeRouteOrchestrator,
} from "../../hostedHub/nodeRouteOrchestrator";
import {
  getHostedEnvironmentSessions,
  hostedHubController,
  useHostedHubStore,
} from "../../hostedHub/state";
import type { HostedHubNode } from "../../hostedHub/types";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { createFakeHistoryWindow, type FakeHistoryWindow } from "../../../test/fakeHistoryWindow";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsPage } from "./SettingsPage";

const account = {
  id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  displayName: "Ada",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};
const session = {
  id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
  accountId: account.id,
  createdAt: 1,
  expiresAt: 2,
  lastSeenAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
};

function node(id: string, label: string): HostedHubNode {
  return {
    id,
    environmentId: EnvironmentId.make(`env_${id.slice(5).padEnd(22, "a").slice(0, 22)}`),
    label,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.slice(5)}`, role: "owner" },
    effectiveRole: "owner",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

const studio = node("node_aaaaaaaaaaaaaaaaaaaaaa", "Studio node");
const laptop = node("node_bbbbbbbbbbbbbbbbbbbbbb", "Travel laptop");
const revoked = { ...node("node_cccccccccccccccccccccc", "Retired node"), revokedAt: 5 };

/** The primary environment descriptor hosted selection writes for `target`. */
function writePrimary(target: HostedHubNode): void {
  writePrimaryEnvironmentDescriptor({
    environmentId: target.environmentId,
    label: target.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.9.0",
    capabilities: {
      repositoryIdentity: false,
      threadSettlement: false,
    },
  });
}

/**
 * Selecting is the lifecycle owner's: as it would, the selection moves the
 * shared node and the primary environment the settings page edits.
 */
function selectingNode() {
  return vi.spyOn(hostedHubController, "selectNode").mockImplementation(async (nodeId: string) => {
    const target = useHostedHubStore.getState().nodes.find((entry) => entry.id === nodeId);
    if (!target) return;
    useHostedHubStore.setState({ selectedNode: target });
    writePrimary(target);
  });
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;
let fakeWindow: FakeHistoryWindow | null = null;
let stopOrchestrator: (() => void) | null = null;

beforeEach(() => {
  hostedHubController.resetForTests();
  getHostedEnvironmentSessions().clear();
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  useSettingsDialogStore.setState({ open: true, section: "general", editingScope: "node" });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  stopOrchestrator?.();
  stopOrchestrator = null;
  fakeWindow = null;
  hostedHubController.resetForTests();
  getHostedEnvironmentSessions().clear();
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  useSettingsDialogStore.setState({ open: false, section: "general" });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("hosted settings choose their device", () => {
  it("moves the settings target to another node through the selection cursor, staying on settings", async () => {
    await page.viewport(1_280, 720);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      browserStatus: "current",
      nodes: [studio, laptop, revoked],
      selectedNode: studio,
      selectionStatus: "online",
      effectiveRole: "owner",
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    writePrimary(studio);
    fakeWindow = createFakeHistoryWindow("/settings");
    installHostedNodeHistory(fakeWindow as unknown as Window & typeof globalThis);
    const selectNode = selectingNode();
    stopOrchestrator = startHostedNodeRouteOrchestrator();

    mounted = await render(
      <SidebarProvider>
        <SettingsPage />
      </SidebarProvider>,
    );
    const deviceHeader = () =>
      document.querySelector<HTMLElement>('[aria-label="Device settings"]')?.textContent ?? "";
    await vi.waitFor(() => expect(deviceHeader()).toContain(studio.label));

    await page.getByRole("button", { name: "Settings device" }).click();
    // Every node this browser may open, and no revoked one.
    await expect.element(page.getByRole("menuitemradio", { name: laptop.label })).toBeVisible();
    await expect
      .element(page.getByRole("menuitemradio", { name: revoked.label }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitemradio", { name: laptop.label }).click();

    // The cursor moves; the address names no node and stays as it is.
    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(laptop.id));
    expect(fakeWindow.location.pathname).toBe("/settings");
    expect(getRoutedHostedNode()).toMatchObject({ nodeId: null, logicalPathname: "/settings" });
    expect(fakeWindow.entries()).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();

    // The node header names the node whose settings are now being edited.
    await vi.waitFor(() => expect(deviceHeader()).toContain(laptop.label));
    expect(deviceHeader()).not.toContain(studio.label);
    expect(document.querySelector('[data-testid="settings-scope-label"]')?.textContent).toBe(
      laptop.label,
    );
    // …and no connection chip rides along in the settings header.
    expect(document.querySelector("details > summary")).toBeNull();
    // The page holds the demand for the node whose settings it shows.
    await vi.waitFor(() =>
      expect(hostedWebConnectionScopes.list()).toEqual([
        expect.objectContaining({
          environmentId: laptop.environmentId,
          scope: { type: "interactive" },
        }),
      ]),
    );
  });

  it("offers every node to choose from before the cursor is on any", async () => {
    await page.viewport(1_280, 720);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      browserStatus: "current",
      nodes: [studio, laptop],
    });
    fakeWindow = createFakeHistoryWindow("/settings");
    installHostedNodeHistory(fakeWindow as unknown as Window & typeof globalThis);
    const selectNode = selectingNode();
    useSettingsDialogStore.setState({ editingScope: "client" });

    mounted = await render(
      <SidebarProvider>
        <SettingsPage />
      </SidebarProvider>,
    );
    const deviceHeader = () =>
      document.querySelector<HTMLElement>('[aria-label="Device settings"]')?.textContent ?? "";
    await vi.waitFor(() => expect(deviceHeader()).toContain("Choose a device"));
    expect(hostedWebConnectionScopes.list()).toEqual([]);

    await page.getByRole("button", { name: "Settings device" }).click();
    await expect.element(page.getByRole("menuitemradio", { name: studio.label })).toBeVisible();
    await page.getByRole("menuitemradio", { name: laptop.label }).click();

    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(laptop.id));
    await vi.waitFor(() => expect(deviceHeader()).toContain(laptop.label));
    expect(document.querySelector('[data-testid="settings-scope-label"]')?.textContent).toBe(
      laptop.label,
    );
  });

  it("targets the last opened thread's node from node-less home and settings", async () => {
    await page.viewport(1_280, 720);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      browserStatus: "current",
      nodes: [studio, laptop],
    });
    setHostedNodeRouteEnvironmentResolver(
      (environmentId) =>
        [studio, laptop].find((entry) => entry.environmentId === environmentId)?.id ?? null,
    );
    fakeWindow = createFakeHistoryWindow(`/node/${studio.id}/${studio.environmentId}/t_1`);
    const history = installHostedNodeHistory(fakeWindow as unknown as Window & typeof globalThis);
    selectingNode();
    stopOrchestrator = startHostedNodeRouteOrchestrator();
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode?.id).toBe(studio.id));

    // Home and settings name no node; the cursor stays on the thread's node.
    for (const pathname of ["/", "/settings"]) {
      history.push(pathname);
      history.flush();
      expect(fakeWindow.location.pathname).toBe(pathname);
    }
    mounted = await render(
      <SidebarProvider>
        <SettingsPage />
      </SidebarProvider>,
    );
    const deviceHeader = () =>
      document.querySelector<HTMLElement>('[aria-label="Device settings"]')?.textContent ?? "";
    await vi.waitFor(() => expect(deviceHeader()).toContain(studio.label));
    expect(document.querySelector("details > summary")).toBeNull();
    expect(fakeWindow.location.pathname).toBe("/settings");

    // A thread on another node moves the cursor, and settings follow it.
    history.push(`/${laptop.environmentId}/t_2`);
    history.flush();
    expect(fakeWindow.location.pathname).toBe(`/node/${laptop.id}/${laptop.environmentId}/t_2`);
    await vi.waitFor(() => expect(useHostedHubStore.getState().selectedNode?.id).toBe(laptop.id));
    history.push("/settings");
    history.flush();
    expect(fakeWindow.location.pathname).toBe("/settings");
    await vi.waitFor(() => expect(deviceHeader()).toContain(laptop.label));
    expect(deviceHeader()).not.toContain(studio.label);
  });

  it("waits for a current directory and browser before offering another node", async () => {
    await page.viewport(1_280, 720);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "stale",
      browserStatus: "current",
      nodes: [studio, laptop],
      selectedNode: studio,
      selectionStatus: "online",
      effectiveRole: "owner",
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    writePrimary(studio);

    mounted = await render(
      <SidebarProvider>
        <SettingsPage />
      </SidebarProvider>,
    );
    await page.getByRole("button", { name: "Settings device" }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: laptop.label }))
      .toHaveAttribute("aria-disabled", "true");
  });
});

describe("the scope sentence names the node a section changes", () => {
  afterEach(() => {
    resetServerStateForTests();
  });

  /**
   * Hosted on Studio, with the node's config in: its node sections are listed
   * (the ones without a config are not).
   */
  function signInOnStudio(overrides: Partial<ReturnType<typeof useHostedHubStore.getState>> = {}) {
    setServerConfigSnapshot({
      environment: {
        environmentId: studio.environmentId,
        label: studio.label,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.9.0",
        capabilities: { repositoryIdentity: false, threadSettlement: false },
      },
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: "ryco_session",
      },
      cwd: "/repo",
      keybindingsConfigPath: "/repo/.ryco-keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/repo/.ryco/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: DEFAULT_SERVER_SETTINGS,
    } satisfies ServerConfig);
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      directoryStatus: "ready",
      browserStatus: "current",
      nodes: [studio, laptop, revoked],
      selectedNode: studio,
      selectionStatus: "online",
      effectiveRole: "owner",
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      ...overrides,
    });
    writePrimary(studio);
  }
  const scopeLabel = () =>
    document.querySelector('[data-testid="settings-scope-label"]')?.textContent ?? null;

  it("switches the node through the nav's own menu, and the section's rows follow", async () => {
    await page.viewport(1_280, 720);
    signInOnStudio();
    fakeWindow = createFakeHistoryWindow("/settings");
    installHostedNodeHistory(fakeWindow as unknown as Window & typeof globalThis);
    const selectNode = selectingNode();
    stopOrchestrator = startHostedNodeRouteOrchestrator();

    mounted = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SettingsPage />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Changes apply to", { exact: true })).toBeVisible();
    const menu = page.getByRole("button", { name: `${studio.label}, switch device` });
    await expect.element(menu).toBeVisible();
    const panelBefore = document.querySelector(".settings-panel-enter");
    expect(panelBefore).not.toBeNull();

    await menu.click();
    // The nav's own list: every node this browser may open, and no revoked one.
    await expect.element(page.getByRole("menuitemradio", { name: laptop.label })).toBeVisible();
    await expect
      .element(page.getByRole("menuitemradio", { name: revoked.label }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitemradio", { name: laptop.label }).click();

    // The selection cursor moves, staying on settings, and the sentence follows it.
    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(laptop.id));
    expect(fakeWindow.location.pathname).toBe("/settings");
    await vi.waitFor(() => expect(scopeLabel()).toBe(laptop.label));
    await expect
      .element(page.getByRole("button", { name: `${laptop.label}, switch device` }))
      .toBeVisible();
    await expect
      .element(page.getByTestId("settings-destination-description"))
      .toHaveTextContent("Identity, imports, updates, and project defaults for this device.");
    // The section is mounted again for the node it now shows, so its rows reload.
    expect(document.querySelector(".settings-panel-enter")).not.toBe(panelBefore);
  });

  it("offers a node only when the nav would, and says which nodes are offline", async () => {
    await page.viewport(1_280, 720);
    const offline = {
      ...node("node_dddddddddddddddddddddd", "Garage box"),
      presence: { online: false, lastHeartbeatAt: 1 },
    };
    signInOnStudio({ browserStatus: "suspended", nodes: [studio, laptop, offline] });

    mounted = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SettingsPage />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await page.getByRole("button", { name: `${studio.label}, switch device` }).click();
    // The directory's own rule for opening a node holds for this menu too.
    await expect
      .element(page.getByRole("menuitemradio", { name: laptop.label }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(page.getByRole("menuitemradio", { name: /^Garage box/ }))
      .toHaveTextContent(`${offline.label}Offline`);
  });

  it("searches the devices when there are more than six", async () => {
    await page.viewport(1_280, 720);
    const more = ["e", "f", "g", "h", "i"].map((letter, index) =>
      node(`node_${letter.repeat(22)}`, `Rack ${index + 1}`),
    );
    signInOnStudio({ nodes: [studio, laptop, ...more] });
    const selectNode = selectingNode();

    mounted = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SettingsPage />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    // A searchable list: its trigger is a combobox.
    await page.getByRole("combobox", { name: `${studio.label}, switch device` }).click();
    const search = page.getByRole("combobox", { name: "Search devices" });
    await expect.element(search).toBeVisible();
    await search.fill("rack 3");
    await expect.element(page.getByRole("option", { name: "Rack 3" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Rack 2" })).not.toBeInTheDocument();
    await page.getByRole("option", { name: "Rack 3" }).click();
    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(more[2]!.id));
  });

  it("shows no sentence on this app's own sections", async () => {
    await page.viewport(1_280, 720);
    signInOnStudio();
    useSettingsDialogStore.setState({ section: "appearance", editingScope: "client" });

    mounted = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SettingsPage />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(page.getByTestId("settings-destination-description"))
      .toHaveTextContent("Theme, typography, and interface details for this app.");
    await expect.element(page.getByText("Changes apply to")).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid="settings-scope-sentence"]')).toBeNull();
  });
});
