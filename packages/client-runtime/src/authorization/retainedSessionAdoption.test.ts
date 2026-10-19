import { EnvironmentId, ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";

import { getHostedDispatchReplay } from "../relay/dispatchReplay.ts";
import { createHostedEnvironmentAttemptFactory } from "../relay/environmentAttemptBinding.ts";
import { HostedHubApiError, type HostedHubApi } from "./api.ts";
import {
  canAdoptHostedEnvironmentSession,
  getHostedEnvironmentSessions,
  resetHostedEnvironmentSessionsForTests,
} from "./hostedEnvironmentSessions.ts";
import {
  configureHostedRuntime,
  type HostedEnvironmentReconcileRequest,
  type HostedNodeLifecycle,
} from "./runtime.ts";
import {
  HOSTED_SESSION_SYNC_DEADLINE_MS,
  HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
  hostedHubController,
  hostedHubStore,
  markHostedSessionReady,
} from "./state.ts";
import type { HostedHubNode, HostedHubSessionResponse } from "./types.ts";

/**
 * Retained environment sessions, driven through the real controller, the real
 * per-environment transition queues and the real session registry. Only the
 * platform's lifecycle ports and the Hub API are fakes: every port call is
 * recorded with the generation it names, and a release or suspension can be
 * held open to observe what waits for it.
 */

const dispatchCommand = { tag: ORCHESTRATION_WS_METHODS.dispatchCommand, stream: false } as const;

function hubNode(id: string, overrides: Partial<HostedHubNode> = {}): HostedHubNode {
  const suffix = id.slice(5);
  return {
    id,
    environmentId: EnvironmentId.make(`env_${suffix}`),
    label: `Node ${suffix.slice(0, 1)}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
    ...overrides,
  };
}

const nodeA = hubNode("node_aaaaaaaaaaaaaaaaaaaaaa");
const nodeB = hubNode("node_bbbbbbbbbbbbbbbbbbbbbb");
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

let directory: ReadonlyArray<HostedHubNode> = [];

const hostedHubApi = {
  credentialMode: "cookie",
  restoreSession: vi.fn(async () => sessionResponse),
  listNodes: vi.fn(async () => directory),
  getBootstrapAvailability: vi.fn(async () => false),
  signOut: vi.fn(async () => undefined),
  clearSessionMaterial: vi.fn(),
} as unknown as HostedHubApi;

type HeldPort = "release" | "suspend";

const holding = new Set<HeldPort>();
const held: Array<{
  readonly port: HeldPort;
  readonly environmentId: EnvironmentId;
  readonly resolve: () => void;
}> = [];

function portCall(port: HeldPort, environmentId: EnvironmentId): Promise<void> {
  if (!holding.has(port)) return Promise.resolve();
  return new Promise((resolve) => held.push({ port, environmentId, resolve }));
}

function settle(port: HeldPort, environmentId: EnvironmentId): void {
  const index = held.findIndex(
    (entry) => entry.port === port && entry.environmentId === environmentId,
  );
  if (index < 0) throw new Error(`no held ${port} for ${environmentId}`);
  held.splice(index, 1)[0]!.resolve();
}

const connectEnvironment = vi.fn((_node: HostedHubNode, _generation: number) => undefined);
const releaseEnvironment = vi.fn((environmentId: EnvironmentId, _generation: number) =>
  portCall("release", environmentId),
);
const suspendEnvironment = vi.fn((environmentId: EnvironmentId, _generation: number) =>
  portCall("suspend", environmentId),
);
const requestEnvironmentReconcile = vi.fn(
  (_request: HostedEnvironmentReconcileRequest) => undefined,
);

const nodeLifecycle: HostedNodeLifecycle = {
  activate: vi.fn(async () => undefined),
  suspend: vi.fn(async () => undefined),
  deactivate: vi.fn(async () => undefined),
  clearNodeScopedState: vi.fn(),
  writePrimaryEnvironmentDescriptor: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(async () => undefined),
  setActiveEnvironmentId: vi.fn(),
  connectEnvironment,
  releaseEnvironment,
  suspendEnvironment,
  requestEnvironmentReconcile,
};

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the retained session tests");
    },
  },
);

function configureRuntime(lifecycle: HostedNodeLifecycle = nodeLifecycle): void {
  configureHostedRuntime(
    {
      endpoint: unusedService as EndpointService,
      httpClient: unusedService as HttpClientService,
      passkeyCeremony: unusedService as PasskeyCeremonyService,
      sessionCredentials: unusedService as SessionCredentialsService,
      nodeLifecycle: lifecycle,
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
        throw new Error("no relay socket is opened by the retained session tests");
      },
    },
    hostedHubApi,
  );
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

/** Whether `promise` settles while nothing but microtasks run. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  const outcome = { settled: false };
  const markSettled = () => {
    outcome.settled = true;
  };
  void promise.then(markSettled, markSettled);
  for (let turn = 0; turn < 200; turn += 1) {
    if (outcome.settled) return true;
    await Promise.resolve();
  }
  return outcome.settled;
}

async function signIn(nodes: ReadonlyArray<HostedHubNode>): Promise<void> {
  directory = nodes;
  await hostedHubController.bootstrap();
  expect(hostedHubStore.getState()).toMatchObject({
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
  });
}

function sessions() {
  return getHostedEnvironmentSessions();
}

function generationOf(environmentId: EnvironmentId): number {
  const record = sessions().read(environmentId);
  if (record === undefined) throw new Error(`no record for ${environmentId}`);
  return record.generation;
}

async function connect(node: HostedHubNode): Promise<number> {
  expect(await hostedHubController.acquireEnvironment(node.id)).toBe("connecting");
  const generation = generationOf(node.environmentId);
  expect(connectEnvironment).toHaveBeenLastCalledWith(node, generation);
  return generation;
}

/** The connection's own attempt reached the node and its own snapshot was accepted. */
function establish(environmentId: EnvironmentId, generation: number): void {
  sessions().transportStatus(environmentId, generation, "online");
  markHostedSessionReady(environmentId, generation);
}

function portCalls(): number {
  return (
    connectEnvironment.mock.calls.length +
    releaseEnvironment.mock.calls.length +
    suspendEnvironment.mock.calls.length +
    requestEnvironmentReconcile.mock.calls.length
  );
}

/** The environments the platform was asked to re-plan one by one. */
function environmentReplans(): Array<EnvironmentId | undefined> {
  return requestEnvironmentReconcile.mock.calls
    .filter(([request]) => request.reason === "directory")
    .map(([request]) => request.environmentId);
}

/** A directory read that fails without saying anything about the session. */
async function staleDirectory(): Promise<void> {
  vi.mocked(hostedHubApi.listNodes).mockRejectedValueOnce(new HostedHubApiError("unavailable", 0));
  await hostedHubController.refreshDirectory();
  expect(hostedHubStore.getState().directoryStatus).toBe("stale");
}

function bindingFor(environmentId: EnvironmentId, nodeId: string) {
  return createHostedEnvironmentAttemptFactory({
    sessions: sessions(),
    environmentId,
    nodeId,
    readShared: () => hostedHubStore.getState(),
    subscribeShared: (listener) => {
      const unsubscribe = hostedHubStore.subscribe(listener);
      return () => {
        unsubscribe();
      };
    },
    ports: {},
  }).binding;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  directory = [];
  configureRuntime();
});

afterEach(async () => {
  holding.clear();
  for (const entry of held.splice(0)) entry.resolve();
  await flush();
  hostedHubController.resetForTests();
  resetHostedEnvironmentSessionsForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("retained environment sessions", () => {
  it("only moves the selection when a node is selected, and connects only on acquire", async () => {
    await signIn([nodeA]);

    await hostedHubController.selectNode(nodeA.id);

    expect(connectEnvironment).not.toHaveBeenCalled();
    expect(sessions().read(envA)).toBeUndefined();
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      browserStatus: "synchronizing",
      effectiveRole: "operator",
    });
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentId: envA }),
    );
    expect(nodeLifecycle.setActiveEnvironmentId).toHaveBeenLastCalledWith(envA);

    const generation = await connect(nodeA);
    expect(connectEnvironment).toHaveBeenCalledOnce();
    expect(sessions().read(envA)).toMatchObject({ generation, connectRequested: true });

    establish(envA, generation);
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
    });
  });

  it("adopts a ready environment on selection in the same tick, with no network call", async () => {
    await signIn([nodeA, nodeB]);
    establish(envA, await connect(nodeA));
    establish(envB, await connect(nodeB));
    await hostedHubController.selectNode(nodeA.id);
    const calls = portCalls();
    const timers = vi.getTimerCount();
    const generation = hostedHubStore.getState().generation;
    vi.mocked(hostedHubApi.restoreSession).mockClear();
    vi.mocked(hostedHubApi.listNodes).mockClear();

    void hostedHubController.selectNode(nodeB.id);

    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeB,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      effectiveRole: "operator",
      errorMessage: null,
      generation: generation + 1,
    });
    // No port call, no session-sync timer, no Hub request.
    expect(portCalls()).toBe(calls);
    expect(vi.getTimerCount()).toBe(timers);
    expect(hostedHubApi.restoreSession).not.toHaveBeenCalled();
    expect(hostedHubApi.listNodes).not.toHaveBeenCalled();

    void hostedHubController.selectNode(nodeA.id);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      sessionStatus: "ready",
      browserStatus: "current",
      generation: generation + 2,
    });
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("adopted");
    expect(portCalls()).toBe(calls);
  });

  it("joins the connection a press requested instead of opening a second one", async () => {
    await signIn([nodeB]);
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("connecting");
    await vi.advanceTimersByTimeAsync(80);

    void hostedHubController.selectNode(nodeB.id);
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("joined");

    // Still idle: the platform has not even started the attempt yet.
    expect(sessions().read(envB)?.transportStatus).toBe("idle");
    expect(connectEnvironment).toHaveBeenCalledOnce();
    expect(requestEnvironmentReconcile).not.toHaveBeenCalled();
  });

  it("opens one connection when a registry listener acquires the environment again", async () => {
    await signIn([nodeA]);
    const answers: string[] = [];
    const unsubscribe = sessions().subscribe(() => {
      void hostedHubController.acquireEnvironment(nodeA.id).then((answer) => {
        answers.push(answer);
      });
    });

    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
    unsubscribe();
    await flush();

    expect(connectEnvironment).toHaveBeenCalledOnce();
    expect(connectEnvironment).toHaveBeenCalledWith(nodeA, generationOf(envA));
    expect(answers.length).toBeGreaterThan(0);
    expect(new Set(answers)).toEqual(new Set(["joined"]));
  });

  it("opens no connection for a generation a listener replaced meanwhile", async () => {
    await signIn([nodeA]);
    let renewed = false;
    const unsubscribe = sessions().subscribe(() => {
      if (renewed || sessions().read(envA) === undefined) return;
      renewed = true;
      sessions().renew(envA);
    });

    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    unsubscribe();
    await flush();

    expect(connectEnvironment).not.toHaveBeenCalled();
    expect(sessions().read(envA)).toMatchObject({ connectRequested: false });
    expect(await connect(nodeA)).toBe(generationOf(envA));
    expect(connectEnvironment).toHaveBeenCalledOnce();
  });

  it("restarts a suspended environment with a fresh generation", async () => {
    await signIn([nodeA]);
    const first = await connect(nodeA);
    establish(envA, first);

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    expect(sessions().read(envA)).toMatchObject({ suspended: true });

    // Suspension replaced the generation once, and the restart once more.
    const restarted = await connect(nodeA);
    expect(restarted).toBe(first + 2);
    expect(connectEnvironment).toHaveBeenCalledTimes(2);
  });

  it("refuses a blocked environment until its directory entry changes", async () => {
    await signIn([nodeA]);
    const generation = await connect(nodeA);
    sessions().failure(envA, generation, { kind: "incompatible", retryable: false });
    connectEnvironment.mockClear();

    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    expect(portCalls()).toBe(0);

    directory = [{ ...nodeA, clientVersion: "1.0.0" }];
    await hostedHubController.refreshDirectory();

    expect(requestEnvironmentReconcile).toHaveBeenCalledWith({
      reason: "directory",
      environmentId: envA,
    });
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
    expect(connectEnvironment).toHaveBeenCalledOnce();
  });

  it("lifts a selected environment's block when the user retries", async () => {
    await signIn([nodeA]);
    await hostedHubController.selectNode(nodeA.id);
    const generation = await connect(nodeA);
    sessions().failure(envA, generation, { kind: "authentication", retryable: false });
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "terminal-failure",
      browserStatus: "current",
      errorMessage: "The relay authentication attempt expired or was rejected.",
    });
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");

    await hostedHubController.retrySelectedNode();

    expect(requestEnvironmentReconcile).toHaveBeenCalledWith({
      reason: "retry",
      environmentId: envA,
    });
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "idle",
      browserStatus: "synchronizing",
      errorMessage: null,
    });
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
  });

  it("starts over when an environment that can be neither adopted nor joined is selected", async () => {
    await signIn([nodeA, nodeB]);
    await hostedHubController.selectNode(nodeA.id);
    const generation = await connect(nodeB);
    sessions().failure(envB, generation, { kind: "authentication", retryable: false });

    await hostedHubController.selectNode(nodeB.id);

    expect(generationOf(envB)).toBeGreaterThan(generation);
    expect(requestEnvironmentReconcile).toHaveBeenCalledWith({
      reason: "retry",
      environmentId: envB,
    });
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeB,
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      errorMessage: null,
    });
  });

  it("ignores a stale callback after A, B and A again", async () => {
    await signIn([nodeA, nodeB]);
    const first = await connect(nodeA);
    establish(envA, first);
    await hostedHubController.selectNode(nodeA.id);
    await hostedHubController.releaseEnvironment(envA);
    establish(envB, await connect(nodeB));
    await hostedHubController.selectNode(nodeB.id);
    await hostedHubController.releaseEnvironment(envB);
    const again = await connect(nodeA);
    await hostedHubController.selectNode(nodeA.id);
    expect(again).toBeGreaterThan(first);
    const record = sessions().read(envA);
    const shared = hostedHubStore.getState();

    markHostedSessionReady(envA, first);
    sessions().transportStatus(envA, first, "online");
    sessions().role(envA, first, "owner");
    sessions().failure(envA, first, { kind: "revoked", retryable: false });

    expect(sessions().read(envA)).toBe(record);
    expect(hostedHubStore.getState()).toBe(shared);
  });

  it("suspends every environment and reconnects them only after revalidation", async () => {
    await signIn([nodeA, nodeB]);
    const generationA = await connect(nodeA);
    const generationB = await connect(nodeB);
    establish(envA, generationA);
    establish(envB, generationB);
    await hostedHubController.selectNode(nodeA.id);

    hostedHubController.suspendBrowser("hidden");

    for (const record of sessions().list()) {
      expect(canAdoptHostedEnvironmentSession(record)).toBe(false);
    }
    expect(suspendEnvironment).toHaveBeenCalledWith(envA, generationA);
    expect(suspendEnvironment).toHaveBeenCalledWith(envB, generationB);
    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "suspended",
      sessionStatus: "stale",
      sessionEstablished: false,
    });

    let finishCheck: (value: HostedHubSessionResponse) => void = () => undefined;
    vi.mocked(hostedHubApi.restoreSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    connectEnvironment.mockClear();
    const resumed = hostedHubController.resumeBrowser();
    expect(hostedHubStore.getState().browserStatus).toBe("checking-access");
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("refused");
    expect(connectEnvironment).not.toHaveBeenCalled();
    expect(requestEnvironmentReconcile).not.toHaveBeenCalled();

    finishCheck(sessionResponse);
    await resumed;

    // The re-plan follows the revalidation, and the acquisition refused
    // during the check is re-planned with it.
    expect(requestEnvironmentReconcile.mock.calls).toEqual([
      [{ reason: "resume" }],
      [{ reason: "directory", environmentId: envB }],
    ]);
    const listed = vi.mocked(hostedHubApi.listNodes).mock.invocationCallOrder.at(-1)!;
    expect(listed).toBeLessThan(requestEnvironmentReconcile.mock.invocationCallOrder[0]!);
    expect(hostedHubStore.getState().browserStatus).toBe("synchronizing");
    expect(connectEnvironment).not.toHaveBeenCalled();
  });

  it("starts every environment over on a resume that no suspension preceded", async () => {
    await signIn([nodeA, nodeB]);
    await hostedHubController.selectNode(nodeA.id);
    const generationA = await connect(nodeA);
    establish(envA, generationA);
    const generationB = await connect(nodeB);
    establish(envB, generationB);
    const binding = bindingFor(envB, nodeB.id);
    expect(binding.authorizeRequest(dispatchCommand)).toBe("allowed");
    const rotated: HostedHubSessionResponse = {
      ...sessionResponse,
      session: { ...sessionResponse.session, id: "sess_bbbbbbbbbbbbbbbbbbbbbb" },
    };
    // The revalidation finds another session of the same account, and the
    // resume it runs restores that session.
    vi.mocked(hostedHubApi.restoreSession)
      .mockResolvedValueOnce(rotated)
      .mockResolvedValueOnce(rotated);

    await hostedHubController.revalidateSession();

    expect(hostedHubStore.getState()).toMatchObject({
      session: rotated.session,
      browserStatus: "synchronizing",
      sessionEstablished: false,
    });
    for (const record of sessions().list()) {
      expect(canAdoptHostedEnvironmentSession(record)).toBe(false);
    }
    expect(suspendEnvironment).toHaveBeenCalledWith(envA, generationA);
    expect(suspendEnvironment).toHaveBeenCalledWith(envB, generationB);
    expect(requestEnvironmentReconcile.mock.calls).toEqual([[{ reason: "resume" }]]);
    expect(binding.authorizeRequest(dispatchCommand)).not.toBe("allowed");

    // Only the environment's own fresh attempt and snapshot admit it again;
    // the connection opened under the replaced session never does.
    const fresh = await connect(nodeB);
    const freshBinding = bindingFor(envB, nodeB.id);
    sessions().transportStatus(envB, fresh, "online");
    expect(freshBinding.authorizeRequest(dispatchCommand)).not.toBe("allowed");
    markHostedSessionReady(envB, fresh);
    expect(freshBinding.authorizeRequest(dispatchCommand)).toBe("allowed");
    expect(binding.authorizeRequest(dispatchCommand)).toBe("forbidden");
  });

  it("never holds a directory refresh or a resume behind an environment's lifecycle ports", async () => {
    await signIn([nodeA, nodeB]);
    const generation = await connect(nodeB);
    establish(envB, generation);
    holding.add("suspend");
    holding.add("release");
    hostedHubController.suspendBrowser("hidden");
    directory = [nodeA, { ...nodeB, revokedAt: 5 }];

    // B's suspension is still pending, and its release queues behind it.
    expect(await settles(hostedHubController.resumeBrowser())).toBe(true);

    expect(hostedHubStore.getState()).toMatchObject({
      browserStatus: "current",
      directoryStatus: "ready",
    });
    expect(requestEnvironmentReconcile).toHaveBeenCalledWith({ reason: "resume" });
    expect(sessions().read(envB)).toBeUndefined();
    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(await settles(hostedHubController.refreshDirectory())).toBe(true);

    settle("suspend", envB);
    await flush();
    expect(releaseEnvironment).toHaveBeenCalledWith(envB, generation + 1);
    expect(nodeLifecycle.clearNodeScopedState).not.toHaveBeenCalled();

    settle("release", envB);
    await flush();
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(envB);
  });

  it("does not re-check access on a foreground signal while the selection reconnects", async () => {
    await signIn([nodeA]);
    await hostedHubController.selectNode(nodeA.id);
    const generation = await connect(nodeA);
    sessions().failure(envA, generation, { kind: "offline", retryable: true });
    vi.mocked(hostedHubApi.restoreSession).mockClear();

    await hostedHubController.recoverAfterConnectivity();

    expect(hostedHubApi.restoreSession).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().browserStatus).toBe("synchronizing");
  });

  it("queues an environment's connect behind its own release only", async () => {
    await signIn([nodeA]);
    const first = await connect(nodeA);
    holding.add("release");

    const releasing = hostedHubController.releaseEnvironment(envA);
    expect(releaseEnvironment).toHaveBeenCalledWith(envA, first);
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
    const second = generationOf(envA);
    expect(second).toBeGreaterThan(first);
    await flush();
    expect(connectEnvironment).not.toHaveBeenCalledWith(nodeA, second);

    settle("release", envA);
    await releasing;
    await flush();

    expect(connectEnvironment).toHaveBeenLastCalledWith(nodeA, second);
    // The newer session keeps what it has already cached.
    expect(nodeLifecycle.clearNodeScopedState).not.toHaveBeenCalled();
  });

  it("never holds one environment behind another's pending release", async () => {
    await signIn([nodeA, nodeB]);
    await connect(nodeB);
    holding.add("release");
    void hostedHubController.releaseEnvironment(envB);
    connectEnvironment.mockClear();

    void hostedHubController.acquireEnvironment(nodeA.id);
    void hostedHubController.selectNode(nodeA.id);

    expect(connectEnvironment).toHaveBeenCalledWith(nodeA, generationOf(envA));
    expect(hostedHubStore.getState().selectedNode).toBe(nodeA);

    settle("release", envB);
    await flush();
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(envB);
  });

  it("connects after a suspension of the replaced generation has finished", async () => {
    await signIn([nodeB]);
    const first = await connect(nodeB);
    establish(envB, first);
    holding.add("suspend");

    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("connecting");
    const restarted = generationOf(envB);
    expect(restarted).toBe(first + 2);
    await flush();
    expect(connectEnvironment).not.toHaveBeenCalledWith(nodeB, restarted);

    settle("suspend", envB);
    await flush();

    expect(suspendEnvironment).toHaveBeenCalledWith(envB, first);
    expect(connectEnvironment).toHaveBeenLastCalledWith(nodeB, restarted);
  });

  it("opens no queued connection for a generation a withdrawal replaced", async () => {
    await signIn([nodeB]);
    establish(envB, await connect(nodeB));
    holding.add("suspend");
    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    // The connect waits for B's own pending suspension.
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("connecting");
    const queued = generationOf(envB);
    connectEnvironment.mockClear();

    hostedHubController.invalidateNativeE2eeAuthorization();
    expect(generationOf(envB)).toBeGreaterThan(queued);
    settle("suspend", envB);
    await flush();

    expect(connectEnvironment).not.toHaveBeenCalled();
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("connecting");
    expect(connectEnvironment.mock.calls).toEqual([[nodeB, generationOf(envB)]]);
  });

  it("opens no queued connection once the account signed out", async () => {
    await signIn([nodeA]);
    await connect(nodeA);
    holding.add("release");
    void hostedHubController.releaseEnvironment(envA);
    // The connect waits for A's own pending release.
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
    connectEnvironment.mockClear();

    const signingOut = hostedHubController.signOut();
    await flush();
    expect(sessions().read(envA)).toBeUndefined();
    settle("release", envA);
    await flush();
    // Sign-out's own release of the record runs after the skipped connect.
    settle("release", envA);
    await signingOut;
    await flush();

    expect(connectEnvironment).not.toHaveBeenCalled();
    expect(releaseEnvironment).toHaveBeenCalledTimes(2);
  });

  it("never holds signing out behind an environment's release port", async () => {
    await signIn([nodeA, nodeB]);
    await connect(nodeA);
    await connect(nodeB);
    holding.add("release");

    expect(await settles(hostedHubController.signOut())).toBe(true);

    expect(hostedHubStore.getState().accountStatus).toBe("signed-out");
    expect(sessions().list()).toHaveLength(0);
    expect(releaseEnvironment).toHaveBeenCalledTimes(2);
    expect(nodeLifecycle.clearNodeScopedState).not.toHaveBeenCalled();

    settle("release", envA);
    settle("release", envB);
    await flush();
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(envA);
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(envB);
  });

  it("expires the session without waiting for an environment's release port", async () => {
    await signIn([nodeA]);
    await connect(nodeA);
    holding.add("release");
    const expired = new HostedHubApiError(
      "session_invalid",
      401,
      undefined,
      undefined,
      undefined,
      "token-invalidated",
    );

    expect(await settles(hostedHubController.expireSession(expired))).toBe(true);

    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "session-expired",
      errorReason: "token-invalidated",
    });
    expect(releaseEnvironment).toHaveBeenCalledOnce();
  });

  it("suspends each environment once when a second suspension precedes the resume", async () => {
    await signIn([nodeA, nodeB]);
    establish(envA, await connect(nodeA));
    establish(envB, await connect(nodeB));
    hostedHubController.suspendBrowser("hidden");
    expect(suspendEnvironment).toHaveBeenCalledTimes(2);
    const suspendedA = generationOf(envA);
    const suspendedB = generationOf(envB);

    hostedHubController.suspendBrowser("offline");

    expect(hostedHubStore.getState().browserStatus).toBe("offline");
    expect(suspendEnvironment).toHaveBeenCalledTimes(2);
    expect(generationOf(envA)).toBe(suspendedA);
    expect(generationOf(envB)).toBe(suspendedB);

    await hostedHubController.recoverAfterConnectivity();
    expect(suspendEnvironment).toHaveBeenCalledTimes(2);
    expect(await connect(nodeA)).toBeGreaterThan(suspendedB);
  });

  it("re-plans an acquisition refused while suspended once the resume revalidated access", async () => {
    await signIn([nodeA, nodeB]);
    establish(envA, await connect(nodeA));
    await hostedHubController.selectNode(nodeA.id);
    hostedHubController.suspendBrowser("hidden");

    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("refused");
    expect(requestEnvironmentReconcile).not.toHaveBeenCalled();

    await hostedHubController.resumeBrowser();

    expect(requestEnvironmentReconcile.mock.calls).toEqual([
      [{ reason: "resume" }],
      [{ reason: "directory", environmentId: envB }],
    ]);
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("connecting");
    await flush();
    expect(requestEnvironmentReconcile).toHaveBeenCalledTimes(2);
  });

  it("re-plans an acquisition refused before the directory's first load", async () => {
    directory = [nodeA];
    let finishDirectory: () => void = () => undefined;
    vi.mocked(hostedHubApi.listNodes).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDirectory = () => resolve(directory);
        }),
    );
    const booting = hostedHubController.bootstrap();
    await hostedHubController.bootstrapAccess();
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      directoryStatus: "loading",
      browserStatus: "current",
      nodes: [],
    });

    // A restored route acquires its node before the directory knows any.
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    expect(requestEnvironmentReconcile).not.toHaveBeenCalled();
    finishDirectory();
    await booting;

    expect(hostedHubStore.getState().directoryStatus).toBe("ready");
    expect(requestEnvironmentReconcile.mock.calls).toEqual([
      [{ reason: "directory", environmentId: envA }],
    ]);
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
  });

  it("re-plans an acquisition refused before the account was restored", async () => {
    directory = [nodeA];
    let finishCheck: (value: HostedHubSessionResponse) => void = () => undefined;
    vi.mocked(hostedHubApi.restoreSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    const booting = hostedHubController.bootstrap();
    expect(hostedHubStore.getState().accountStatus).not.toBe("authenticated");

    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    finishCheck(sessionResponse);
    await booting;

    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "authenticated",
      directoryStatus: "ready",
    });
    expect(requestEnvironmentReconcile.mock.calls).toEqual([
      [{ reason: "directory", environmentId: envA }],
    ]);
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
  });

  it("re-plans an acquisition refused while offline once connectivity recovered", async () => {
    await signIn([nodeA]);
    hostedHubController.suspendBrowser("offline");

    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    expect(connectEnvironment).not.toHaveBeenCalled();

    await hostedHubController.recoverAfterConnectivity();

    expect(environmentReplans()).toEqual([envA]);
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
  });

  it("re-plans an acquisition refused while the directory was stale once it is current again", async () => {
    await signIn([nodeA]);
    await staleDirectory();
    expect(hostedHubStore.getState().browserStatus).toBe("current");

    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    expect(requestEnvironmentReconcile).not.toHaveBeenCalled();

    await hostedHubController.refreshDirectory();

    expect(requestEnvironmentReconcile.mock.calls).toEqual([
      [{ reason: "directory", environmentId: envA }],
    ]);
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");

    // A directory that was already current is no recovery.
    await hostedHubController.refreshDirectory();
    expect(requestEnvironmentReconcile).toHaveBeenCalledOnce();
  });

  it("never re-plans an acquisition refused for good", async () => {
    const nativeOnly = hubNode("node_cccccccccccccccccccccc", {
      capabilities: { repositoryIdentity: true, nativeClientRequired: true },
    });
    await signIn([nodeA, nodeB, nativeOnly]);
    const generation = await connect(nodeA);
    sessions().failure(envA, generation, { kind: "incompatible", retryable: false });
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    expect(await hostedHubController.acquireEnvironment(nativeOnly.id)).toBe("refused");
    expect(await hostedHubController.acquireEnvironment("node_dddddddddddddddddddddd")).toBe(
      "refused",
    );

    // Refused while the directory is stale, and still blocked or now revoked
    // once it is current again.
    await staleDirectory();
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("refused");
    directory = [nodeA, { ...nodeB, revokedAt: 5 }, nativeOnly];
    await hostedHubController.refreshDirectory();
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");

    // Refused while suspended, and gone from the directory the resume reads.
    hostedHubController.suspendBrowser("hidden");
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    directory = [nativeOnly];
    await hostedHubController.resumeBrowser();

    expect(requestEnvironmentReconcile.mock.calls).toEqual([[{ reason: "resume" }]]);
    expect(sessions().read(envA)).toBeUndefined();
  });

  it("asks once per recovery even when the re-planned acquisition is refused again", async () => {
    await signIn([nodeA]);
    hostedHubController.suspendBrowser("hidden");
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    // The platform acquires as soon as it is asked, and a listener replaces
    // every generation such an acquisition requests a connection for.
    const answers: Array<Promise<string>> = [];
    requestEnvironmentReconcile.mockImplementation((request) => {
      if (request.reason === "directory") {
        answers.push(hostedHubController.acquireEnvironment(nodeA.id));
      }
    });
    let replacing = true;
    const unsubscribe = sessions().subscribe(() => {
      if (replacing && sessions().read(envA)?.connectRequested) sessions().renew(envA);
    });
    try {
      await hostedHubController.resumeBrowser();
      await flush();

      expect(await Promise.all(answers)).toEqual(["refused"]);
      expect(environmentReplans()).toEqual([envA]);
      expect(connectEnvironment).not.toHaveBeenCalled();

      // An unchanged directory is no recovery; the next one asks once more.
      await hostedHubController.refreshDirectory();
      expect(environmentReplans()).toEqual([envA]);
      replacing = false;
      await staleDirectory();
      await hostedHubController.refreshDirectory();

      expect(environmentReplans()).toEqual([envA, envA]);
      expect(await Promise.all(answers)).toEqual(["refused", "connecting"]);
      expect(connectEnvironment).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      requestEnvironmentReconcile.mockImplementation(() => undefined);
    }
  });

  it("re-plans nothing refused before signing out or for another account", async () => {
    await signIn([nodeA]);
    hostedHubController.suspendBrowser("hidden");
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");

    await hostedHubController.signOut();
    await signIn([nodeA]);
    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();

    expect(requestEnvironmentReconcile.mock.calls).toEqual([[{ reason: "resume" }]]);

    await staleDirectory();
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
    const otherAccount: HostedHubSessionResponse = {
      ...sessionResponse,
      account: { ...sessionResponse.account, id: "acct_bbbbbbbbbbbbbbbbbbbbbb" },
      session: {
        ...sessionResponse.session,
        id: "sess_bbbbbbbbbbbbbbbbbbbbbb",
        accountId: "acct_bbbbbbbbbbbbbbbbbbbbbb",
      },
    };
    vi.mocked(hostedHubApi.restoreSession).mockResolvedValueOnce(otherAccount);

    await hostedHubController.adoptSessionCredential(async () => true);

    expect(hostedHubStore.getState()).toMatchObject({
      account: otherAccount.account,
      directoryStatus: "ready",
    });
    expect(environmentReplans()).toEqual([]);
  });

  it("admits a warm environment while the selection still reconnects after a resume", async () => {
    await signIn([nodeA, nodeB]);
    establish(envA, await connect(nodeA));
    establish(envB, await connect(nodeB));
    await hostedHubController.selectNode(nodeA.id);
    hostedHubController.suspendBrowser("hidden");
    await hostedHubController.resumeBrowser();
    expect(hostedHubStore.getState().browserStatus).toBe("synchronizing");

    const selected = await connect(nodeA);
    sessions().failure(envA, selected, { kind: "offline", retryable: true });
    const warm = await connect(nodeB);
    const binding = bindingFor(envB, nodeB.id);
    sessions().transportStatus(envB, warm, "online");
    expect(binding.authorizeRequest(dispatchCommand)).toBe("awaiting-session");

    markHostedSessionReady(envB, warm);

    expect(binding.authorizeRequest(dispatchCommand)).toBe("allowed");
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      transportStatus: "reconnecting",
      browserStatus: "synchronizing",
      errorMessage: "The selected node is offline. Ryco will reconnect when it becomes available.",
    });

    sessions().failure(envA, selected, { kind: "authorization-removed", retryable: false });
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "terminal-failure",
      selectionStatus: "authorization-removed",
      browserStatus: "current",
      effectiveRole: null,
    });
    expect(binding.authorizeRequest(dispatchCommand)).toBe("allowed");
  });

  it("withdraws a ready environment that is not selected in the same tick", async () => {
    await signIn([nodeA, nodeB]);
    establish(envA, await connect(nodeA));
    await hostedHubController.selectNode(nodeA.id);
    establish(envB, await connect(nodeB));
    const binding = bindingFor(envB, nodeB.id);
    expect(binding.authorizeRequest(dispatchCommand)).toBe("allowed");

    hostedHubController.invalidateNativeE2eeAuthorization();

    expect(binding.authorizeRequest(dispatchCommand)).not.toBe("allowed");
    expect(sessions().read(envB)).toMatchObject({
      effectiveRole: null,
      sessionStatus: "closed",
      suspended: true,
    });
    expect(hostedHubStore.getState()).toMatchObject({
      effectiveRole: null,
      transportStatus: "reconnecting",
      sessionStatus: "closed",
      sessionEstablished: false,
    });
    expect(await hostedHubController.acquireEnvironment(nodeB.id)).toBe("connecting");
  });

  it("fails every environment session on a terminal Hub session failure", async () => {
    await signIn([nodeA, nodeB]);
    await hostedHubController.selectNode(nodeA.id);
    establish(envA, await connect(nodeA));
    await connect(nodeB);

    hostedHubController.reportHubSessionFailure({ kind: "authentication", retryable: false });

    expect(
      sessions()
        .list()
        .map((record) => record.transportStatus),
    ).toEqual(["terminal-failure", "terminal-failure"]);
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "terminal-failure",
      effectiveRole: null,
      browserStatus: "current",
    });
  });

  it("releases every environment whose node the directory revoked", async () => {
    await signIn([nodeA, nodeB]);
    await hostedHubController.selectNode(nodeA.id);
    establish(envA, await connect(nodeA));
    const revokedGeneration = await connect(nodeB);

    directory = [nodeA, { ...nodeB, revokedAt: 5 }];
    await hostedHubController.refreshDirectory();

    expect(sessions().read(envB)).toBeUndefined();
    expect(releaseEnvironment).toHaveBeenCalledWith(envB, revokedGeneration);
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(envB);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: nodeA,
      sessionStatus: "ready",
    });

    directory = [{ ...nodeA, revokedAt: 6 }];
    await hostedHubController.refreshDirectory();

    expect(sessions().read(envA)).toBeUndefined();
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: null,
      selectionStatus: "revoked",
      effectiveRole: null,
      transportStatus: "idle",
      sessionStatus: "closed",
    });
  });

  it("leaves the selection when its node becomes locked for this client", async () => {
    await signIn([nodeA]);
    await hostedHubController.selectNode(nodeA.id);
    const generation = await connect(nodeA);
    establish(envA, generation);

    directory = [
      { ...nodeA, capabilities: { repositoryIdentity: true, nativeClientRequired: true } },
    ];
    await hostedHubController.refreshDirectory();

    expect(releaseEnvironment).toHaveBeenCalledWith(envA, generation);
    expect(sessions().read(envA)).toBeUndefined();
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: null,
      selectionStatus: "none",
      effectiveRole: null,
      transportStatus: "idle",
      sessionStatus: "closed",
      browserStatus: "current",
      errorMessage: null,
    });
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenLastCalledWith(null);
  });

  it("publishes a changed role once, through the selected record", async () => {
    await signIn([nodeA]);
    await hostedHubController.selectNode(nodeA.id);
    establish(envA, await connect(nodeA));
    const roles: Array<string | null> = [];
    let last = hostedHubStore.getState().effectiveRole;
    const unsubscribe = hostedHubStore.subscribe(() => {
      const role = hostedHubStore.getState().effectiveRole;
      if (role !== last) roles.push(role);
      last = role;
    });

    directory = [{ ...nodeA, effectiveRole: "owner", grant: { ...nodeA.grant, role: "owner" } }];
    await hostedHubController.refreshDirectory();
    unsubscribe();

    expect(sessions().read(envA)?.effectiveRole).toBe("owner");
    expect(roles).toEqual(["owner"]);
  });

  it("keeps a spent transfer budget on the selection quiet", async () => {
    await signIn([nodeA]);
    await hostedHubController.selectNode(nodeA.id);
    const generation = await connect(nodeA);
    establish(envA, generation);

    sessions().failure(envA, generation, {
      kind: "budget",
      retryable: true,
      closeReason: "transfer_limit",
    });

    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "reconnecting",
      sessionStatus: "stale",
      errorMessage: null,
    });
  });

  it("keeps a directory failure's message until the selected session's own error changes", async () => {
    await signIn([nodeA]);
    await hostedHubController.selectNode(nodeA.id);
    const generation = await connect(nodeA);
    hostedHubStore.setState({ errorMessage: "Hub is temporarily unavailable." });

    sessions().transportStatus(envA, generation, "online");
    expect(hostedHubStore.getState().errorMessage).toBe("Hub is temporarily unavailable.");

    sessions().failure(envA, generation, { kind: "offline", retryable: true });
    expect(hostedHubStore.getState().errorMessage).toBe(
      "The selected node is offline. Ryco will reconnect when it becomes available.",
    );
  });

  it("fails a requested session that misses its synchronization deadline", async () => {
    await signIn([nodeA]);
    await hostedHubController.selectNode(nodeA.id);
    await connect(nodeA);

    await vi.advanceTimersByTimeAsync(HOSTED_SESSION_SYNC_DEADLINE_MS);

    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "terminal-failure",
      browserStatus: "current",
      errorMessage: HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
    });
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("refused");
  });

  it("routes readiness per record and hands each ready edge to the dispatch replay once", async () => {
    const markReady = vi.spyOn(getHostedDispatchReplay(), "markReady");
    await signIn([nodeA, nodeB]);
    const generationA = await connect(nodeA);
    const generationB = await connect(nodeB);
    sessions().transportStatus(envA, generationA, "online");
    sessions().transportStatus(envB, generationB, "online");

    markHostedSessionReady(envA, generationA);
    markHostedSessionReady(envA, generationA);
    markHostedSessionReady(envB, generationA);

    expect(sessions().read(envA)?.sessionStatus).toBe("ready");
    expect(sessions().read(envB)?.sessionEstablished).toBe(false);
    expect(markReady.mock.calls).toEqual([[envA]]);

    markHostedSessionReady(envB, generationB);
    expect(markReady.mock.calls).toEqual([[envA], [envB]]);

    // A replacement channel of the same generation is ready again only on its
    // own snapshot, and that is a new ready edge.
    sessions().connectionClosed(envA, generationA);
    sessions().connectionRecovered(envA, generationA);
    sessions().transportStatus(envA, generationA, "online");
    markHostedSessionReady(envA, generationA);
    expect(markReady.mock.calls).toEqual([[envA], [envB], [envA]]);
  });

  it("acknowledges an unconfirmed action on any environment", async () => {
    const markReady = vi.spyOn(getHostedDispatchReplay(), "markReady");
    await signIn([nodeA, nodeB]);
    await hostedHubController.selectNode(nodeA.id);
    const generation = await connect(nodeB);
    establish(envB, generation);
    markReady.mockClear();

    hostedHubController.markEnvironmentDeliveryUnknown(envB);
    expect(sessions().read(envB)).toMatchObject({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    });
    expect(hostedHubStore.getState().sessionStatus).toBe("synchronizing");

    hostedHubController.acknowledgeDeliveryUnknown(envB);

    expect(sessions().read(envB)?.sessionStatus).toBe("ready");
    expect(markReady.mock.calls).toEqual([[envB]]);
  });

  it("releases the selection with its environment, and nothing when returning to the directory", async () => {
    await signIn([nodeA, nodeB]);
    const generation = await connect(nodeA);
    establish(envA, generation);
    await hostedHubController.selectNode(nodeA.id);
    await connect(nodeB);

    await hostedHubController.returnToDirectory();

    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: null,
      selectionStatus: "none",
      transportStatus: "idle",
      sessionStatus: "closed",
      browserStatus: "current",
    });
    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(sessions().list()).toHaveLength(2);
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenLastCalledWith(null);

    void hostedHubController.selectNode(nodeA.id);
    expect(hostedHubStore.getState().sessionStatus).toBe("ready");

    await hostedHubController.releaseEnvironment(envA);

    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: null,
      selectionStatus: "none",
      sessionStatus: "closed",
    });
    expect(releaseEnvironment).toHaveBeenCalledWith(envA, generation);
    expect(sessions().read(envA)).toBeUndefined();
    expect(sessions().read(envB)).toBeDefined();
  });

  it("releases every environment on sign-out", async () => {
    await signIn([nodeA, nodeB]);
    await hostedHubController.selectNode(nodeA.id);
    const generationA = await connect(nodeA);
    const generationB = await connect(nodeB);

    await hostedHubController.signOut();

    expect(releaseEnvironment).toHaveBeenCalledWith(envA, generationA);
    expect(releaseEnvironment).toHaveBeenCalledWith(envB, generationB);
    expect(sessions().list()).toHaveLength(0);
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(envA);
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(envB);
    expect(hostedHubStore.getState()).toMatchObject({
      accountStatus: "signed-out",
      selectedNode: null,
    });
  });

  it("clears an ended account session's state even for an environment acquired again meanwhile", async () => {
    await signIn([nodeA]);
    const first = await connect(nodeA);
    holding.add("release");

    const clearing = hostedHubController.clearAccount("session-expired");
    expect(releaseEnvironment).toHaveBeenCalledWith(envA, first);
    await signIn([nodeA]);
    expect(await hostedHubController.acquireEnvironment(nodeA.id)).toBe("connecting");
    const next = generationOf(envA);
    await flush();
    expect(connectEnvironment).not.toHaveBeenCalledWith(nodeA, next);

    settle("release", envA);
    await clearing;
    await flush();

    // The next session never starts on the previous one's cached state, and
    // connects only after it is gone.
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(envA);
    expect(connectEnvironment).toHaveBeenLastCalledWith(nodeA, next);
    expect(
      vi.mocked(nodeLifecycle.clearNodeScopedState).mock.invocationCallOrder.at(-1),
    ).toBeLessThan(connectEnvironment.mock.invocationCallOrder.at(-1) ?? 0);
  });

  it("neither acquires nor selects a node that requires a native client in the browser", async () => {
    const nativeOnly = hubNode("node_cccccccccccccccccccccc", {
      capabilities: { repositoryIdentity: true, nativeClientRequired: true },
    });
    await signIn([nodeA, nativeOnly]);

    expect(await hostedHubController.acquireEnvironment(nativeOnly.id)).toBe("refused");
    expect(connectEnvironment).not.toHaveBeenCalled();

    // Nor does selecting it move the selection, which could only show it
    // synchronizing for good.
    await hostedHubController.selectNode(nodeA.id);
    const selected = hostedHubStore.getState();
    vi.mocked(nodeLifecycle.writePrimaryEnvironmentDescriptor).mockClear();

    await hostedHubController.selectNode(nativeOnly.id);

    expect(hostedHubStore.getState()).toBe(selected);
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).not.toHaveBeenCalled();
    expect(portCalls()).toBe(0);
  });

  it("requires every retained lifecycle port", async () => {
    const {
      connectEnvironment: _connect,
      requestEnvironmentReconcile: _reconcile,
      ...partial
    } = nodeLifecycle;
    configureRuntime(partial);

    await expect(hostedHubController.acquireEnvironment(nodeA.id)).rejects.toThrow(
      "Retained hosted sessions require the connectEnvironment, releaseEnvironment, suspendEnvironment and requestEnvironmentReconcile lifecycle ports.",
    );
  });

  it("reports missing retained lifecycle ports at first use, never as a Hub failure", async () => {
    const { releaseEnvironment: _release, ...partial } = nodeLifecycle;
    configureRuntime(partial);
    directory = [nodeA];
    const initial = hostedHubStore.getState();

    expect(() => hostedHubController.bootstrap()).toThrow(
      "Retained hosted sessions require the connectEnvironment, releaseEnvironment, suspendEnvironment and requestEnvironmentReconcile lifecycle ports.",
    );
    expect(hostedHubApi.restoreSession).not.toHaveBeenCalled();
    expect(hostedHubStore.getState()).toBe(initial);

    // Ports that went missing after sign-in fail the directory read the same
    // way, without publishing a stale directory.
    configureRuntime();
    await signIn([nodeA]);
    configureRuntime(partial);
    vi.mocked(hostedHubApi.listNodes).mockClear();

    await expect(hostedHubController.refreshDirectory()).rejects.toThrow(
      "Retained hosted sessions require",
    );
    expect(hostedHubApi.listNodes).not.toHaveBeenCalled();
    expect(hostedHubStore.getState()).toMatchObject({
      directoryStatus: "ready",
      errorMessage: null,
    });
  });
});
