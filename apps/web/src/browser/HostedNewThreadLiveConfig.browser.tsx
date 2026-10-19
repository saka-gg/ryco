import {
  createEnvironmentConnection,
  type EnvironmentConnection,
} from "@ryco/client-runtime/connection";
import type { NodeMutationLease } from "@ryco/client-runtime/authorization/nodeMutationLease";
import type { KnownEnvironment } from "@ryco/client-runtime/knownEnvironment";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type EffectiveProjectPreferences,
  type EnvironmentApi,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@ryco/contracts";
import { scopedProjectKey } from "@ryco/client-runtime/scoped";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const hostedEnvironmentId = EnvironmentId.make("environment-hosted-node");

const harness = {
  connection: null as EnvironmentConnection | null,
  lease: null as NodeMutationLease | null,
  generation: 1,
};

const navigate = vi.fn(async () => undefined);
const router = { state: { matches: [] }, navigate };
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => router,
}));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
  useSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector(DEFAULT_CLIENT_SETTINGS),
  useUpdateSettings: () => vi.fn(),
  updateClientModelFavorites: vi.fn(),
  __resetClientSettingsPersistenceForTests: vi.fn(),
}));
// The hosted-hub build's node lease over a signed-out workspace; every export is
// stubbed so imports resolve. The target's connection is set in beforeEach.
vi.mock("../hostedHub/hostedConnectionCoordinator", () => {
  const signedOut = {
    status: "signed-out",
    accountId: null,
    machines: [],
    workspace: {
      machines: [],
      snapshots: [],
      projects: [],
      worktrees: [],
      threads: [],
      logicalProjects: [],
    },
    homeDiscovery: { environmentId: null, failedEnvironmentIds: [] },
    demand: { demand: null, queuedEnvironmentIds: [], activeConnectionCount: 0 },
  };
  const unavailable = () => {
    throw new Error("Not available in this test.");
  };
  return {
    MAX_HOSTED_WEB_CONNECTIONS: 1,
    HOSTED_WEB_WAKE_STAGGER_MS: 750,
    HOME_DISCOVERY_CACHE_WAIT_MS: 1_500,
    readHostedWorkspaceState: () => signedOut,
    useHostedWorkspaceState: () => signedOut,
    readHostedNodeMutationLease: vi.fn(),
    waitForHostedNodeMutationLease: vi.fn(),
    nodeIdForHostedEnvironment: vi.fn(),
    hasActiveHostedWorkspaceCoordinator: () => false,
    setHostedWorkspaceBackgrounded: async () => undefined,
    isHostedEnvironmentDemanded: () => false,
    requestHostedWorkspaceReconcile: () => undefined,
    retryHostedHomeDiscovery: () => undefined,
    startHostedWorkspaceCoordinator: unavailable,
    createHostedConnectionCoordinator: unavailable,
    hostedNodeRequiresNativeClient: unavailable,
    readHostedDemandReadiness: unavailable,
    hostedDemandUnblocked: unavailable,
    hostedDemandAwaitsPresence: unavailable,
  };
});
vi.mock("../hostedHub/adoptHostedEnvironmentRoute", () => ({
  adoptHostedEnvironmentRoute: () => undefined,
}));
vi.mock("../environments/runtime", { spy: true });

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { toastManager } from "../components/ui/toast";
import { readEnvironmentConnection } from "../environments/runtime";
import {
  nodeIdForHostedEnvironment,
  readHostedNodeMutationLease,
  waitForHostedNodeMutationLease,
} from "../hostedHub/hostedConnectionCoordinator";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resetNewDraftDefaultsCacheForTests } from "../hooks/newDraftDefaults";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetServerStateForTests,
  resetWsConnectionStateForTests,
  setServerConfigSnapshot,
  type WsRpcClient,
} from "../rpc/serverState";
import { useStore } from "../store";

const projectId = ProjectId.make("project-hosted-defaults");

function config(label: string, tokenMode: "off" | "balanced" | "aggressive"): ServerConfig {
  return {
    environment: {
      environmentId: hostedEnvironmentId,
      label,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
        projectPreferences: true,
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "ryco_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultAgentTokenMode: tokenMode },
  };
}

const effective: EffectiveProjectPreferences = {
  initialModelSelection: {
    value: { instanceId: ProviderInstanceId.make("codex"), model: "project-model" },
    source: "project",
  },
  defaultThreadEnvMode: { value: "worktree", source: "project" },
  worktreeBranchPrefix: { value: "tasks", source: "node" },
  runSetupScript: { value: false, source: "project" },
  worktreeRoot: { value: ".worktrees", source: "node" },
  overrides: {},
};

function lease(selectionGeneration: number): NodeMutationLease {
  return {
    environmentId: hostedEnvironmentId,
    selectionGeneration,
    snapshotGeneration: 1,
    effectiveRole: "owner",
    directoryReady: true,
    relayReady: true,
    shellReady: true,
  };
}

/** The hosted primary connection of the current generation, observed like the shell does. */
function connectHostedNode() {
  let emit: (event: ServerConfigStreamEvent) => void = () => undefined;
  const connection = createEnvironmentConnection({
    kind: "primary",
    knownEnvironment: {
      environmentId: hostedEnvironmentId,
      label: "Hosted node",
      source: "hub-hosted",
    } as unknown as KnownEnvironment,
    client: {
      server: {
        subscribeLifecycle: () => () => undefined,
        subscribeConfig: (listener: (event: ServerConfigStreamEvent) => void) => {
          emit = listener;
          return () => undefined;
        },
      },
      orchestration: { subscribeShell: () => () => undefined },
      terminal: { onEvent: () => () => undefined },
      dispose: async () => undefined,
      reconnect: async () => undefined,
    } as unknown as WsRpcClient,
    pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
    resetShellProjection: () => undefined,
    applyShellEvent: () => undefined,
    syncShellSnapshot: () => undefined,
    applyTerminalEvent: () => undefined,
    lifecycleGeneration: {
      generation: harness.generation,
      readCurrent: () => harness.generation,
    },
  });
  connection.config.subscribe(() => undefined);
  recordWsConnectionAttempt("wss://hub.test/relay", {
    environmentId: hostedEnvironmentId,
    recordGlobal: false,
  });
  recordWsConnectionOpened({ environmentId: hostedEnvironmentId, recordGlobal: false });
  harness.connection = connection;
  return {
    connection,
    emitSnapshot: (next: ServerConfig) =>
      emit({ version: 1, type: "snapshot", config: next } as ServerConfigStreamEvent),
  };
}

/** Leaving the node: the owner advances the generation and the lease, synchronously. */
function switchNode() {
  harness.generation += 1;
  harness.lease = lease(harness.generation);
}

function NewDraft() {
  const { handleNewThread } = useNewThreadHandler();
  return (
    <button onClick={() => void handleNewThread({ environmentId: hostedEnvironmentId, projectId })}>
      New draft
    </button>
  );
}

const readDraft = () =>
  useComposerDraftStore
    .getState()
    .getDraftSessionByLogicalProjectKey(
      scopedProjectKey({ environmentId: hostedEnvironmentId, projectId }),
    );

let mounted: Awaited<ReturnType<typeof render>> | null = null;
beforeEach(() => {
  navigate.mockClear();
  harness.generation = 1;
  harness.lease = lease(1);
  harness.connection = null;
  resetWsConnectionStateForTests();
  vi.mocked(readEnvironmentConnection).mockImplementation((environmentId) =>
    harness.connection?.environmentId === environmentId ? harness.connection : null,
  );
  vi.mocked(nodeIdForHostedEnvironment).mockImplementation((environmentId) =>
    environmentId === hostedEnvironmentId ? "node-1" : null,
  );
  vi.mocked(readHostedNodeMutationLease).mockImplementation(() => harness.lease);
  vi.mocked(waitForHostedNodeMutationLease).mockImplementation(async () => harness.lease);
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  // The global cache holds the node the browser was on before: never trusted.
  setServerConfigSnapshot(config("previous node", "off"));
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
  __resetEnvironmentApiOverridesForTests();
  resetNewDraftDefaultsCacheForTests();
});

describe("hosted new draft config", () => {
  it("opens with the connection's current config and no getConfig", async () => {
    connectHostedNode().emitSnapshot(config("current node", "aggressive"));
    const getConfig = vi.fn(async () => config("fresh", "balanced"));
    __setEnvironmentApiOverrideForTests(hostedEnvironmentId, {
      server: { getConfig, getProjectPreferences: async () => effective },
    } as unknown as EnvironmentApi);
    mounted = await render(<NewDraft />);

    await page.getByRole("button", { name: "New draft" }).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(getConfig).not.toHaveBeenCalled();
    expect(readDraft()).toMatchObject({ envMode: "worktree", tokenMode: "aggressive" });
  });

  it("reads the config fresh when the connection's config belongs to an ended generation", async () => {
    connectHostedNode().emitSnapshot(config("ended generation", "aggressive"));
    // The generation moved on (and the selection came back) before the
    // replacement connection delivered anything.
    harness.generation += 1;
    harness.lease = lease(2);
    const getConfig = vi.fn(async () => config("fresh", "balanced"));
    __setEnvironmentApiOverrideForTests(hostedEnvironmentId, {
      server: { getConfig, getProjectPreferences: async () => effective },
    } as unknown as EnvironmentApi);
    mounted = await render(<NewDraft />);

    await page.getByRole("button", { name: "New draft" }).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(getConfig).toHaveBeenCalledOnce();
    expect(readDraft()).toMatchObject({ tokenMode: "balanced" });
  });

  it("never creates a draft from the old node's config when the node switches mid-draft", async () => {
    connectHostedNode().emitSnapshot(config("node A", "aggressive"));
    let answer!: (value: EffectiveProjectPreferences) => void;
    const getConfig = vi.fn(async () => config("fresh", "balanced"));
    __setEnvironmentApiOverrideForTests(hostedEnvironmentId, {
      server: {
        getConfig,
        getProjectPreferences: () => new Promise((resolve) => (answer = resolve)),
      },
    } as unknown as EnvironmentApi);
    const toast = vi.spyOn(toastManager, "add");
    mounted = await render(<NewDraft />);

    await page.getByRole("button", { name: "New draft" }).click();
    await vi.waitFor(() => expect(answer).toBeDefined());
    switchNode();
    answer(effective);

    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "The workspace connection changed. Try creating the draft again.",
        }),
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(readDraft()).toBeNull();
  });

  it("drops the node's background answer once the hosted session that asked has ended", async () => {
    connectHostedNode().emitSnapshot(config("node A", "aggressive"));
    let answer: Promise<EffectiveProjectPreferences> = Promise.resolve(effective);
    __setEnvironmentApiOverrideForTests(hostedEnvironmentId, {
      server: { getConfig: vi.fn(), getProjectPreferences: () => answer },
    } as unknown as EnvironmentApi);
    mounted = await render(<NewDraft />);
    await page.getByRole("button", { name: "New draft" }).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });

    // The repeat draft opens at once with the remembered answer.
    let resolveAnswer!: (value: EffectiveProjectPreferences) => void;
    answer = new Promise((resolve) => (resolveAnswer = resolve));
    await page.getByRole("button", { name: "New draft" }).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    expect(readDraft()).toMatchObject({ envMode: "worktree" });

    switchNode();
    resolveAnswer({ ...effective, defaultThreadEnvMode: { value: "local", source: "project" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readDraft()).toMatchObject({ envMode: "worktree" });
  });
});
