import type {
  AuthSessionState,
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationThread,
  ThreadId,
} from "@ryco/contracts";
import {
  RemoteEnvironmentAuthHttpError,
  SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE,
  SavedEnvironmentCredentialError,
  type EnvironmentConnection,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
import {
  WS_URL_PROVIDER_TIMEOUT_MS,
  type WsProtocolLifecycleHandlers,
} from "@ryco/client-runtime/rpc";
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
  urls: [] as Array<(signal?: AbortSignal) => Promise<string>>,
  options: [] as Array<WsProtocolLifecycleHandlers>,
  clientDisposals: 0,
}));
vi.mock("../rpc/wsTransport", () => ({
  WsTransport: class {
    constructor(
      url: (signal?: AbortSignal) => Promise<string>,
      options: WsProtocolLifecycleHandlers,
    ) {
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

import { installHostedPrimaryConnectionFactory } from "../hostedHub/primaryConnectionFactory";
import type { HostedPrimaryConnectionDeps } from "../hostedHub/primaryConnection";
import { useComposerDraftStore } from "../state/composerDraftStore";
import { useMessageQueueStore } from "../state/messageQueueStore";
import { subscribeAppStateResume } from "./appStateResume";
import { createMobileEnvironmentDriver, type MobileCatalogLike } from "./environmentDriver";
import { createMobileEnvironmentStateSink } from "./environmentStateSink";
import { createSavedSessionHints, type SavedSessionHints } from "./savedSessionHints";
import { selectThreadDetailLoaded, useStore } from "../state/threadsRuntime";
import { selectThreadBodyUsage } from "@ryco/client-runtime/state/threads/threadBodyResidency";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";

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
    config: { read: () => null, subscribe: () => () => {} },
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** A bearer session the node answered for, with `daysLeft` of its 30 days left. */
function bearerSession(daysLeft: number, role = "owner"): AuthSessionState {
  return {
    authenticated: true,
    role,
    sessionMethod: "bearer-session-token",
    expiresAt: new Date(Date.now() + daysLeft * DAY_MS).toISOString(),
    auth: {},
  } as unknown as AuthSessionState;
}

function memoryHints(initial?: AuthSessionState): SavedSessionHints {
  const values = new Map<string, string>();
  if (initial) {
    values.set(
      "ryco.savedEnvironments.sessionHints.v1",
      JSON.stringify({ version: 1, sessions: { [ENV_ID]: initial } }),
    );
  }
  return createSavedSessionHints({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
  });
}

describe("mobile environment driver with session hints", () => {
  it("connects a session far from renewal without asking first, then checks in the background", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const registeredWhenAsked: boolean[] = [];
    const fetchRemoteSessionState = vi.fn(async () => {
      registeredWhenAsked.push(driver.supervisor.read(ENV_ID) !== null);
      return bearerSession(29.5, "client");
    });
    const sessionHints = memoryHints(bearerSession(29.6));
    const driver: ReturnType<typeof createMobileEnvironmentDriver> = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: { ...noopRemoteApi, fetchRemoteSessionState },
      subscribeResume: () => () => {},
      sessionHints,
    });

    const connection = await driver.connectSavedEnvironment(record());
    expect(driver.supervisor.read(ENV_ID)).toBe(connection);
    expect(fake.runtime(ENV_ID)?.role).toBe("owner");

    // The skipped question is asked once the connection exists, and its answer
    // replaces the hinted role and the remembered session.
    await vi.waitFor(() => expect(fetchRemoteSessionState).toHaveBeenCalledOnce());
    expect(registeredWhenAsked).toEqual([true]);
    await vi.waitFor(() => expect(fake.runtime(ENV_ID)?.role).toBe("client"));
    expect((await sessionHints.read(ENV_ID))?.role).toBe("client");
    await driver.supervisor.remove(ENV_ID);
  });

  it("asks before the socket again once the remembered session is forgotten", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const registeredWhenAsked: boolean[] = [];
    const fetchRemoteSessionState = vi.fn(async () => {
      registeredWhenAsked.push(driver.supervisor.read(ENV_ID) !== null);
      return bearerSession(29.5);
    });
    const sessionHints = memoryHints(bearerSession(29.6));
    const driver: ReturnType<typeof createMobileEnvironmentDriver> = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: { ...noopRemoteApi, fetchRemoteSessionState },
      subscribeResume: () => () => {},
      sessionHints,
    });

    // A re-pairing or removal replaces the credential the hint described.
    driver.forgetSessionHint(ENV_ID);
    await expect(sessionHints.read(ENV_ID)).resolves.toBeNull();
    await driver.connectSavedEnvironment(record());
    expect(registeredWhenAsked).toEqual([false]);
    await driver.supervisor.remove(ENV_ID);
  });

  it("does not remember the answer of an attempt a new pairing cancelled", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "replaced-bearer");
    fake.upsert(record());
    let cancelled = false;
    const fetchRemoteSessionState = vi.fn(async () => {
      // The pairing replaces the credential while this check is in flight.
      cancelled = true;
      return bearerSession(29.5, "client");
    });
    const sessionHints = memoryHints();
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: { ...noopRemoteApi, fetchRemoteSessionState },
      subscribeResume: () => () => {},
      sessionHints,
    });

    await expect(driver.connectSavedEnvironment(record(), () => cancelled)).rejects.toThrow();
    expect(fetchRemoteSessionState).toHaveBeenCalledOnce();
    await expect(sessionHints.read(ENV_ID)).resolves.toBeNull();
    expect(driver.supervisor.read(ENV_ID)).toBeNull();
  });

  it("asks before the socket when the remembered session is due for renewal", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const fetchRemoteSessionState = vi.fn(async () => bearerSession(29.5));
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: { ...noopRemoteApi, fetchRemoteSessionState },
      subscribeResume: () => () => {},
      // Ten days into its lifetime: renewal is due, so the node is asked first.
      sessionHints: memoryHints(bearerSession(20)),
    });

    await driver.connectSavedEnvironment(record()).catch(() => undefined);
    expect(fetchRemoteSessionState).toHaveBeenCalled();
    await driver.supervisor.remove(ENV_ID);
  });

  it("asks first, and remembers the answer, when nothing is remembered", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const fetchRemoteSessionState = vi.fn(async () => bearerSession(29.5));
    const sessionHints = memoryHints();
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: { ...noopRemoteApi, fetchRemoteSessionState },
      subscribeResume: () => () => {},
      sessionHints,
    });

    await driver.connectSavedEnvironment(record());
    expect(fetchRemoteSessionState).toHaveBeenCalledOnce();
    expect((await sessionHints.read(ENV_ID))?.sessionMethod).toBe("bearer-session-token");
    await driver.supervisor.remove(ENV_ID);
  });

  it("ends the connection and forgets the hint when the background check finds the session gone", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const sessionHints = memoryHints(bearerSession(29.6));
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: { ...noopRemoteApi, fetchRemoteSessionState: async () => sessionState(false) },
      subscribeResume: () => () => {},
      sessionHints,
    });

    await driver.connectSavedEnvironment(record());

    await vi.waitFor(() => expect(driver.supervisor.read(ENV_ID)).toBeNull());
    expect(fake.runtime(ENV_ID)).toMatchObject({
      authState: "requires-auth",
      lastError: SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE,
    });
    expect(await sessionHints.read(ENV_ID)).toBeNull();
  });

  it("remembers the renewed session after an in-session renewal, so the next connect skips the check", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeCatalog();
      fake.setBearerToken(ENV_ID, "bearer-1");
      fake.upsert(record());
      // Each bearer lives thirty days from when it was issued.
      const issuedAt = new Map([["bearer-1", Date.now()]]);
      const asked: Array<{ readonly bearer: string; readonly registered: boolean }> = [];
      const fetchRemoteSessionState = vi.fn(async (input: { readonly bearerToken: string }) => {
        asked.push({
          bearer: input.bearerToken,
          registered: driver.supervisor.read(ENV_ID) !== null,
        });
        return {
          authenticated: true,
          role: "owner",
          sessionMethod: "bearer-session-token",
          expiresAt: new Date(issuedAt.get(input.bearerToken)! + 30 * DAY_MS).toISOString(),
          auth: {},
        } as unknown as AuthSessionState;
      });
      const sessionHints = memoryHints();
      const driver: ReturnType<typeof createMobileEnvironmentDriver> =
        createMobileEnvironmentDriver({
          catalog: fake.catalog,
          remoteApi: {
            ...noopRemoteApi,
            fetchRemoteSessionState,
            rotateRemoteBearerSession: async () => {
              issuedAt.set("bearer-2", Date.now());
              return { sessionToken: "bearer-2", role: "owner" } as unknown as Awaited<
                ReturnType<(typeof noopRemoteApi)["rotateRemoteBearerSession"]>
              >;
            },
          },
          subscribeResume: () => () => {},
          sessionHints,
        });
      await driver.connectSavedEnvironment(record());

      // Connected for a day: the pairing renews in place.
      await vi.advanceTimersByTimeAsync(DAY_MS + 60_000);
      await expect(fake.catalog.readBearerToken(ENV_ID)).resolves.toBe("bearer-2");
      expect((await sessionHints.read(ENV_ID))?.expiresAt).toBe(
        new Date(issuedAt.get("bearer-2")! + 30 * DAY_MS).toISOString(),
      );

      // The next connect presents bearer-2 straight away and asks afterwards.
      await driver.supervisor.remove(ENV_ID);
      asked.length = 0;
      await driver.connectSavedEnvironment(record());
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toEqual([{ bearer: "bearer-2", registered: true }]);
      await driver.supervisor.remove(ENV_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the hint when the ws-token request rejects the bearer", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const sessionHints = memoryHints(bearerSession(29.6));
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      // The background check never answers, so only the socket reports.
      remoteApi: { ...noopRemoteApi, fetchRemoteSessionState: () => new Promise(() => {}) },
      subscribeResume: () => () => {},
      sessionHints,
    });

    await driver.connectSavedEnvironment(record());
    socketHolder.options
      .at(-1)!
      .onTerminalUrlError?.(new RemoteEnvironmentAuthHttpError("Unauthorized request.", 401));

    expect(fake.runtime(ENV_ID)?.authState).toBe("requires-auth");
    expect(await sessionHints.read(ENV_ID)).toBeNull();
    await vi.waitFor(() => expect(driver.supervisor.read(ENV_ID)).toBeNull());
  });
});

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

  it("bounds the direct ws-token request and abandons it with its connect attempt", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-1");
    fake.upsert(record());
    const resolveRemoteWebSocketConnectionUrl = vi.fn(
      noopRemoteApi.resolveRemoteWebSocketConnectionUrl,
    );
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: { ...noopRemoteApi, resolveRemoteWebSocketConnectionUrl },
      subscribeResume: () => () => {},
    });

    await driver.connectSavedEnvironment(record());

    expect(socketHolder.options.at(-1)?.urlProviderTimeoutMs).toBe(WS_URL_PROVIDER_TIMEOUT_MS);
    const attempt = new AbortController();
    await socketHolder.urls.at(-1)!(attempt.signal);
    expect(resolveRemoteWebSocketConnectionUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ bearerToken: "bearer-1", signal: attempt.signal }),
    );
    await driver.supervisor.remove(ENV_ID);
  });

  it("never presents a bearer a renewal superseded when the stored one cannot be read", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeCatalog();
      fake.setBearerToken(ENV_ID, "bearer-1");
      fake.upsert(record());
      const dayMs = 24 * 60 * 60 * 1000;
      // Each bearer lives thirty days from when it was issued.
      const issuedAt = new Map([["bearer-1", Date.now()]]);
      const resolveRemoteWebSocketConnectionUrl = vi.fn(
        async (input: { readonly bearerToken: string }) =>
          `ws://node.local/?wsToken=for-${input.bearerToken}`,
      );
      const rotateRemoteBearerSession = vi.fn(async () => {
        issuedAt.set("bearer-2", Date.now());
        return { sessionToken: "bearer-2", role: "owner" } as unknown as Awaited<
          ReturnType<(typeof noopRemoteApi)["rotateRemoteBearerSession"]>
        >;
      });
      const driver = createMobileEnvironmentDriver({
        catalog: fake.catalog,
        remoteApi: {
          fetchRemoteSessionState: async (input: { readonly bearerToken: string }) =>
            ({
              authenticated: true,
              role: "owner",
              sessionMethod: "bearer-session-token",
              expiresAt: new Date(issuedAt.get(input.bearerToken)! + 30 * dayMs).toISOString(),
            }) as unknown as AuthSessionState,
          resolveRemoteWebSocketConnectionUrl,
          rotateRemoteBearerSession,
        },
        subscribeResume: () => () => {},
      });
      await driver.connectSavedEnvironment(record());
      expect(rotateRemoteBearerSession).not.toHaveBeenCalled();

      // The connection stays up for a day: it renews in place, and bearer-1 is
      // superseded once bearer-2 is used.
      await vi.advanceTimersByTimeAsync(dayMs + 60_000);
      expect(rotateRemoteBearerSession).toHaveBeenCalledExactlyOnceWith({
        httpBaseUrl: "http://node.local:44342/",
        bearerToken: "bearer-1",
      });
      await expect(fake.catalog.readBearerToken(ENV_ID)).resolves.toBe("bearer-2");

      // Later the socket reconnects while the keychain is locked.
      vi.spyOn(fake.catalog, "readBearerToken").mockRejectedValue(
        new Error("errSecInteractionNotAllowed"),
      );
      resolveRemoteWebSocketConnectionUrl.mockClear();
      await expect(socketHolder.urls.at(-1)!()).rejects.toThrow(
        "This environment's saved credential could not be read.",
      );
      expect(resolveRemoteWebSocketConnectionUrl).not.toHaveBeenCalled();
      await driver.supervisor.remove(ENV_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a connection's pairing renewed from its renewal, and stops with the connection", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeCatalog();
      fake.setBearerToken(ENV_ID, "bearer-1");
      fake.upsert(record());
      const dayMs = 24 * 60 * 60 * 1000;
      const fetchRemoteSessionState = vi.fn(
        async (input: { readonly bearerToken: string }) =>
          ({
            authenticated: true,
            role: "owner",
            sessionMethod: "bearer-session-token",
            // Twenty days left of thirty: due for renewal; the renewal is fresh.
            expiresAt: new Date(
              Date.now() + (input.bearerToken === "bearer-1" ? 20 : 30) * dayMs,
            ).toISOString(),
          }) as unknown as AuthSessionState,
      );
      const driver = createMobileEnvironmentDriver({
        catalog: fake.catalog,
        remoteApi: {
          ...noopRemoteApi,
          fetchRemoteSessionState,
          rotateRemoteBearerSession: async () =>
            ({ sessionToken: "bearer-2", role: "owner" }) as unknown as Awaited<
              ReturnType<(typeof noopRemoteApi)["rotateRemoteBearerSession"]>
            >,
        },
        subscribeResume: () => () => {},
      });

      await driver.connectSavedEnvironment(record());
      // The session check, then the renewal's first use.
      expect(fetchRemoteSessionState.mock.calls.map(([input]) => input.bearerToken)).toEqual([
        "bearer-1",
        "bearer-2",
      ]);

      // The renewal is next due a day after the renewed session began, not now.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchRemoteSessionState).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);

      // Removed: its renewal stops with it rather than waiting out the day.
      await driver.supervisor.remove(ENV_ID);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a replaced connection's socket from reporting over its replacement", async () => {
    const fake = createFakeCatalog();
    fake.setBearerToken(ENV_ID, "bearer-token");
    fake.upsert(record());
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
    });
    await driver.connectSavedEnvironment(record());
    const socketOptions = socketHolder.options.at(-1)!;

    // Paired again: a new connection replaced this one and is connected.
    await driver.supervisor.remove(ENV_ID);
    driver.supervisor.register(fakeConnection(ENV_ID));
    fake.catalog.runtimeStore.getState().patch(ENV_ID, {
      connectionState: "connected",
      lastError: null,
    });

    // The old socket reports until it has fully stopped.
    socketOptions.onAttempt?.("ws://node.local/ws");
    socketOptions.onError?.("Unable to connect to the Ryco server WebSocket.");
    socketOptions.onClose?.({ code: 1006, reason: "Socket dropped." }, { intentional: false });

    expect(fake.runtime(ENV_ID)).toMatchObject({ connectionState: "connected", lastError: null });
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

  it("defers the hosted primary until it is admitted, then connects it once", async () => {
    const fake = createFakeCatalog();
    const primaryId = "hosted-deferred" as EnvironmentId;
    const factory = vi.fn(() => fakeConnection(primaryId, { kind: "primary" }));
    installHostedPrimaryConnectionFactory(factory);
    let admitted = false;
    const connect = vi.fn(async (rec: SavedEnvironmentRecord) => fakeConnection(rec.environmentId));
    try {
      const driver = createMobileEnvironmentDriver({
        catalog: fake.catalog,
        remoteApi: noopRemoteApi,
        subscribeResume: () => () => {},
        connectSavedEnvironment: connect,
        admitPrimaryConnection: () => admitted,
      });
      fake.setBearerToken(ENV_ID, "bearer-token");
      fake.upsert(record());

      // The direct plane starts before the snapshot cache has hydrated; the
      // hosted primary does not.
      const stop = driver.start();
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
      expect(factory).not.toHaveBeenCalled();
      expect(driver.supervisor.read(primaryId)).toBeNull();

      admitted = true;
      driver.releaseDeferredPrimaryConnection();
      expect(factory).toHaveBeenCalledOnce();
      expect(driver.supervisor.read(primaryId)?.kind).toBe("primary");

      // Released once: a second release does not build another candidate.
      driver.releaseDeferredPrimaryConnection();
      expect(factory).toHaveBeenCalledOnce();

      // The hosted connection receives a priority handler, so it opts into
      // thread-priority deltas, and the handler reaches the supervisor.
      const [primaryDeps] = factory.mock.calls[0] as unknown as [HostedPrimaryConnectionDeps];
      const applyPriorities = vi
        .spyOn(driver.supervisor, "applyThreadPriorities")
        .mockImplementation(() => undefined);
      const item = { kind: "thread-priorities" } as unknown as Parameters<
        HostedPrimaryConnectionDeps["applyThreadPriorities"]
      >[0];
      primaryDeps.applyThreadPriorities(item, primaryId);
      expect(applyPriorities).toHaveBeenCalledExactlyOnceWith(item, primaryId);
      applyPriorities.mockRestore();
      stop();
      await driver.supervisor.remove(primaryId);
    } finally {
      installHostedPrimaryConnectionFactory(null);
    }
  });

  it("asks thread windows for activity previews", () => {
    const fake = createFakeCatalog();
    const driver = createMobileEnvironmentDriver({
      catalog: fake.catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
    });
    const subscribeThreadWindow = vi.fn(() => () => undefined);
    const connection = fakeConnection(ENV_ID);
    (connection.client as { orchestration?: unknown }).orchestration = { subscribeThreadWindow };
    driver.supervisor.register(connection);

    const release = driver.supervisor.retainThreadDetailSubscription(
      ENV_ID,
      "thread-preview" as ThreadId,
    );

    // Full tool output and diffs are read on expand, not shipped in every window.
    expect(subscribeThreadWindow).toHaveBeenCalledOnce();
    expect(subscribeThreadWindow.mock.calls[0]).toEqual([
      expect.objectContaining({ activityPayloads: "preview" }),
      expect.any(Function),
      expect.anything(),
    ]);
    release();
  });

  it("applies one frame's detail events as one batch, before a later window snapshot, and on stop", () => {
    const environmentId = "env-detail-batch" as EnvironmentId;
    const threadId = "thread-batch" as ThreadId;
    const ref = { environmentId, threadId };
    const sink = createMobileEnvironmentStateSink();
    const applied: Array<{ readonly sequences: number[]; readonly detailLoaded: boolean }> = [];
    const applySpy = vi
      .spyOn(sink, "applyOrchestrationEvents")
      .mockImplementation((_environmentId, events) => {
        applied.push({
          sequences: events.map((event) => event.sequence),
          detailLoaded: selectThreadDetailLoaded(useStore.getState(), ref),
        });
      });
    const frames: Array<() => void> = [];
    const driver = createMobileEnvironmentDriver({
      catalog: createFakeCatalog().catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
      stateSink: sink,
      threadDetailEventScheduling: {
        scheduleFrame: (callback) => frames.push(callback),
        scheduleFallback: () => undefined,
      },
    });
    const stop = driver.start();
    let emit: ((item: unknown) => void) | null = null;
    const connection = fakeConnection(environmentId);
    (connection.client as { orchestration?: unknown }).orchestration = {
      subscribeThreadWindow: (_input: unknown, listener: (item: unknown) => void) => {
        emit = listener;
        return () => undefined;
      },
    };
    driver.supervisor.register(connection);
    const release = driver.supervisor.retainThreadDetailSubscription(environmentId, threadId);
    expect(emit).not.toBeNull();
    const event = (sequence: number) =>
      ({
        sequence,
        type: "thread.message-sent",
        payload: { threadId, messageId: "message-1", text: `delta ${sequence}`, streaming: true },
      }) as unknown as OrchestrationEvent;

    for (const sequence of [1, 2, 3]) emit!({ kind: "event", event: event(sequence) });
    expect(applied).toEqual([]);
    expect(frames).toHaveLength(1);

    // A window snapshot is a store write: the buffered events land first, as
    // one batch, before the snapshot loads the detail.
    const page = { cursor: null, hasMore: false };
    emit!({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 4,
        thread: {
          id: threadId,
          projectId: "project-1",
          title: "Batch",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          worktreeId: null,
          latestTurn: null,
          createdAt: "2026-10-15T00:00:00.000Z",
          updatedAt: "2026-10-15T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        } as unknown as OrchestrationThread,
        history: { messages: page, proposedPlans: page, activities: page, checkpoints: page },
      },
    });
    expect(applied).toEqual([{ sequences: [1, 2, 3], detailLoaded: false }]);
    expect(selectThreadDetailLoaded(useStore.getState(), ref)).toBe(true);
    frames[0]!();
    expect(applied).toHaveLength(1);

    // Stopping the driver applies what is still buffered.
    emit!({ kind: "event", event: event(5) });
    expect(applied).toHaveLength(1);
    stop();
    expect(applied.at(-1)).toEqual({ sequences: [5], detailLoaded: true });

    release();
    applySpy.mockRestore();
    void driver.supervisor.remove(environmentId);
  });

  it("keeps the body of a running thread and of one with a queued send or unsent draft, while old idle bodies go", async () => {
    const environmentId = "env-residency" as EnvironmentId;
    const listeners = new Map<string, (item: unknown) => void>();
    const driver = createMobileEnvironmentDriver({
      catalog: createFakeCatalog().catalog,
      remoteApi: noopRemoteApi,
      subscribeResume: () => () => {},
    });
    const connection = fakeConnection(environmentId);
    (connection.client as { orchestration?: unknown }).orchestration = {
      subscribeThreadWindow: (
        input: { readonly threadId: string },
        listener: (item: unknown) => void,
      ) => {
        listeners.set(input.threadId, listener);
        return () => undefined;
      },
    };
    driver.supervisor.register(connection);

    const page = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };
    const windowSnapshot = (threadId: string, running: boolean) => ({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: {
          id: threadId,
          projectId: "project-1",
          title: threadId,
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          worktreeId: null,
          latestTurn: running
            ? {
                turnId: "turn-1",
                state: "running",
                requestedAt: "2026-10-15T00:00:00.000Z",
                startedAt: "2026-10-15T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
          createdAt: "2026-10-15T00:00:00.000Z",
          updatedAt: "2026-10-15T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: `${threadId}-message`,
              role: "user",
              text: "hello",
              turnId: null,
              streaming: false,
              createdAt: "2026-10-15T00:00:00.000Z",
              updatedAt: "2026-10-15T00:00:00.000Z",
            },
          ],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
        history: { messages: page, proposedPlans: page, activities: page, checkpoints: page },
      },
    });
    const refOf = (index: number) => scopeThreadRef(environmentId, `thread-${index}` as ThreadId);
    const bodyCount = () =>
      selectThreadBodyUsage(useStore.getState()).filter(
        ({ ref }) => ref.environmentId === environmentId,
      ).length;

    // thread-0 and thread-1 are the oldest idle threads: only their work keeps them.
    useMessageQueueStore.getState().enqueue(`${environmentId}:thread-0`, {
      id: "queued-message",
      composer: {},
      settings: {},
    });
    useComposerDraftStore.getState().setPrompt(refOf(1), "unsent draft");
    // A draft entry that holds only a changed composer mode is no unsent work.
    useComposerDraftStore.getState().setInteractionMode(refOf(4), "plan");
    try {
      for (let index = 0; index < 70; index += 1) {
        const release = driver.supervisor.retainThreadDetailSubscription(
          environmentId,
          `thread-${index}` as ThreadId,
          { view: true },
        );
        // thread-2 is mid-turn, so it is busy rather than idle.
        listeners.get(`thread-${index}`)?.(windowSnapshot(`thread-${index}`, index === 2));
        release();
        await Promise.resolve();
      }
      await Promise.resolve();

      const loaded = (index: number) => selectThreadDetailLoaded(useStore.getState(), refOf(index));
      expect(loaded(0)).toBe(true);
      expect(loaded(1)).toBe(true);
      expect(loaded(2)).toBe(true);
      // 70 bodies against a budget of 64: the oldest six unprotected ones go.
      expect(loaded(3)).toBe(false);
      expect(loaded(4)).toBe(false);
      expect(loaded(8)).toBe(false);
      expect(loaded(9)).toBe(true);
      expect(loaded(69)).toBe(true);
      expect(bodyCount()).toBe(64);
    } finally {
      useMessageQueueStore.getState().clear(`${environmentId}:thread-0`);
      useComposerDraftStore.getState().setPrompt(refOf(1), "");
      useComposerDraftStore.getState().setInteractionMode(refOf(4), null);
      await driver.supervisor.resetForTests();
      useStore.getState().removeEnvironmentState(environmentId);
    }
  });

  it("routes a thread-stream snapshot/event from the state sink into state/threads", () => {
    const sink = createMobileEnvironmentStateSink();
    const snapshotSpy = vi
      .spyOn(useStore.getState(), "syncServerShellSnapshot")
      .mockImplementation(() => undefined);
    const eventSpy = vi.spyOn(useStore.getState(), "applyShellEvents").mockImplementation(() => []);

    const snapshot = { threads: [] } as unknown as Parameters<
      typeof sink.syncServerShellSnapshot
    >[1];
    const event = { kind: "thread-upserted" } as unknown as Parameters<
      typeof sink.applyShellEvents
    >[1][number];

    sink.syncServerShellSnapshot(ENV_ID, snapshot);
    sink.applyShellEvents(ENV_ID, [event]);

    expect(snapshotSpy).toHaveBeenCalledWith(snapshot, ENV_ID);
    expect(eventSpy).toHaveBeenCalledWith([event], ENV_ID, expect.any(Function));

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

  it("ignores inactive interruptions but resumes after background passes through inactive", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppStateResume(listener);

    // Notification Center or the app-switcher peek: inactive and straight back.
    appStateHolder.handler!("inactive");
    appStateHolder.handler!("active");
    expect(listener).not.toHaveBeenCalled();

    // A real background trip returns through inactive before active.
    appStateHolder.handler!("background");
    appStateHolder.handler!("inactive");
    expect(listener).not.toHaveBeenCalled();
    appStateHolder.handler!("active");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
