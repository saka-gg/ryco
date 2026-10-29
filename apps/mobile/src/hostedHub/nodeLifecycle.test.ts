import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";
import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => {
  const connections = new Map<string, { readonly environmentId: string }>();
  return {
    hydrated: true,
    deferred: [] as Array<() => Promise<void>>,
    directEnvironments: new Set<string>(),
    setActive: vi.fn(),
    demote: vi.fn(),
    reconcile: vi.fn(),
    writeDescriptor: vi.fn(),
    connections,
    supervisor: {
      read: (environmentId: string) => connections.get(environmentId) ?? null,
      register: vi.fn((connection: { readonly environmentId: string }) => {
        const existing = connections.get(connection.environmentId);
        if (existing && existing !== connection) {
          throw new Error(`Environment ${connection.environmentId} already has a connection.`);
        }
        connections.set(connection.environmentId, connection);
        return connection;
      }),
      remove: vi.fn(async (environmentId: string) => {
        const connection = connections.get(environmentId) as
          | { readonly dispose: () => Promise<void> }
          | undefined;
        if (!connection) return false;
        connections.delete(environmentId);
        await connection.dispose();
        return true;
      }),
      disposeThreadDetailSubscriptionsForEnvironment: vi.fn(),
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      applyThreadPriorities: vi.fn(),
      syncShellSnapshot: vi.fn(),
    },
  };
});
vi.mock("../runtime/bootstrap", () => ({
  createMobileConnectionRegistry: () => ({
    catalog: {
      get: (environmentId: string) =>
        fixture.directEnvironments.has(environmentId) ? { environmentId } : null,
    },
    driver: { supervisor: fixture.supervisor },
  }),
}));
vi.mock("../runtime/startupBarrier", () => ({
  mobileRuntimeStartupBarrier: {
    isHydrated: () => fixture.hydrated,
    runAfterHydration: (work: () => void, onFailure: (error: unknown) => void) => {
      fixture.deferred.push(() => Promise.resolve().then(work).catch(onFailure));
    },
  },
}));
vi.mock("../connection/hostedConnectionCoordinator", () => ({
  readMobileHostedConnectionCoordinator: () => ({
    requestEnvironmentReconcile: fixture.reconcile,
  }),
}));
vi.mock("../state/threadsRuntime", () => ({
  useStore: { getState: () => ({ setActiveEnvironmentId: fixture.setActive }) },
}));
vi.mock("./nodeStateCleanup", () => ({ demoteMobileHostedEnvironmentState: fixture.demote }));
vi.mock("./primaryEnvironment", () => ({
  writePrimaryEnvironmentDescriptor: fixture.writeDescriptor,
}));

import {
  configureHostedRuntime,
  getHostedEnvironmentSessions,
  hostedHubController,
  hostedHubStore,
  markHostedSessionReady,
  resetHostedEnvironmentSessionsForTests,
  type HostedHubApi,
  type HostedHubNode,
  type HostedHubSessionResponse,
} from "@ryco/client-runtime/authorization";

import {
  mobileHostedNodeLifecycle,
  resetMobileHostedEnvironmentConnectionsForTests,
} from "./nodeLifecycle";
import { installHostedEnvironmentConnectionFactory } from "./primaryConnectionFactory";

function hubNode(suffix: string): HostedHubNode {
  return {
    id: `node_${suffix}`,
    environmentId: EnvironmentId.make(`env_${suffix}`),
    label: `Node ${suffix}`,
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix}`, role: "owner" },
    effectiveRole: "owner",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

const nodeA = hubNode("a");
const nodeB = hubNode("b");
const envA = nodeA.environmentId;
const envB = nodeB.environmentId;

const sessionResponse: HostedHubSessionResponse = {
  account: {
    id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Ada",
    role: "owner",
    createdAt: 1,
    disabledAt: null,
  },
  session: {
    id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
    accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    createdAt: 1,
    expiresAt: 2,
    lastSeenAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
  },
  csrfToken: "csrf-token",
};

const hostedHubApi = {
  credentialMode: "bearer",
  restoreSession: vi.fn(async () => sessionResponse),
  listNodes: vi.fn(async () => [nodeA, nodeB]),
  getBootstrapAvailability: vi.fn(async () => false),
  signOut: vi.fn(async () => undefined),
  clearSessionMaterial: vi.fn(),
} as unknown as HostedHubApi;

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the node lifecycle tests");
    },
  },
);

interface FakeConnection {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
  readonly dispose: ReturnType<typeof vi.fn>;
}

const built: FakeConnection[] = [];
const environmentFactory = vi.fn(
  (input: { readonly node: HostedHubNode; readonly generation: number }) => {
    const connection: FakeConnection = {
      environmentId: input.node.environmentId,
      generation: input.generation,
      dispose: vi.fn(async () => undefined),
    };
    built.push(connection);
    return connection as unknown as EnvironmentConnection;
  },
);

function sessions() {
  return getHostedEnvironmentSessions();
}

function generationOf(environmentId: EnvironmentId): number {
  const record = sessions().read(environmentId);
  if (record === undefined) throw new Error(`no record for ${environmentId}`);
  return record.generation;
}

/** The connection's own attempt reached the node and its own snapshot was accepted. */
function establish(environmentId: EnvironmentId): void {
  const generation = generationOf(environmentId);
  sessions().transportStatus(environmentId, generation, "online");
  markHostedSessionReady(environmentId, generation);
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

/** What the demand executor does: connect the environment through the controller. */
async function acquire(node: HostedHubNode): Promise<string> {
  const answer = await hostedHubController.acquireEnvironment(node.id);
  await flush();
  return answer;
}

function lifecyclePortCalls(): number {
  return (
    environmentFactory.mock.calls.length +
    fixture.supervisor.register.mock.calls.length +
    fixture.supervisor.remove.mock.calls.length +
    fixture.reconcile.mock.calls.length
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  built.length = 0;
  fixture.hydrated = true;
  fixture.deferred.length = 0;
  fixture.directEnvironments.clear();
  fixture.connections.clear();
  installHostedEnvironmentConnectionFactory(environmentFactory);
  configureHostedRuntime(
    {
      endpoint: unusedService as EndpointService,
      httpClient: unusedService as HttpClientService,
      passkeyCeremony: unusedService as PasskeyCeremonyService,
      sessionCredentials: unusedService as SessionCredentialsService,
      nodeLifecycle: mobileHostedNodeLifecycle,
      environmentSessions: "retained",
      timers: {
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (timer) => globalThis.clearTimeout(timer),
        queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
      },
      isForeground: () => true,
      subscribeForeground: () => () => undefined,
      hasPendingRelayRequests: () => false,
      resetRelayAttemptFactory: () => undefined,
      relayUrl: () => "wss://hub.example.test/v1/relay/client",
      createRelaySocket: () => {
        throw new Error("no relay socket is opened by the node lifecycle tests");
      },
    },
    hostedHubApi,
  );
  await hostedHubController.bootstrap();
  expect(hostedHubStore.getState()).toMatchObject({
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
  });
});

afterEach(async () => {
  await flush();
  hostedHubController.resetForTests();
  resetHostedEnvironmentSessionsForTests();
  resetMobileHostedEnvironmentConnectionsForTests();
  installHostedEnvironmentConnectionFactory(null);
});

describe("mobile hosted node lifecycle with retained environment sessions", () => {
  it("re-selects a warm node with no lifecycle call and is mutation-ready in the same tick", async () => {
    expect(await acquire(nodeA)).toBe("connecting");
    expect(await acquire(nodeB)).toBe("connecting");
    establish(envA);
    establish(envB);
    void hostedHubController.selectNode(nodeA.id);
    expect(built.map((connection) => connection.environmentId)).toEqual([envA, envB]);
    vi.clearAllMocks();

    void hostedHubController.selectNode(nodeB.id);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeB,
      transportStatus: "online",
      sessionStatus: "ready",
      browserStatus: "current",
    });

    void hostedHubController.selectNode(nodeA.id);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      transportStatus: "online",
      sessionStatus: "ready",
      browserStatus: "current",
    });
    expect(await acquire(nodeA)).toBe("adopted");

    // No connection built, registered or removed, nothing re-planned, and no
    // Hub request: both channels stay exactly as they were.
    expect(lifecyclePortCalls()).toBe(0);
    expect(hostedHubApi.restoreSession).not.toHaveBeenCalled();
    expect(hostedHubApi.listNodes).not.toHaveBeenCalled();
    expect(fixture.connections.size).toBe(2);
    expect(built.every((connection) => connection.dispose.mock.calls.length === 0)).toBe(true);
  });

  it("joins a node whose dropped channel is already reconnecting", async () => {
    await acquire(nodeA);
    await acquire(nodeB);
    establish(envA);
    establish(envB);
    void hostedHubController.selectNode(nodeB.id);
    sessions().connectionClosed(envA, generationOf(envA));
    vi.clearAllMocks();

    void hostedHubController.selectNode(nodeA.id);
    expect(await acquire(nodeA)).toBe("joined");

    // Its own transport replaces the channel; selecting it starts nothing.
    expect(lifecyclePortCalls()).toBe(0);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      transportStatus: "reconnecting",
      sessionStatus: "stale",
    });
  });

  it("starts a failed node over once when it is selected again", async () => {
    await acquire(nodeA);
    await acquire(nodeB);
    establish(envA);
    establish(envB);
    void hostedHubController.selectNode(nodeB.id);
    const failed = generationOf(envA);
    sessions().failure(envA, failed, { kind: "authentication", retryable: false });
    vi.clearAllMocks();

    void hostedHubController.selectNode(nodeA.id);
    expect(fixture.reconcile).toHaveBeenCalledExactlyOnceWith({
      reason: "retry",
      environmentId: envA,
    });
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      sessionStatus: "synchronizing",
    });

    expect(await acquire(nodeA)).toBe("connecting");
    // The failed generation's connection is replaced by exactly one new one.
    expect(environmentFactory).toHaveBeenCalledOnce();
    expect(built.at(-1)).toMatchObject({ environmentId: envA, generation: generationOf(envA) });
    expect(built.at(-1)!.generation).toBeGreaterThan(failed);
    expect(fixture.supervisor.remove).toHaveBeenCalledExactlyOnceWith(envA);
    expect(fixture.connections.get(envA)).toBe(built.at(-1));
    expect(fixture.connections.get(envB)).toBeDefined();
  });

  it("never lets a late teardown of an older generation touch the newer connection", async () => {
    await acquire(nodeA);
    const older = generationOf(envA);
    sessions().renew(envA);
    await acquire(nodeA);
    const newer = built.at(-1)!;
    expect(newer.generation).toBeGreaterThan(older);

    await mobileHostedNodeLifecycle.releaseEnvironment!(envA, older);
    await mobileHostedNodeLifecycle.suspendEnvironment!(envA, older);

    expect(fixture.connections.get(envA)).toBe(newer);
    expect(newer.dispose).not.toHaveBeenCalled();

    // A connection request for the older generation opens nothing either.
    mobileHostedNodeLifecycle.connectEnvironment!(nodeA, older);
    expect(environmentFactory).toHaveBeenCalledTimes(2);
  });

  it("suspends a connection's transport and keeps what it displays", async () => {
    await acquire(nodeA);
    const connection = built.at(-1)!;

    hostedHubController.suspendBrowser("hidden");
    await flush();

    expect(fixture.connections.has(envA)).toBe(false);
    expect(connection.dispose).toHaveBeenCalledOnce();
    expect(fixture.demote).not.toHaveBeenCalled();
    expect(sessions().read(envA)).toMatchObject({ suspended: true });
  });

  it("removes a released connection before the controller demotes its node's state", async () => {
    await acquire(nodeA);
    const connection = built.at(-1)!;

    await hostedHubController.releaseEnvironment(envA);

    expect(fixture.connections.has(envA)).toBe(false);
    expect(connection.dispose).toHaveBeenCalledOnce();
    expect(fixture.supervisor.disposeThreadDetailSubscriptionsForEnvironment).toHaveBeenCalledWith(
      envA,
    );
    expect(fixture.demote).toHaveBeenCalledExactlyOnceWith(envA);
  });

  it("waits for the cached projections and opens nothing for a generation replaced meanwhile", async () => {
    fixture.hydrated = false;
    await acquire(nodeA);
    await acquire(nodeB);
    expect(environmentFactory).not.toHaveBeenCalled();

    await hostedHubController.releaseEnvironment(envA);
    for (const run of fixture.deferred.splice(0)) await run();

    expect(built.map((connection) => connection.environmentId)).toEqual([envB]);
    expect(fixture.connections.has(envA)).toBe(false);
  });

  it("never reaches an environment the direct plane owns through the relay", async () => {
    fixture.directEnvironments.add(envA);

    expect(await acquire(nodeA)).toBe("connecting");

    expect(environmentFactory).not.toHaveBeenCalled();
    // The generation fails at once instead of waiting for its deadline.
    expect(sessions().read(envA)).toMatchObject({
      transportStatus: "terminal-failure",
      syncFailed: true,
    });
  });

  it("opens nothing through the single-session primary port", () => {
    mobileHostedNodeLifecycle.connectPrimaryEnvironment();

    expect(environmentFactory).not.toHaveBeenCalled();
    expect(fixture.supervisor.register).not.toHaveBeenCalled();
  });

  it("asks the connection coordinator to re-plan when the controller requests it", () => {
    mobileHostedNodeLifecycle.requestEnvironmentReconcile!({ reason: "resume" });

    expect(fixture.reconcile).toHaveBeenCalledExactlyOnceWith({ reason: "resume" });
  });
});
