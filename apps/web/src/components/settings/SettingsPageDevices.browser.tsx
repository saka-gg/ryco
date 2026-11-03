// The settings page outside hosted mode with a remote device next to this app's own: which
// device the page shows, in which view, and what an offline or connecting device does to
// the section.
//
// What is pinned here: a remote device that cannot be read (offline, connecting) keeps the
// section and says why, and the section stays when it reconnects; `openSettings` with a
// device and an address naming one open that device's own values, a plain open every
// device's; a reload's device waits for the saved devices to load instead of being written
// over; and Providers, which has no shared rows, never falls back to another device's rows.
import "../../index.css";

import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
// Rendered outside a `RouterProvider`: the page reads route params only for the
// routed thread, and leaves settings through the router.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => null,
  useRouter: () => ({ navigate, history: { canGoBack: () => false, back: () => undefined } }),
}));

import {
  SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
  writeBrowserSavedEnvironmentRegistry,
} from "../../clientPersistenceStorage";
import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsPage, type SettingsPageLocation } from "./SettingsPage";
import { SharedSettingsSourceProvider } from "./sharedSettings/sharedSettingsSource";
import { createTestSharedSettings } from "./sharedSettings/sharedSettingsTestSource";

const LOCAL = EnvironmentId.make("env-local");
const STUDIO = EnvironmentId.make("env-studio");

function serverConfig(environmentId: EnvironmentId, label: string): ServerConfig {
  return {
    environment: {
      environmentId,
      label,
      platform: { os: "darwin", arch: "arm64" },
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
  } satisfies ServerConfig;
}

const STUDIO_RECORD = {
  environmentId: STUDIO,
  label: "Studio",
  wsBaseUrl: "ws://studio.test",
  httpBaseUrl: "http://studio.test",
  createdAt: "2026-08-01T09:00:00.000Z",
  lastConnectedAt: "2026-11-01T09:00:00.000Z",
};

/** This app's own device, connected. */
function signInLocally(): void {
  writePrimaryEnvironmentDescriptor({
    environmentId: LOCAL,
    label: "This Mac",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.9.0",
    capabilities: { repositoryIdentity: false, threadSettlement: false },
  });
  setServerConfigSnapshot(serverConfig(LOCAL, "This Mac"));
}

/** Studio as a saved device: in the registry, and connected (with its config) or not. */
function saveStudio(connection: "connected" | "disconnected"): void {
  useSavedEnvironmentRegistryStore.setState({ byId: { [STUDIO]: STUDIO_RECORD } });
  setStudioConnection(connection);
}

function setStudioConnection(connection: "connected" | "disconnected"): void {
  const connected = connection === "connected";
  useSavedEnvironmentRuntimeStore.setState((state) => ({
    byId: {
      ...state.byId,
      [STUDIO]: {
        connectionState: connection,
        authState: "authenticated",
        lastError: null,
        lastErrorAt: null,
        role: "owner",
        descriptor: null,
        serverConfig: connected ? serverConfig(STUDIO, "Studio") : null,
        connectedAt: connected ? "2026-11-03T09:00:00.000Z" : null,
        disconnectedAt: connected ? null : "2026-11-03T08:00:00.000Z",
      },
    },
  }));
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function renderPage(location?: SettingsPageLocation) {
  await page.viewport(1_280, 720);
  // Both devices as the shared rows read them; Studio as offline as the page sees it.
  const network = createTestSharedSettings([
    { id: LOCAL, label: "This Mac" },
    {
      id: STUDIO,
      label: "Studio",
      connected:
        useSavedEnvironmentRuntimeStore.getState().byId[STUDIO]?.connectionState === "connected",
    },
  ]);
  mounted = await render(
    <AppAtomRegistryProvider>
      <SharedSettingsSourceProvider value={network.source}>
        <SidebarProvider>
          <SettingsPage location={location} />
        </SidebarProvider>
      </SharedSettingsSourceProvider>
    </AppAtomRegistryProvider>,
  );
}

const bar = () => page.getByTestId("settings-device-bar");
const pill = (label: string) => bar().getByRole("button", { name: label });
const allDevices = () => bar().getByRole("button", { name: "All devices" });
const heading = () => document.querySelector(".settings-panel-enter h2")?.textContent ?? null;

beforeEach(() => {
  signInLocally();
  useSettingsDialogStore.setState({
    open: true,
    section: "general",
    targetEnvironmentId: null,
    deviceTab: null,
    deviceView: "all",
  });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetServerStateForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  window.localStorage.removeItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY);
  useSettingsDialogStore.setState({
    open: false,
    section: "general",
    targetEnvironmentId: null,
    deviceTab: null,
    deviceView: "all",
  });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("a remote device the page cannot read yet", () => {
  it("keeps Usage when the bar's device is offline, and shows its rows once it reconnects", async () => {
    saveStudio("disconnected");
    useSettingsDialogStore.setState({ section: "usage" });
    await renderPage();
    await vi.waitFor(() => expect(heading()).toBe("Usage & cost"));

    await pill("Studio").click();
    await expect.element(page.getByText("Studio is offline")).toBeVisible();
    expect(heading()).toBe("Usage & cost");
    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "usage",
      targetEnvironmentId: STUDIO,
    });
    // The section stays listed for it.
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect.element(nav.getByRole("button", { name: "Providers & models" })).toBeVisible();

    setStudioConnection("connected");
    await expect.element(page.getByText("Studio is offline")).not.toBeInTheDocument();
    expect(heading()).toBe("Usage & cost");
    expect(useSettingsDialogStore.getState().section).toBe("usage");
  });

  it("keeps Providers for an offline device it was opened on", async () => {
    saveStudio("disconnected");
    useSettingsDialogStore.getState().openSettings("providers", STUDIO);
    await renderPage();

    await expect.element(page.getByText("Studio is offline")).toBeVisible();
    expect(heading()).toBe("Providers & models");
    expect(useSettingsDialogStore.getState().section).toBe("providers");
  });
});

describe("which view the page opens on", () => {
  it("opens a device named by openSettings on its own values, and a plain open on every device's", async () => {
    saveStudio("connected");
    const replace = vi.fn();
    useSettingsDialogStore.getState().openSettings("usage", STUDIO);
    await renderPage({ search: {}, replace });

    await expect.element(pill("Studio")).toHaveAttribute("aria-pressed", "true");
    await expect.element(allDevices()).toHaveAttribute("aria-pressed", "false");
    // The address names the device; its own values need no view.
    await vi.waitFor(() =>
      expect(replace).toHaveBeenLastCalledWith({ section: "usage", device: STUDIO }),
    );

    useSettingsDialogStore.getState().openSettings("usage");
    await expect.element(allDevices()).toHaveAttribute("aria-pressed", "true");
    await vi.waitFor(() =>
      expect(replace).toHaveBeenLastCalledWith({ section: "usage", device: LOCAL, view: "all" }),
    );
  });

  it("restores a device's own values from the address, and every device's with view=all", async () => {
    saveStudio("connected");
    await renderPage({ search: { section: "usage", device: STUDIO }, replace: vi.fn() });
    await expect.element(pill("Studio")).toHaveAttribute("aria-pressed", "true");
    await expect.element(allDevices()).toHaveAttribute("aria-pressed", "false");
    await mounted?.unmount();

    useSettingsDialogStore.setState({ deviceView: "device" });
    await renderPage({
      search: { section: "usage", device: STUDIO, view: "all" },
      replace: vi.fn(),
    });
    await expect.element(allDevices()).toHaveAttribute("aria-pressed", "true");
    expect(useSettingsDialogStore.getState().targetEnvironmentId).toBe(STUDIO);
  });
});

describe("a reload's device", () => {
  it("waits for the saved devices to load, and the address keeps it meanwhile", async () => {
    // A reload: the saved devices are read after the page first renders.
    resetSavedEnvironmentRegistryStoreForTests();
    writeBrowserSavedEnvironmentRegistry([STUDIO_RECORD]);
    const replace = vi.fn();
    await renderPage({ search: { section: "device", device: STUDIO, tab: "security" }, replace });

    await vi.waitFor(() =>
      expect(useSettingsDialogStore.getState().targetEnvironmentId).toBe(STUDIO),
    );
    await expect
      .element(page.getByRole("tab", { name: "Security", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await vi.waitFor(() =>
      expect(document.querySelector(".settings-panel-enter h2")?.textContent).toBe("Studio"),
    );
    // Never written over with this app's own device.
    for (const [search] of replace.mock.calls) expect(search).toMatchObject({ device: STUDIO });
  });
});

describe("Providers on All devices", () => {
  it("never falls back to another device's rows while the bar's device is offline", async () => {
    saveStudio("disconnected");
    useSettingsDialogStore.setState({
      section: "providers",
      targetEnvironmentId: STUDIO,
      deviceView: "all",
    });
    await renderPage();

    await expect.element(allDevices()).toHaveAttribute("aria-pressed", "true");
    // The editor waits for the bar's device; no shared-rows-only fallback through This Mac.
    await expect.element(page.getByText("Studio is offline")).toBeVisible();
    expect(document.querySelector('[data-testid="settings-shared-rows-only"]')).toBeNull();
    // The table reads every device itself: it stays, the offline column read only.
    await expect.element(page.getByTestId("provider-device-table")).toBeVisible();
  });

  it("lists every device in its table while the bar shows this app's own", async () => {
    saveStudio("disconnected");
    useSettingsDialogStore.setState({ section: "providers", deviceView: "all" });
    await renderPage();

    await expect.element(allDevices()).toHaveAttribute("aria-pressed", "true");
    const table = page.getByTestId("provider-device-table");
    await expect.element(table).toBeVisible();
    const columns = Array.from(
      document.querySelectorAll('[data-testid="provider-device-table"] thead th'),
    ).map((cell) => cell.textContent ?? "");
    expect(columns.some((text) => text.includes("Studio"))).toBe(true);
    expect(columns.some((text) => text.includes("This Mac"))).toBe(true);
    expect(document.querySelector('[data-testid="settings-shared-rows-only"]')).toBeNull();
  });
});
