import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The real saved-environment catalog and supervisor run here; only the
// storage behind them, the node's HTTP API and the sockets are faked.
const persisted = vi.hoisted(() => ({
  registry: [] as Array<Record<string, unknown>>,
  secrets: new Map<string, string>(),
}));
const mockSetSavedEnvironmentRegistry = vi.fn(async (records: Array<Record<string, unknown>>) => {
  persisted.registry = records;
});
const mockRemoveSavedEnvironmentSecret = vi.fn(async (environmentId: string) => {
  persisted.secrets.delete(environmentId);
});
const mockClearProjectIconCache = vi.fn();
const mockRemoveEnvironmentState = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockFetchRemoteSessionState = vi.fn();

function MockWsTransport() {
  return undefined;
}

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getSavedEnvironmentRegistry: async () => persisted.registry,
      setSavedEnvironmentRegistry: mockSetSavedEnvironmentRegistry,
      getSavedEnvironmentSecret: async (environmentId: string) =>
        persisted.secrets.get(environmentId) ?? null,
      setSavedEnvironmentSecret: async (environmentId: string, secret: string) => {
        persisted.secrets.set(environmentId, secret);
        return true;
      },
      removeSavedEnvironmentSecret: mockRemoveSavedEnvironmentSecret,
    },
  }),
}));

vi.mock("@ryco/client-runtime/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/client-runtime/connection")>()),
  clearProjectIconCache: mockClearProjectIconCache,
}));

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: vi.fn(() => null),
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: vi.fn(),
  fetchRemoteEnvironmentDescriptor: vi.fn(),
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: vi.fn(() => false),
  resolveRemoteWebSocketConnectionUrl: vi.fn(async () => "wss://remote.example.test/"),
  rotateRemoteBearerSession: vi.fn(),
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: vi.fn(() => ({
    dispose: vi.fn(async () => undefined),
    isHeartbeatFresh: vi.fn(() => false),
    server: { getConfig: vi.fn(async () => undefined) },
    orchestration: { subscribeThread: vi.fn(() => () => undefined) },
  })),
}));

vi.mock("../../rpc/wsTransport", () => ({
  DeviceWsTransport: MockWsTransport,
  HostedWsTransport: MockWsTransport,
  WsTransport: MockWsTransport,
}));

vi.mock("~/store", () => ({
  useStore: {
    getState: () => ({
      syncServerShellSnapshot: vi.fn(),
      syncServerThreadDetail: vi.fn(),
      removeServerThreadDetail: vi.fn(),
      applyServerShellEvent: vi.fn(),
      removeEnvironmentState: mockRemoveEnvironmentState,
    }),
  },
  selectProjectsAcrossEnvironments: vi.fn(() => []),
  selectSidebarThreadSummaryByRef: vi.fn(() => null),
  selectThreadByRef: vi.fn(() => null),
  selectThreadsAcrossEnvironments: vi.fn(() => []),
}));

const environmentId = EnvironmentId.make("env-saved");
const savedRecord: PersistedSavedEnvironmentRecord = {
  environmentId,
  label: "Studio Mac",
  httpBaseUrl: "https://studio.example.test/",
  wsBaseUrl: "wss://studio.example.test/",
  createdAt: "2026-10-24T00:00:00.000Z",
  lastConnectedAt: null,
};
const configSnapshot = { environment: { environmentId, label: "Studio Mac" } };

function savedConnections() {
  return mockCreateEnvironmentConnection.mock.results
    .map((result) => result.value as { kind: string; dispose: ReturnType<typeof vi.fn> })
    .filter((connection) => connection.kind === "saved");
}

describe("switching a saved machine off and on", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    persisted.registry = [{ ...savedRecord }];
    persisted.secrets = new Map([[environmentId, "saved-bearer-token"]]);
    mockFetchRemoteSessionState.mockResolvedValue({ authenticated: true, role: "owner" });
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      if (input.kind === "saved") {
        queueMicrotask(() => input.onConfigUpdated?.(configSnapshot, "snapshot"));
      }
      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      };
    });
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    const { resetSavedEnvironmentRegistryStoreForTests } = await import("./catalog");
    resetSavedEnvironmentRegistryStoreForTests();
    vi.useRealTimers();
  });

  it("ends a connected machine's session but keeps its record, credential and artwork", async () => {
    const service = await import("./service");
    const { setSavedEnvironmentEnabled } = await import("./savedEnvironmentSwitch");
    const { getSavedEnvironmentRecord } = await import("./catalog");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(savedConnections()).toHaveLength(1);
    expect(service.readEnvironmentConnection(environmentId)).not.toBeNull();

    await setSavedEnvironmentEnabled(environmentId, false);

    expect(service.readEnvironmentConnection(environmentId)).toBeNull();
    expect(savedConnections()[0]?.dispose).toHaveBeenCalled();
    expect(mockRemoveEnvironmentState).toHaveBeenCalledWith(environmentId);
    expect(getSavedEnvironmentRecord(environmentId)?.disabledAt).toEqual(expect.any(String));
    expect(persisted.registry).toEqual([
      expect.objectContaining({ environmentId, disabledAt: expect.any(String) }),
    ]);
    expect(mockRemoveSavedEnvironmentSecret).not.toHaveBeenCalled();
    expect(persisted.secrets.get(environmentId)).toBe("saved-bearer-token");
    expect(mockClearProjectIconCache).not.toHaveBeenCalled();

    // Later syncs and retry ticks leave it off.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(savedConnections()).toHaveLength(1);
    stop();
  });

  it("connects it again with its saved credential once it is switched on", async () => {
    const service = await import("./service");
    const { setSavedEnvironmentEnabled } = await import("./savedEnvironmentSwitch");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(3_000);
    await setSavedEnvironmentEnabled(environmentId, false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(savedConnections()).toHaveLength(1);

    await setSavedEnvironmentEnabled(environmentId, true);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(savedConnections()).toHaveLength(2);
    expect(service.readEnvironmentConnection(environmentId)).not.toBeNull();
    expect(persisted.registry).toEqual([
      expect.not.objectContaining({ disabledAt: expect.anything() }),
    ]);
    stop();
  });

  it("leaves a machine switched off before launch unconnected, even on an explicit connect", async () => {
    persisted.registry = [{ ...savedRecord, disabledAt: "2026-10-31T09:00:00.000Z" }];
    const service = await import("./service");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(savedConnections()).toHaveLength(0);

    await service.reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(savedConnections()).toHaveLength(0);
    expect(mockFetchRemoteSessionState).not.toHaveBeenCalled();
    stop();
  });
});
