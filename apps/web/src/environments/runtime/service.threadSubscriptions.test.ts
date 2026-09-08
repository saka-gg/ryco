import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn();
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockGetPrimaryKnownEnvironment = vi.hoisted(() => vi.fn());
const mockFetchRemoteSessionState = vi.fn();
const mockConnectionReconnects: Array<ReturnType<typeof vi.fn>> = [];
let savedEnvironmentRegistryListener: (() => void) | null = null;

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: mockGetPrimaryKnownEnvironment,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: vi.fn(),
  fetchRemoteEnvironmentDescriptor: vi.fn(),
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: vi.fn(() => false),
  resolveRemoteWebSocketConnectionUrl: vi.fn(async () => "ws://remote.example.test/ws"),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
      rename: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: mockCreateWsRpcClient,
}));

vi.mock("../../rpc/wsTransport", () => ({
  DeviceWsTransport: MockWsTransport,
  HostedWsTransport: MockWsTransport,
  WsTransport: MockWsTransport,
}));

function makeThreadShellSnapshot(params: {
  readonly threadId: ThreadId;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
}): OrchestrationShellSnapshot {
  const projectId = ProjectId.make("project-1");
  const turnId = TurnId.make("turn-1");

  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [
      {
        id: params.threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn:
          params.sessionStatus === "running"
            ? {
                turnId,
                state: "running",
                requestedAt: "2026-04-13T00:00:00.000Z",
                startedAt: "2026-04-13T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: params.sessionStatus
          ? {
              threadId: params.threadId,
              status: params.sessionStatus,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: params.sessionStatus === "running" ? turnId : null,
              lastError: null,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
        latestUserMessageAt: null,
        hasPendingApprovals: params.hasPendingApprovals ?? false,
        hasPendingUserInput: params.hasPendingUserInput ?? false,
        hasActionableProposedPlan: params.hasActionableProposedPlan ?? false,
      },
    ],
  };
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
      environmentId: EnvironmentId.make("env-1"),
    });

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockCreateWsRpcClient.mockReturnValue({
      isHeartbeatFresh: vi.fn(() => false),
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: {
              repositoryIdentity: true,
              threadSettlement: false,
              threadPriorityRanking: false,
            },
          },
        })),
      },
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      const reconnect = vi.fn(async () => undefined);
      mockConnectionReconnects.push(reconnect);
      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect,
        dispose: vi.fn(async () => undefined),
      };
    });
    savedEnvironmentRegistryListener = null;
    mockSavedEnvironmentRegistrySubscribe.mockImplementation((listener: () => void) => {
      savedEnvironmentRegistryListener = listener;
      return () => {
        if (savedEnvironmentRegistryListener === listener) {
          savedEnvironmentRegistryListener = null;
        }
      };
    });
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
    mockGetSavedEnvironmentRecord.mockReturnValue(null);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockFetchRemoteSessionState.mockResolvedValue({
      authenticated: true,
      role: "client",
    });
    mockConnectionReconnects.length = 0;
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps thread detail subscriptions warm across releases until idle eviction", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService();
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("releases an idle speculative thread detail subscription immediately when requested", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService();
    const release = retainThreadDetailSubscription(
      EnvironmentId.make("env-1"),
      ThreadId.make("thread-speculative"),
    );

    release({ immediately: true });

    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("ignores an immediate release from a disposed subscription generation", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      removeSavedEnvironment,
      getPrimaryEnvironmentConnection,
    } = await import("./service");
    const stop = startEnvironmentConnectionService();
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-recreated");
    const releaseOld = retainThreadDetailSubscription(environmentId, threadId);

    await removeSavedEnvironment(environmentId);
    getPrimaryEnvironmentConnection();
    const releaseCurrent = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    mockThreadUnsubscribe.mockClear();

    releaseOld({ immediately: true });
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();
    releaseCurrent({ immediately: true });
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not dispose an active thread detail retain when speculative demand is released", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService();
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active-and-speculative");
    const releaseActive = retainThreadDetailSubscription(environmentId, threadId);
    const releaseSpeculative = retainThreadDetailSubscription(environmentId, threadId);

    releaseSpeculative({ immediately: true });

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    releaseActive();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not start the primary connection until the known environment has an id", async () => {
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
    });
    const {
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService();

    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
    expect(listEnvironmentConnections()).toEqual([]);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("returns the same registered primary connection before the service starts", async () => {
    const {
      getPrimaryEnvironmentConnection,
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const first = getPrimaryEnvironmentConnection();
    const second = getPrimaryEnvironmentConnection();

    expect(second).toBe(first);
    expect(listEnvironmentConnections()).toEqual([first]);
    expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(1);

    await resetEnvironmentServiceForTests();
  });

  it("evicts only to capacity and does not reschedule sibling idle timers on thread upsert", async () => {
    const {
      retainThreadDetailSubscription,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");
    const stop = startEnvironmentConnectionService();
    const environmentId = EnvironmentId.make("env-1");
    const threadIds = Array.from({ length: 33 }, (_, index) =>
      ThreadId.make(`thread-capacity-${index}`),
    );
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    for (const threadId of threadIds) {
      retainThreadDetailSubscription(environmentId, threadId)();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    const targetThreadId = threadIds.at(-1)!;
    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 1,
        thread: makeThreadShellSnapshot({ threadId: targetThreadId }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(32);

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(33);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("drops shell snapshots after browser suspension invalidates the hosted generation", async () => {
    vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
    const { hostedHubController, useHostedHubStore } = await import("~/hostedHub/state");
    const { useStore } = await import("~/store");
    useHostedHubStore.setState({ accountStatus: "authenticated", generation: 7 });
    const syncServerShellSnapshot = vi.spyOn(useStore.getState(), "syncServerShellSnapshot");
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    const stop = startEnvironmentConnectionService();
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    const environmentId = EnvironmentId.make("env-1");
    const currentSnapshot = makeThreadShellSnapshot({ threadId: ThreadId.make("thread-current") });
    const staleSnapshot = makeThreadShellSnapshot({ threadId: ThreadId.make("thread-stale") });
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(currentSnapshot, environmentId);
    expect(syncServerShellSnapshot).toHaveBeenCalledOnce();

    hostedHubController.suspendBrowser("hidden");
    expect(useHostedHubStore.getState().generation).toBe(8);
    connectionInput.syncShellSnapshot(staleSnapshot, environmentId);
    expect(syncServerShellSnapshot).toHaveBeenCalledOnce();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("accepts a restarted node's lower shell sequence after the stream resubscribes", async () => {
    const { useStore } = await import("~/store");
    const syncServerShellSnapshot = vi.spyOn(useStore.getState(), "syncServerShellSnapshot");
    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    const stop = startEnvironmentConnectionService();
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    const environmentId = EnvironmentId.make("env-1");
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({ threadId: ThreadId.make("thread-before-restart") }),
        snapshotSequence: 50,
      },
      environmentId,
    );
    expect(syncServerShellSnapshot).toHaveBeenCalledOnce();

    connectionInput.resetShellProjection(environmentId);
    connectionInput.syncShellSnapshot(
      {
        ...makeThreadShellSnapshot({ threadId: ThreadId.make("thread-after-restart") }),
        snapshotSequence: 1,
      },
      environmentId,
    );

    expect(syncServerShellSnapshot).toHaveBeenCalledTimes(2);
    expect(syncServerShellSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshotSequence: 1,
        threads: [expect.objectContaining({ id: "thread-after-restart" })],
      }),
      environmentId,
    );

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService();
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
        hasPendingApprovals: true,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reattaches retained thread detail subscriptions after a saved environment reconnect replaces the client", async () => {
    const environmentId = EnvironmentId.make("env-remote");
    const threadId = ThreadId.make("thread-reconnect");
    const record = {
      environmentId,
      label: "Remote env",
      httpBaseUrl: "http://remote.example.test",
      wsBaseUrl: "ws://remote.example.test",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-01T00:00:00.000Z",
    };
    mockListSavedEnvironmentRecords.mockReturnValue([record]);
    mockGetSavedEnvironmentRecord.mockReturnValue(record);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");

    const {
      disconnectSavedEnvironment,
      listEnvironmentConnections,
      reconnectSavedEnvironment,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService();
    savedEnvironmentRegistryListener?.();
    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(2);
      expect(
        listEnvironmentConnections().some(
          (connection) => connection.environmentId === environmentId,
        ),
      ).toBe(true);
    });

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await disconnectSavedEnvironment(environmentId);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(
      listEnvironmentConnections().some((connection) => connection.environmentId === environmentId),
    ).toBe(false);

    const reconnectPromise = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(200);
    await reconnectPromise;
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(3);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects environment streams when the browser resumes from the background", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService();
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("leaves browser resume reconnects to the hosted lifecycle owner", async () => {
    vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService();
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));

    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("skips reconnecting healthy environment streams when the browser resumes", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValueOnce({
      isHeartbeatFresh: vi.fn(() => true),
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: {
              repositoryIdentity: true,
              threadSettlement: false,
              threadPriorityRanking: false,
            },
          },
        })),
      },
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService();
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("allows a larger idle cache before capacity eviction starts", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService();
    const environmentId = EnvironmentId.make("env-1");

    for (let index = 0; index < 12; index += 1) {
      const release = retainThreadDetailSubscription(
        environmentId,
        ThreadId.make(`thread-${index + 1}`),
      );
      release();
    }

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("disposes cached thread detail subscriptions when the environment service resets", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService();
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    release();

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
  });
});
