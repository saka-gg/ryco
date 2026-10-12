import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  CliProxyHubId,
  EnvironmentId,
  type CliProxyTestHubResult,
  type EnvironmentApi,
  type ServerConfig,
  type ServerSettings,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SettingsTargetProvider } from "../../settingsTarget";
import { CliProxyHubSettings } from "./CliProxyHubSettings";

const harness = vi.hoisted(() => ({ updateSettings: vi.fn() }));

// Only the settings write is observed; nothing here connects to an environment.
vi.mock("../../environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
  getSavedEnvironmentRecord: () => null,
  getSavedEnvironmentRuntimeState: () => null,
  hasSavedEnvironmentRegistryHydrated: () => true,
  listSavedEnvironmentRecords: () => [],
  resetSavedEnvironmentRegistryStoreForTests: () => undefined,
  resetSavedEnvironmentRuntimeStoreForTests: () => undefined,
  resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
    new URL(path, "http://localhost:3000").toString(),
  waitForSavedEnvironmentRegistryHydration: async () => undefined,
  addSavedEnvironment: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  connectDesktopWorkspaceEnvironment: vi.fn(),
  connectDesktopSshEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: async () => undefined,
  getPrimaryEnvironmentConnection: () => null,
  readEnvironmentConnection: () => null,
  reconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(),
  resetEnvironmentServiceForTests: () => undefined,
  startEnvironmentConnectionService: () => undefined,
  subscribeEnvironmentConnections: () => () => {},
  updateEnvironmentServerSettings: harness.updateSettings,
  useSavedEnvironmentRegistryStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
  useSavedEnvironmentRuntimeStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

const environmentId = EnvironmentId.make("env-hubs");

function Fixture(props: {
  readonly hubsSupported?: boolean;
  readonly cloudflareSupported?: boolean;
  readonly hubs?: ServerSettings["cliProxyHubs"];
}) {
  const serverConfig = {
    settings: { ...DEFAULT_SERVER_SETTINGS, cliProxyHubs: props.hubs ?? {} },
    environment: {
      capabilities:
        props.hubsSupported === false
          ? {}
          : {
              cliProxyHubs: true,
              cliProxyCloudflareAccess: props.cloudflareSupported !== false,
            },
    },
  } as unknown as ServerConfig;
  return (
    <AppAtomRegistryProvider>
      <SettingsTargetProvider
        value={{
          environmentId,
          nodeLabel: "This machine",
          serverConfig,
          primary: true,
          connected: true,
          canManage: true,
        }}
      >
        <CliProxyHubSettings />
      </SettingsTargetProvider>
    </AppAtomRegistryProvider>
  );
}

function serveTests(test: () => Promise<CliProxyTestHubResult>) {
  const testCliProxyHub = vi.fn(test);
  __setEnvironmentApiOverrideForTests(environmentId, {
    server: { testCliProxyHub },
  } as unknown as EnvironmentApi);
  return testCliProxyHub;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function openAddDialog() {
  await page.getByRole("button", { name: "Add CLIProxyAPI hub" }).click();
  await expect.element(page.getByLabelText("Hub URL")).toBeVisible();
}

describe("CliProxyHubSettings", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;
  let stopTierSync: (() => void) | null = null;

  beforeEach(async () => {
    await page.viewport(1_280, 800);
    stopTierSync = syncDocumentPresentationTier();
    harness.updateSettings.mockReset();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    stopTierSync?.();
    stopTierSync = null;
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
  });

  it("is not part of the frozen web phone tier", async () => {
    await page.viewport(390, 844);
    // The tier follows a media query, so it lands after the resize, not with it.
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
    });
    mounted = await render(<Fixture />);
    expect(document.body.textContent).not.toContain("CLIProxyAPI hubs");

    await page.viewport(1_280, 800);
    await expect.element(page.getByText("CLIProxyAPI hubs", { exact: true })).toBeVisible();
  });

  it("asks to update a node that predates hubs instead of saving into it", async () => {
    mounted = await render(<Fixture hubsSupported={false} />);
    await expect
      .element(page.getByText("Update Ryco on this node to connect CLIProxyAPI hubs."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add CLIProxyAPI hub" })).toBeDisabled();
  });

  it("drops a test result for a URL that was edited since", async () => {
    const test = deferred<CliProxyTestHubResult>();
    const testCliProxyHub = serveTests(() => test.promise);
    mounted = await render(<Fixture />);
    await openAddDialog();
    await page.getByLabelText("Hub URL").fill("http://hub-a:8317");
    await page.getByLabelText("Management key").fill("key");
    await page.getByRole("button", { name: "Test connection" }).click();
    await page.getByLabelText("Hub URL").fill("http://hub-b:8317");

    test.resolve({ version: "6.6.6", accountCount: 3 });
    await test.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(testCliProxyHub).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Connected");
  });

  it("validates a token pair and includes it in connection tests and saves", async () => {
    const testCliProxyHub = serveTests(async () => ({ accountCount: 3 }));
    harness.updateSettings.mockResolvedValue(undefined);
    mounted = await render(<Fixture />);
    await openAddDialog();
    await page.getByLabelText("Hub URL").fill("https://hub.example");
    await page.getByLabelText("Management key").fill("key");
    await page.getByLabelText("Cloudflare Access Client ID").fill("token.access");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect.element(page.getByText(/Enter both the Cloudflare Access/)).toBeVisible();
    expect(testCliProxyHub).not.toHaveBeenCalled();
    await page.getByLabelText("Cloudflare Access Client Secret").fill("cf-secret");
    await expect
      .element(page.getByLabelText("Cloudflare Access Client Secret"))
      .toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect
      .element(page.getByText("Connected · 3 subscription accounts", { exact: true }))
      .toBeVisible();
    expect(testCliProxyHub).toHaveBeenCalledWith({
      url: "https://hub.example",
      managementKey: "key",
      cloudflareAccessClientId: "token.access",
      cloudflareAccessClientSecret: "cf-secret",
    });
    await page.getByRole("button", { name: "Add hub", exact: true }).click();
    expect(harness.updateSettings).toHaveBeenCalledWith(environmentId, {
      cliProxyHubs: {
        "cliproxy-hub-example": {
          url: "https://hub.example",
          managementKey: "key",
          enabled: true,
          cloudflareAccessClientId: "token.access",
          cloudflareAccessClientSecret: "cf-secret",
        },
      },
    });
  });

  it("keeps the saved token when editing, and allows its explicit removal", async () => {
    const hubId = CliProxyHubId.make("home");
    const testCliProxyHub = serveTests(async () => ({ accountCount: 3 }));
    harness.updateSettings.mockResolvedValue(undefined);
    const hub = {
      url: "https://hub.example",
      label: "Home",
      enabled: true,
      managementKey: "",
      managementKeyRedacted: true,
      cloudflareAccessClientId: "token.access",
      cloudflareAccessClientSecret: "",
      cloudflareAccessClientSecretRedacted: true,
    };
    mounted = await render(<Fixture hubs={{ [hubId]: hub }} />);
    await page.getByRole("button", { name: "Edit Home" }).click();
    await expect.element(page.getByLabelText("Cloudflare Access Client Secret")).toHaveValue("");
    await page.getByLabelText("Management key").fill("new-key");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect
      .element(page.getByText("Connected · 3 subscription accounts", { exact: true }))
      .toBeVisible();
    expect(testCliProxyHub).toHaveBeenLastCalledWith({
      url: hub.url,
      hubId,
      managementKey: "new-key",
      cloudflareAccessClientId: "token.access",
      cloudflareAccessClientSecret: "",
    });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(harness.updateSettings).toHaveBeenLastCalledWith(environmentId, {
      cliProxyHubs: {
        [hubId]: { ...hub, managementKey: "new-key", managementKeyRedacted: undefined },
      },
    });

    await page.getByRole("button", { name: "Edit Home" }).click();
    await page.getByLabelText("Cloudflare Access Client ID").fill("");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect
      .element(page.getByText("Connected · 3 subscription accounts", { exact: true }))
      .toBeVisible();
    expect(testCliProxyHub).toHaveBeenLastCalledWith({
      url: hub.url,
      hubId,
      cloudflareAccessClientId: "",
      cloudflareAccessClientSecret: "",
    });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(harness.updateSettings).toHaveBeenLastCalledWith(environmentId, {
      cliProxyHubs: {
        [hubId]: {
          ...hub,
          cloudflareAccessClientId: "",
          cloudflareAccessClientSecretRedacted: undefined,
        },
      },
    });
  });

  it("asks to update older nodes before entering Cloudflare credentials", async () => {
    mounted = await render(<Fixture cloudflareSupported={false} />);
    await openAddDialog();
    await expect
      .element(page.getByText("Update Ryco on this node to use Cloudflare Access service tokens."))
      .toBeVisible();
    await expect.element(page.getByLabelText("Cloudflare Access Client ID")).toBeDisabled();
    await expect.element(page.getByLabelText("Cloudflare Access Client Secret")).toBeDisabled();
  });

  it("reports a save that fails after its dialog closed in the section", async () => {
    const save = deferred<never>();
    harness.updateSettings.mockReturnValue(save.promise);
    mounted = await render(<Fixture />);
    await openAddDialog();
    await page.getByLabelText("Hub URL").fill("http://hub-a:8317");
    await page.getByLabelText("Management key").fill("key");
    await page.getByRole("button", { name: "Add hub", exact: true }).click();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByLabelText("Hub URL")).not.toBeInTheDocument();

    await openAddDialog();
    save.reject(new Error("save failed for hub-a"));
    await expect.element(page.getByText("save failed for hub-a")).toBeVisible();
    // The message belongs to the section, not to the form opened since.
    await expect.element(page.getByLabelText("Hub URL")).toHaveValue("");
    await expect
      .element(page.getByRole("dialog").getByText("save failed for hub-a"))
      .not.toBeInTheDocument();
  });
});
