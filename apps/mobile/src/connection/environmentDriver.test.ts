import type { AuthSessionState, EnvironmentId } from "@ryco/contracts";
import {
  SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE,
  SavedEnvironmentCredentialError,
  type EnvironmentConnection,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
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

  it("lets a cancelled connect fail without touching the connection that replaced it", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "old-bearer-token");
    fake.upsert(record());
    let failSessionCheck!: (error: unknown) => void;
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: {
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
