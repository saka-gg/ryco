import {
  configureHostedRuntime,
  getHostedEnvironmentSessions,
  HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS,
  hostedHubController,
  hostedHubStore,
  markHostedSessionReady,
  resetHostedEnvironmentSessionsForTests,
  type HostedEnvironmentReconcileRequest,
  type HostedHubApi,
  type HostedHubNode,
  type HostedHubSessionResponse,
  type HostedNodeLifecycle,
} from "@ryco/client-runtime/authorization";
import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createMobileHostedConnectionCoordinator,
  MAX_MOBILE_HOSTED_CONNECTIONS,
  MOBILE_HOSTED_WAKE_STAGGER_MS,
  mobileHostedConnectionsStore,
  type MobileHostedConnectionCoordinator,
} from "./hostedConnectionCoordinator";
import {
  createMobileHostedScopeLeaseStore,
  type MobileHostedScopeLeaseStore,
} from "./hostedConnectionScopes";

/**
 * The coordinator driven through the real hosted controller in retained mode,
 * the real session registry and the real demand executor. Only the platform's
 * lifecycle ports and the Hub API are fakes: the ports record which
 * environments hold a connection, and a release can be held open to observe
 * what waits for it.
 */

function hubNode(index: number): HostedHubNode {
  return {
    id: `node_${index}`,
    environmentId: EnvironmentId.make(`env_${index}`),
    label: `Node ${index}`,
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${index}`, role: "owner" },
    effectiveRole: "owner",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

const nodes = Array.from({ length: 5 }, (_, index) => hubNode(index + 1));
const [nodeA, nodeB, nodeC, nodeD, nodeE] = nodes as [
  HostedHubNode,
  HostedHubNode,
  HostedHubNode,
  HostedHubNode,
  HostedHubNode,
];

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
  listNodes: vi.fn(async () => nodes),
  getBootstrapAvailability: vi.fn(async () => false),
  signOut: vi.fn(async () => undefined),
  clearSessionMaterial: vi.fn(),
} as unknown as HostedHubApi;

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the coordinator tests");
    },
  },
);

/** Environments holding a connection: from its connect until its release or suspension resolved. */
const live = new Set<EnvironmentId>();
let peak = 0;
const connects: Array<{ readonly environmentId: EnvironmentId; readonly at: number }> = [];
let holdReleases = false;
const heldReleases: Array<{ readonly environmentId: EnvironmentId; readonly resolve: () => void }> =
  [];

function closePort(environmentId: EnvironmentId): Promise<void> {
  const close = () => {
    live.delete(environmentId);
  };
  if (!holdReleases) {
    close();
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    heldReleases.push({
      environmentId,
      resolve: () => {
        close();
        resolve();
      },
    }),
  );
}

function settleRelease(environmentId: EnvironmentId): void {
  const index = heldReleases.findIndex((entry) => entry.environmentId === environmentId);
  if (index < 0) throw new Error(`no held release for ${environmentId}`);
  heldReleases.splice(index, 1)[0]!.resolve();
}

let coordinator: MobileHostedConnectionCoordinator;
let scopes: MobileHostedScopeLeaseStore;
/** Environments the direct plane owns. */
const directEnvironments = new Set<EnvironmentId>();

const connectEnvironment = vi.fn((node: HostedHubNode, _generation: number) => {
  live.add(node.environmentId);
  peak = Math.max(peak, live.size);
  connects.push({ environmentId: node.environmentId, at: Date.now() });
});
const releaseEnvironment = vi.fn((environmentId: EnvironmentId, _generation: number) =>
  closePort(environmentId),
);
const suspendEnvironment = vi.fn(async (environmentId: EnvironmentId, _generation: number) => {
  live.delete(environmentId);
});

const nodeLifecycle: HostedNodeLifecycle = {
  activate: async () => undefined,
  suspend: async () => undefined,
  deactivate: async () => undefined,
  clearNodeScopedState: vi.fn(),
  writePrimaryEnvironmentDescriptor: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: async () => undefined,
  setActiveEnvironmentId: vi.fn(),
  connectEnvironment,
  releaseEnvironment,
  suspendEnvironment,
  requestEnvironmentReconcile: (request: HostedEnvironmentReconcileRequest) =>
    coordinator.requestEnvironmentReconcile(request),
};

function sessions() {
  return getHostedEnvironmentSessions();
}

function generationOf(environmentId: EnvironmentId): number {
  const record = sessions().read(environmentId);
  if (record === undefined) throw new Error(`no record for ${environmentId}`);
  return record.generation;
}

/** The environment's own attempt reached the node and its own snapshot was accepted. */
function establish(...environmentIds: ReadonlyArray<EnvironmentId>): void {
  for (const environmentId of environmentIds) {
    const generation = generationOf(environmentId);
    sessions().transportStatus(environmentId, generation, "online");
    markHostedSessionReady(environmentId, generation);
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function viewThread(node: HostedHubNode): () => void {
  return scopes.retain(node.environmentId, {
    type: "thread-detail",
    threadId: ThreadId.make(`thread_${node.id}`),
  });
}

/** Freeze, as the app lifecycle binding orders it: no wake owed, every session suspended. */
async function background(): Promise<void> {
  coordinator.cancelPendingRecovery();
  hostedHubController.suspendBrowser("hidden");
  await coordinator.releaseNonRetainedForBackground();
  await flush();
}

/** The directory as the Hub lists it once one node's entry changed. */
function directoryWith(updated: HostedHubNode): ReadonlyArray<HostedHubNode> {
  return nodes.map((node) => (node.id === updated.id ? updated : node));
}

function portCalls(): number {
  return (
    connectEnvironment.mock.calls.length +
    releaseEnvironment.mock.calls.length +
    suspendEnvironment.mock.calls.length
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.clearAllMocks();
  live.clear();
  peak = 0;
  connects.length = 0;
  holdReleases = false;
  heldReleases.length = 0;
  directEnvironments.clear();
  configureHostedRuntime(
    {
      endpoint: unusedService as EndpointService,
      httpClient: unusedService as HttpClientService,
      passkeyCeremony: unusedService as PasskeyCeremonyService,
      sessionCredentials: unusedService as SessionCredentialsService,
      nodeLifecycle,
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
        throw new Error("no relay socket is opened by the coordinator tests");
      },
    },
    hostedHubApi,
  );
  scopes = createMobileHostedScopeLeaseStore();
  coordinator = createMobileHostedConnectionCoordinator({
    scopes,
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    nodeForId: (nodeId) =>
      hostedHubStore.getState().nodes.find((node) => node.id === nodeId) ?? null,
    isDirectEnvironment: (environmentId) => directEnvironments.has(environmentId),
  });
  await hostedHubController.bootstrap();
  expect(hostedHubStore.getState()).toMatchObject({
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
  });
});

afterEach(async () => {
  holdReleases = false;
  for (const entry of heldReleases.splice(0)) entry.resolve();
  await flush();
  coordinator.dispose();
  scopes.reset();
  hostedHubController.resetForTests();
  resetHostedEnvironmentSessionsForTests();
  vi.useRealTimers();
});

describe("mobile hosted connection coordinator", () => {
  it("re-selects a warm node without a lifecycle call, ready in the same tick", async () => {
    await coordinator.acquireNode(nodeA.id);
    await coordinator.acquireNode(nodeB.id);
    establish(nodeA.environmentId, nodeB.environmentId);
    const calls = portCalls();
    vi.mocked(hostedHubApi.restoreSession).mockClear();
    vi.mocked(hostedHubApi.listNodes).mockClear();

    const reselected = coordinator.acquireNode(nodeA.id);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      transportStatus: "online",
      sessionStatus: "ready",
      browserStatus: "current",
    });
    await reselected;
    await flush();

    expect(portCalls()).toBe(calls);
    expect(hostedHubApi.restoreSession).not.toHaveBeenCalled();
    expect(hostedHubApi.listNodes).not.toHaveBeenCalled();
    expect(live).toEqual(new Set([nodeA.environmentId, nodeB.environmentId]));
  });

  it("connects another environment while one is releasing, and that one only after its release", async () => {
    await coordinator.acquireNode(nodeA.id);
    await coordinator.acquireNode(nodeB.id);
    holdReleases = true;
    const releasing = coordinator.releaseEnvironment(nodeA.environmentId);
    await flush();
    expect(releaseEnvironment).toHaveBeenCalledOnce();

    // No serial chain: a release in flight never holds another environment.
    await coordinator.acquireNode(nodeC.id);
    expect(connectEnvironment).toHaveBeenLastCalledWith(nodeC, generationOf(nodeC.environmentId));

    // The released environment keeps its slot, and connects only once its own
    // release has resolved.
    connectEnvironment.mockClear();
    await coordinator.acquireNode(nodeA.id);
    await flush();
    expect(connectEnvironment).not.toHaveBeenCalled();

    settleRelease(nodeA.environmentId);
    expect(await releasing).toBe(true);
    await flush();
    expect(connectEnvironment).toHaveBeenCalledExactlyOnceWith(
      nodeA,
      generationOf(nodeA.environmentId),
    );
    expect(peak).toBeLessThanOrEqual(MAX_MOBILE_HOSTED_CONNECTIONS);
  });

  it("holds the bound of three under a five-node fixture, never exceeded during a swap", async () => {
    holdReleases = true;
    for (const node of nodes) {
      vi.advanceTimersByTime(10);
      await coordinator.acquireNode(node.id);
      await flush();
      // Every eviction is held open for a moment: the next connection waits.
      expect(live.size).toBeLessThanOrEqual(MAX_MOBILE_HOSTED_CONNECTIONS);
      for (const entry of heldReleases.splice(0)) entry.resolve();
      await flush();
    }

    expect(MAX_MOBILE_HOSTED_CONNECTIONS).toBe(3);
    expect(peak).toBe(MAX_MOBILE_HOSTED_CONNECTIONS);
    expect(live).toEqual(new Set([nodeC.environmentId, nodeD.environmentId, nodeE.environmentId]));
    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeA.environmentId,
      nodeB.environmentId,
    ]);
  });

  it("queues a fourth foreground node behind three mounted views and releases nothing", async () => {
    for (const node of [nodeA, nodeB, nodeC]) viewThread(node);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(live.size).toBe(3);

    await coordinator.acquireNode(nodeD.id);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(live.has(nodeD.environmentId)).toBe(false);
    expect(coordinator.demand().queuedEnvironmentIds).toEqual([nodeD.environmentId]);
    expect(hostedHubStore.getState().selectedNode).toBe(nodeD);
  });

  it("lets the foreground displace a pairing ceremony, never a mounted view", async () => {
    const releasePairing = coordinator.retainPairingScope(nodeA.id, nodeA.environmentId);
    expect(releasePairing).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    viewThread(nodeB);
    await vi.advanceTimersByTimeAsync(10);
    viewThread(nodeC);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(live.size).toBe(3);

    await coordinator.acquireNode(nodeD.id);
    await flush();

    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeA.environmentId,
    ]);
    expect(live).toEqual(new Set([nodeB.environmentId, nodeC.environmentId, nodeD.environmentId]));
    // The ceremony keeps its scope and waits for a free connection.
    expect(coordinator.demand().queuedEnvironmentIds).toEqual([nodeA.environmentId]);
    expect(peak).toBe(MAX_MOBILE_HOSTED_CONNECTIONS);
    releasePairing?.();
  });

  it("fails closed for a pairing route whose node and environment do not match", () => {
    expect(coordinator.retainPairingScope(nodeA.id, nodeB.environmentId)).toBeNull();
  });

  it("releases only sessions nobody demands when the app goes to the background", async () => {
    viewThread(nodeA);
    await coordinator.acquireNode(nodeB.id);
    await coordinator.acquireNode(nodeC.id);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    establish(nodeA.environmentId, nodeB.environmentId, nodeC.environmentId);

    await background();

    // B was warm with nothing holding it; A has a mounted view, C is selected.
    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeB.environmentId,
    ]);
    expect(sessions().read(nodeB.environmentId)).toBeUndefined();
    expect(sessions().read(nodeA.environmentId)).toMatchObject({ suspended: true });
    expect(sessions().read(nodeC.environmentId)).toMatchObject({ suspended: true });
    expect(live.size).toBe(0);
  });

  it("re-acquires suspended sessions only after revalidation, the selected node first", async () => {
    viewThread(nodeA);
    await coordinator.acquireNode(nodeB.id);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    establish(nodeA.environmentId, nodeB.environmentId);
    await background();
    connectEnvironment.mockClear();
    connects.length = 0;

    // Nothing reconnects while the app is away, wakes included.
    await vi.advanceTimersByTimeAsync(10 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(connectEnvironment).not.toHaveBeenCalled();

    const resumedAt = Date.now();
    await hostedHubController.resumeBrowser();
    await flush();
    expect(hostedHubStore.getState().browserStatus).not.toBe("checking-access");
    expect(connects.map(({ environmentId }) => environmentId)).toEqual([nodeB.environmentId]);
    expect(connects[0]!.at).toBe(resumedAt);

    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(connects.map(({ environmentId }) => environmentId)).toEqual([
      nodeB.environmentId,
      nodeA.environmentId,
    ]);
    expect(connects[1]!.at - connects[0]!.at).toBeGreaterThanOrEqual(MOBILE_HOSTED_WAKE_STAGGER_MS);
    // Each was restarted with its own fresh generation.
    expect(sessions().read(nodeA.environmentId)).toMatchObject({
      suspended: false,
      connectRequested: true,
    });
  });

  it("wakes the foreground at once and the other retained nodes at least 750 ms apart", async () => {
    viewThread(nodeA);
    await vi.advanceTimersByTimeAsync(10);
    viewThread(nodeB);
    await coordinator.acquireNode(nodeC.id);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    establish(nodeA.environmentId, nodeB.environmentId, nodeC.environmentId);
    await background();
    connects.length = 0;

    await hostedHubController.resumeBrowser();
    coordinator.reconnectRetainedAfterForeground();
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(connects.map(({ environmentId }) => environmentId)).toEqual([
      nodeC.environmentId,
      nodeB.environmentId,
      nodeA.environmentId,
    ]);
    expect(connects[1]!.at - connects[0]!.at).toBeGreaterThanOrEqual(MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(connects[2]!.at - connects[1]!.at).toBeGreaterThanOrEqual(MOBILE_HOSTED_WAKE_STAGGER_MS);
  });

  it("cancels pending wakes when the app leaves the foreground again", async () => {
    viewThread(nodeA);
    await vi.advanceTimersByTimeAsync(10);
    viewThread(nodeB);
    await coordinator.acquireNode(nodeC.id);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    await background();
    await hostedHubController.resumeBrowser();
    await flush();
    expect(coordinator.demand().pendingWakes.length).toBeGreaterThan(0);
    connects.length = 0;

    await background();
    await vi.advanceTimersByTimeAsync(10 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(coordinator.demand().pendingWakes).toEqual([]);
    expect(connects).toEqual([]);
  });

  it("reconnects mounted views once access is revalidated after a sign-in", async () => {
    viewThread(nodeA);
    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(live.has(nodeA.environmentId)).toBe(true);
    // The app lifecycle binding is torn down with the account session.
    coordinator.cancelPendingRecovery();
    await hostedHubController.clearAccount("signed-out");
    await flush();
    expect(sessions().list()).toEqual([]);
    connectEnvironment.mockClear();

    await hostedHubController.bootstrap();
    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(connectEnvironment).toHaveBeenCalledExactlyOnceWith(
      nodeA,
      generationOf(nodeA.environmentId),
    );
  });

  it("leaves a dropped warm session with a mounted view to reconnect and releases a leaseless one", async () => {
    viewThread(nodeA);
    await coordinator.acquireNode(nodeB.id);
    await coordinator.acquireNode(nodeC.id);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    establish(nodeA.environmentId, nodeB.environmentId, nodeC.environmentId);

    sessions().connectionClosed(nodeA.environmentId, generationOf(nodeA.environmentId));
    sessions().connectionClosed(nodeB.environmentId, generationOf(nodeB.environmentId));
    await flush();

    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeB.environmentId,
    ]);
    expect(coordinator.isDemanded(nodeA.environmentId)).toBe(true);
    expect(coordinator.isDemanded(nodeB.environmentId)).toBe(false);
    expect(sessions().read(nodeA.environmentId)).toMatchObject({ relayGap: true });
    expect(sessions().read(nodeB.environmentId)).toBeUndefined();
  });

  it("connects a dropped selected node again after the user switched away and back", async () => {
    await coordinator.acquireNode(nodeA.id);
    establish(nodeA.environmentId);
    sessions().connectionClosed(nodeA.environmentId, generationOf(nodeA.environmentId));
    await flush();
    // Selected, so its own transport keeps retrying.
    expect(releaseEnvironment).not.toHaveBeenCalled();

    await coordinator.acquireNode(nodeB.id);
    await flush();
    // Nothing demands it any more, so its transport stopped retrying: released.
    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeA.environmentId,
    ]);
    expect(sessions().read(nodeA.environmentId)).toBeUndefined();
    connectEnvironment.mockClear();

    await coordinator.acquireNode(nodeA.id);
    await flush();

    expect(connectEnvironment).toHaveBeenCalledExactlyOnceWith(
      nodeA,
      generationOf(nodeA.environmentId),
    );
    expect(sessions().read(nodeA.environmentId)).toMatchObject({
      connectRequested: true,
      relayGap: false,
    });
    expect(live).toEqual(new Set([nodeA.environmentId, nodeB.environmentId]));
  });

  it("releases a dropped environment once its last view closes, and a later view connects it fresh", async () => {
    await coordinator.acquireNode(nodeB.id);
    const closeView = viewThread(nodeA);
    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS);
    establish(nodeA.environmentId, nodeB.environmentId);
    sessions().connectionClosed(nodeA.environmentId, generationOf(nodeA.environmentId));
    await flush();
    expect(releaseEnvironment).not.toHaveBeenCalled();

    closeView();
    await flush();

    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeA.environmentId,
    ]);
    expect(sessions().read(nodeA.environmentId)).toBeUndefined();
    expect(coordinator.demand().activeConnectionCount).toBe(1);
    connectEnvironment.mockClear();

    viewThread(nodeA);
    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(connectEnvironment).toHaveBeenCalledExactlyOnceWith(
      nodeA,
      generationOf(nodeA.environmentId),
    );
  });

  it("releases a first attempt that failed and lost its demand while it waited to retry", async () => {
    await coordinator.acquireNode(nodeA.id);
    sessions().failure(nodeA.environmentId, generationOf(nodeA.environmentId), {
      kind: "offline",
      retryable: true,
    });
    await flush();
    expect(releaseEnvironment).not.toHaveBeenCalled();

    await coordinator.acquireNode(nodeB.id);
    await flush();
    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeA.environmentId,
    ]);
    connectEnvironment.mockClear();

    await coordinator.acquireNode(nodeA.id);

    expect(connectEnvironment).toHaveBeenCalledExactlyOnceWith(
      nodeA,
      generationOf(nodeA.environmentId),
    );
  });

  it("releases a session that could not synchronize once nothing demands it, keeping the bound of three", async () => {
    await coordinator.acquireNode(nodeA.id);
    const failed = generationOf(nodeA.environmentId);
    sessions().transportStatus(nodeA.environmentId, failed, "online");
    sessions().reportShellSnapshotFailure(nodeA.environmentId, failed);
    await flush();
    // Selected, so it keeps its channel and the slot that channel takes.
    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(coordinator.demand().activeConnectionCount).toBe(1);

    for (const node of [nodeB, nodeC, nodeD]) {
      vi.advanceTimersByTime(10);
      await coordinator.acquireNode(node.id);
      await flush();
    }

    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeA.environmentId,
    ]);
    expect(sessions().read(nodeA.environmentId)).toBeUndefined();
    expect(live).toEqual(new Set([nodeB.environmentId, nodeC.environmentId, nodeD.environmentId]));
    expect(peak).toBeLessThanOrEqual(MAX_MOBILE_HOSTED_CONNECTIONS);
    expect(coordinator.demand().activeConnectionCount).toBe(MAX_MOBILE_HOSTED_CONNECTIONS);
  });

  it("keeps the slot of a failed session a mounted view still shows until the view closes", async () => {
    const closeView = viewThread(nodeA);
    await vi.advanceTimersByTimeAsync(10);
    sessions().transportStatus(nodeA.environmentId, generationOf(nodeA.environmentId), "online");
    // Its snapshot never arrives: the session-sync deadline fails it, channel open.
    await vi.advanceTimersByTimeAsync(HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS);
    expect(sessions().read(nodeA.environmentId)).toMatchObject({
      transportStatus: "terminal-failure",
      syncFailed: true,
    });
    viewThread(nodeB);
    await vi.advanceTimersByTimeAsync(10);
    viewThread(nodeC);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    await coordinator.acquireNode(nodeD.id);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(live).toEqual(new Set([nodeA.environmentId, nodeB.environmentId, nodeC.environmentId]));
    expect(coordinator.demand().queuedEnvironmentIds).toEqual([nodeD.environmentId]);

    closeView();
    await flush();

    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeA.environmentId,
    ]);
    expect(live).toEqual(new Set([nodeB.environmentId, nodeC.environmentId, nodeD.environmentId]));
    expect(peak).toBe(MAX_MOBILE_HOSTED_CONNECTIONS);
  });

  it("closes a failed mounted view's channel before connecting it again once its directory entry changed", async () => {
    viewThread(nodeA);
    await coordinator.acquireNode(nodeB.id);
    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS);
    const failed = generationOf(nodeA.environmentId);
    sessions().transportStatus(nodeA.environmentId, failed, "online");
    sessions().reportShellSnapshotFailure(nodeA.environmentId, failed);
    await flush();
    expect(releaseEnvironment).not.toHaveBeenCalled();
    connectEnvironment.mockClear();

    vi.mocked(hostedHubApi.listNodes).mockResolvedValueOnce(
      directoryWith({ ...nodeA, clientVersion: "1.0.1" }),
    );
    await hostedHubController.refreshDirectory();
    await flush();

    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeA.environmentId,
    ]);
    expect(connectEnvironment).toHaveBeenCalledOnce();
    expect(connectEnvironment.mock.calls[0]![0].environmentId).toBe(nodeA.environmentId);
    expect(releaseEnvironment.mock.invocationCallOrder[0]!).toBeLessThan(
      connectEnvironment.mock.invocationCallOrder[0]!,
    );
    expect(generationOf(nodeA.environmentId)).toBeGreaterThan(failed);
    expect(sessions().read(nodeA.environmentId)).toMatchObject({
      connectRequested: true,
      syncFailed: false,
    });
    expect(live).toEqual(new Set([nodeA.environmentId, nodeB.environmentId]));
  });

  it("connects a failed selected node again in place once its directory entry changed", async () => {
    await coordinator.acquireNode(nodeA.id);
    const failed = generationOf(nodeA.environmentId);
    sessions().transportStatus(nodeA.environmentId, failed, "online");
    sessions().reportShellSnapshotFailure(nodeA.environmentId, failed);
    await flush();
    connectEnvironment.mockClear();

    vi.mocked(hostedHubApi.listNodes).mockResolvedValueOnce(
      directoryWith({ ...nodeA, clientVersion: "1.0.1" }),
    );
    await hostedHubController.refreshDirectory();
    await flush();

    // The foreground takes back the slot it frees; its new connection
    // replaces the failed one.
    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(connectEnvironment).toHaveBeenCalledOnce();
    expect(connectEnvironment.mock.calls[0]![0].environmentId).toBe(nodeA.environmentId);
    expect(generationOf(nodeA.environmentId)).toBeGreaterThan(failed);
    expect(hostedHubStore.getState().selectedNode?.id).toBe(nodeA.id);
    expect(coordinator.demand().activeConnectionCount).toBe(1);
  });

  it("keeps an evicted environment's slot until the release already tearing it down resolved", async () => {
    for (const node of [nodeA, nodeB, nodeC]) {
      vi.advanceTimersByTime(10);
      await coordinator.acquireNode(node.id);
    }
    expect(live.size).toBe(MAX_MOBILE_HOSTED_CONNECTIONS);
    holdReleases = true;
    const releasing = coordinator.releaseEnvironment(nodeA.environmentId);

    // The fourth node evicts the environment being released, and waits for it.
    vi.advanceTimersByTime(10);
    await coordinator.acquireNode(nodeD.id);
    await flush();
    expect(live.has(nodeD.environmentId)).toBe(false);
    expect(coordinator.demand().releasingEnvironmentIds).toEqual([nodeA.environmentId]);

    settleRelease(nodeA.environmentId);
    expect(await releasing).toBe(true);
    await flush();

    expect(live).toEqual(new Set([nodeB.environmentId, nodeC.environmentId, nodeD.environmentId]));
    expect(peak).toBe(MAX_MOBILE_HOSTED_CONNECTIONS);
    expect(releaseEnvironment).toHaveBeenCalledOnce();
  });

  it("evicts the least recently opened warm node, counting a re-selection as an opening", async () => {
    for (const node of [nodeA, nodeB, nodeC]) {
      vi.advanceTimersByTime(10);
      await coordinator.acquireNode(node.id);
    }
    establish(nodeA.environmentId, nodeB.environmentId, nodeC.environmentId);
    vi.advanceTimersByTime(10);
    await coordinator.acquireNode(nodeA.id);
    expect(connects).toHaveLength(3);

    vi.advanceTimersByTime(10);
    await coordinator.acquireNode(nodeD.id);
    await flush();

    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      nodeB.environmentId,
    ]);
    expect(live).toEqual(new Set([nodeA.environmentId, nodeC.environmentId, nodeD.environmentId]));
  });

  it("keeps an identity-conflict release closed until the node is acquired again", async () => {
    viewThread(nodeA);
    await coordinator.acquireNode(nodeA.id);
    await flush();
    connectEnvironment.mockClear();

    expect(await coordinator.releaseEnvironment(nodeA.environmentId)).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    // The mounted view still wants it, but the release holds.
    expect(connectEnvironment).not.toHaveBeenCalled();
    expect(sessions().read(nodeA.environmentId)).toBeUndefined();

    await coordinator.acquireNode(nodeA.id);
    expect(connectEnvironment).toHaveBeenCalledExactlyOnceWith(
      nodeA,
      generationOf(nodeA.environmentId),
    );
  });

  it("reconnects a node through the executor without touching another node", async () => {
    await coordinator.acquireNode(nodeA.id);
    await coordinator.acquireNode(nodeB.id);
    const releasePairing = coordinator.retainPairingScope(nodeB.id, nodeB.environmentId);
    const before = generationOf(nodeB.environmentId);
    const otherGeneration = generationOf(nodeA.environmentId);

    expect(await coordinator.reconnectNode(nodeB.id, nodeB.environmentId)).toBe(true);

    expect(generationOf(nodeB.environmentId)).toBeGreaterThan(before);
    expect(generationOf(nodeA.environmentId)).toBe(otherGeneration);
    expect(live).toEqual(new Set([nodeA.environmentId, nodeB.environmentId]));
    expect(await coordinator.reconnectNode(nodeA.id, nodeB.environmentId)).toBe(false);
    releasePairing?.();
  });

  it("reports a reconnect that waits for a slot mounted views hold as started", async () => {
    viewThread(nodeB);
    await vi.advanceTimersByTimeAsync(10);
    viewThread(nodeC);
    await vi.advanceTimersByTimeAsync(10);
    viewThread(nodeD);
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    await coordinator.acquireNode(nodeA.id);
    expect(coordinator.demand().queuedEnvironmentIds).toEqual([nodeA.environmentId]);

    // Every slot stays with a mounted view: the node connects once one frees.
    expect(await coordinator.reconnectNode(nodeA.id, nodeA.environmentId)).toBe(true);
    expect(coordinator.demand().queuedEnvironmentIds).toEqual([nodeA.environmentId]);
    expect(hostedHubStore.getState().selectedNode).toBe(nodeA);
    expect(live).toEqual(new Set([nodeB.environmentId, nodeC.environmentId, nodeD.environmentId]));
  });

  it("carries an interrupted request's uncertainty into the environment's next session", async () => {
    await coordinator.acquireNode(nodeA.id);
    establish(nodeA.environmentId);
    sessions().registerPendingRequestReader(
      nodeA.environmentId,
      generationOf(nodeA.environmentId),
      () => true,
    );

    await coordinator.releaseEnvironment(nodeA.environmentId);
    expect(mobileHostedConnectionsStore.getState().deliveryUnknownEnvironmentIds).toEqual([
      nodeA.environmentId,
    ]);

    await coordinator.acquireNode(nodeA.id);
    expect(coordinator.read(nodeA.environmentId)?.sessionStatus).toBe("delivery-unknown");
  });

  it("acknowledges a recovered non-selected environment from its own record", async () => {
    await coordinator.acquireNode(nodeB.id);
    await coordinator.acquireNode(nodeA.id);
    establish(nodeA.environmentId, nodeB.environmentId);

    coordinator.markEnvironmentDeliveryUnknown(nodeB.environmentId);
    expect(coordinator.read(nodeB.environmentId)).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    coordinator.acknowledgeDeliveryUnknown(nodeB.environmentId);

    expect(coordinator.read(nodeB.environmentId)?.sessionStatus).toBe("ready");
    expect(mobileHostedConnectionsStore.getState().deliveryUnknownEnvironmentIds).toEqual([]);
    // The selected node's shared session is left alone.
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      sessionStatus: "ready",
    });
  });

  it("releases every session on releaseAll", async () => {
    await coordinator.acquireNode(nodeA.id);
    await coordinator.acquireNode(nodeB.id);

    await coordinator.releaseAll();

    expect(sessions().list()).toEqual([]);
    expect(live.size).toBe(0);
  });
});

describe("mobile hosted warm set", () => {
  /** Select each node in turn and let its session establish, as using it does. */
  async function use(...used: ReadonlyArray<HostedHubNode>): Promise<void> {
    for (const node of used) {
      vi.advanceTimersByTime(10);
      await coordinator.acquireNode(node.id);
      establish(node.environmentId);
      await flush();
    }
  }

  const connected = () => connects.map(({ environmentId }) => environmentId);

  it("restores the last warm set after a background, the selected node first, without moving the selection", async () => {
    await use(nodeA, nodeB, nodeC);
    expect(coordinator.demand().recentEnvironmentIds).toEqual([
      nodeC.environmentId,
      nodeB.environmentId,
      nodeA.environmentId,
    ]);
    const select = vi.spyOn(hostedHubController, "selectNode");
    await background();
    connects.length = 0;

    await hostedHubController.resumeBrowser();
    coordinator.reconnectRetainedAfterForeground();
    await flush();
    // The restore waits for the selected node's own attempt.
    expect(connected()).toEqual([nodeC.environmentId]);
    establish(nodeC.environmentId);
    await flush();
    await vi.advanceTimersByTimeAsync(MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(connected()).toEqual([nodeC.environmentId, nodeB.environmentId, nodeA.environmentId]);
    expect(connects[2]!.at - connects[1]!.at).toBeGreaterThanOrEqual(MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(select).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().selectedNode?.id).toBe(nodeC.id);
    expect(peak).toBeLessThanOrEqual(MAX_MOBILE_HOSTED_CONNECTIONS);
  });

  it("restores nothing while access is not revalidated", async () => {
    await use(nodeA, nodeB);
    await background();
    connects.length = 0;

    // A foreground request that arrives before revalidation restores nothing.
    coordinator.requestEnvironmentReconcile({ reason: "resume" });
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(connects).toEqual([]);
    expect(coordinator.demand()).toMatchObject({
      warmEnvironmentIds: [],
      warmRestorePending: true,
    });
  });

  it("skips released and direct environments", async () => {
    await use(nodeA, nodeB, nodeC);
    expect(await coordinator.releaseEnvironment(nodeA.environmentId)).toBe(true);
    directEnvironments.add(nodeB.environmentId);
    await background();
    connects.length = 0;

    await hostedHubController.resumeBrowser();
    await flush();
    establish(nodeC.environmentId);
    await flush();
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(connected()).toEqual([nodeC.environmentId]);
    expect(coordinator.demand().warmEnvironmentIds).toEqual([nodeC.environmentId]);
  });

  it("skips an environment the directory lists offline", async () => {
    await use(nodeA, nodeB);
    await background();
    connects.length = 0;

    vi.mocked(hostedHubApi.listNodes).mockResolvedValueOnce(
      directoryWith({ ...nodeA, presence: { online: false, lastHeartbeatAt: 1 } }),
    );
    await hostedHubController.resumeBrowser();
    await flush();
    establish(nodeB.environmentId);
    await flush();
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(connected()).toEqual([nodeB.environmentId]);
  });

  it("forgets the warm set when the account signs out", async () => {
    await use(nodeA, nodeB);
    coordinator.cancelPendingRecovery();
    expect(coordinator.demand()).toMatchObject({
      recentEnvironmentIds: [nodeB.environmentId, nodeA.environmentId],
      warmRestorePending: true,
    });

    await hostedHubController.clearAccount("signed-out");
    await flush();

    expect(coordinator.demand()).toMatchObject({
      recentEnvironmentIds: [],
      warmEnvironmentIds: [],
      warmRestorePending: false,
    });
  });

  it("forgets the warm set when the session changes while signed in", async () => {
    await use(nodeA, nodeB, nodeC);
    await background();
    await hostedHubController.resumeBrowser();
    await flush();
    establish(nodeC.environmentId);
    await flush();
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(coordinator.demand().warmEnvironmentIds).toHaveLength(3);
    // Backgrounded again: the warm set is owed for the next foreground.
    await background();
    expect(coordinator.demand()).toMatchObject({
      recentEnvironmentIds: [nodeC.environmentId, nodeB.environmentId, nodeA.environmentId],
      warmRestorePending: true,
    });
    connects.length = 0;

    // The same account comes back with another session: the revalidation and
    // the resume it starts both see it.
    const rotated: HostedHubSessionResponse = {
      ...sessionResponse,
      session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
    };
    vi.mocked(hostedHubApi.restoreSession)
      .mockResolvedValueOnce(rotated)
      .mockResolvedValueOnce(rotated);
    await hostedHubController.revalidateSession();
    await flush();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      session: { id: rotated.session.id },
    });
    expect(coordinator.demand()).toMatchObject({
      recentEnvironmentIds: [],
      warmEnvironmentIds: [],
      warmRestorePending: false,
    });

    coordinator.reconnectRetainedAfterForeground();
    await flush();
    establish(nodeC.environmentId);
    await flush();
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    // Only the selected node reconnects; the previous session's warm set stays away.
    expect(connected()).toEqual([nodeC.environmentId]);
    expect(coordinator.demand().warmEnvironmentIds).toEqual([]);
  });

  it("neither reconnects nor queues a restored warm node whose session fails or drops", async () => {
    await use(nodeA, nodeB, nodeC);
    await background();
    await hostedHubController.resumeBrowser();
    await flush();
    establish(nodeC.environmentId);
    await flush();
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);
    expect(coordinator.demand().warmEnvironmentIds).toEqual([
      nodeC.environmentId,
      nodeB.environmentId,
      nodeA.environmentId,
    ]);
    establish(nodeB.environmentId, nodeA.environmentId);
    connectEnvironment.mockClear();

    sessions().failure(nodeB.environmentId, generationOf(nodeB.environmentId), {
      kind: "incompatible",
      retryable: false,
    });
    sessions().connectionClosed(nodeA.environmentId, generationOf(nodeA.environmentId));
    await flush();
    await vi.advanceTimersByTimeAsync(3 * MOBILE_HOSTED_WAKE_STAGGER_MS);

    expect(connectEnvironment).not.toHaveBeenCalled();
    expect(coordinator.demand()).toMatchObject({
      queuedEnvironmentIds: [],
      warmQueuedEnvironmentIds: [],
      warmEnvironmentIds: [nodeC.environmentId],
    });
    expect(coordinator.demand().warmCooldownEnvironmentIds.toSorted()).toEqual([
      nodeA.environmentId,
      nodeB.environmentId,
    ]);
    expect(releaseEnvironment.mock.calls.map(([environmentId]) => environmentId)).toEqual(
      expect.arrayContaining([nodeA.environmentId, nodeB.environmentId]),
    );
  });
});

describe("mobile hosted connection facade", () => {
  it("reads each session from its shared record", async () => {
    await coordinator.acquireNode(nodeA.id);
    const environmentId = nodeA.environmentId;
    const generation = generationOf(environmentId);
    expect(coordinator.read(environmentId)).toMatchObject({
      environmentId,
      nodeId: nodeA.id,
      label: "Node 1",
      generation,
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      attemptPrepared: false,
      errorMessage: null,
    });
    expect(coordinator.isCurrentGeneration(environmentId, generation)).toBe(true);

    sessions().transportStatus(environmentId, generation, "online");
    expect(coordinator.read(environmentId)?.attemptPrepared).toBe(true);
    sessions().connectionClosed(environmentId, generation);
    expect(coordinator.read(environmentId)).toMatchObject({
      attemptPrepared: false,
      transportStatus: "reconnecting",
    });
    sessions().failure(environmentId, generation, { kind: "offline", retryable: true });
    expect(coordinator.read(environmentId)?.errorMessage).toBe("This machine is offline.");
    expect(coordinator.read(nodeB.environmentId)).toBeNull();
  });

  it("reports a session that could not synchronize", async () => {
    await coordinator.acquireNode(nodeA.id);

    sessions().reportShellSnapshotFailure(nodeA.environmentId, generationOf(nodeA.environmentId));

    expect(coordinator.read(nodeA.environmentId)).toMatchObject({
      transportStatus: "terminal-failure",
      errorMessage: "Ryco state could not be synchronized.",
    });
  });

  it("projects the registry, most recent first, keeping identity until it changes", async () => {
    await coordinator.acquireNode(nodeA.id);
    vi.advanceTimersByTime(10);
    await coordinator.acquireNode(nodeB.id);
    const state = mobileHostedConnectionsStore.getState();

    expect(mobileHostedConnectionsStore.getState()).toBe(state);
    expect(state.selectedNodes.map((record) => record.environmentId)).toEqual([
      nodeB.environmentId,
      nodeA.environmentId,
    ]);

    const listener = vi.fn();
    const unsubscribe = mobileHostedConnectionsStore.subscribe(listener);
    sessions().transportStatus(nodeB.environmentId, generationOf(nodeB.environmentId), "online");
    const next = mobileHostedConnectionsStore.getState();

    expect(listener).toHaveBeenCalled();
    expect(next).not.toBe(state);
    expect(next.selectedNodes[0]?.transportStatus).toBe("online");
    // An unchanged record keeps its view.
    expect(next.selectedNodes[1]).toBe(state.selectedNodes[1]);
    unsubscribe();

    // Opening a warm node again moves it to the front, though nothing connects.
    const calls = portCalls();
    vi.advanceTimersByTime(10);
    await coordinator.acquireNode(nodeA.id);
    expect(portCalls()).toBe(calls);
    expect(
      mobileHostedConnectionsStore.getState().selectedNodes.map((record) => record.environmentId),
    ).toEqual([nodeA.environmentId, nodeB.environmentId]);
  });
});
