import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";

import { getHostedDispatchReplay } from "../relay/dispatchReplay.ts";
import {
  activateHostedNode,
  clearHostedNodeScopedState,
  connectHostedEnvironment,
  deactivateHostedNode,
  releaseHostedEnvironment,
  requestHostedEnvironmentReconcile,
  setActiveHostedEnvironment,
  suspendHostedEnvironment,
  suspendHostedNode,
} from "./environment.ts";
import {
  configureHostedRuntime,
  type HostedNodeLifecycle,
  type HostedRuntimeConfiguration,
} from "./runtime.ts";
import type { HostedHubApi } from "./api.ts";
import type { HostedHubNode } from "./types.ts";

/**
 * The transition queue is the single owner of the node teardown order and of
 * the relay-attempt reset. Its browser-facing effects — the app UI store
 * clearing catalog and the primary-environment connect/disconnect — are
 * injected as the `nodeLifecycle` dependency, so these tests assert the
 * ordering and the reset ownership against fakes, without touching web stores.
 */

const environmentId = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");

const resetRelayAttemptFactory = vi.fn();
const nodeLifecycle: HostedNodeLifecycle = {
  activate: vi.fn(async () => undefined),
  suspend: vi.fn(async () => undefined),
  deactivate: vi.fn(async () => undefined),
  clearNodeScopedState: vi.fn(),
  writePrimaryEnvironmentDescriptor: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(async () => undefined),
  setActiveEnvironmentId: vi.fn(),
};

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the transition-queue tests");
    },
  },
);

function fakeRuntime(): HostedRuntimeConfiguration {
  return {
    endpoint: unusedService as EndpointService,
    httpClient: unusedService as HttpClientService,
    passkeyCeremony: unusedService as PasskeyCeremonyService,
    sessionCredentials: unusedService as SessionCredentialsService,
    nodeLifecycle,
    timers: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
      queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
    },
    isForeground: () => true,
    subscribeForeground: () => () => undefined,
    hasPendingRelayRequests: () => false,
    resetRelayAttemptFactory,
    relayUrl: () => "wss://hub.example.test/v1/relay/client",
    createRelaySocket: () => ({}),
  };
}

function node(): HostedHubNode {
  return {
    id: "node_aaaaaaaaaaaaaaaaaaaaaa",
    environmentId,
    label: "Node",
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant_aaaaaaaaaaaaaaaaaaaaaa", role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  configureHostedRuntime(fakeRuntime(), {} as HostedHubApi);
});

afterEach(async () => {
  await deactivateHostedNode(environmentId);
  vi.clearAllMocks();
});

describe("hosted node transition queue", () => {
  it("delegates node-scoped clearing to the injected browser catalog", () => {
    clearHostedNodeScopedState(environmentId);
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(environmentId);
  });

  it("resets the relay attempt exactly once during ordered teardown", async () => {
    await activateHostedNode(node(), null);
    expect(nodeLifecycle.connectPrimaryEnvironment).toHaveBeenCalledOnce();

    await deactivateHostedNode(environmentId);

    expect(resetRelayAttemptFactory).toHaveBeenCalledOnce();
    expect(nodeLifecycle.disconnectPrimaryEnvironment).toHaveBeenCalledOnce();
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(environmentId);
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenLastCalledWith(null);
  });

  it("runs the deactivation effects in the documented order", async () => {
    await deactivateHostedNode(environmentId);

    const reset = resetRelayAttemptFactory.mock.invocationCallOrder[0]!;
    const disconnect = vi.mocked(nodeLifecycle.disconnectPrimaryEnvironment).mock
      .invocationCallOrder[0]!;
    const clear = vi.mocked(nodeLifecycle.clearNodeScopedState).mock.invocationCallOrder[0]!;
    const descriptor = vi.mocked(nodeLifecycle.writePrimaryEnvironmentDescriptor).mock
      .invocationCallOrder[0]!;
    // Documented switching-nodes teardown order: reset the relay attempt, then
    // disconnect the primary environment, then clear node-scoped state, then
    // write a null primary descriptor.
    expect(reset).toBeLessThan(disconnect);
    expect(disconnect).toBeLessThan(clear);
    expect(clear).toBeLessThan(descriptor);
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(environmentId);
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenCalledWith(null);
  });

  it("recovers the same node without clearing its node-scoped state", async () => {
    await activateHostedNode(node(), null);
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId }),
    );
    expect(nodeLifecycle.setActiveEnvironmentId).toHaveBeenCalledWith(environmentId);

    await activateHostedNode(node(), environmentId);

    expect(resetRelayAttemptFactory).toHaveBeenCalledOnce();
    expect(nodeLifecycle.disconnectPrimaryEnvironment).toHaveBeenCalledOnce();
    expect(nodeLifecycle.connectPrimaryEnvironment).toHaveBeenCalledTimes(2);
    // Same-node recovery must not run the destructive clearing catalog.
    expect(nodeLifecycle.clearNodeScopedState).not.toHaveBeenCalled();
  });

  it("suspends hosted transport idempotently without a second reset", async () => {
    await activateHostedNode(node(), null);
    vi.clearAllMocks();

    await Promise.all([
      suspendHostedNode(environmentId),
      suspendHostedNode(environmentId),
      suspendHostedNode(environmentId),
    ]);

    expect(resetRelayAttemptFactory).toHaveBeenCalledOnce();
    expect(nodeLifecycle.disconnectPrimaryEnvironment).toHaveBeenCalledOnce();
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).not.toHaveBeenCalled();
    expect(nodeLifecycle.clearNodeScopedState).not.toHaveBeenCalled();

    await activateHostedNode(node(), environmentId);
    expect(resetRelayAttemptFactory).toHaveBeenCalledOnce();
    expect(nodeLifecycle.disconnectPrimaryEnvironment).toHaveBeenCalledOnce();
    expect(nodeLifecycle.connectPrimaryEnvironment).toHaveBeenCalledOnce();
  });
});

/**
 * The concurrency invariant.
 *
 * Wave 3a leaves the thread-open retarget ungated, and the entire basis for
 * that decision is this: however many node switches the UI dispatches, and
 * however they interleave, the transition queue keeps exactly one hosted
 * connection live. A second live connection would mean two relay sessions
 * writing the single process-global ws-connection atom and two writers of the
 * primary-environment descriptor, with the last one winning at random.
 */
describe("hosted node transition queue concurrency", () => {
  const environmentA = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
  const environmentB = EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb");
  const environmentC = EnvironmentId.make("env_cccccccccccccccccccccc");

  function nodeFor(id: string, nodeEnvironmentId: EnvironmentId): HostedHubNode {
    return { ...node(), id, environmentId: nodeEnvironmentId };
  }

  it("never lets a second hosted connection be live while another is being torn down", async () => {
    let live = 0;
    let maxLive = 0;
    const activated: EnvironmentId[] = [];
    const countingLifecycle: HostedNodeLifecycle = {
      activate: async () => undefined,
      suspend: async () => undefined,
      deactivate: async () => undefined,
      clearNodeScopedState: () => undefined,
      writePrimaryEnvironmentDescriptor: () => undefined,
      setActiveEnvironmentId: (id) => {
        activated.push(id);
      },
      connectPrimaryEnvironment: () => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        // Fail loudly at the exact interleaving rather than only in the
        // aggregate, so a regression names the transition that broke it.
        if (live > 1) throw new Error(`hosted connections live at once: ${live}`);
      },
      disconnectPrimaryEnvironment: async () => {
        // A real await inside teardown widens the window in which a queued
        // activation could interleave; without it the queue would be trivially
        // serial and the assertion would prove nothing.
        await Promise.resolve();
        live = Math.max(0, live - 1);
      },
    };
    configureHostedRuntime(
      { ...fakeRuntime(), nodeLifecycle: countingLifecycle },
      {} as HostedHubApi,
    );

    await Promise.all([
      activateHostedNode(nodeFor("node_a", environmentA), null),
      activateHostedNode(nodeFor("node_b", environmentB), environmentA),
      deactivateHostedNode(environmentB),
      activateHostedNode(nodeFor("node_c", environmentC), environmentB),
    ]);

    expect(maxLive).toBe(1);
    expect(live).toBe(1);
    expect(activated.at(-1)).toBe(environmentC);
  });
});

/**
 * Retained environment sessions keep one connection per environment. Each
 * environment's connect, release and suspension run on its own queue, name the
 * session generation they act for, and never wait for another environment.
 */
describe("retained hosted environment transitions", () => {
  const environmentA = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
  const environmentB = EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb");

  function nodeFor(id: string, nodeEnvironmentId: EnvironmentId): HostedHubNode {
    return { ...node(), id, environmentId: nodeEnvironmentId };
  }

  function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  async function flush(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  }

  const order: string[] = [];
  const pending = new Map<string, () => void>();
  /** A connect's generation that nothing replaced while it waited. */
  const current = () => true;

  function held(port: string, environmentId: EnvironmentId, generation: number): Promise<void> {
    order.push(`${port}:${environmentId}:${generation}`);
    const gate = deferred();
    pending.set(`${port}:${environmentId}`, gate.resolve);
    return gate.promise;
  }

  /** Resolve a held port once the environment's queue has reached it. */
  async function settle(port: string, environmentId: EnvironmentId): Promise<void> {
    await flush();
    const resolve = pending.get(`${port}:${environmentId}`);
    if (resolve === undefined) throw new Error(`no held ${port} for ${environmentId}`);
    pending.delete(`${port}:${environmentId}`);
    resolve();
  }

  const retainedLifecycle: HostedNodeLifecycle = {
    ...nodeLifecycle,
    connectEnvironment: vi.fn((connected: HostedHubNode, generation: number) => {
      order.push(`connect:${connected.environmentId}:${generation}`);
    }),
    releaseEnvironment: vi.fn((environmentId: EnvironmentId, generation: number) =>
      held("release", environmentId, generation),
    ),
    suspendEnvironment: vi.fn((environmentId: EnvironmentId, generation: number) =>
      held("suspend", environmentId, generation),
    ),
    requestEnvironmentReconcile: vi.fn(),
  };

  beforeEach(() => {
    order.length = 0;
    configureHostedRuntime(
      { ...fakeRuntime(), nodeLifecycle: retainedLifecycle, environmentSessions: "retained" },
      {} as HostedHubApi,
    );
  });

  afterEach(async () => {
    for (const resolve of pending.values()) resolve();
    pending.clear();
    await flush();
  });

  it("orders one environment's transitions and never holds another behind them", async () => {
    const releasing = releaseHostedEnvironment(environmentA, 1, () => false);
    void connectHostedEnvironment(nodeFor("node_a", environmentA), 2, current);
    // Environment B has nothing pending: its connect runs in the same tick.
    void connectHostedEnvironment(nodeFor("node_b", environmentB), 3, current);
    void suspendHostedEnvironment(environmentB, 3);

    expect(order).toEqual([`release:${environmentA}:1`, `connect:${environmentB}:3`]);
    await flush();
    // B's suspension followed B's own connect; A's connect still waits for A's
    // release, which nothing else waits for.
    expect(order).toEqual([
      `release:${environmentA}:1`,
      `connect:${environmentB}:3`,
      `suspend:${environmentB}:3`,
    ]);

    await settle("release", environmentA);
    await releasing;
    await flush();

    expect(order.at(-1)).toBe(`connect:${environmentA}:2`);
  });

  it("runs a transition enqueued by running work after it, and later ones after both", async () => {
    vi.mocked(retainedLifecycle.connectEnvironment!).mockImplementationOnce(
      (connected: HostedHubNode, generation: number) => {
        order.push(`connect:${connected.environmentId}:${generation}`);
        // A listener of the connection this opens releases the environment
        // before the connect port has returned.
        void releaseHostedEnvironment(connected.environmentId, generation, () => false);
      },
    );

    void connectHostedEnvironment(nodeFor("node_a", environmentA), 1, current);
    void connectHostedEnvironment(nodeFor("node_a", environmentA), 2, current);
    await flush();
    // The next connect waits for the release the first one's work enqueued.
    expect(order).toEqual([`connect:${environmentA}:1`, `release:${environmentA}:1`]);

    await settle("release", environmentA);
    await flush();

    expect(order).toEqual([
      `connect:${environmentA}:1`,
      `release:${environmentA}:1`,
      `connect:${environmentA}:2`,
    ]);
  });

  it("opens nothing for a generation replaced while its connect waited", async () => {
    let stillCurrent = true;
    const releasing = releaseHostedEnvironment(environmentA, 1, () => false);
    void connectHostedEnvironment(nodeFor("node_a", environmentA), 2, () => stillCurrent);

    stillCurrent = false;
    await settle("release", environmentA);
    await releasing;
    await flush();

    expect(order).toEqual([`release:${environmentA}:1`]);
    expect(retainedLifecycle.connectEnvironment).not.toHaveBeenCalled();
  });

  it("passes the session generation to every port", async () => {
    void connectHostedEnvironment(nodeFor("node_a", environmentA), 7, current);
    const suspending = suspendHostedEnvironment(environmentA, 7);
    await settle("suspend", environmentA);
    await suspending;
    const releasing = releaseHostedEnvironment(environmentA, 8, () => false);
    await settle("release", environmentA);
    await releasing;
    requestHostedEnvironmentReconcile({ reason: "retry", environmentId: environmentA });

    expect(retainedLifecycle.connectEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: environmentA }),
      7,
    );
    expect(retainedLifecycle.suspendEnvironment).toHaveBeenCalledWith(environmentA, 7);
    expect(retainedLifecycle.releaseEnvironment).toHaveBeenCalledWith(environmentA, 8);
    expect(retainedLifecycle.requestEnvironmentReconcile).toHaveBeenCalledWith({
      reason: "retry",
      environmentId: environmentA,
    });
  });

  it("ends the environment's replays and clears its state only without a newer session", async () => {
    const end = vi.spyOn(getHostedDispatchReplay(), "end");
    let newer = true;

    const keeping = releaseHostedEnvironment(environmentA, 1, () => newer);
    await settle("release", environmentA);
    await keeping;
    expect(end).toHaveBeenCalledWith(environmentA);
    expect(nodeLifecycle.clearNodeScopedState).not.toHaveBeenCalled();

    newer = false;
    const clearing = releaseHostedEnvironment(environmentA, 2, () => newer);
    await settle("release", environmentA);
    await clearing;
    expect(nodeLifecycle.clearNodeScopedState).toHaveBeenCalledWith(environmentA);
    end.mockRestore();
  });

  it("shows the active environment at once, without waiting for its transitions", () => {
    void releaseHostedEnvironment(environmentA, 1, () => false);

    setActiveHostedEnvironment(nodeFor("node_a", environmentA));
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentId: environmentA }),
    );
    expect(nodeLifecycle.setActiveEnvironmentId).toHaveBeenLastCalledWith(environmentA);

    setActiveHostedEnvironment(null);
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenLastCalledWith(null);
    // Showing an environment never connects or disconnects anything.
    expect(retainedLifecycle.connectEnvironment).not.toHaveBeenCalled();
    expect(nodeLifecycle.disconnectPrimaryEnvironment).not.toHaveBeenCalled();
  });

  it("states thread settlement in the selected node's placeholder only as its directory does", () => {
    setActiveHostedEnvironment({
      ...nodeFor("node_a", environmentA),
      capabilities: {
        repositoryIdentity: true,
        nativeClientRequired: false,
        threadSettlement: true,
      },
    });
    expect(nodeLifecycle.writePrimaryEnvironmentDescriptor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capabilities: expect.objectContaining({ threadSettlement: true }),
      }),
    );
  });

  it("requires every retained lifecycle port at first use", () => {
    const { suspendEnvironment: _suspend, ...partial } = retainedLifecycle;
    configureHostedRuntime(
      { ...fakeRuntime(), nodeLifecycle: partial, environmentSessions: "retained" },
      {} as HostedHubApi,
    );
    const message =
      "Retained hosted sessions require the connectEnvironment, releaseEnvironment, suspendEnvironment and requestEnvironmentReconcile lifecycle ports.";

    expect(() => connectHostedEnvironment(nodeFor("node_a", environmentA), 1, current)).toThrow(
      message,
    );
    expect(() => releaseHostedEnvironment(environmentA, 1, () => false)).toThrow(message);
    expect(() => requestHostedEnvironmentReconcile({ reason: "resume" })).toThrow(message);
    expect(retainedLifecycle.connectEnvironment).not.toHaveBeenCalled();
  });
});
