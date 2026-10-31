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
    const { getSavedEnvironmentRuntimeState } = await import("./catalog");
    const { SavedEnvironmentSwitchedOffError } = await import("@ryco/client-runtime/connection");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(savedConnections()).toHaveLength(0);

    // Refused, and never shown connecting: a chat's Reconnect would otherwise
    // report success and leave the machine "connecting" for good.
    await expect(service.reconnectSavedEnvironment(environmentId)).rejects.toBeInstanceOf(
      SavedEnvironmentSwitchedOffError,
    );
    expect(getSavedEnvironmentRuntimeState(environmentId).connectionState).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getSavedEnvironmentRuntimeState(environmentId).connectionState).toBe("disconnected");
    expect(savedConnections()).toHaveLength(0);
    expect(mockFetchRemoteSessionState).not.toHaveBeenCalled();
    stop();
  });

  it("tells a Reconnect that the machine was switched off while it connected", async () => {
    let answerSession: (value: unknown) => void = () => undefined;
    mockFetchRemoteSessionState.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerSession = resolve;
        }),
    );
    const service = await import("./service");
    const { setSavedEnvironmentEnabled } = await import("./savedEnvironmentSwitch");
    const { getSavedEnvironmentRuntimeState } = await import("./catalog");
    const { SavedEnvironmentSwitchedOffError } = await import("@ryco/client-runtime/connection");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(0);
    const reconnect = service.reconnectSavedEnvironment(environmentId);
    const outcome = reconnect.then(
      () => "reconnected",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);

    await setSavedEnvironmentEnabled(environmentId, false);
    answerSession({ authenticated: true, role: "owner" });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await outcome).toBeInstanceOf(SavedEnvironmentSwitchedOffError);
    expect(getSavedEnvironmentRuntimeState(environmentId).connectionState).toBe("disconnected");
    expect(savedConnections()).toHaveLength(0);
    stop();
  });
});

describe("switching an SSH machine off", () => {
  const sshTarget = {
    alias: "devbox",
    hostname: "devbox.example.test",
    username: "julius",
    port: 22,
  };
  const sshRecord: PersistedSavedEnvironmentRecord = {
    ...savedRecord,
    httpBaseUrl: "http://127.0.0.1:3774/",
    wsBaseUrl: "ws://127.0.0.1:3774/",
    desktopSsh: sshTarget,
  };
  // Each new tunnel listens on a new local port.
  const tunnelOnPort = (port: number, pairingToken: string | null = null) => ({
    target: sshTarget,
    httpBaseUrl: `http://127.0.0.1:${port}/`,
    wsBaseUrl: `ws://127.0.0.1:${port}/`,
    pairingToken,
    remotePort: 3773,
    remoteServerKind: "managed" as const,
  });
  const bridge = {
    ensureSshEnvironment: vi.fn(),
    disconnectSshEnvironment: vi.fn(),
    fetchSshEnvironmentDescriptor: vi.fn(),
    bootstrapSshBearerSession: vi.fn(),
    fetchSshSessionState: vi.fn(),
    issueSshWebSocketToken: vi.fn(),
  };

  // The SSH connect code loads on first use; loaded up front, its import does
  // not race the fake clock.
  async function loadService() {
    const service = await import("./service");
    await import("./desktopSshConnection");
    return service;
  }

  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    persisted.registry = [{ ...sshRecord }];
    persisted.secrets = new Map([[environmentId, "ssh-bearer-token"]]);
    vi.stubGlobal("window", {
      desktopBridge: bridge,
      location: { origin: "http://localhost:5733" },
    });
    bridge.ensureSshEnvironment.mockResolvedValue(tunnelOnPort(3774));
    bridge.disconnectSshEnvironment.mockResolvedValue(undefined);
    bridge.bootstrapSshBearerSession.mockResolvedValue({
      sessionToken: "ssh-bearer-token-2",
      role: "owner",
    });
    bridge.fetchSshSessionState.mockResolvedValue({ authenticated: true, role: "owner" });
    bridge.issueSshWebSocketToken.mockResolvedValue({ token: "ws-token" });
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("stays off when the tunnel a connect was waiting for comes up on a new port", async () => {
    const tunnel = deferred<ReturnType<typeof tunnelOnPort>>();
    bridge.ensureSshEnvironment.mockResolvedValue(tunnelOnPort(3775, "ssh-pairing-code"));
    bridge.ensureSshEnvironment.mockReturnValueOnce(tunnel.promise);
    const service = await loadService();
    const { setSavedEnvironmentEnabled } = await import("./savedEnvironmentSwitch");
    const { getSavedEnvironmentRecord } = await import("./catalog");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.ensureSshEnvironment).toHaveBeenCalledTimes(1);

    await setSavedEnvironmentEnabled(environmentId, false);
    expect(bridge.disconnectSshEnvironment).toHaveBeenCalledTimes(1);
    // The desktop's disconnect only fails the callers waiting for the tunnel;
    // the one building it gets it.
    tunnel.resolve(tunnelOnPort(3775));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(getSavedEnvironmentRecord(environmentId)).toEqual(
      expect.objectContaining({
        disabledAt: expect.any(String),
        httpBaseUrl: "http://127.0.0.1:3774/",
      }),
    );
    expect(persisted.registry).toEqual([
      expect.objectContaining({ environmentId, disabledAt: expect.any(String) }),
    ]);
    expect(bridge.ensureSshEnvironment).toHaveBeenCalledTimes(1);
    expect(savedConnections()).toHaveLength(0);
    // The tunnel that came up anyway is taken down again.
    expect(bridge.disconnectSshEnvironment).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps a rename made while a connect waited for its tunnel", async () => {
    const tunnel = deferred<ReturnType<typeof tunnelOnPort>>();
    bridge.ensureSshEnvironment.mockReturnValueOnce(tunnel.promise);
    // The connect stops at its session check: a connected node would rename
    // the record to its own name.
    bridge.fetchSshSessionState.mockReturnValue(new Promise(() => undefined));
    const service = await loadService();
    const { getSavedEnvironmentRecord, useSavedEnvironmentRegistryStore } =
      await import("./catalog");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(0);

    useSavedEnvironmentRegistryStore.getState().rename(environmentId, "Devbox");
    tunnel.resolve(tunnelOnPort(3775));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(getSavedEnvironmentRecord(environmentId)).toEqual(
      expect.objectContaining({ label: "Devbox", httpBaseUrl: "http://127.0.0.1:3775/" }),
    );
    expect(persisted.registry).toEqual([
      expect.objectContaining({ label: "Devbox", httpBaseUrl: "http://127.0.0.1:3775/" }),
    ]);
    stop();
  });

  it("stays off when the bearer a connect was issuing fails after the switch-off", async () => {
    // No stored bearer: the connect issues one through a new tunnel first.
    persisted.secrets = new Map();
    bridge.ensureSshEnvironment.mockResolvedValue(tunnelOnPort(3775, "ssh-pairing-code"));
    const issue = deferred<{ sessionToken: string; role: string }>();
    bridge.bootstrapSshBearerSession.mockReturnValueOnce(issue.promise);
    const service = await loadService();
    const { setSavedEnvironmentEnabled } = await import("./savedEnvironmentSwitch");
    const { getSavedEnvironmentRecord } = await import("./catalog");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.bootstrapSshBearerSession).toHaveBeenCalledTimes(1);

    await setSavedEnvironmentEnabled(environmentId, false);
    // A failed issue rolls the address back; it must not write back the record
    // as it was before the switch-off.
    issue.reject(new Error("tunnel closed"));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(getSavedEnvironmentRecord(environmentId)?.disabledAt).toEqual(expect.any(String));
    expect(persisted.registry).toEqual([
      expect.objectContaining({ environmentId, disabledAt: expect.any(String) }),
    ]);
    expect(bridge.ensureSshEnvironment).toHaveBeenCalledTimes(1);
    expect(savedConnections()).toHaveLength(0);
    stop();
  });

  it("ends this client's session first, even when the machine cannot be reached over SSH", async () => {
    const service = await loadService();
    const { setSavedEnvironmentEnabled } = await import("./savedEnvironmentSwitch");
    const { getSavedEnvironmentRecord } = await import("./catalog");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(service.readEnvironmentConnection(environmentId)).not.toBeNull();
    // With no tunnel up, the desktop SSHes in to stop the remote server: on a
    // machine out of reach that waits for a timeout, then fails.
    const sshDisconnect = deferred<undefined>();
    bridge.disconnectSshEnvironment.mockReturnValueOnce(sshDisconnect.promise);

    const switching = setSavedEnvironmentEnabled(environmentId, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.readEnvironmentConnection(environmentId)).toBeNull();
    expect(mockRemoveEnvironmentState).toHaveBeenCalledWith(environmentId);

    sshDisconnect.reject(new Error("ssh: connect to host devbox port 22: Operation timed out"));
    await expect(switching).resolves.toBeUndefined();
    expect(getSavedEnvironmentRecord(environmentId)?.disabledAt).toEqual(expect.any(String));
    // Switching on issues a fresh SSH bearer through the next tunnel.
    expect(persisted.secrets.has(environmentId)).toBe(false);
    stop();
  });

  it("removes a machine that cannot be reached over SSH", async () => {
    const service = await loadService();
    const { getSavedEnvironmentRecord } = await import("./catalog");
    const stop = service.startEnvironmentConnectionService();
    await vi.advanceTimersByTimeAsync(3_000);
    bridge.disconnectSshEnvironment.mockRejectedValueOnce(
      new Error("ssh: connect to host devbox port 22: Operation timed out"),
    );

    await expect(service.removeSavedEnvironment(environmentId)).resolves.toBeUndefined();
    expect(getSavedEnvironmentRecord(environmentId)).toBeNull();
    expect(mockRemoveEnvironmentState).toHaveBeenCalledWith(environmentId);
    expect(mockClearProjectIconCache).toHaveBeenCalledWith(environmentId);
    stop();
  });
});
