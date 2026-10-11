import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";

import {
  activateHostedNode,
  clearHostedNodeScopedState,
  deactivateHostedNode,
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
