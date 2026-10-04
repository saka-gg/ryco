import type { WsProtocolLifecycleHandlers } from "@ryco/client-runtime/rpc";
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let mockSavedRecords: Array<Record<string, unknown>> = [];

type SessionStateSettlers = {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: unknown) => void;
};

const mockResolveRemotePairingTarget = vi.fn();
const mockFetchRemoteEnvironmentDescriptor = vi.fn();
const mockBootstrapRemoteBearerSession = vi.fn();
const mockFetchRemoteSessionState = vi.fn();
const mockIsRemoteEnvironmentAuthHttpError = vi.fn((_: unknown) => false);
const mockResolveRemoteWebSocketConnectionUrl = vi.fn();
const mockRotateRemoteBearerSession = vi.fn();
const mockBootstrapSshBearerSession = vi.fn();
const mockFetchSshSessionState = vi.fn();
const mockPersistSavedEnvironmentRecord = vi.fn();
const mockWriteSavedEnvironmentBearerToken = vi.fn();
const mockSetSavedEnvironmentRegistry = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn((environmentId: EnvironmentId) => {
  return mockSavedRecords.find((record) => record.environmentId === environmentId) ?? null;
});
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockRemoveSavedEnvironmentBearerToken = vi.fn();
const mockPatchRuntime = vi.fn();
const mockClearRuntime = vi.fn();
const mockRegistrySetState = vi.fn((next: { byId: Record<string, Record<string, unknown>> }) => {
  mockSavedRecords = Object.values(next.byId);
});
const mockRemove = vi.fn((environmentId: EnvironmentId) => {
  mockSavedRecords = mockSavedRecords.filter((record) => record.environmentId !== environmentId);
});
const mockMarkConnected = vi.fn((environmentId: EnvironmentId, connectedAt: string) => {
  mockSavedRecords = mockSavedRecords.map((record) =>
    record.environmentId === environmentId ? { ...record, lastConnectedAt: connectedAt } : record,
  );
});
const mockRename = vi.fn((environmentId: EnvironmentId, label: string) => {
  mockSavedRecords = mockSavedRecords.map((record) =>
    record.environmentId === environmentId ? { ...record, label } : record,
  );
});
const mockUpsert = vi.fn((record: Record<string, unknown>) => {
  mockSavedRecords = [
    ...mockSavedRecords.filter((entry) => entry.environmentId !== record.environmentId),
    record,
  ];
});
const mockListSavedEnvironmentRecords = vi.fn(() => mockSavedRecords);
const mockEnsureSshEnvironment = vi.fn();
const mockDisconnectSshEnvironment = vi.fn();
const mockFetchSshEnvironmentDescriptor = vi.fn();
const mockToPersistedSavedEnvironmentRecord = vi.fn((record) => record);
const mockCreateEnvironmentConnection = vi.fn();
const mockWsTransport = vi.fn();
const mockDeviceWsTransport = vi.fn();
const mockClientGetConfig = vi.fn(async () => ({
  environment: {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Remote environment",
  },
}));

vi.mock("../remote/target", () => ({
  resolveRemotePairingTarget: mockResolveRemotePairingTarget,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: mockBootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: mockIsRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl: mockResolveRemoteWebSocketConnectionUrl,
  rotateRemoteBearerSession: mockRotateRemoteBearerSession,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setSavedEnvironmentRegistry: mockSetSavedEnvironmentRegistry,
    },
  }),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: mockPersistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: mockRemoveSavedEnvironmentBearerToken,
  toPersistedSavedEnvironmentRecord: mockToPersistedSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore: {
    getState: () => ({
      upsert: mockUpsert,
      remove: mockRemove,
      markConnected: mockMarkConnected,
      rename: mockRename,
    }),
    setState: mockRegistrySetState,
    subscribe: vi.fn(() => () => {}),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      byId: {},
      ensure: vi.fn(),
      patch: mockPatchRuntime,
      clear: mockClearRuntime,
    }),
  },
  waitForSavedEnvironmentRegistryHydration: vi.fn(),
  writeSavedEnvironmentBearerToken: mockWriteSavedEnvironmentBearerToken,
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: vi.fn(() => ({
    isHeartbeatFresh: vi.fn(() => false),
    server: {
      getConfig: mockClientGetConfig,
    },
    orchestration: {
      subscribeThread: vi.fn(() => () => {}),
    },
  })),
}));

vi.mock("../../rpc/wsTransport", () => ({
  DeviceWsTransport: mockDeviceWsTransport,
  HostedWsTransport: vi.fn(),
  WsTransport: mockWsTransport,
}));

describe("addSavedEnvironment", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSavedRecords = [];
    vi.stubGlobal("window", {
      desktopBridge: {
        ensureSshEnvironment: mockEnsureSshEnvironment,
        disconnectSshEnvironment: mockDisconnectSshEnvironment,
        fetchSshEnvironmentDescriptor: mockFetchSshEnvironmentDescriptor,
        bootstrapSshBearerSession: mockBootstrapSshBearerSession,
        fetchSshSessionState: mockFetchSshSessionState,
        issueSshWebSocketToken: vi.fn(),
      },
    });
    mockResolveRemotePairingTarget.mockImplementation(
      (input: { host?: string; pairingCode?: string }) => ({
        httpBaseUrl: input.host
          ? input.host.endsWith("/")
            ? input.host
            : `${input.host}/`
          : "https://remote.example.com/",
        wsBaseUrl: input.host
          ? input.host.replace(/^http/u, "ws").endsWith("/")
            ? input.host.replace(/^http/u, "ws")
            : `${input.host.replace(/^http/u, "ws")}/`
          : "wss://remote.example.com/",
        credential: input.pairingCode ?? "pairing-code",
      }),
    );
    mockFetchRemoteEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Remote environment",
    });
    mockBootstrapRemoteBearerSession.mockResolvedValue({
      sessionToken: "bearer-token",
      role: "owner",
    });
    mockFetchRemoteSessionState.mockResolvedValue({
      authenticated: true,
      role: "owner",
    });
    mockIsRemoteEnvironmentAuthHttpError.mockReturnValue(false);
    mockResolveRemoteWebSocketConnectionUrl.mockResolvedValue(
      "wss://remote.example.com/?wsToken=remote-token",
    );
    mockFetchSshEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Remote environment",
    });
    mockBootstrapSshBearerSession.mockResolvedValue({
      sessionToken: "ssh-bearer-token",
      role: "owner",
    });
    mockPersistSavedEnvironmentRecord.mockResolvedValue(undefined);
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(false);
    mockSetSavedEnvironmentRegistry.mockResolvedValue(undefined);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockRemoveSavedEnvironmentBearerToken.mockResolvedValue(undefined);
    mockFetchSshSessionState.mockResolvedValue({
      authenticated: true,
      role: "owner",
    });
    mockCreateEnvironmentConnection.mockImplementation(
      (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => ({
        kind: "saved",
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: async () => undefined,
        reconnect: async () => undefined,
        dispose: async () => undefined,
      }),
    );
    mockClientGetConfig.mockResolvedValue({
      environment: {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
      },
    });
    mockEnsureSshEnvironment.mockResolvedValue({
      target: {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
      },
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      pairingToken: "ssh-pairing-code",
    });
    mockDisconnectSshEnvironment.mockResolvedValue(undefined);
  });

  it("rolls back persisted metadata when bearer token persistence fails", async () => {
    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");

    expect(mockPersistSavedEnvironmentRecord).toHaveBeenCalledTimes(1);
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "bearer-token",
    );
    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([]);
    expect(mockUpsert).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  }, 15_000);

  it("restores unrelated saved environments when credential persistence rollback runs", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-existing"),
        label: "Existing environment",
        httpBaseUrl: "https://existing.example.com/",
        wsBaseUrl: "wss://existing.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];

    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");

    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([
      expect.objectContaining({
        environmentId: EnvironmentId.make("environment-existing"),
      }),
    ]);

    await resetEnvironmentServiceForTests();
  });

  it("persists the server label after saved environment metadata refresh", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockClientGetConfig.mockResolvedValue({
      environment: {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Julius's Mac mini",
      },
    });

    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "100.65.180.100",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).resolves.toMatchObject({
      environmentId: EnvironmentId.make("environment-1"),
    });

    expect(mockRename).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "Julius's Mac mini",
    );
    expect(mockSavedRecords).toEqual([
      expect.objectContaining({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Julius's Mac mini",
      }),
    ]);

    await resetEnvironmentServiceForTests();
  });

  it("removes an older ssh record when the same target returns a new environment id", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockFetchSshEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Remote environment",
    });
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Old ssh environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      },
    ];

    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "http://127.0.0.1:3774/",
        pairingCode: "ssh-pairing-code",
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      }),
    ).resolves.toMatchObject({
      environmentId: EnvironmentId.make("environment-2"),
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: EnvironmentId.make("environment-2"),
      }),
    );
    expect(mockRemove).toHaveBeenCalledWith(EnvironmentId.make("environment-1"));
    expect(mockRemoveSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
    );

    await resetEnvironmentServiceForTests();
  });

  it("retries desktop ssh session refresh when the forwarded endpoint returns ssh_http 401", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockBootstrapSshBearerSession
      .mockResolvedValueOnce({
        sessionToken: "ssh-bearer-token",
        role: "owner",
      })
      .mockResolvedValueOnce({
        sessionToken: "ssh-bearer-token-2",
        role: "owner",
      });
    mockFetchSshSessionState
      .mockRejectedValueOnce(new Error("[ssh_http:401] Unauthorized"))
      .mockResolvedValueOnce({
        authenticated: true,
        role: "owner",
      });

    const { connectDesktopSshEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(
      connectDesktopSshEnvironment({
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      }),
    ).resolves.toMatchObject({
      environmentId: EnvironmentId.make("environment-1"),
    });

    expect(mockEnsureSshEnvironment).toHaveBeenCalled();
    expect(mockBootstrapSshBearerSession).toHaveBeenCalledTimes(2);
    expect(mockFetchSshSessionState).toHaveBeenCalledTimes(2);

    await resetEnvironmentServiceForTests();
  });

  it("does not attempt desktop ssh bearer recovery for non-ssh saved environments", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    const authError = {
      status: 401,
      message: "Unauthorized",
    };
    mockFetchRemoteSessionState.mockRejectedValueOnce(authError);
    mockIsRemoteEnvironmentAuthHttpError.mockImplementation(
      (error: unknown) => error === authError,
    );

    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("This environment no longer accepts its saved pairing. Pair it again.");

    expect(mockEnsureSshEnvironment).not.toHaveBeenCalled();
    expect(mockBootstrapSshBearerSession).not.toHaveBeenCalled();
    expect(mockPatchRuntime).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({ authState: "requires-auth", connectionState: "disconnected" }),
    );

    await resetEnvironmentServiceForTests();
  });

  it("asks for a new pairing when the node no longer accepts a saved bearer", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("expired-bearer-token");
    // What the node really answers for an expired or revoked bearer. Its socket
    // never opens, so a config read over it would wait forever.
    mockFetchRemoteSessionState.mockResolvedValue({ authenticated: false });
    mockClientGetConfig.mockReturnValue(new Promise(() => undefined));
    const dispose = vi.fn(async () => undefined);
    mockCreateEnvironmentConnection.mockImplementation(
      (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => ({
        kind: "saved" as const,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: async () => undefined,
        reconnect: async () => undefined,
        dispose,
      }),
    );

    const {
      reconnectSavedEnvironment,
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    await expect(reconnectSavedEnvironment(EnvironmentId.make("environment-1"))).rejects.toThrow(
      "This environment no longer accepts its saved pairing. Pair it again.",
    );

    expect(mockPatchRuntime).toHaveBeenLastCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({
        authState: "requires-auth",
        connectionState: "disconnected",
        lastError: "This environment no longer accepts its saved pairing. Pair it again.",
      }),
    );
    expect(mockPatchRuntime).not.toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({ connectionState: "error" }),
    );
    expect(listEnvironmentConnections()).toHaveLength(0);
    // The rejected bearer never asks for a ws-token or opens a socket.
    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
    expect(mockWsTransport).not.toHaveBeenCalled();
    expect(mockResolveRemoteWebSocketConnectionUrl).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    // The record and its bearer stay; pairing again replaces the credential.
    expect(mockRemoveSavedEnvironmentBearerToken).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  });

  it.each([
    {
      outcome: "fails on the network",
      settle: (session: SessionStateSettlers) => session.reject(new Error("fetch failed")),
    },
    {
      outcome: "is told the old bearer is rejected",
      settle: (session: SessionStateSettlers) => session.resolve({ authenticated: false }),
    },
  ])(
    "leaves a re-paired environment alone when the connect it replaced $outcome",
    async ({ settle }) => {
      const environmentId = EnvironmentId.make("environment-1");
      mockSavedRecords = [
        {
          environmentId,
          label: "Remote environment",
          httpBaseUrl: "https://remote.example.com/",
          wsBaseUrl: "wss://remote.example.com/",
          createdAt: "2026-04-14T00:00:00.000Z",
          lastConnectedAt: null,
        },
      ];
      mockReadSavedEnvironmentBearerToken.mockResolvedValue("old-bearer-token");
      mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
      mockBootstrapRemoteBearerSession.mockResolvedValue({
        sessionToken: "new-bearer-token",
        role: "owner",
      });
      let oldSession!: SessionStateSettlers;
      mockFetchRemoteSessionState.mockImplementation((input: { readonly bearerToken: string }) =>
        input.bearerToken === "old-bearer-token"
          ? new Promise((resolve, reject) => {
              oldSession = { resolve, reject };
            })
          : Promise.resolve({ authenticated: true, role: "owner" }),
      );
      const created: Array<{ readonly dispose: ReturnType<typeof vi.fn> }> = [];
      mockCreateEnvironmentConnection.mockImplementation(
        (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => {
          const connection = {
            kind: "saved" as const,
            environmentId: input.knownEnvironment.environmentId,
            knownEnvironment: input.knownEnvironment,
            client: input.client,
            ensureBootstrapped: async () => undefined,
            reconnect: async () => undefined,
            dispose: vi.fn(async () => undefined),
          };
          created.push(connection);
          return connection;
        },
      );

      const {
        addSavedEnvironment,
        reconnectSavedEnvironment,
        listEnvironmentConnections,
        resetEnvironmentServiceForTests,
      } = await import("./service");

      // A connect on the old bearer is still waiting when the user pairs again.
      const staleConnect = reconnectSavedEnvironment(environmentId);
      await vi.waitFor(() => {
        expect(oldSession).toBeDefined();
      });
      await addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      });
      const repaired = listEnvironmentConnections();
      const repairedConnection = created.at(-1);
      expect(repaired).toEqual([repairedConnection]);
      mockPatchRuntime.mockClear();

      settle(oldSession);
      await expect(staleConnect).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(listEnvironmentConnections()).toEqual(repaired);
      expect(repairedConnection?.dispose).not.toHaveBeenCalled();
      expect(mockPatchRuntime).not.toHaveBeenCalledWith(
        environmentId,
        expect.objectContaining({ connectionState: "error" }),
      );
      expect(mockPatchRuntime).not.toHaveBeenCalledWith(
        environmentId,
        expect.objectContaining({ authState: "requires-auth" }),
      );

      await resetEnvironmentServiceForTests();
    },
  );

  it("asks for a new pairing when a connected environment's socket has its bearer rejected", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    mockSavedRecords = [
      {
        environmentId,
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");
    const dispose = vi.fn(async () => undefined);
    mockCreateEnvironmentConnection.mockImplementation(
      (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => ({
        kind: "saved" as const,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: async () => undefined,
        reconnect: async () => undefined,
        dispose,
      }),
    );

    const {
      reconnectSavedEnvironment,
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
    } = await import("./service");
    // The module graph is fresh per test; the error class must be the service's.
    const { RemoteEnvironmentAuthHttpError } = await import("@ryco/client-runtime/connection");

    await reconnectSavedEnvironment(environmentId);
    expect(listEnvironmentConnections()).toHaveLength(1);

    const socketOptions = mockWsTransport.mock.calls.at(-1)?.[1] as WsProtocolLifecycleHandlers;
    const deviceOptions = mockDeviceWsTransport.mock.calls.at(-1)?.[1] as {
      readonly isTerminalUrlError?: (error: unknown) => boolean;
    };
    const rejection = new RemoteEnvironmentAuthHttpError("Unauthorized request.", 401);
    // Both sockets stop on a rejected bearer and keep retrying anything else.
    expect(socketOptions.isTerminalUrlError?.(rejection)).toBe(true);
    expect(socketOptions.isTerminalUrlError?.(new Error("fetch failed"))).toBe(false);
    expect(deviceOptions.isTerminalUrlError?.(rejection)).toBe(true);

    // The bearer expires (or is revoked) while the app stays open: the next
    // reconnect's ws-token request is rejected. The protocol reports the failed
    // URL provider first, then that it stopped for good.
    mockPatchRuntime.mockClear();
    socketOptions.onError?.("Unable to prepare the Ryco server WebSocket connection.");
    socketOptions.onTerminalUrlError?.(rejection);

    expect(mockPatchRuntime).toHaveBeenLastCalledWith(
      environmentId,
      expect.objectContaining({
        authState: "requires-auth",
        connectionState: "disconnected",
        lastError: "This environment no longer accepts its saved pairing. Pair it again.",
      }),
    );
    await vi.waitFor(() => {
      expect(listEnvironmentConnections()).toHaveLength(0);
    });
    expect(dispose).toHaveBeenCalledOnce();
    const patches = mockPatchRuntime.mock.calls.map(
      ([, patch]) => patch as Record<string, unknown>,
    );
    const requiresAuthAt = patches.findIndex((patch) => patch.authState === "requires-auth");
    expect(patches.slice(requiresAuthAt + 1)).not.toContainEqual(
      expect.objectContaining({ connectionState: "error" }),
    );
    // The record and its bearer stay; pairing again replaces the credential.
    expect(mockRemoveSavedEnvironmentBearerToken).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  });

  it("renews a direct pairing in use before building its socket, and connects with the renewal", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    mockSavedRecords = [
      {
        environmentId,
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];
    let storedBearer = "bearer-1";
    mockReadSavedEnvironmentBearerToken.mockImplementation(async () => storedBearer);
    mockWriteSavedEnvironmentBearerToken.mockImplementation(
      async (_environmentId: EnvironmentId, token: string) => {
        storedBearer = token;
        return true;
      },
    );
    // Twenty days left of thirty: the pairing is due for renewal.
    mockFetchRemoteSessionState.mockImplementation(
      async (input: { readonly bearerToken: string }) => ({
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt: new Date(
          Date.now() + (input.bearerToken === "bearer-1" ? 20 : 30) * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    );
    mockRotateRemoteBearerSession.mockResolvedValue({
      authenticated: true,
      role: "owner",
      sessionMethod: "bearer-session-token",
      sessionToken: "bearer-2",
    });
    vi.stubGlobal("window", { ...window, location: { origin: "http://localhost:5733" } });

    const {
      reconnectSavedEnvironment,
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    await reconnectSavedEnvironment(environmentId);

    expect(listEnvironmentConnections()).toHaveLength(1);
    expect(mockRotateRemoteBearerSession).toHaveBeenCalledExactlyOnceWith({
      httpBaseUrl: "https://remote.example.com/",
      bearerToken: "bearer-1",
    });
    expect(storedBearer).toBe("bearer-2");
    // The socket asks for its ws-token with the bearer stored now.
    const socketUrl = mockWsTransport.mock.calls.at(-1)?.[0] as () => Promise<string>;
    await socketUrl();
    expect(mockResolveRemoteWebSocketConnectionUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ bearerToken: "bearer-2" }),
    );

    await resetEnvironmentServiceForTests();
  });

  it("never presents a bearer a renewal superseded when the stored one cannot be read", async () => {
    vi.useFakeTimers();
    const dayMs = 24 * 60 * 60 * 1000;
    const environmentId = EnvironmentId.make("environment-1");
    mockSavedRecords = [
      {
        environmentId,
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];
    let storedBearer = "bearer-1";
    mockReadSavedEnvironmentBearerToken.mockImplementation(async () => storedBearer);
    mockWriteSavedEnvironmentBearerToken.mockImplementation(
      async (_environmentId: EnvironmentId, token: string) => {
        storedBearer = token;
        return true;
      },
    );
    // Each bearer lives thirty days from when it was issued.
    const issuedAt = new Map([["bearer-1", Date.now()]]);
    mockFetchRemoteSessionState.mockImplementation(
      async (input: { readonly bearerToken: string }) => ({
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt: new Date(issuedAt.get(input.bearerToken)! + 30 * dayMs).toISOString(),
      }),
    );
    mockRotateRemoteBearerSession.mockImplementation(async () => {
      issuedAt.set("bearer-2", Date.now());
      return {
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        sessionToken: "bearer-2",
      };
    });
    vi.stubGlobal("window", { ...window, location: { origin: "http://localhost:5733" } });

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    const connecting = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(1_000);
    await connecting;
    expect(mockRotateRemoteBearerSession).not.toHaveBeenCalled();

    // The connection stays up for a day: it renews in place, and bearer-1 is
    // superseded once bearer-2 is used.
    await vi.advanceTimersByTimeAsync(dayMs + 60_000);
    expect(mockRotateRemoteBearerSession).toHaveBeenCalledExactlyOnceWith({
      httpBaseUrl: "https://remote.example.com/",
      bearerToken: "bearer-1",
    });
    expect(storedBearer).toBe("bearer-2");

    // Later the socket drops while the stored bearer cannot be read.
    mockReadSavedEnvironmentBearerToken.mockRejectedValue(new Error("Keychain is locked."));
    mockResolveRemoteWebSocketConnectionUrl.mockClear();
    const socketUrl = mockWsTransport.mock.calls.at(-1)?.[0] as () => Promise<string>;
    await expect(socketUrl()).rejects.toThrow(
      "This environment's saved credential could not be read.",
    );
    expect(mockResolveRemoteWebSocketConnectionUrl).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  });

  it("keeps a connection's pairing renewed from its renewal, and stops with the connection", async () => {
    vi.useFakeTimers();
    const dayMs = 24 * 60 * 60 * 1000;
    const environmentId = EnvironmentId.make("environment-1");
    mockSavedRecords = [
      {
        environmentId,
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];
    let storedBearer = "bearer-1";
    mockReadSavedEnvironmentBearerToken.mockImplementation(async () => storedBearer);
    mockWriteSavedEnvironmentBearerToken.mockImplementation(
      async (_environmentId: EnvironmentId, token: string) => {
        storedBearer = token;
        return true;
      },
    );
    // Twenty days left of thirty: due for renewal; the renewal is fresh.
    mockFetchRemoteSessionState.mockImplementation(
      async (input: { readonly bearerToken: string }) => ({
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt: new Date(
          Date.now() + (input.bearerToken === "bearer-1" ? 20 : 30) * dayMs,
        ).toISOString(),
      }),
    );
    mockRotateRemoteBearerSession.mockResolvedValue({
      authenticated: true,
      role: "owner",
      sessionMethod: "bearer-session-token",
      sessionToken: "bearer-2",
    });
    // The connection runs what it was given to stop once it is disposed.
    mockCreateEnvironmentConnection.mockImplementation(
      (input: {
        knownEnvironment: { environmentId: EnvironmentId };
        client: unknown;
        onDispose?: () => void;
      }) => ({
        kind: "saved",
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: async () => undefined,
        reconnect: async () => undefined,
        dispose: async () => input.onDispose?.(),
      }),
    );

    const {
      reconnectSavedEnvironment,
      disconnectSavedEnvironment,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const connecting = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(1_000);
    await connecting;
    // The session check, then the renewal's first use.
    expect(mockFetchRemoteSessionState.mock.calls.map(([input]) => input.bearerToken)).toEqual([
      "bearer-1",
      "bearer-2",
    ]);

    // The renewal is next due a day after the renewed session began, not now.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetchRemoteSessionState).toHaveBeenCalledTimes(2);
    const timersWhileConnected = vi.getTimerCount();

    // Disconnected: its renewal stops with it rather than waiting out the day.
    await disconnectSavedEnvironment(environmentId);
    expect(vi.getTimerCount()).toBe(timersWhileConnected - 1);

    await resetEnvironmentServiceForTests();
  });

  it("fails a connect whose socket never delivers the server config", async () => {
    vi.useFakeTimers();
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");
    mockClientGetConfig.mockReturnValue(new Promise(() => undefined));

    const {
      reconnectSavedEnvironment,
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const reconnecting = expect(
      reconnectSavedEnvironment(EnvironmentId.make("environment-1")),
    ).rejects.toThrow("The environment answered but did not finish connecting in time.");
    await vi.advanceTimersByTimeAsync(30_000);
    await reconnecting;

    expect(mockPatchRuntime).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({ connectionState: "error" }),
    );
    expect(listEnvironmentConnections()).toHaveLength(0);

    await resetEnvironmentServiceForTests();
  });

  it("only registers the retried ssh connection after bearer re-issuance succeeds", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockBootstrapSshBearerSession
      .mockResolvedValueOnce({
        sessionToken: "ssh-bearer-token",
        role: "owner",
      })
      .mockResolvedValueOnce({
        sessionToken: "ssh-bearer-token-2",
        role: "owner",
      });
    mockFetchSshSessionState
      .mockRejectedValueOnce(new Error("[ssh_http:401] Unauthorized"))
      .mockResolvedValueOnce({
        authenticated: true,
        role: "owner",
      });

    const createdConnections: Array<{
      readonly environmentId: EnvironmentId;
      readonly dispose: ReturnType<typeof vi.fn>;
    }> = [];
    mockCreateEnvironmentConnection.mockImplementation(
      (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => {
        const connection = {
          kind: "saved" as const,
          environmentId: input.knownEnvironment.environmentId,
          knownEnvironment: input.knownEnvironment,
          client: input.client,
          ensureBootstrapped: async () => undefined,
          reconnect: async () => undefined,
          dispose: vi.fn(async () => undefined),
        };
        createdConnections.push(connection);
        return connection;
      },
    );

    const {
      connectDesktopSshEnvironment,
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    await connectDesktopSshEnvironment({
      alias: "devbox",
      hostname: "devbox",
      username: null,
      port: null,
    });

    // The rejected bearer is replaced before any socket is built on it.
    expect(createdConnections).toHaveLength(1);
    expect(mockWsTransport).toHaveBeenCalledOnce();
    expect(createdConnections[0]?.dispose).not.toHaveBeenCalled();
    expect(listEnvironmentConnections()).toHaveLength(1);
    expect(listEnvironmentConnections()[0]).toBe(createdConnections[0]);

    await resetEnvironmentServiceForTests();
  });

  it("marks desktop ssh reconnect failures as runtime errors when bearer recovery fails", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);

    const connection = {
      kind: "saved" as const,
      environmentId: EnvironmentId.make("environment-1"),
      knownEnvironment: {
        environmentId: EnvironmentId.make("environment-1"),
      },
      client: {},
      ensureBootstrapped: async () => undefined,
      reconnect: vi.fn(async () => {
        throw new Error("socket closed");
      }),
      dispose: async () => undefined,
    };
    mockCreateEnvironmentConnection.mockReturnValue(connection);

    const { addSavedEnvironment, reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await addSavedEnvironment({
      label: "Remote environment",
      host: "http://127.0.0.1:3774/",
      pairingCode: "ssh-pairing-code",
      desktopSsh: {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
      },
    });

    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      },
    ];
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(false);

    await expect(reconnectSavedEnvironment(EnvironmentId.make("environment-1"))).rejects.toThrow(
      "Unable to persist saved environment credentials.",
    );

    expect(mockPatchRuntime).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({
        connectionState: "error",
        lastError: "Unable to persist saved environment credentials.",
      }),
    );

    await resetEnvironmentServiceForTests();
  });

  it("bootstraps a desktop ssh environment through the desktop bridge", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);

    const { connectDesktopSshEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(
      connectDesktopSshEnvironment({
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      }),
    ).resolves.toMatchObject({
      environmentId: EnvironmentId.make("environment-1"),
    });

    expect(mockEnsureSshEnvironment).toHaveBeenCalledWith(
      {
        alias: "devbox",
        hostname: "devbox",
        username: null,
        port: null,
      },
      { issuePairingToken: true },
    );
    expect(mockResolveRemotePairingTarget).toHaveBeenCalledWith({
      host: "http://127.0.0.1:3774/",
      pairingCode: "ssh-pairing-code",
    });
    expect(mockFetchSshEnvironmentDescriptor).toHaveBeenCalledWith("http://127.0.0.1:3774/");
    expect(mockBootstrapSshBearerSession).toHaveBeenCalledWith(
      "http://127.0.0.1:3774/",
      "ssh-pairing-code",
    );
    expect(mockFetchRemoteEnvironmentDescriptor).not.toHaveBeenCalled();
    expect(mockBootstrapRemoteBearerSession).not.toHaveBeenCalled();
    expect(mockUpsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateEnvironmentConnection.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await resetEnvironmentServiceForTests();
  });

  it("disconnects the desktop ssh process before removing a saved ssh environment", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      },
    ];

    const { removeSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await removeSavedEnvironment(EnvironmentId.make("environment-1"));

    expect(mockDisconnectSshEnvironment).toHaveBeenCalledWith({
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 22,
    });
    expect(mockRemove).toHaveBeenCalledWith(EnvironmentId.make("environment-1"));
    expect(mockRemoveSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
    );
    expect(mockDisconnectSshEnvironment.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemove.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await resetEnvironmentServiceForTests();
  });

  it("disconnects a saved ssh environment without removing its saved record", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      },
    ];

    const { disconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await disconnectSavedEnvironment(EnvironmentId.make("environment-1"));

    expect(mockDisconnectSshEnvironment).toHaveBeenCalledWith({
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 22,
    });
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockRemoveSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
    );

    await resetEnvironmentServiceForTests();
  });

  it("keeps remote environment credentials when disconnecting a non-ssh saved environment", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];

    const { disconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await disconnectSavedEnvironment(EnvironmentId.make("environment-1"));

    expect(mockDisconnectSshEnvironment).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockRemoveSavedEnvironmentBearerToken).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  });

  it("clears stale browser credentials when a non-ssh saved environment has no readable token", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(reconnectSavedEnvironment(EnvironmentId.make("environment-1"))).rejects.toThrow(
      "Saved environment is missing its saved credential.",
    );

    expect(mockRemoveSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
    );
    expect(mockPatchRuntime).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({
        authState: "requires-auth",
        connectionState: "disconnected",
      }),
    );

    await resetEnvironmentServiceForTests();
  });

  it("cancels a pending saved environment connection when disconnected", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");
    const dispose = vi.fn(async () => undefined);
    mockCreateEnvironmentConnection.mockImplementation(
      (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => ({
        kind: "saved" as const,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: async () => undefined,
        reconnect: async () => undefined,
        dispose,
      }),
    );
    let resolveSessionState!: (value: {
      readonly authenticated: true;
      readonly role: "owner";
    }) => void;
    mockFetchRemoteSessionState.mockReturnValue(
      new Promise((resolve) => {
        resolveSessionState = resolve;
      }),
    );

    const {
      disconnectSavedEnvironment,
      listEnvironmentConnections,
      reconnectSavedEnvironment,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const reconnectPromise = reconnectSavedEnvironment(EnvironmentId.make("environment-1"));
    await vi.waitFor(() => {
      expect(mockFetchRemoteSessionState).toHaveBeenCalledOnce();
    });

    await disconnectSavedEnvironment(EnvironmentId.make("environment-1"));
    resolveSessionState({
      authenticated: true,
      role: "owner",
    });
    await expect(reconnectPromise).resolves.toBeUndefined();

    expect(listEnvironmentConnections()).toHaveLength(0);
    // The cancelled attempt stops before it builds a socket.
    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(mockPatchRuntime).not.toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({
        connectionState: "error",
      }),
    );

    await resetEnvironmentServiceForTests();
  });

  it("reissues ssh pairing credentials when connecting after a manual ssh disconnect", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      },
    ];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await reconnectSavedEnvironment(EnvironmentId.make("environment-1"));

    expect(mockEnsureSshEnvironment).toHaveBeenCalledWith(
      {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
      },
      { issuePairingToken: true },
    );
    expect(mockBootstrapSshBearerSession).toHaveBeenCalledWith(
      "http://127.0.0.1:3774/",
      "ssh-pairing-code",
    );
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "ssh-bearer-token",
    );

    await resetEnvironmentServiceForTests();
  });

  it("rolls back ssh registry metadata when pairing token issuance fails", async () => {
    const originalRecord = {
      environmentId: EnvironmentId.make("environment-1"),
      label: "Remote environment",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
      createdAt: "2026-04-14T00:00:00.000Z",
      lastConnectedAt: null,
      desktopSsh: {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
      },
    };
    mockSavedRecords = [originalRecord];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockEnsureSshEnvironment.mockResolvedValue({
      target: {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 22,
      },
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      pairingToken: null,
    });

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(reconnectSavedEnvironment(EnvironmentId.make("environment-1"))).rejects.toThrow(
      "Desktop SSH launch did not return a pairing token.",
    );

    expect(mockPersistSavedEnvironmentRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        httpBaseUrl: "http://127.0.0.1:3774/",
      }),
    );
    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([originalRecord]);
    expect(mockSavedRecords).toEqual([originalRecord]);
    expect(mockBootstrapSshBearerSession).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  });

  it("surfaces desktop ssh bootstrap failures during saved ssh reconnect", async () => {
    mockSavedRecords = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        createdAt: "2026-04-14T00:00:00.000Z",
        lastConnectedAt: null,
        desktopSsh: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 22,
        },
      },
    ];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockEnsureSshEnvironment.mockRejectedValue(new Error("SSH command timed out after 60000ms."));

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(reconnectSavedEnvironment(EnvironmentId.make("environment-1"))).rejects.toThrow(
      "SSH command timed out after 60000ms.",
    );
    expect(mockPatchRuntime).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({
        connectionState: "connecting",
      }),
    );
    expect(mockPatchRuntime).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({
        connectionState: "error",
        lastError: "SSH command timed out after 60000ms.",
      }),
    );

    await resetEnvironmentServiceForTests();
  });
});
