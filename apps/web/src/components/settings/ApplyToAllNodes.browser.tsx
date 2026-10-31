// "Apply to all nodes" on a node default, with two saved nodes whose settings
// differ. The nodes' own settings writes are the only stand-in: each applies
// the patch to that node's current settings with the shared settings code, so
// its compare-and-set refuses exactly what the real node would.
import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type EffectiveProjectPreferences,
  type EnvironmentApi,
  type ServerConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@ryco/contracts";
import { recordWsConnectionOpened, resetWsConnectionStateForTests } from "@ryco/client-runtime/rpc";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  function createStore<S>(initial: S) {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
      getState: () => state,
      setState: (next: S) => {
        state = next;
        for (const listener of Array.from(listeners)) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }
  return {
    registry: createStore({ byId: {} as Record<string, { environmentId: string; label: string }> }),
    runtime: createStore({
      byId: {} as Record<string, { role: "owner" | "client" | null; serverConfig: unknown }>,
    }),
    /** Each node's own current settings, which its settings write checks. */
    nodeSettings: new Map<string, unknown>(),
    writes: [] as Array<{ environmentId: string; patch: unknown }>,
  };
});

vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: () => <span>Model picker</span>,
}));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => <span>Traits picker</span> }));
vi.mock("../../environments/runtime", async () => {
  const { useSyncExternalStore } = await import("react");
  const bind = <S,>(store: {
    getState: () => S;
    subscribe: (listener: () => void) => () => void;
  }) =>
    Object.assign(
      <T,>(selector: (state: S) => T): T =>
        useSyncExternalStore(
          store.subscribe,
          () => selector(store.getState()),
          () => selector(store.getState()),
        ),
      store,
    );
  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    listEnvironmentConnections: () => [],
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
    // Every saved node has a live connection here.
    readEnvironmentConnection: (environmentId: string) =>
      harness.registry.getState().byId[environmentId] ? {} : null,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: vi.fn(),
    resetEnvironmentServiceForTests: () => undefined,
    startEnvironmentConnectionService: () => undefined,
    subscribeEnvironmentConnections: () => () => undefined,
    // The node's own `server.updateSettings`, then the client's snapshot of it.
    updateEnvironmentServerSettings: async (environmentId: string, patch: ServerSettingsPatch) => {
      harness.writes.push({ environmentId, patch });
      const current = harness.nodeSettings.get(environmentId) as ServerSettings;
      const next = applyServerSettingsPatch(current, patch);
      harness.nodeSettings.set(environmentId, next);
      const byId = harness.runtime.getState().byId;
      const entry = byId[environmentId]!;
      harness.runtime.setState({
        byId: {
          ...byId,
          [environmentId]: {
            ...entry,
            serverConfig: { ...(entry.serverConfig as ServerConfig), settings: next },
          },
        },
      });
    },
    useSavedEnvironmentRegistryStore: bind(harness.registry),
    useSavedEnvironmentRuntimeStore: bind(harness.runtime),
  };
});

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SettingsEditingScopeProvider, SettingsTargetProvider } from "../../settingsTarget";
import { ProjectPreferenceSettings } from "./ProjectPreferenceSettings";
import { SettingsCard } from "./settingsLayout";

const STUDIO = EnvironmentId.make("studio-node");
const LAPTOP = EnvironmentId.make("laptop-node");

function nodeConfig(environmentId: EnvironmentId, settings: ServerSettings): ServerConfig {
  return {
    environment: {
      environmentId,
      label: environmentId,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true, threadSettlement: false, projectPreferences: true },
    },
    settings,
    providers: [],
  } as unknown as ServerConfig;
}

/** The effective node defaults a node reports for its own settings. */
function effectiveFor(settings: ServerSettings): EffectiveProjectPreferences {
  return {
    overrides: {},
    initialModelSelection: {
      value: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
      source: "builtin",
    },
    defaultThreadEnvMode: { value: settings.defaultThreadEnvMode, source: "node" },
    worktreeBranchPrefix: { value: settings.worktreeBranchPrefix, source: "node" },
    runSetupScript: { value: settings.runSetupScript, source: "node" },
    worktreeRoot: { value: "", source: "builtin" },
  };
}

/**
 * Two saved, connected nodes this client owns. `seen` is each node's config as
 * this client last received it; `actual` is what the node holds now.
 */
function saveNodes(input: {
  readonly studio: ServerSettings;
  readonly laptop: { readonly seen: ServerSettings; readonly actual: ServerSettings };
}) {
  harness.registry.setState({
    byId: {
      [STUDIO]: { environmentId: STUDIO, label: "Studio" },
      [LAPTOP]: { environmentId: LAPTOP, label: "Laptop" },
    },
  });
  harness.runtime.setState({
    byId: {
      [STUDIO]: { role: "owner", serverConfig: nodeConfig(STUDIO, input.studio) },
      [LAPTOP]: { role: "owner", serverConfig: nodeConfig(LAPTOP, input.laptop.seen) },
    },
  });
  harness.nodeSettings.set(STUDIO, input.studio);
  harness.nodeSettings.set(LAPTOP, input.laptop.actual);
  for (const environmentId of [STUDIO, LAPTOP]) {
    recordWsConnectionOpened({ environmentId, recordGlobal: false });
  }
  __setEnvironmentApiOverrideForTests(STUDIO, {
    server: {
      getProjectPreferences: async () =>
        effectiveFor(harness.nodeSettings.get(STUDIO) as ServerSettings),
    },
  } as unknown as EnvironmentApi);
}

function StudioDefaults() {
  const config = harness.runtime.getState().byId[STUDIO]!.serverConfig as ServerConfig;
  return (
    <AppAtomRegistryProvider>
      <SettingsEditingScopeProvider value="node">
        <SettingsTargetProvider
          value={{
            environmentId: STUDIO,
            nodeLabel: "Studio",
            serverConfig: config,
            primary: false,
            connected: true,
            canManage: true,
          }}
        >
          <SettingsCard>
            <ProjectPreferenceSettings projectId="" projects={[]} />
          </SettingsCard>
        </SettingsTargetProvider>
      </SettingsEditingScopeProvider>
    </AppAtomRegistryProvider>
  );
}

const worktree: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" };
const local: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" };

let mounted: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(async () => {
  // A desktop window: the frozen phone tier never offers this.
  await page.viewport(1_280, 900);
  harness.writes = [];
  harness.nodeSettings.clear();
  harness.registry.setState({ byId: {} });
  harness.runtime.setState({ byId: {} });
  resetWsConnectionStateForTests();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  __resetEnvironmentApiOverridesForTests();
  document.body.innerHTML = "";
});

const newThreadsRow = () => page.getByRole("button", { name: "Apply to all nodes: new threads" });

describe("Apply to all nodes", () => {
  it("shows Mixed, and writes each node's own expected value", async () => {
    saveNodes({ studio: worktree, laptop: { seen: local, actual: local } });
    mounted = await render(<StudioDefaults />);

    await expect.element(page.getByTestId("settings-mixed-badge").first()).toBeVisible();
    await expect.element(newThreadsRow()).toBeEnabled();
    await newThreadsRow().click();

    await expect
      .element(page.getByText(/^Applied to /))
      .toHaveTextContent("Applied to Studio, Laptop.");
    expect(harness.writes).toEqual([
      {
        environmentId: STUDIO,
        patch: {
          defaultThreadEnvMode: "worktree",
          expectedNodePreferences: { defaultThreadEnvMode: "worktree" },
        },
      },
      {
        environmentId: LAPTOP,
        patch: {
          defaultThreadEnvMode: "worktree",
          expectedNodePreferences: { defaultThreadEnvMode: "local" },
        },
      },
    ]);
    expect((harness.nodeSettings.get(LAPTOP) as ServerSettings).defaultThreadEnvMode).toBe(
      "worktree",
    );
  });

  it("names the node whose value changed elsewhere and leaves it as it is", async () => {
    // Laptop changed since this client last heard from it.
    saveNodes({ studio: worktree, laptop: { seen: local, actual: worktree } });
    mounted = await render(<StudioDefaults />);

    await expect.element(page.getByTestId("settings-mixed-badge").first()).toBeVisible();
    await newThreadsRow().click();

    await expect
      .element(page.getByText(/^Applied to /))
      .toHaveTextContent(
        "Applied to Studio. Not changed: Laptop (Node preferences changed elsewhere. Reload before saving.).",
      );
    expect(harness.writes.map((write) => write.environmentId)).toEqual([STUDIO, LAPTOP]);
  });

  it("shows nothing to apply with one known node", async () => {
    saveNodes({ studio: worktree, laptop: { seen: local, actual: local } });
    harness.registry.setState({ byId: { [STUDIO]: { environmentId: STUDIO, label: "Studio" } } });
    mounted = await render(<StudioDefaults />);

    await expect
      .element(page.getByRole("combobox", { name: "Default thread mode" }))
      .toHaveTextContent("New worktree");
    await expect.element(newThreadsRow()).not.toBeInTheDocument();
    await expect.element(page.getByTestId("settings-mixed-badge")).not.toBeInTheDocument();
  });
});
