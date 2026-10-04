import type { AuthSessionState, EnvironmentId } from "@ryco/contracts";
import {
  RemoteEnvironmentAuthHttpError,
  SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE,
  SavedEnvironmentCredentialError,
  type EnvironmentConnection,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
import type { WsProtocolLifecycleHandlers } from "@ryco/client-runtime/rpc";
import { describe, expect, it, vi } from "vite-plus/test";

// Native modules are stubbed so the driver/state-sink load under the Node runner.
const appStateHolder = vi.hoisted(() => ({ handler: null as ((state: string) => void) | null }));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_type: string, handler: (state: string) => void) => {
      appStateHolder.handler = handler;
      return { remove: () => {} };
    },
  },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

// The saved-environment socket is replaced by a recorder: tests drive its
// lifecycle callbacks the way the protocol would.
const socketHolder = vi.hoisted(() => ({
  urls: [] as Array<() => Promise<string>>,
  options: [] as Array<WsProtocolLifecycleHandlers>,
  clientDisposals: 0,
}));
vi.mock("../rpc/wsTransport", () => ({
  WsTransport: class {
    constructor(url: () => Promise<string>, options: WsProtocolLifecycleHandlers) {
      socketHolder.urls.push(url);
      socketHolder.options.push(options);
    }
    dispose = async () => {};
  },
}));
vi.mock("../rpc/wsRpcClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc/wsRpcClient")>()),
  createWsRpcClient: () => ({
    server: { subscribeLifecycle: () => () => {}, subscribeConfig: () => () => {} },
    orchestration: { subscribeShell: () => () => {} },
    terminal: { onEvent: () => () => {} },
    isHeartbeatFresh: () => false,
    reconnect: async () => {},
    dispose: async () => {
      socketHolder.clientDisposals += 1;
    },
  }),
}));

import { subscribeAppStateResume } from "./appStateResume";
import { createMobileEnvironmentDriver, type MobileCatalogLike } from "./environmentDriver";
import { createMobileEnvironmentStateSink } from "./environmentStateSink";
import { useStore } from "../state/threadsRuntime";

const ENV_ID = "env-1" as EnvironmentId;

function record(id: EnvironmentId = ENV_ID): SavedEnvironmentRecord {
  return {
    environmentId: id,
    label: "Local node",
    httpBaseUrl: "http://node.local:44342/",
    wsBaseUrl: "ws://node.local:44342/",
    createdAt: "2026-07-24T00:00:00.000Z",
    lastConnectedAt: null,
  };
}

/** A controllable in-memory catalog matching the driver's structural contract. */
function createFakeCatalog() {
  const byId = new Map<EnvironmentId, SavedEnvironmentRecord>();
  const runtimeById = new Map<EnvironmentId, Partial<SavedEnvironmentRuntimeState>>();
  const registryListeners = new Set<() => void>();
  const tokens = new Map<EnvironmentId, string>();
  const catalog: MobileCatalogLike = {
    registryStore: {
      subscribe: (listener) => {
        registryListeners.add(listener);
        return () => registryListeners.delete(listener);
      },
      getState: () => ({
        markConnected: (environmentId, connectedAt) => {
          const existing = byId.get(environmentId);
          if (existing) byId.set(environmentId, { ...existing, lastConnectedAt: connectedAt });
        },
      }),
    },
    runtimeStore: {
      getState: () => ({
        byId: Object.fromEntries(runtimeById) as Record<
          EnvironmentId,
          SavedEnvironmentRuntimeState
        >,
        ensure: (environmentId) => {
          if (!runtimeById.has(environmentId)) runtimeById.set(environmentId, {});
        },
        patch: (environmentId, patch) => {
          runtimeById.set(environmentId, { ...runtimeById.get(environmentId), ...patch });
        },
      }),
    },
    hasHydrated: () => true,
    waitForHydration: () => Promise.resolve(),
    list: () => [...byId.values()],
    get: (environmentId) => byId.get(environmentId) ?? null,
    readBearerToken: async (environmentId) => tokens.get(environmentId) ?? null,
    writeBearerToken: async (environmentId, token) => {
      tokens.set(environmentId, token);
      return true;
    },
  };
  return {
    catalog,
    setBearerToken: (id: EnvironmentId, token: string) => tokens.set(id, token),
    upsert: (rec: SavedEnvironmentRecord) => {
      byId.set(rec.environmentId, rec);
      registryListeners.forEach((listener) => listener());
    },
    runtime: (id: EnvironmentId) => runtimeById.get(id),
  };
}

function fakeConnection(
  environmentId: EnvironmentId,
  overrides?: {
    reconnect?: () => Promise<void>;
    heartbeatFresh?: boolean;
    kind?: EnvironmentConnection["kind"];
    dispose?: () => Promise<void>;
  },
): EnvironmentConnection {
  return {
    kind: overrides?.kind ?? "saved",
    environmentId,
    knownEnvironment: {
      id: environmentId,
      label: "Local node",
      source: "manual",
      environmentId,
      target: { httpBaseUrl: "http://node.local/", wsBaseUrl: "ws://node.local/" },
    },
    client: {
      isHeartbeatFresh: () => overrides?.heartbeatFresh ?? false,
      dispose: async () => {},
      reconnect: async () => {},
    } as EnvironmentConnection["client"],
    shellSnapshotReadiness: { read: () => null, subscribe: () => () => {} },
    ensureBootstrapped: async () => {},
    reconnect: overrides?.reconnect ?? (async () => {}),
    dispose: overrides?.dispose ?? (async () => {}),
  };
}

const sessionState = (authenticated: boolean) =>
  ({ authenticated, ...(authenticated ? { role: "owner" } : {}) }) as unknown as AuthSessionState;

const noopRemoteApi = {
  fetchRemoteSessionState: async () => sessionState(true),
  resolveRemoteWebSocketConnectionUrl: async () => "ws://node.local/?wsToken=t",
  // The sessions above carry no lifetime, so nothing here is due for renewal.
  rotateRemoteBearerSession: async (): Promise<never> => {
    throw new Error("No renewal is due in this test.");
  },
};

describe("mobile environment driver", () => {
  it("asks for a new pairing before opening a socket on a bearer the node rejects", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "expired-bearer-token");
    fake.upsert(record());
    const resolveRemoteWebSocketConnectionUrl = vi.fn(async () => "ws://node.local/?wsToken=t");
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      // An expired or revoked bearer: the node answers 200 authenticated:false.
      remoteApi: {
        ...noopRemoteApi,
        fetchRemoteSessionState: async () => sessionState(false),
        resolveRemoteWebSocketConnectionUrl,
      },
      subscribeResume: () => () => {},
    });

    await expect(driver.connectSavedEnvironment(record())).rejects.toBeInstanceOf(
      SavedEnvironmentCredentialError,
    );

    expect(fake.runtime(ENV_ID)).toMatchObject({
      authState: "requires-auth",
      connectionState: "disconnected",
      lastError: SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE,
    });
    expect(resolveRemoteWebSocketConnectionUrl).not.toHaveBeenCalled();
    expect(driver.supervisor.read(ENV_ID)).toBeNull();
  });

  it("leaves an unreachable node on the retry schedule rather than asking to pair", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: {
        ...noopRemoteApi,
        fetchRemoteSessionState: async () => {
          throw new Error("Network request failed");
        },
        resolveRemoteWebSocketConnectionUrl: noopRemoteApi.resolveRemoteWebSocketConnectionUrl,
      },
      subscribeResume: () => () => {},
    });

    const connecting = driver.connectSavedEnvironment(record());
    await expect(connecting).rejects.toThrow("Network request failed");
    await expect(connecting).rejects.not.toBeInstanceOf(SavedEnvironmentCredentialError);
    expect(fake.runtime(ENV_ID)).toMatchObject({ connectionState: "error" });
    expect(fake.runtime(ENV_ID)?.authState).not.toBe("requires-auth");
  });

  it("asks for a new pairing when a connected node rejects the bearer on reconnect", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
    });
    const connection = await driver.connectSavedEnvironment(record());
    expect(driver.supervisor.read(ENV_ID)).toBe(connection);
    const disposalsBefore = socketHolder.clientDisposals;

    const socketOptions = socketHolder.options.at(-1)!;
    const rejection = new RemoteEnvironmentAuthHttpError("Unauthorized request.", 401);
    expect(socketOptions.isTerminalUrlError?.(rejection)).toBe(true);
    expect(socketOptions.isTerminalUrlError?.(new Error("Network request failed"))).toBe(false);

    // The bearer expires (or is revoked) while the app runs: the next
    // reconnect's ws-token request is rejected. The protocol reports the failed
    // URL provider first, then that it stopped for good.
    socketOptions.onError?.("Unable to prepare the Ryco server WebSocket connection.");
    socketOptions.onTerminalUrlError?.(rejection);

    expect(fake.runtime(ENV_ID)).toMatchObject({
      authState: "requires-auth",
      connectionState: "disconnected",
      lastError: SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE,
    });
    await vi.waitFor(() => expect(driver.supervisor.read(ENV_ID)).toBeNull());
    expect(socketHolder.clientDisposals).toBe(disposalsBefore + 1);
    expect(fake.runtime(ENV_ID)?.authState).toBe("requires-auth");
    // The bearer stays; pairing again replaces it in place.
    await expect(fake.catalog.readBearerToken(ENV_ID)).resolves.toBe("bearer-token");
  });

  it("leaves a node that needs pairing again out of background reconnects", async () => {
    const fake = createFakeCatalog();
    const otherId = "env-2" as EnvironmentId;
    fake.catalog.runtimeStore.getState().patch(ENV_ID, { authState: "requires-auth" });
    const connect = vi.fn(async (rec: SavedEnvironmentRecord) => fakeConnection(rec.environmentId));
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
      connectSavedEnvironment: connect,
    });
    driver.start();

    fake.upsert(record());
    fake.upsert(record(otherId));
    await vi.waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: otherId }),
        expect.any(Function),
      ),
    );
    expect(connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENV_ID }),
      expect.any(Function),
    );

    // Pairing again (or the user's Connect) got the node to accept it again.
    fake.catalog.runtimeStore.getState().patch(ENV_ID, { authState: "authenticated" });
    fake.upsert(record());
    await vi.waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: ENV_ID }),
        expect.any(Function),
      ),
    );
  });

  it("clears Needs re-pair once the node accepts the saved credential again", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "new-bearer-token");
    fake.upsert(record());
    fake.catalog.runtimeStore.getState().patch(ENV_ID, { authState: "requires-auth" });
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
    });

    await driver.connectSavedEnvironment(record());

    expect(fake.runtime(ENV_ID)).toMatchObject({ authState: "authenticated", role: "owner" });
  });

  it("renews a direct pairing in use before its socket asks for a ws-token", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-1");
    fake.upsert(record());
    const dayMs = 24 * 60 * 60 * 1000;
    const resolveRemoteWebSocketConnectionUrl = vi.fn(
      async (input: { readonly bearerToken: string }) =>
        `ws://node.local/?wsToken=for-${input.bearerToken}`,
    );
    const rotateRemoteBearerSession = vi.fn(
      async () =>
        ({ sessionToken: "bearer-2", role: "owner" }) as unknown as Awaited<
          ReturnType<(typeof noopRemoteApi)["rotateRemoteBearerSession"]>
        >,
    );
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: {
        // Twenty days left of thirty: due for renewal; the renewal is fresh.
        fetchRemoteSessionState: async (input: { readonly bearerToken: string }) =>
          ({
            authenticated: true,
            role: "owner",
            sessionMethod: "bearer-session-token",
            expiresAt: new Date(
              Date.now() + (input.bearerToken === "bearer-1" ? 20 : 30) * dayMs,
            ).toISOString(),
          }) as unknown as AuthSessionState,
        resolveRemoteWebSocketConnectionUrl,
        rotateRemoteBearerSession,
      },
      subscribeResume: () => () => {},
    });

    await driver.connectSavedEnvironment(record());

    expect(rotateRemoteBearerSession).toHaveBeenCalledExactlyOnceWith({
      httpBaseUrl: "http://node.local:44342/",
      bearerToken: "bearer-1",
    });
    await expect(fake.catalog.readBearerToken(ENV_ID)).resolves.toBe("bearer-2");
    await socketHolder.urls.at(-1)!();
    expect(resolveRemoteWebSocketConnectionUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ bearerToken: "bearer-2" }),
    );
    await driver.supervisor.remove(ENV_ID);
  });

  it("lets a cancelled connect fail without touching the connection that replaced it", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "old-bearer-token");
    fake.upsert(record());
    let failSessionCheck!: (error: unknown) => void;
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: {
        ...noopRemoteApi,
        fetchRemoteSessionState: () =>
          new Promise<AuthSessionState>((_resolve, reject) => {
            failSessionCheck = reject;
          }),
        resolveRemoteWebSocketConnectionUrl: noopRemoteApi.resolveRemoteWebSocketConnectionUrl,
      },
      subscribeResume: () => () => {},
    });
    let cancelled = false;
    const staleConnect = driver.connectSavedEnvironment(record(), () => cancelled);
    await vi.waitFor(() => expect(failSessionCheck).toBeDefined());

    // A new pairing cancelled the attempt and registered its own connection.
    cancelled = true;
    const dispose = vi.fn(async () => undefined);
    const replacement = driver.supervisor.register(fakeConnection(ENV_ID, { dispose }));
    fake.catalog.runtimeStore.getState().patch(ENV_ID, {
      connectionState: "connected",
      authState: "authenticated",
    });

    failSessionCheck(new Error("Network request failed"));
    await expect(staleConnect).rejects.toThrow("Network request failed");

    expect(driver.supervisor.read(ENV_ID)).toBe(replacement);
    expect(dispose).not.toHaveBeenCalled();
    expect(fake.runtime(ENV_ID)).toMatchObject({
      connectionState: "connected",
      authState: "authenticated",
    });
  });

  it("constructs the supervisor and wires the registry + resume seams on start (no import side effects)", () => {
    const fake = createFakeCatalog();
    const resumeSubscribe = vi.fn(() => () => {});
    const connect = vi.fn(async (rec: SavedEnvironmentRecord) => fakeConnection(rec.environmentId));

    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: resumeSubscribe,
      connectSavedEnvironment: connect,
    });

    // Building the driver must not connect or subscribe anything.
    expect(driver.supervisor).toBeDefined();
    expect(resumeSubscribe).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();

    const stop = driver.start();
    expect(typeof stop).toBe("function");
    // start wires the AppState-backed resume seam.
    expect(resumeSubscribe).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
  });

  it("connects a paired environment on registry change and drives its status to connected", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
      // A fake connect that stands in for the real socket open: mark connected
      // and register the connection with the supervisor.
      connectSavedEnvironment: async (rec) => {
        fake.catalog.runtimeStore.getState().patch(rec.environmentId, {
          connectionState: "connected",
        });
        const connection = fakeConnection(rec.environmentId);
        driver.supervisor.register(connection);
        return connection;
      },
    });

    driver.start();
    fake.upsert(record());

    await vi.waitFor(() => {
      expect(fake.runtime(ENV_ID)?.connectionState).toBe("connected");
    });
    expect(driver.supervisor.read(ENV_ID)).not.toBeNull();
  });

  it("re-drives reconnect for a stale connection when AppState resumes", async () => {
    const fake = createFakeCatalog();
    let resumeListener: ((reason: string) => void) | null = null;
    const reconnect = vi.fn(async () => {});
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: (listener) => {
        resumeListener = listener;
        return () => {};
      },
      connectSavedEnvironment: async (rec) => fakeConnection(rec.environmentId),
    });
    driver.start();
    driver.supervisor.register(fakeConnection(ENV_ID, { reconnect, heartbeatFresh: false }));

    expect(resumeListener).not.toBeNull();
    resumeListener!("appstate-active");

    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
  });

  it("disconnects the requested primary without tearing down another hosted node", async () => {
    const fake = createFakeCatalog();
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
    });
    const firstId = "hosted-a" as EnvironmentId;
    const secondId = "hosted-b" as EnvironmentId;
    const disposeFirst = vi.fn(async () => undefined);
    const disposeSecond = vi.fn(async () => undefined);
    driver.supervisor.register(fakeConnection(firstId, { kind: "primary", dispose: disposeFirst }));
    driver.supervisor.register(
      fakeConnection(secondId, { kind: "primary", dispose: disposeSecond }),
    );

    await driver.supervisor.disconnectPrimary(secondId);

    expect(driver.supervisor.read(firstId)).not.toBeNull();
    expect(driver.supervisor.read(secondId)).toBeNull();
    expect(disposeFirst).not.toHaveBeenCalled();
    expect(disposeSecond).toHaveBeenCalledOnce();
  });

  it("routes a thread-stream snapshot/event from the state sink into state/threads", () => {
    const sink = createMobileEnvironmentStateSink();
    const snapshotSpy = vi
      .spyOn(useStore.getState(), "syncServerShellSnapshot")
      .mockImplementation(() => undefined);
    const eventSpy = vi
      .spyOn(useStore.getState(), "applyShellEvent")
      .mockImplementation(() => undefined);

    const snapshot = { threads: [] } as unknown as Parameters<
      typeof sink.syncServerShellSnapshot
    >[1];
    const event = { kind: "thread-upserted" } as unknown as Parameters<
      typeof sink.applyShellEvent
    >[1];

    sink.syncServerShellSnapshot(ENV_ID, snapshot);
    sink.applyShellEvent(ENV_ID, event);

    expect(snapshotSpy).toHaveBeenCalledWith(snapshot, ENV_ID);
    expect(eventSpy).toHaveBeenCalledWith(event, ENV_ID);

    snapshotSpy.mockRestore();
    eventSpy.mockRestore();
  });
});

describe("subscribeAppStateResume", () => {
  it("fires the listener only on a background -> foreground transition", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppStateResume(listener);
    expect(appStateHolder.handler).not.toBeNull();

    // Active with no prior background must not fire.
    appStateHolder.handler!("active");
    expect(listener).not.toHaveBeenCalled();

    // Background, then foreground fires exactly once.
    appStateHolder.handler!("background");
    appStateHolder.handler!("active");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("appstate-active");

    unsubscribe();
  });
});
