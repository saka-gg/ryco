import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  AppLifecycleEvent,
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";

import { bindConnectivityRecovery } from "../connection/connectivityRecovery.ts";
import type { HostedHubApi } from "./api.ts";
import {
  BACKGROUND_STAY_HEARTBEAT_WAIT_MS,
  createHostedBackgroundStayPolicy,
  hostedSessionsKeepable,
} from "./hostedBackgroundStay.ts";
import {
  canAdoptHostedEnvironmentSession,
  getHostedEnvironmentSessions,
  resetHostedEnvironmentSessionsForTests,
} from "./hostedEnvironmentSessions.ts";
import { configureHostedRuntime, type HostedNodeLifecycle } from "./runtime.ts";
import { hostedHubController, hostedHubStore, markHostedSessionReady } from "./state.ts";
import type { HostedHubNode, HostedHubSessionResponse } from "./types.ts";

/**
 * The background stay (findings F1) through the real hosted controller, the
 * real session registry and the real connectivity binding. Only the Hub API,
 * the platform's lifecycle ports, its background time and its connections'
 * heartbeats are fakes. Each Hub API call and each lifecycle port call is a
 * network exchange on a real phone, so their counts are what a two-second app
 * switch costs.
 */

function hubNode(suffix: string): HostedHubNode {
  return {
    id: `node_${suffix.repeat(22)}`,
    environmentId: EnvironmentId.make(`env_${suffix.repeat(22)}`),
    label: `Node ${suffix}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix.repeat(22)}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

const nodes = [hubNode("a"), hubNode("b"), hubNode("c")];

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
  credentialMode: "cookie",
  restoreSession: vi.fn(async () => sessionResponse),
  listNodes: vi.fn(async () => nodes),
  getBootstrapAvailability: vi.fn(async () => false),
  signOut: vi.fn(async () => undefined),
  clearSessionMaterial: vi.fn(),
} as unknown as HostedHubApi;

const connectEnvironment = vi.fn((_node: HostedHubNode, _generation: number) => undefined);
const suspendEnvironment = vi.fn(async (_environmentId: EnvironmentId, _generation: number) => {});
const releaseEnvironment = vi.fn(async (_environmentId: EnvironmentId, _generation: number) => {});
const requestEnvironmentReconcile = vi.fn();

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
      throw new Error("platform service is not used by the background stay tests");
    },
  },
);

function configureRuntime(): void {
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
        throw new Error("no relay socket is opened by the background stay tests");
      },
    },
    hostedHubApi,
  );
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

const sessions = () => getHostedEnvironmentSessions();

/** Signs in and brings every node's session to adoptable, as after a launch. */
async function signInWithLiveSessions(): Promise<void> {
  await hostedHubController.bootstrap();
  for (const node of nodes) {
    expect(await hostedHubController.acquireEnvironment(node.id)).toBe("connecting");
    const generation = sessions().read(node.environmentId)!.generation;
    sessions().transportStatus(node.environmentId, generation, "online");
    markHostedSessionReady(node.environmentId, generation);
  }
  for (const record of sessions().list())
    expect(canAdoptHostedEnvironmentSession(record)).toBe(true);
}

/** Network exchanges since `vi.clearAllMocks`: Hub HTTP calls and relay connection work. */
function exchanges() {
  return {
    hubSessionChecks: vi.mocked(hostedHubApi.restoreSession).mock.calls.length,
    hubDirectoryReads: vi.mocked(hostedHubApi.listNodes).mock.calls.length,
    relaySuspensions: suspendEnvironment.mock.calls.length,
    // A suspended session is re-acquired on a fresh generation: a new relay
    // socket, auth frame, E2EE handshake and a full shell snapshot per node.
    nodesOwingFreshAttempt: sessions()
      .list()
      .filter((record) => !canAdoptHostedEnvironmentSession(record)).length,
  };
}

function lifecycleHarness() {
  let foreground = true;
  const listeners = new Set<(event: AppLifecycleEvent) => void>();
  return {
    lifecycle: {
      isForeground: () => foreground,
      isOnline: () => true,
      subscribe: (listener: (event: AppLifecycleEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event: AppLifecycleEvent) {
      if (event === "background") foreground = false;
      if (event === "foreground") foreground = true;
      for (const listener of listeners) listener(event);
    },
  };
}

function platformStay() {
  const state = { expired: false, ended: 0, expire: null as (() => void) | null };
  return {
    state,
    begin: vi.fn((expire: () => void) => {
      state.expire = expire;
      return {
        remainingMs: Number.POSITIVE_INFINITY,
        expiredByPlatform: () => state.expired,
        end: () => {
          state.ended += 1;
        },
      };
    }),
  };
}

function bind(options: { readonly stay: boolean; readonly heartbeat?: () => "fresh" | "stale" }) {
  const app = lifecycleHarness();
  const platform = platformStay();
  const resumeKept = vi.fn();
  const heartbeat = vi.fn(
    (environmentId: EnvironmentId, generation: number): "fresh" | "stale" | "missing" => {
      const record = sessions().read(environmentId);
      if (record?.generation !== generation) return "missing";
      return options.heartbeat?.() ?? "fresh";
    },
  );
  const dispose = bindConnectivityRecovery({
    lifecycle: app.lifecycle,
    suspend: (reason) => hostedHubController.suspendBrowser(reason),
    releaseBackground: async () => undefined,
    recover: () => hostedHubController.recoverAfterConnectivity(),
    beginWake: () => () => undefined,
    cancelWake: () => undefined,
    backgroundStay: options.stay
      ? createHostedBackgroundStayPolicy({
          readHosted: () => hostedHubStore.getState(),
          sessions: sessions(),
          beginPlatformStay: platform.begin,
          connectionHeartbeat: heartbeat,
          resumeKept,
        })
      : undefined,
  });
  return { ...app, platform, resumeKept, heartbeat, dispose };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  configureRuntime();
});

afterEach(async () => {
  await flush();
  hostedHubController.resetForTests();
  resetHostedEnvironmentSessionsForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a two-second app switch with three Hub machines", () => {
  it("before: suspends every session and recovers from scratch", async () => {
    await signInWithLiveSessions();
    const h = bind({ stay: false });
    vi.clearAllMocks();
    h.emit("background");
    await vi.advanceTimersByTimeAsync(2_000);
    h.emit("foreground");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(exchanges()).toEqual({
      hubSessionChecks: 1,
      hubDirectoryReads: 1,
      relaySuspensions: 3,
      nodesOwingFreshAttempt: 3,
    });
    h.dispose();
  });

  it("after: keeps every session and only reads the heartbeats", async () => {
    await signInWithLiveSessions();
    const generations = sessions()
      .list()
      .map((record) => record.generation);
    const h = bind({ stay: true });
    vi.clearAllMocks();
    h.emit("background");
    expect(h.platform.begin).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    h.emit("foreground");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(exchanges()).toEqual({
      hubSessionChecks: 0,
      hubDirectoryReads: 0,
      relaySuspensions: 0,
      nodesOwingFreshAttempt: 0,
    });
    expect(
      sessions()
        .list()
        .map((record) => record.generation),
    ).toEqual(generations);
    expect(hostedHubStore.getState().browserStatus).toBe("current");
    expect(h.heartbeat).toHaveBeenCalledTimes(3);
    expect(h.resumeKept).toHaveBeenCalledOnce();
    expect(h.platform.state.ended).toBe(1);
    h.dispose();
  });
});

describe("the hosted background stay", () => {
  it("suspends as before once the stay runs out", async () => {
    await signInWithLiveSessions();
    const h = bind({ stay: true });
    vi.clearAllMocks();
    h.emit("background");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(exchanges().relaySuspensions).toBe(3);
    expect(hostedHubStore.getState().browserStatus).toBe("suspended");
    expect(h.platform.state.ended).toBe(1);
    h.emit("foreground");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(exchanges().hubSessionChecks).toBe(1);
    h.dispose();
  });

  it("ends the stay as soon as a kept session's relay drops", async () => {
    await signInWithLiveSessions();
    const h = bind({ stay: true });
    vi.clearAllMocks();
    h.emit("background");
    const record = sessions().read(nodes[1]!.environmentId)!;
    sessions().transportStatus(record.environmentId, record.generation, "reconnecting");
    await flush();
    expect(hostedHubStore.getState().browserStatus).toBe("suspended");
    expect(exchanges().relaySuspensions).toBeGreaterThan(0);
    h.dispose();
  });

  it("suspends at once while a session is still establishing", async () => {
    await hostedHubController.bootstrap();
    expect(await hostedHubController.acquireEnvironment(nodes[0]!.id)).toBe("connecting");
    expect(hostedSessionsKeepable(hostedHubStore.getState(), sessions().list())).toBeNull();
    const h = bind({ stay: true });
    h.emit("background");
    expect(h.platform.begin).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().browserStatus).toBe("suspended");
    h.dispose();
  });

  it("recovers when iOS took the time back before the return", async () => {
    await signInWithLiveSessions();
    const h = bind({ stay: true });
    vi.clearAllMocks();
    h.emit("background");
    // The announcement itself never reached JavaScript before the return.
    h.platform.state.expired = true;
    await vi.advanceTimersByTimeAsync(2_000);
    h.emit("foreground");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(h.heartbeat).not.toHaveBeenCalled();
    expect(exchanges().relaySuspensions).toBe(3);
    expect(exchanges().hubSessionChecks).toBe(1);
    h.dispose();
  });

  it("waits briefly for an old heartbeat and keeps the sessions when it answers", async () => {
    await signInWithLiveSessions();
    let answered = false;
    const h = bind({ stay: true, heartbeat: () => (answered ? "fresh" : "stale") });
    vi.clearAllMocks();
    h.emit("background");
    await vi.advanceTimersByTimeAsync(2_000);
    h.emit("foreground");
    await vi.advanceTimersByTimeAsync(1_000);
    answered = true;
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(h.resumeKept).toHaveBeenCalledOnce();
    expect(exchanges().relaySuspensions).toBe(0);
    h.dispose();
  });

  it("recovers when a kept connection stays silent", async () => {
    await signInWithLiveSessions();
    const h = bind({ stay: true, heartbeat: () => "stale" });
    vi.clearAllMocks();
    h.emit("background");
    await vi.advanceTimersByTimeAsync(2_000);
    h.emit("foreground");
    await vi.advanceTimersByTimeAsync(BACKGROUND_STAY_HEARTBEAT_WAIT_MS + 500);
    await flush();
    expect(h.resumeKept).not.toHaveBeenCalled();
    expect(exchanges().relaySuspensions).toBe(3);
    expect(exchanges().hubSessionChecks).toBe(1);
    h.dispose();
  });
});
