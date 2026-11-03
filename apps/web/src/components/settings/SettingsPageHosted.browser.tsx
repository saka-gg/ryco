// Hosted settings choose their device through the selection cursor.
//
// THE FILE EXISTS BECAUSE THE MODE IS READ AT MODULE SCOPE. `isHostedHubMode()`
// answers a build-time flag, so the hoisted `vi.mock` below applies to the whole
// file — the same reason `NodeSecuritySettingsHosted.browser.tsx` is its own
// file.
//
// What is pinned here: hosted settings show the selected node's values, and
// the device bar ("Values for") and the nav's device items are how a hosted
// reader chooses which node that is. The settings address names no node: a
// choice moves the selection cursor, the page stays where it is, and the bar
// names the node it lands on. The cursor itself follows the last opened thread
// across the pages no node owns.
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
import { setSettingsDeviceView } from "./sharedSettings/sharedSettingsMode";
import { createFakeHistoryWindow, type FakeHistoryWindow } from "../../../test/fakeHistoryWindow";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsPage, type SettingsPageLocation } from "./SettingsPage";

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
  useSettingsDialogStore.setState({ open: true, section: "projects" });
  // These tests follow the device pills; "All devices" has its own test below.
  setSettingsDeviceView("device");
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
  setSettingsDeviceView("all");
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** The node the device bar shows values for. */
const shownNode = () =>
  document.querySelector('[data-testid="settings-device-bar"] [aria-pressed="true"]')
    ?.textContent ?? null;
const pill = (label: string | RegExp) =>
  page.getByTestId("settings-device-bar").getByRole("button", { name: label });

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
    await vi.waitFor(() => expect(shownNode()).toBe(studio.label));
    // Every node this browser may open, and no revoked one.
    await expect.element(pill(laptop.label)).toBeVisible();
    await expect.element(pill(revoked.label)).not.toBeInTheDocument();
    await pill(laptop.label).click();

    // The cursor moves; the address names no node and stays as it is.
    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(laptop.id));
    expect(fakeWindow.location.pathname).toBe("/settings");
    expect(getRoutedHostedNode()).toMatchObject({ nodeId: null, logicalPathname: "/settings" });
    expect(fakeWindow.entries()).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();

    // The bar names the node whose values are now shown, on the same section.
    await vi.waitFor(() => expect(shownNode()).toBe(laptop.label));
    expect(useSettingsDialogStore.getState().section).toBe("projects");
    // …and no connection chip rides along in the settings header.
    expect(document.querySelector("details > summary")).toBeNull();
    // The page holds the demand for the node whose values it shows.
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

    mounted = await render(
      <SidebarProvider>
        <SettingsPage />
      </SidebarProvider>,
    );
    await expect.element(page.getByText("Choose a device")).toBeVisible();
    expect(shownNode()).toBeNull();
    expect(hostedWebConnectionScopes.list()).toEqual([]);

    // The nav lists every node under Devices; one opens its page.
    const devices = page.getByRole("group", { name: "Devices" });
    await expect.element(devices.getByRole("button", { name: studio.label })).toBeVisible();
    await devices.getByRole("button", { name: laptop.label }).click();

    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(laptop.id));
    await vi.waitFor(() => expect(document.querySelector("h2")?.textContent).toBe(laptop.label));
    expect(useSettingsDialogStore.getState().section).toBe("device");
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
    await vi.waitFor(() => expect(shownNode()).toBe(studio.label));
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
    await vi.waitFor(() => expect(shownNode()).toBe(laptop.label));
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
    await expect.element(pill(laptop.label)).toBeDisabled();
  });
});

describe("the device bar and This app", () => {
  afterEach(() => {
    resetServerStateForTests();
  });

  /** Hosted on Studio, with the node's config in. */
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

  it("marks rows stored on the device, and remounts them for the node it switches to", async () => {
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
    await expect.element(page.getByText("Values for", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Per device").first()).toBeVisible();
    const panelBefore = document.querySelector(".settings-panel-enter");
    expect(panelBefore).not.toBeNull();

    await pill(laptop.label).click();
    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(laptop.id));
    expect(fakeWindow.location.pathname).toBe("/settings");
    await vi.waitFor(() => expect(shownNode()).toBe(laptop.label));
    await expect
      .element(page.getByTestId("settings-destination-description"))
      .toHaveTextContent("New threads, worktrees and where projects open.");
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
    // The directory's own rule for opening a node holds for the bar too.
    await expect.element(pill(laptop.label)).toBeDisabled();
    await expect.element(pill(offline.label)).toHaveAttribute("title", "Offline");
  });

  it("shows no device bar on this app's own sections, and says so", async () => {
    await page.viewport(1_280, 720);
    signInOnStudio();
    useSettingsDialogStore.setState({ section: "appearance" });

    mounted = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SettingsPage />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(page.getByTestId("settings-destination-description"))
      .toHaveTextContent("How this app looks.This app");
    expect(document.querySelector('[data-testid="settings-device-bar"]')).toBeNull();
  });

  it("keeps this app's rows for a hosted viewer, and hides the node's", async () => {
    await page.viewport(1_280, 720);
    signInOnStudio({ effectiveRole: "viewer" });
    useSettingsDialogStore.setState({ section: "chat" });

    mounted = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SettingsPage />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Composer controls" })).toBeVisible();
    await expect.element(page.getByText("No settings you can change")).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Response streaming" }))
      .not.toBeInTheDocument();
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect
      .element(nav.getByRole("button", { name: "Providers & models" }))
      .not.toBeInTheDocument();
    await expect.element(nav.getByRole("button", { name: "Chat & composer" })).toBeVisible();
  });

  const renderPage = (location?: SettingsPageLocation) =>
    render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SettingsPage location={location} />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
  const tab = (name: string) => page.getByRole("tab", { name, exact: true });

  it("lists a card per device on All devices, and a card opens its page on Overview", async () => {
    await page.viewport(1_280, 720);
    signInOnStudio();
    useSettingsDialogStore.setState({ section: "devices", deviceTab: "power" });

    mounted = await renderPage();
    const cards = page.getByRole("list", { name: "Devices" });
    await expect.element(cards.getByRole("button", { name: /Studio node/ })).toBeVisible();
    await expect.element(cards.getByRole("button", { name: /Travel laptop/ })).toBeVisible();
    await expect.element(cards.getByText("Hub device").first()).toBeVisible();
    // A hosted browser runs no backend of its own to pair a device with.
    await expect.element(page.getByText("Add a device")).not.toBeInTheDocument();

    await cards.getByRole("button", { name: /Studio node/ }).click();
    await expect.element(tab("Overview")).toHaveAttribute("aria-selected", "true");
    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "device",
      deviceTab: null,
    });
    await expect.element(page.getByRole("heading", { name: "Studio node" })).toBeVisible();
  });

  it("shows one tab at a time, and an old id opens its tab", async () => {
    await page.viewport(1_280, 720);
    signInOnStudio();
    useSettingsDialogStore.setState({ section: "security", deviceTab: null });

    mounted = await renderPage();
    await expect.element(tab("Security")).toHaveAttribute("aria-selected", "true");
    await vi.waitFor(() =>
      expect(useSettingsDialogStore.getState()).toMatchObject({
        section: "device",
        deviceTab: "security",
      }),
    );

    await tab("Access").click();
    await expect.element(tab("Access")).toHaveAttribute("aria-selected", "true");
    // Hosted: this app has no backend of its own, so Access says where it lives.
    await expect.element(page.getByText(/are set on Studio node itself/)).toBeVisible();
    expect(useSettingsDialogStore.getState().deviceTab).toBe("access");

    await tab("Computer use").click();
    await expect
      .element(page.getByText("Computer use needs the Ryco desktop app on Studio node."))
      .toBeVisible();
  });

  it("follows its address and writes its place back, without naming the hosted node", async () => {
    await page.viewport(1_280, 720);
    signInOnStudio();
    useSettingsDialogStore.setState({ section: "appearance", deviceTab: null });
    const replace = vi.fn();

    mounted = await renderPage({ search: { section: "device", tab: "power" }, replace });
    await expect.element(tab("Power")).toHaveAttribute("aria-selected", "true");
    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "device",
      deviceTab: "power",
    });

    await tab("Security").click();
    await vi.waitFor(() =>
      expect(replace).toHaveBeenLastCalledWith({ section: "device", tab: "security" }),
    );
  });

  it("shows every device's values by default in a section with shared rows", async () => {
    setSettingsDeviceView("all");
    signInOnStudio({ nodes: [studio, laptop] });
    mounted = await renderPage();
    const all = page
      .getByTestId("settings-device-bar")
      .getByRole("button", { name: "All devices" });
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await expect.element(pill(studio.label)).toHaveAttribute("aria-pressed", "false");
    // A device pill shows that device's own values.
    await pill(studio.label).click();
    await expect.element(all).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps five devices in the bar and the rest under More, with a search", async () => {
    await page.viewport(1_280, 720);
    const many = Array.from({ length: 5 }, (_, index) =>
      node(`node_${String(index).repeat(22)}`, `Box ${index + 1}`),
    );
    signInOnStudio({ nodes: [studio, laptop, ...many] });
    const selectNode = selectingNode();

    mounted = await renderPage();
    const bar = page.getByTestId("settings-device-bar");
    await expect.element(pill(studio.label)).toBeVisible();
    // "All devices", five device pills and More.
    expect(bar.getByRole("button").elements()).toHaveLength(7);

    await bar.getByRole("button", { name: /More/ }).click();
    await page.getByRole("searchbox", { name: "Search devices" }).fill("box 5");
    const others = page.getByRole("list", { name: "Other devices" });
    await expect.element(others.getByRole("listitem")).toHaveTextContent("Box 5");
    await others.getByRole("listitem").click();
    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith(many[4]!.id));
  });
});
