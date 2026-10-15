import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ServerConfig,
  type ServerProvider,
} from "@ryco/contracts";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  applyProvidersUpdated,
  applySettingsUpdated,
  resetServerStateForTests,
  setServerConfigSnapshot,
  useServerConfigSelector,
} from "../rpc/serverState";
import { useSettings } from "../hooks/useSettings";
import { sameInboxProviderCatalogs } from "../components/inboxSidebar/inboxSidebarModel";

vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => null,
      setClientSettings: async () => undefined,
    },
    server: { updateSettings: async () => undefined },
  }),
}));

function makeConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-settings"),
      label: "Local",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true, threadSettlement: false },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
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
  } as unknown as ServerConfig;
}

const selectAgentControlEnabled = (settings: UnifiedSettings) => settings.agentControl.enabled;
const selectProviderCount = (config: ServerConfig | null) => config?.providers.length ?? 0;
const selectProviders = (config: ServerConfig | null) => config?.providers ?? null;

describe("useSettings subscriptions", () => {
  afterEach(() => {
    resetServerStateForTests();
  });

  it("re-renders only when the selected setting changes", async () => {
    setServerConfigSnapshot(makeConfig());
    const renders = { settings: 0, providers: 0 };
    function SettingsProbe() {
      const enabled = useSettings(selectAgentControlEnabled);
      return <span data-testid="agent-control">{String(enabled)}</span>;
    }
    function ProvidersProbe() {
      const count = useServerConfigSelector(selectProviderCount);
      return <span data-testid="providers">{count}</span>;
    }
    const mounted = await render(
      <AppAtomRegistryProvider>
        <Profiler id="settings" onRender={() => (renders.settings += 1)}>
          <SettingsProbe />
        </Profiler>
        <Profiler id="providers" onRender={() => (renders.providers += 1)}>
          <ProvidersProbe />
        </Profiler>
      </AppAtomRegistryProvider>,
    );
    try {
      await vi.waitFor(() =>
        expect(mounted.container.querySelector('[data-testid="agent-control"]')?.textContent).toBe(
          "false",
        ),
      );
      const settingsRendersAfterMount = renders.settings;
      const providerRendersAfterMount = renders.providers;

      // Provider-status pushes replace the config but not its settings.
      applyProvidersUpdated({ providers: [{} as ServerProvider] });
      applyProvidersUpdated({ providers: [{} as ServerProvider] });
      await vi.waitFor(() =>
        expect(mounted.container.querySelector('[data-testid="providers"]')?.textContent).toBe("1"),
      );
      expect(renders.settings).toBe(settingsRendersAfterMount);
      expect(renders.providers).toBe(providerRendersAfterMount + 1);

      // An unrelated setting changes: still no render.
      applySettingsUpdated({
        ...DEFAULT_SERVER_SETTINGS,
        runSetupScript: !DEFAULT_SERVER_SETTINGS.runSetupScript,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(renders.settings).toBe(settingsRendersAfterMount);

      // The selected setting changes: one render with the new value.
      applySettingsUpdated({
        ...DEFAULT_SERVER_SETTINGS,
        agentControl: { enabled: true },
      });
      await vi.waitFor(() =>
        expect(mounted.container.querySelector('[data-testid="agent-control"]')?.textContent).toBe(
          "true",
        ),
      );
      expect(renders.settings).toBe(settingsRendersAfterMount + 1);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the inbox's provider catalogs across status-only provider pushes", async () => {
    const models = [{ slug: "gpt-5.4" }] as unknown as ServerProvider["models"];
    const provider = (status: string, nextModels = models) =>
      ({
        instanceId: "codex",
        driver: "codex",
        status,
        models: nextModels,
      }) as unknown as ServerProvider;
    setServerConfigSnapshot({ ...makeConfig(), providers: [provider("ready")] });
    let renders = 0;
    function CatalogProbe() {
      const providers = useServerConfigSelector(selectProviders, sameInboxProviderCatalogs);
      return <span data-testid="catalog">{providers?.[0]?.models.length ?? 0}</span>;
    }
    const mounted = await render(
      <AppAtomRegistryProvider>
        <Profiler id="catalog" onRender={() => (renders += 1)}>
          <CatalogProbe />
        </Profiler>
      </AppAtomRegistryProvider>,
    );
    try {
      await vi.waitFor(() =>
        expect(mounted.container.querySelector('[data-testid="catalog"]')?.textContent).toBe("1"),
      );
      const rendersAfterMount = renders;
      // Status changes keep the catalog: the inbox model is not rebuilt.
      applyProvidersUpdated({ providers: [provider("checking")] });
      applyProvidersUpdated({ providers: [provider("error")] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(renders).toBe(rendersAfterMount);
      // A new model catalog does.
      applyProvidersUpdated({
        providers: [provider("ready", [...models, { slug: "gpt-5.5" }] as typeof models)],
      });
      await vi.waitFor(() =>
        expect(mounted.container.querySelector('[data-testid="catalog"]')?.textContent).toBe("2"),
      );
      expect(renders).toBe(rendersAfterMount + 1);
    } finally {
      await mounted.unmount();
    }
  });
});
