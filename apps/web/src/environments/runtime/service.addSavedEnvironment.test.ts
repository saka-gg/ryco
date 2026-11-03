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
const mockRevokeSshClientSession = vi.fn();
const mockPersistSavedEnvironmentRecord = vi.fn();
const mockWriteSavedEnvironmentBearerToken = vi.fn();
const mockSetSavedEnvironmentRegistry = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn((environmentId: EnvironmentId) => {
  return mockSavedRecords.find((record) => record.environmentId === environmentId) ?? null;
});
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockRemoveSavedEnvironmentBearerToken = vi.fn();
let mockRuntimeById: Record<string, Record<string, unknown>> = {};
const mockPatchRuntime = vi.fn((environmentId: EnvironmentId, patch: Record<string, unknown>) => {
  mockRuntimeById = {
    ...mockRuntimeById,
    [environmentId]: { ...mockRuntimeById[environmentId], ...patch },
  };
});
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
const mockListLinkedDirectRecords = vi.fn((): Array<Record<string, unknown>> => []);
const mockEnsureSshEnvironment = vi.fn();
const mockDisconnectSshEnvironment = vi.fn();
const mockFetchSshEnvironmentDescriptor = vi.fn();
const mockToPersistedSavedEnvironmentRecord = vi.fn((record) => record);
const mockCreateEnvironmentConnection = vi.fn();
const mockWsTransport = vi.fn();
const mockDeviceWsTransport = vi.fn();
const mockCreateDirectDeviceRpcTransport = vi.fn();
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
  getLinkedDirectRecord: vi.fn(() => null),
  listLinkedDirectRecords: mockListLinkedDirectRecords,
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
      byId: mockRuntimeById,
      ensure: vi.fn(),
      patch: mockPatchRuntime,
      clear: mockClearRuntime,
    }),
  },
  waitForSavedEnvironmentRegistryHydration: vi.fn(),
  writeSavedEnvironmentBearerToken: mockWriteSavedEnvironmentBearerToken,
}));

vi.mock("./connection", () => ({
  // A real saved connection's config subscription delivers the node's config
  // as its first item; `mockClientGetConfig` stands for that config here.
  createEnvironmentConnection: (input: {
    readonly onConfigUpdated?: (config: unknown, source: "snapshot") => void;
  }) => {
    void Promise.resolve()
      .then(() => mockClientGetConfig())
      .then((config) => input.onConfigUpdated?.(config, "snapshot"))
      .catch(() => undefined);
    return mockCreateEnvironmentConnection(input);
  },
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

vi.mock("@ryco/client-runtime/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/rpc")>();
  return {
    ...actual,
    createDirectDeviceRpcTransport: (
      input: Parameters<typeof actual.createDirectDeviceRpcTransport>[0],
    ) => {
      mockCreateDirectDeviceRpcTransport(input);
      return actual.createDirectDeviceRpcTransport(input);
    },
  };
});

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
    mockRuntimeById = {};
    vi.stubGlobal("window", {
      desktopBridge: {
        ensureSshEnvironment: mockEnsureSshEnvironment,
        disconnectSshEnvironment: mockDisconnectSshEnvironment,
        fetchSshEnvironmentDescriptor: mockFetchSshEnvironmentDescriptor,
        bootstrapSshBearerSession: mockBootstrapSshBearerSession,
        fetchSshSessionState: mockFetchSshSessionState,
        issueSshWebSocketToken: vi.fn(),
        revokeSshClientSession: mockRevokeSshClientSession,
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

  it("keeps a Hub-linked pairing as a route of its Hub machine, never a second environment", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    const record = await addSavedEnvironment({
      label: "Studio Mac",
      host: "http://192.168.1.20:3773",
      pairingCode: "linked-code",
      hubLink: { hubEnvironmentId: "env_hub", linkedAt: "2026-10-30T08:00:00.000Z" },
    });

    expect(record).toMatchObject({
      environmentId: "environment-1",
      hubLink: { hubEnvironmentId: "env_hub" },
    });
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "bearer-token",
    );
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ hubLink: expect.anything() }),
    );
    // No connection, no socket: the machine's own connection takes the route.
    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
    expect(mockWsTransport).not.toHaveBeenCalled();
    // What a direct copy of the machine held under this id is forgotten.
    expect(mockClearRuntime).toHaveBeenCalledWith(EnvironmentId.make("environment-1"));

    await resetEnvironmentServiceForTests();
  }, 15_000);

  it("keeps the Hub-linked routes in storage when a failed pairing is rolled back", async () => {
    const linked = {
      environmentId: EnvironmentId.make("environment-linked"),
      label: "Studio",
      httpBaseUrl: "https://studio.tail1.ts.net/",
      wsBaseUrl: "wss://studio.tail1.ts.net/",
      createdAt: "2026-10-20T00:00:00.000Z",
      lastConnectedAt: null,
      hubLink: { hubEnvironmentId: "env_hub", linkedAt: "2026-10-29T00:00:00.000Z" },
    };
    mockListLinkedDirectRecords.mockReturnValue([linked]);
    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");

    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([linked]);
    expect(mockRegistrySetState).toHaveBeenCalledWith(
      expect.objectContaining({ linkedById: { [linked.environmentId]: linked } }),
    );
    mockListLinkedDirectRecords.mockReturnValue([]);
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
    // Device control rides the main socket: no device socket until one is needed.
    expect(mockDeviceWsTransport).not.toHaveBeenCalled();
    const deviceTransportInput = mockCreateDirectDeviceRpcTransport.mock.calls.at(-1)?.[0] as {
      readonly openDedicated: () => unknown;
    };
    deviceTransportInput.openDedicated();
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
      // The supervisor's attempt can abandon the rotation if its slot times out.
      signal: expect.any(AbortSignal),
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

  it("keeps a cancelled attempt's socket from reporting over the environment's state", async () => {
    vi.useFakeTimers();
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
    // The attempt's socket is up, but its first server config never arrives.
    mockClientGetConfig.mockReturnValue(new Promise(() => undefined));

    const {
      reconnectSavedEnvironment,
      disconnectSavedEnvironment,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const connecting = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(1_000);
    const socketOptions = mockWsTransport.mock.calls.at(-1)?.[1] as WsProtocolLifecycleHandlers;
    expect(socketOptions).toBeDefined();

    // The user disconnects (or pairs again) while the attempt still waits.
    await disconnectSavedEnvironment(environmentId);
    mockPatchRuntime.mockClear();
    // Its socket keeps reporting until the attempt notices it was cancelled.
    socketOptions.onAttempt?.("wss://remote.example.com/ws");
    socketOptions.onOpen?.();
    socketOptions.onError?.("Unable to connect to the Ryco server WebSocket.");
    socketOptions.onClose?.({ code: 1006, reason: "Socket dropped." }, { intentional: false });
    expect(mockPatchRuntime).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    await connecting;
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

  it("registers a connect before its config arrives and removes it when the socket's bearer is rejected", async () => {
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
    const { RemoteEnvironmentAuthHttpError } = await import("@ryco/client-runtime/connection");

    const reconnecting = reconnectSavedEnvironment(environmentId);
    reconnecting.catch(() => undefined);
    // The session check passed: the connection is registered while the socket's
    // ws-token, upgrade and config are still pending.
    await vi.waitFor(() => expect(listEnvironmentConnections()).toHaveLength(1));

    const socketOptions = mockWsTransport.mock.calls.at(-1)?.[1] as WsProtocolLifecycleHandlers;
    socketOptions.onTerminalUrlError?.(
      new RemoteEnvironmentAuthHttpError("Unauthorized request.", 401),
    );

    await expect(reconnecting).rejects.toThrow();
    await vi.waitFor(() => expect(listEnvironmentConnections()).toHaveLength(0));
    expect(dispose).toHaveBeenCalled();
    expect(mockPatchRuntime).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ authState: "requires-auth" }),
    );

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
    const { peekProjectIconSource, readProjectIconSource } =
      await import("@ryco/client-runtime/connection");
    const iconProject = "icon-project" as never;
    await readProjectIconSource(
      {
        projects: { readIcon: async () => ({ mimeType: "image/png", dataBase64: "aWNvbg==" }) },
      } as never,
      EnvironmentId.make("environment-1"),
      iconProject,
      null,
    );
    expect(
      peekProjectIconSource(EnvironmentId.make("environment-1"), iconProject, null),
    ).not.toBeUndefined();

    await removeSavedEnvironment(EnvironmentId.make("environment-1"));

    // The node's project artwork is memory-only and keyed by node: forgotten too.
    expect(
      peekProjectIconSource(EnvironmentId.make("environment-1"), iconProject, null),
    ).toBeUndefined();
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

  describe("owner re-pair of client-role ssh environments", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const sshTarget = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 22,
    };
    const sshRecord = {
      environmentId,
      label: "Remote environment",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      createdAt: "2026-04-14T00:00:00.000Z",
      lastConnectedAt: null,
      desktopSsh: sshTarget,
    };
    const tunnelBootstrap = {
      target: sshTarget,
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
      pairingToken: null,
    };
    const pairingCalls = () =>
      mockEnsureSshEnvironment.mock.calls.filter(
        (call) => (call[1] as { issuePairingToken?: boolean } | undefined)?.issuePairingToken,
      );

    beforeEach(() => {
      mockSavedRecords = [sshRecord];
      mockReadSavedEnvironmentBearerToken.mockResolvedValue("client-bearer");
      mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
      mockFetchSshSessionState.mockImplementation(async (_httpBaseUrl, bearerToken) =>
        bearerToken === "owner-bearer"
          ? { authenticated: true, role: "owner", sessionId: "owner-session" }
          : { authenticated: true, role: "client", sessionId: "client-session" },
      );
      mockRevokeSshClientSession.mockResolvedValue({ revoked: true });
    });

    it("re-pairs as owner over the tunnel, persists the bearer, then revokes the client session", async () => {
      mockEnsureSshEnvironment.mockImplementation(async (_target, options) => ({
        ...tunnelBootstrap,
        ...(options?.issuePairingToken
          ? { pairingToken: "owner-pairing-code", pairingRole: "owner" }
          : {}),
      }));
      mockBootstrapSshBearerSession.mockResolvedValue({
        sessionToken: "owner-bearer",
        role: "owner",
      });

      const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      await reconnectSavedEnvironment(environmentId);

      expect(pairingCalls()).toEqual([
        [sshTarget, { issuePairingToken: true, requireOwnerPairing: true }],
      ]);
      expect(mockBootstrapSshBearerSession).toHaveBeenCalledWith(
        "http://127.0.0.1:3774/",
        "owner-pairing-code",
      );
      expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
        environmentId,
        "owner-bearer",
      );
      expect(mockRevokeSshClientSession).toHaveBeenCalledWith(
        "http://127.0.0.1:3774/",
        "owner-bearer",
        "client-session",
      );
      // The owner bearer is stored before the session it replaces goes away.
      expect(mockWriteSavedEnvironmentBearerToken.mock.invocationCallOrder[0]).toBeLessThan(
        mockRevokeSshClientSession.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
      );
      // The connection is built on the owner bearer.
      expect(mockFetchSshSessionState).toHaveBeenLastCalledWith(
        "http://127.0.0.1:3774/",
        "owner-bearer",
      );
      expect(mockPatchRuntime).toHaveBeenCalledWith(
        environmentId,
        expect.objectContaining({ role: "owner" }),
      );

      await resetEnvironmentServiceForTests();
    });

    it("keeps the client bearer when the remote cannot mint owner credentials, and asks once", async () => {
      // The remote CLI predates owner pairing: an owner-only request mints nothing.
      mockEnsureSshEnvironment.mockResolvedValue(tunnelBootstrap);
      mockCreateEnvironmentConnection.mockImplementationOnce(() => {
        throw new Error("socket setup failed");
      });

      const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      await expect(reconnectSavedEnvironment(environmentId)).rejects.toThrow("socket setup failed");
      await reconnectSavedEnvironment(environmentId);

      expect(pairingCalls()).toEqual([
        [sshTarget, { issuePairingToken: true, requireOwnerPairing: true }],
      ]);
      expect(mockBootstrapSshBearerSession).not.toHaveBeenCalled();
      expect(mockWriteSavedEnvironmentBearerToken).not.toHaveBeenCalled();
      expect(mockRevokeSshClientSession).not.toHaveBeenCalled();
      expect(mockPatchRuntime).toHaveBeenCalledWith(
        environmentId,
        expect.objectContaining({ role: "client" }),
      );

      await resetEnvironmentServiceForTests();
    });

    it("never re-pairs a client bearer the tunnel issued during the same connect", async () => {
      mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
      mockEnsureSshEnvironment.mockImplementation(async (_target, options) => ({
        ...tunnelBootstrap,
        ...(options?.issuePairingToken
          ? { pairingToken: "client-pairing-code", pairingRole: "client" }
          : {}),
      }));
      mockBootstrapSshBearerSession.mockResolvedValue({
        sessionToken: "client-bearer",
        role: "client",
      });

      const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      await reconnectSavedEnvironment(environmentId);

      expect(pairingCalls()).toEqual([[sshTarget, { issuePairingToken: true }]]);
      expect(mockRevokeSshClientSession).not.toHaveBeenCalled();

      await resetEnvironmentServiceForTests();
    });

    const ownerPairingCall = [sshTarget, { issuePairingToken: true, requireOwnerPairing: true }];
    const configForVersion = (serverVersion: string) => ({
      environment: { environmentId, label: "Remote environment", serverVersion },
    });

    it("asks again once the connected node reports another Ryco version, and reconnects as owner", async () => {
      // The remote CLI predates owner pairing until Ryco is updated there.
      let remoteVersion = "0.1.30";
      let remoteMintsOwner = false;
      let storedBearer = "client-bearer";
      mockReadSavedEnvironmentBearerToken.mockImplementation(async () => storedBearer);
      mockWriteSavedEnvironmentBearerToken.mockImplementation(async (_id, token: string) => {
        storedBearer = token;
        return true;
      });
      mockFetchSshEnvironmentDescriptor.mockImplementation(async () => ({
        environmentId,
        label: "Remote environment",
        serverVersion: remoteVersion,
      }));
      mockClientGetConfig.mockImplementation(async () => configForVersion(remoteVersion) as never);
      mockEnsureSshEnvironment.mockImplementation(async (_target, options) => ({
        ...tunnelBootstrap,
        ...(options?.issuePairingToken && remoteMintsOwner
          ? { pairingToken: "owner-pairing-code", pairingRole: "owner" }
          : {}),
      }));
      mockBootstrapSshBearerSession.mockResolvedValue({
        sessionToken: "owner-bearer",
        role: "owner",
      });
      const reconnect = vi.fn(async () => undefined);
      let onConfigUpdated!: (config: unknown, type: "snapshot" | "settingsUpdated") => void;
      mockCreateEnvironmentConnection.mockImplementation(
        (input: {
          knownEnvironment: { environmentId: EnvironmentId };
          client: unknown;
          onConfigUpdated: typeof onConfigUpdated;
        }) => {
          onConfigUpdated = input.onConfigUpdated;
          return {
            kind: "saved",
            environmentId: input.knownEnvironment.environmentId,
            knownEnvironment: input.knownEnvironment,
            client: input.client,
            ensureBootstrapped: async () => undefined,
            reconnect,
            dispose: async () => undefined,
          };
        },
      );

      const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      await reconnectSavedEnvironment(environmentId);
      expect(pairingCalls()).toEqual([ownerPairingCall]);
      expect(mockRuntimeById[environmentId]?.role).toBe("client");

      // The socket reconnects to the same Ryco: nothing is asked.
      onConfigUpdated(configForVersion("0.1.30"), "snapshot");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pairingCalls()).toEqual([ownerPairingCall]);

      // Ryco is updated on the node and its server restarts; the socket
      // reconnects on its own, still on the client bearer.
      remoteVersion = "0.1.36";
      remoteMintsOwner = true;
      onConfigUpdated(configForVersion("0.1.36"), "snapshot");

      await vi.waitFor(() => {
        expect(reconnect).toHaveBeenCalledOnce();
      });
      expect(pairingCalls()).toEqual([ownerPairingCall, ownerPairingCall]);
      expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
        environmentId,
        "owner-bearer",
      );
      expect(mockRevokeSshClientSession).toHaveBeenCalledWith(
        "http://127.0.0.1:3774/",
        "owner-bearer",
        "client-session",
      );
      expect(mockWriteSavedEnvironmentBearerToken.mock.invocationCallOrder[0]).toBeLessThan(
        reconnect.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
      );

      await resetEnvironmentServiceForTests();
    });

    it("retries a failed re-pair on the next connect once its retry delay has passed", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
      mockEnsureSshEnvironment.mockImplementation(async (_target, options) => {
        if (options?.requireOwnerPairing && pairingCalls().length === 1) {
          throw new Error("ssh: Connection reset by peer");
        }
        return {
          ...tunnelBootstrap,
          ...(options?.issuePairingToken
            ? { pairingToken: "owner-pairing-code", pairingRole: "owner" }
            : {}),
        };
      });
      mockBootstrapSshBearerSession.mockResolvedValue({
        sessionToken: "owner-bearer",
        role: "owner",
      });
      mockCreateEnvironmentConnection
        .mockImplementationOnce(() => {
          throw new Error("socket setup failed");
        })
        .mockImplementationOnce(() => {
          throw new Error("socket setup failed");
        });

      const { DESKTOP_SSH_OWNER_REPAIR_RETRY_MS } = await import("@ryco/client-runtime/connection");
      const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      // An SSH hiccup fails the re-pair: the client bearer stays.
      await expect(reconnectSavedEnvironment(environmentId)).rejects.toThrow("socket setup failed");
      expect(pairingCalls()).toEqual([ownerPairingCall]);
      expect(mockWriteSavedEnvironmentBearerToken).not.toHaveBeenCalled();

      // A connect right after does not ask again.
      await expect(reconnectSavedEnvironment(environmentId)).rejects.toThrow("socket setup failed");
      expect(pairingCalls()).toEqual([ownerPairingCall]);

      vi.setSystemTime(Date.now() + DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
      await reconnectSavedEnvironment(environmentId);

      expect(pairingCalls()).toEqual([ownerPairingCall, ownerPairingCall]);
      expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
        environmentId,
        "owner-bearer",
      );
      expect(mockPatchRuntime).toHaveBeenCalledWith(
        environmentId,
        expect.objectContaining({ role: "owner" }),
      );

      await resetEnvironmentServiceForTests();
    });

    /**
     * A node whose first `failures` owner re-pairs hit an SSH hiccup, then
     * mint owner credentials. Returns the stored bearer, the connection's
     * reconnect and a socket snapshot.
     */
    const failFirstOwnerPairings = (failures = 1) => {
      const state = { storedBearer: "client-bearer" };
      mockReadSavedEnvironmentBearerToken.mockImplementation(async () => state.storedBearer);
      mockWriteSavedEnvironmentBearerToken.mockImplementation(async (_id, token: string) => {
        state.storedBearer = token;
        return true;
      });
      mockEnsureSshEnvironment.mockImplementation(async (_target, options) => {
        if (options?.requireOwnerPairing && pairingCalls().length <= failures) {
          throw new Error("ssh: Connection reset by peer");
        }
        return {
          ...tunnelBootstrap,
          ...(options?.issuePairingToken
            ? { pairingToken: "owner-pairing-code", pairingRole: "owner" }
            : {}),
        };
      });
      mockBootstrapSshBearerSession.mockResolvedValue({
        sessionToken: "owner-bearer",
        role: "owner",
      });
      const reconnect = vi.fn(async () => undefined);
      let onConfigUpdated!: (config: unknown, type: "snapshot" | "settingsUpdated") => void;
      mockCreateEnvironmentConnection.mockImplementation(
        (input: {
          knownEnvironment: { environmentId: EnvironmentId };
          client: unknown;
          onConfigUpdated: typeof onConfigUpdated;
        }) => {
          onConfigUpdated = input.onConfigUpdated;
          return {
            kind: "saved",
            environmentId: input.knownEnvironment.environmentId,
            knownEnvironment: input.knownEnvironment,
            client: input.client,
            ensureBootstrapped: async () => undefined,
            reconnect,
            dispose: async () => undefined,
          };
        },
      );
      return {
        state,
        reconnect,
        snapshot: (serverVersion: string) =>
          onConfigUpdated(configForVersion(serverVersion), "snapshot"),
      };
    };

    it("re-pairs a connected node in place once a failed re-pair's retry delay has passed", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
      mockClientGetConfig.mockImplementation(async () => configForVersion("0.1.36") as never);
      const node = failFirstOwnerPairings();

      const { DESKTOP_SSH_OWNER_REPAIR_RETRY_MS } = await import("@ryco/client-runtime/connection");
      const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      // At app start the re-pair hits an SSH hiccup: the node connects on its
      // client bearer, and its socket then stays healthy.
      await reconnectSavedEnvironment(environmentId);
      expect(pairingCalls()).toEqual([ownerPairingCall]);
      expect(mockRuntimeById[environmentId]?.role).toBe("client");

      await vi.advanceTimersByTimeAsync(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS - 1);
      expect(pairingCalls()).toEqual([ownerPairingCall]);

      // No connect and no socket snapshot: the retry itself asks again.
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(node.reconnect).toHaveBeenCalledOnce();
      });
      expect(pairingCalls()).toEqual([ownerPairingCall, ownerPairingCall]);
      expect(node.state.storedBearer).toBe("owner-bearer");
      expect(mockRevokeSshClientSession).toHaveBeenCalledWith(
        "http://127.0.0.1:3774/",
        "owner-bearer",
        "client-session",
      );

      await resetEnvironmentServiceForTests();
    });

    it("keeps retrying a connected node whose re-pair keeps failing", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
      mockClientGetConfig.mockImplementation(async () => configForVersion("0.1.36") as never);
      const node = failFirstOwnerPairings(2);

      const { DESKTOP_SSH_OWNER_REPAIR_RETRY_MS } = await import("@ryco/client-runtime/connection");
      const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      await reconnectSavedEnvironment(environmentId);
      expect(pairingCalls()).toEqual([ownerPairingCall]);

      await vi.advanceTimersByTimeAsync(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
      await vi.waitFor(() => {
        expect(pairingCalls()).toEqual([ownerPairingCall, ownerPairingCall]);
      });
      expect(node.reconnect).not.toHaveBeenCalled();
      expect(node.state.storedBearer).toBe("client-bearer");

      await vi.advanceTimersByTimeAsync(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
      await vi.waitFor(() => {
        expect(node.reconnect).toHaveBeenCalledOnce();
      });
      expect(pairingCalls()).toEqual([ownerPairingCall, ownerPairingCall, ownerPairingCall]);
      expect(node.state.storedBearer).toBe("owner-bearer");

      await resetEnvironmentServiceForTests();
    });

    it("retries a failed re-pair at once when the connected node reports another Ryco version", async () => {
      // The node was connected before, on Ryco 0.1.30.
      mockRuntimeById = {
        [environmentId]: { descriptor: { environmentId, serverVersion: "0.1.30" } },
      };
      mockClientGetConfig.mockImplementation(async () => configForVersion("0.1.30") as never);
      const node = failFirstOwnerPairings();

      const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      await reconnectSavedEnvironment(environmentId);
      expect(pairingCalls()).toEqual([ownerPairingCall]);
      expect(mockRuntimeById[environmentId]?.role).toBe("client");

      // The socket reconnects to the same Ryco within the retry delay: nothing is asked.
      node.snapshot("0.1.30");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pairingCalls()).toEqual([ownerPairingCall]);

      // Ryco is updated on the node, as the copy dialog asks, and its server restarts.
      node.snapshot("0.1.36");
      await vi.waitFor(() => {
        expect(node.reconnect).toHaveBeenCalledOnce();
      });
      expect(pairingCalls()).toEqual([ownerPairingCall, ownerPairingCall]);
      expect(node.state.storedBearer).toBe("owner-bearer");

      await resetEnvironmentServiceForTests();
    });

    it("stops a re-pair a disconnect cancelled before it stores the bearer or reopens the tunnel", async () => {
      mockEnsureSshEnvironment.mockImplementation(async (_target, options) => ({
        ...tunnelBootstrap,
        ...(options?.issuePairingToken
          ? { pairingToken: "owner-pairing-code", pairingRole: "owner" }
          : {}),
      }));
      let resolveRedeem!: (value: { sessionToken: string; role: "owner" }) => void;
      mockBootstrapSshBearerSession.mockReturnValue(
        new Promise((resolve) => {
          resolveRedeem = resolve;
        }),
      );

      const {
        disconnectSavedEnvironment,
        reconnectSavedEnvironment,
        resetEnvironmentServiceForTests,
      } = await import("./service");
      const connecting = reconnectSavedEnvironment(environmentId);
      await vi.waitFor(() => {
        expect(mockBootstrapSshBearerSession).toHaveBeenCalledOnce();
      });
      const tunnelEnsures = mockEnsureSshEnvironment.mock.calls.length;

      await disconnectSavedEnvironment(environmentId);
      resolveRedeem({ sessionToken: "owner-bearer", role: "owner" });
      await expect(connecting).resolves.toBeUndefined();

      expect(mockWriteSavedEnvironmentBearerToken).not.toHaveBeenCalled();
      expect(mockRevokeSshClientSession).not.toHaveBeenCalled();
      // The tunnel the disconnect closed stays closed.
      expect(mockEnsureSshEnvironment).toHaveBeenCalledTimes(tunnelEnsures);
      expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();

      await resetEnvironmentServiceForTests();
    });

    it("never brings back an environment removed while its re-pair opened a new tunnel", async () => {
      let resolveOwnerPairing!: (value: Record<string, unknown>) => void;
      mockEnsureSshEnvironment.mockImplementation((_target, options) =>
        options?.requireOwnerPairing
          ? new Promise((resolve) => {
              resolveOwnerPairing = resolve;
            })
          : Promise.resolve(tunnelBootstrap),
      );

      const { reconnectSavedEnvironment, removeSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      const connecting = reconnectSavedEnvironment(environmentId);
      await vi.waitFor(() => {
        expect(pairingCalls()).toEqual([ownerPairingCall]);
      });

      await removeSavedEnvironment(environmentId);
      expect(mockSavedRecords).toEqual([]);
      // The tunnel came back on another local port.
      resolveOwnerPairing({
        ...tunnelBootstrap,
        httpBaseUrl: "http://127.0.0.1:3775/",
        wsBaseUrl: "ws://127.0.0.1:3775/",
        pairingToken: "owner-pairing-code",
        pairingRole: "owner",
      });
      await expect(connecting).resolves.toBeUndefined();

      expect(mockPersistSavedEnvironmentRecord).not.toHaveBeenCalled();
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockBootstrapSshBearerSession).not.toHaveBeenCalled();
      expect(mockSavedRecords).toEqual([]);

      await resetEnvironmentServiceForTests();
    });

    it("never stores a bearer, nor rolls the registry back, for a pairing a removal cancelled", async () => {
      mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
      mockEnsureSshEnvironment.mockImplementation(async (_target, options) => ({
        ...tunnelBootstrap,
        ...(options?.issuePairingToken
          ? { pairingToken: "owner-pairing-code", pairingRole: "owner" }
          : {}),
      }));
      let resolveRedeem!: (value: { sessionToken: string; role: "owner" }) => void;
      mockBootstrapSshBearerSession.mockReturnValue(
        new Promise((resolve) => {
          resolveRedeem = resolve;
        }),
      );

      const { reconnectSavedEnvironment, removeSavedEnvironment, resetEnvironmentServiceForTests } =
        await import("./service");
      const connecting = reconnectSavedEnvironment(environmentId);
      await vi.waitFor(() => {
        expect(mockBootstrapSshBearerSession).toHaveBeenCalledOnce();
      });
      const tunnelEnsures = mockEnsureSshEnvironment.mock.calls.length;

      await removeSavedEnvironment(environmentId);
      resolveRedeem({ sessionToken: "owner-bearer", role: "owner" });
      await expect(connecting).resolves.toBeUndefined();

      expect(mockWriteSavedEnvironmentBearerToken).not.toHaveBeenCalled();
      expect(mockSetSavedEnvironmentRegistry).not.toHaveBeenCalled();
      expect(mockEnsureSshEnvironment).toHaveBeenCalledTimes(tunnelEnsures);
      expect(mockSavedRecords).toEqual([]);

      await resetEnvironmentServiceForTests();
    });
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
    // The address goes back into the live record, and nothing else changes.
    expect(mockPersistSavedEnvironmentRecord).toHaveBeenLastCalledWith(originalRecord);
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
