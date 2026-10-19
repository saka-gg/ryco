import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import type { WorkspaceMetadataCache } from "@ryco/client-runtime/state/workspace";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedHubNode, HostedHubSessionResponse } from "./types";
import { createFakeHistoryWindow } from "../../test/fakeHistoryWindow";

/**
 * Retained environment sessions end to end: the real lifecycle owner, session
 * registry, demand executor, workspace coordinator, route orchestrator and
 * environment service, with retained mode forced through the runtime's test
 * seam. Only the relay is fake: a transport records its options and never opens
 * a socket, and each RPC client lets a test deliver a shell snapshot.
 */

interface CapturedTransport {
  readonly environmentId: EnvironmentId | null;
  readonly createdAt: number;
  readonly resolveUrl: () => Promise<string>;
  readonly options: {
    readonly getEnvironmentId?: () => EnvironmentId | null;
    readonly authorizeRequest?: (request: {
      readonly tag: string;
      readonly stream: boolean;
    }) => string;
    readonly shouldReconnect?: () => boolean;
    readonly onClose?: (details: unknown, context: { readonly intentional: boolean }) => void;
  };
}

interface CapturedClient {
  readonly environmentId: EnvironmentId | null;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly orchestration: {
    readonly dispatchCommand: ReturnType<typeof vi.fn>;
    readonly subscribeShell: ReturnType<typeof vi.fn>;
  };
  emitShellSnapshot(snapshot: OrchestrationShellSnapshot): void;
}

const { capturedTransports, capturedClients, transportOf, createWsRpcClient } = vi.hoisted(() => ({
  capturedTransports: [] as CapturedTransport[],
  capturedClients: [] as CapturedClient[],
  transportOf: new WeakMap<object, CapturedTransport>(),
  createWsRpcClient: vi.fn(),
}));

function MockWsTransport(
  this: object,
  resolveUrl: () => Promise<string>,
  options: CapturedTransport["options"],
) {
  const captured: CapturedTransport = {
    environmentId: options.getEnvironmentId?.() ?? null,
    createdAt: Date.now(),
    resolveUrl,
    options,
  };
  capturedTransports.push(captured);
  transportOf.set(this, captured);
}

function MockDeviceWsTransport() {}

vi.mock("../rpc/wsTransport", () => ({
  DeviceWsTransport: MockDeviceWsTransport,
  HostedWsTransport: MockWsTransport,
  WsTransport: MockWsTransport,
}));

vi.mock("../rpc/wsRpcClient", () => ({ createWsRpcClient }));

// No account socket: every relay channel here is ticketed.
vi.mock("./hubSession", () => ({
  subscribeWebHubInvalidation: () => () => undefined,
  isWebHubSessionOnline: () => false,
  probeWebHubSession: () => undefined,
  resumeWebHubSession: () => undefined,
  watchWebHostedHubSession: () => () => undefined,
  createWebHubRelaySocket: () => {
    throw new Error("no relay socket is opened by these tests");
  },
  isWebHubServerAuthenticatedRelayAvailable: () => false,
  createWebHubServerAuthenticatedRelaySocket: () => {
    throw new Error("no relay socket is opened by these tests");
  },
}));

import { hostedHubApi } from "./api";
import { readHostedRpcCapability } from "./capabilities";
import {
  HOSTED_WEB_WAKE_STAGGER_MS,
  readHostedWorkspaceState,
  setHostedWorkspaceBackgrounded,
  startHostedWorkspaceCoordinator,
} from "./hostedConnectionCoordinator";
import { hostedWebConnectionScopes } from "./hostedConnectionScopes";
import {
  resetHostedNodeRouteOrchestratorForTests,
  selectHostedNodeRoute,
  startHostedNodeRouteOrchestrator,
} from "./nodeRouteOrchestrator";
import { installHostedNodeHistory, resetHostedNodeRoutesForTests } from "./nodeRoutes";
import { configureWebHostedRuntime } from "./runtime";
import { getHostedEnvironmentSessions, hostedHubController, hostedHubStore } from "./state";
import {
  listEnvironmentConnections,
  readEnvironmentConnection,
  resetEnvironmentServiceForTests,
  subscribeEnvironmentConnections,
} from "../environments/runtime/service";

function hubNode(index: number, overrides: Partial<HostedHubNode> = {}): HostedHubNode {
  const suffix = String(index).padStart(22, "0");
  return {
    id: `node_${suffix}`,
    environmentId: EnvironmentId.make(`env_${suffix}`),
    label: `Node ${index}`,
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
    expiresAt: 9_999_999_999_999,
    lastSeenAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
  },
  csrfToken: "csrf-retained-canary",
};

const emptyCache: WorkspaceMetadataCache = {
  load: async () => null,
  list: async () => [],
  replace: async () => undefined,
  purgeEnvironment: async () => undefined,
  purgeAccount: async () => undefined,
};

const dispatchCommand = { tag: ORCHESTRATION_WS_METHODS.dispatchCommand, stream: false } as const;

function makeClient(environmentId: EnvironmentId | null): CapturedClient & Record<string, unknown> {
  let shellListener:
    | ((item: { kind: "snapshot"; snapshot: OrchestrationShellSnapshot }) => void)
    | null = null;
  return {
    environmentId,
    reconnect: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    isHeartbeatFresh: vi.fn(() => false),
    server: {
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeConfig: vi.fn(() => () => undefined),
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => ({ sequence: 0 })),
      subscribeShell: vi.fn((listener: typeof shellListener) => {
        shellListener = listener;
        return () => {
          shellListener = null;
        };
      }),
    },
    terminal: { onEvent: vi.fn(() => () => undefined) },
    emitShellSnapshot(snapshot) {
      shellListener?.({ kind: "snapshot", snapshot });
    },
  };
}

let snapshotSequence = 0;
function shellSnapshot(): OrchestrationShellSnapshot {
  snapshotSequence += 1;
  return {
    snapshotSequence,
    projects: [],
    threads: [],
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

let directory: ReadonlyArray<HostedHubNode> = [];
let stopCoordinator: (() => void) | null = null;
let stopOrchestrator: (() => void) | null = null;
let renewalTicks: Array<() => void> = [];
let history: ReturnType<typeof installHostedNodeHistory>;

/** Lets microtasks, the plans they schedule and `ms` of timers run. */
async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let turn = 0; turn < 5; turn += 1) await vi.advanceTimersByTimeAsync(0);
}

async function signIn(nodes: ReadonlyArray<HostedHubNode>, maxConnections: number) {
  directory = nodes;
  await hostedHubController.bootstrap();
  expect(hostedHubStore.getState()).toMatchObject({
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
  });
  stopOrchestrator = startHostedNodeRouteOrchestrator();
  stopCoordinator = startHostedWorkspaceCoordinator({
    cache: emptyCache,
    hubOrigin: "https://hub.example.test",
    maxConnections,
    // The renewal tick runs only when a test says so.
    setInterval: (callback) => renewalTicks.push(callback),
    clearInterval: () => undefined,
  });
  await flush();
}

async function route(node: HostedHubNode): Promise<void> {
  selectHostedNodeRoute(node.id);
  history.flush();
  await flush();
}

function retainView(node: HostedHubNode): () => void {
  return hostedWebConnectionScopes.retain(node.environmentId, {
    type: "thread-detail",
    threadId: ThreadId.make(`thread-${node.id}`),
  });
}

function transportsFor(node: HostedHubNode): ReadonlyArray<CapturedTransport> {
  return capturedTransports.filter((entry) => entry.environmentId === node.environmentId);
}

function latestClient(node: HostedHubNode): CapturedClient {
  const client = capturedClients.findLast((entry) => entry.environmentId === node.environmentId);
  if (!client) throw new Error(`no client for ${node.id}`);
  return client;
}

function generationOf(node: HostedHubNode): number {
  const record = getHostedEnvironmentSessions().read(node.environmentId);
  if (!record) throw new Error(`no record for ${node.id}`);
  return record.generation;
}

/** The environment's own relay attempt came online and its client accepted a snapshot. */
function establish(node: HostedHubNode): void {
  getHostedEnvironmentSessions().transportStatus(node.environmentId, generationOf(node), "online");
  latestClient(node).emitShellSnapshot(shellSnapshot());
  expect(getHostedEnvironmentSessions().read(node.environmentId)?.sessionEstablished).toBe(true);
}

/** The relay channel closed on its own after its attempt had a ticket. */
async function dropRelay(node: HostedHubNode): Promise<CapturedTransport> {
  const transport = transportsFor(node).at(-1)!;
  await transport.resolveUrl();
  transport.options.onClose?.({ code: 1006 }, { intentional: false });
  await flush();
  return transport;
}

function liveEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return listEnvironmentConnections().map((connection) => connection.environmentId);
}

beforeAll(() => {
  vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
  configureWebHostedRuntime(hostedHubApi, { environmentSessions: "retained" });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
  vi.stubGlobal("window", {
    location: { href: "https://hub.example.test/", origin: "https://hub.example.test" },
  });
  capturedTransports.length = 0;
  capturedClients.length = 0;
  renewalTicks = [];
  createWsRpcClient.mockReset();
  createWsRpcClient.mockImplementation((transport: object) => {
    const client = makeClient(transportOf.get(transport)?.environmentId ?? null);
    capturedClients.push(client);
    return client;
  });
  vi.spyOn(hostedHubApi, "restoreSession").mockResolvedValue(sessionResponse);
  vi.spyOn(hostedHubApi, "listNodes").mockImplementation(async () => directory);
  vi.spyOn(hostedHubApi, "issueRelayTicket").mockImplementation(async () => ({
    ticket: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    expiresAt: Date.now() + 60_000,
    protocolMajor: 1,
    protocolMinor: 2,
  }));
  // Away from home, so home discovery never adds demand of its own.
  history = installHostedNodeHistory(
    createFakeHistoryWindow("/account") as unknown as Window & typeof globalThis,
  );
});

afterEach(async () => {
  stopOrchestrator?.();
  stopOrchestrator = null;
  stopCoordinator?.();
  stopCoordinator = null;
  resetHostedNodeRouteOrchestratorForTests();
  resetHostedNodeRoutesForTests();
  hostedWebConnectionScopes.reset();
  hostedHubController.resetForTests();
  getHostedEnvironmentSessions().clear();
  await resetEnvironmentServiceForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hosted Web retained environment sessions", () => {
  it("never holds two connections at one allowed connection, and swaps without leaving for the directory", async () => {
    const [a, b] = [hubNode(1), hubNode(2)];
    await signIn([a, b], 1);
    const returnToDirectory = vi.spyOn(hostedHubController, "returnToDirectory");
    let mostLive = 0;
    const unsubscribe = subscribeEnvironmentConnections(() => {
      mostLive = Math.max(mostLive, listEnvironmentConnections().length);
    });

    await route(a);
    establish(a);
    await route(b);
    expect(liveEnvironmentIds()).toEqual([b.environmentId]);
    await route(a);

    expect(liveEnvironmentIds()).toEqual([a.environmentId]);
    expect(mostLive).toBe(1);
    expect(returnToDirectory).not.toHaveBeenCalled();
    expect(hostedHubStore.getState().selectedNode?.id).toBe(a.id);
    unsubscribe();
  });

  it("queues a routed fourth node behind three views and selecting it connects nothing", async () => {
    const nodes = [hubNode(1), hubNode(2), hubNode(3), hubNode(4)];
    await signIn(nodes, 3);
    const releases = nodes.slice(0, 3).map(retainView);
    await flush(3 * HOSTED_WEB_WAKE_STAGGER_MS);
    expect(liveEnvironmentIds().toSorted()).toEqual(
      nodes.slice(0, 3).map((node) => node.environmentId),
    );

    const fourth = nodes[3]!;
    await route(fourth);
    await flush(3 * HOSTED_WEB_WAKE_STAGGER_MS);

    expect(hostedHubStore.getState().selectedNode?.id).toBe(fourth.id);
    expect(listEnvironmentConnections()).toHaveLength(3);
    expect(readEnvironmentConnection(fourth.environmentId)).toBeNull();
    expect(getHostedEnvironmentSessions().read(fourth.environmentId)).toBeUndefined();
    expect(readHostedWorkspaceState().demand.queuedEnvironmentIds).toContain(fourth.environmentId);
    expect(transportsFor(fourth)).toHaveLength(0);
    releases.forEach((release) => release());
  });

  it("adopts a live session on the switch back without a new attempt or shell subscription", async () => {
    const [a, b] = [hubNode(1), hubNode(2)];
    await signIn([a, b], 3);
    await route(a);
    establish(a);
    await route(b);
    establish(b);

    await route(a);

    expect(transportsFor(a)).toHaveLength(1);
    expect(latestClient(a).orchestration.subscribeShell).toHaveBeenCalledOnce();
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: a,
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    expect(liveEnvironmentIds().toSorted()).toEqual([a.environmentId, b.environmentId]);
  });

  it("refuses commands on an environment still synchronizing while another is ready", async () => {
    const [x, y] = [hubNode(1), hubNode(2)];
    await signIn([x, y], 3);
    await route(y);
    establish(y);
    const releaseX = retainView(x);
    await flush(HOSTED_WEB_WAKE_STAGGER_MS);
    const xTransport = transportsFor(x).at(-1)!;
    const yTransport = transportsFor(y).at(-1)!;

    expect(xTransport.options.authorizeRequest?.(dispatchCommand)).toBe("awaiting-session");
    expect(readHostedRpcCapability(dispatchCommand.tag, x.environmentId).allowed).toBe(false);
    expect(yTransport.options.authorizeRequest?.(dispatchCommand)).toBe("allowed");
    expect(readHostedRpcCapability(dispatchCommand.tag, y.environmentId).allowed).toBe(true);

    // A callback of X's replaced generation changes neither X nor Y.
    const stale = generationOf(x);
    const staleClient = latestClient(x);
    getHostedEnvironmentSessions().renew(x.environmentId);
    const projected = hostedHubStore.getState();
    getHostedEnvironmentSessions().transportStatus(x.environmentId, stale, "online");
    staleClient.emitShellSnapshot(shellSnapshot());
    expect(getHostedEnvironmentSessions().read(x.environmentId)?.sessionEstablished).toBe(false);
    expect(hostedHubStore.getState()).toMatchObject({
      selectedNode: y,
      generation: projected.generation,
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
    });
    releaseX();
  });

  it("reconnects a warm environment that holds a lease while the directory is shown", async () => {
    const a = hubNode(1);
    await signIn([a], 3);
    const release = retainView(a);
    await flush();
    establish(a);
    expect(hostedHubStore.getState().selectedNode).toBeNull();
    const tickets = vi.mocked(hostedHubApi.issueRelayTicket).mock.calls.length;

    const transport = await dropRelay(a);

    expect(readEnvironmentConnection(a.environmentId)).not.toBeNull();
    expect(transport.options.shouldReconnect?.()).toBe(true);
    await transport.resolveUrl();
    expect(vi.mocked(hostedHubApi.issueRelayTicket).mock.calls.length).toBe(tickets + 2);
    release();
  });

  it("joins a requested connection when the route follows within 100 ms", async () => {
    const a = hubNode(1);
    await signIn([a], 3);
    await expect(hostedHubController.acquireEnvironment(a.id)).resolves.toBe("connecting");
    await flush(50);
    await route(a);
    await flush(HOSTED_WEB_WAKE_STAGGER_MS);

    expect(transportsFor(a)).toHaveLength(1);
    expect(readEnvironmentConnection(a.environmentId)).not.toBeNull();
  });

  it("re-acquires every retained record after a resume, the routed one first", async () => {
    const [a, b] = [hubNode(1), hubNode(2)];
    await signIn([a, b], 3);
    await route(a);
    establish(a);
    const releaseB = retainView(b);
    await flush(HOSTED_WEB_WAKE_STAGGER_MS);
    establish(b);

    hostedHubController.suspendBrowser("hidden");
    await flush(3 * HOSTED_WEB_WAKE_STAGGER_MS);
    expect(listEnvironmentConnections()).toHaveLength(0);
    expect(transportsFor(a)).toHaveLength(1);
    expect(transportsFor(b)).toHaveLength(1);

    const resumedAt = Date.now();
    await hostedHubController.resumeBrowser();
    await flush();
    expect(transportsFor(a)).toHaveLength(2);
    expect(transportsFor(b)).toHaveLength(1);
    await flush(HOSTED_WEB_WAKE_STAGGER_MS);
    expect(transportsFor(b)).toHaveLength(2);
    expect(transportsFor(a)[1]!.createdAt - resumedAt).toBe(0);
    expect(transportsFor(b)[1]!.createdAt - transportsFor(a)[1]!.createdAt).toBeGreaterThanOrEqual(
      HOSTED_WEB_WAKE_STAGGER_MS,
    );
    // Neither regained authority from its old session.
    expect(getHostedEnvironmentSessions().read(a.environmentId)?.sessionEstablished).toBe(false);
    expect(getHostedEnvironmentSessions().read(b.environmentId)?.sessionEstablished).toBe(false);
    releaseB();
  });

  it("releases a leaseless warm environment whose relay drops and reconnects a leased one", async () => {
    const [a, b] = [hubNode(1), hubNode(2)];
    await signIn([a, b], 3);
    await route(a);
    establish(a);
    await route(b);
    establish(b);
    // A is warm but nothing holds it any more; B is routed.
    const releaseEnvironment = vi.spyOn(hostedHubController, "releaseEnvironment");

    const dropped = await dropRelay(a);
    expect(releaseEnvironment).toHaveBeenCalledWith(a.environmentId);
    expect(readEnvironmentConnection(a.environmentId)).toBeNull();
    expect(getHostedEnvironmentSessions().read(a.environmentId)).toBeUndefined();
    expect(dropped.options.shouldReconnect?.()).toBe(false);

    const leased = await dropRelay(b);
    expect(releaseEnvironment).not.toHaveBeenCalledWith(b.environmentId);
    expect(readEnvironmentConnection(b.environmentId)).not.toBeNull();
    expect(leased.options.shouldReconnect?.()).toBe(true);
  });

  it("does not reconnect a terminally failed record until its directory entry changes", async () => {
    const [a, b] = [hubNode(1), hubNode(2)];
    await signIn([a, b], 3);
    await route(a);
    const releaseB = retainView(b);
    await flush(HOSTED_WEB_WAKE_STAGGER_MS);
    expect(transportsFor(b)).toHaveLength(1);

    getHostedEnvironmentSessions().failure(b.environmentId, generationOf(b), {
      kind: "incompatible",
      retryable: false,
    });
    for (let tick = 0; tick < 3; tick += 1) {
      renewalTicks.forEach((callback) => callback());
      await flush(25_000);
    }
    expect(transportsFor(b)).toHaveLength(1);

    directory = [a, hubNode(2, { clientVersion: "0.9.1" })];
    await hostedHubController.refreshDirectory();
    await flush(HOSTED_WEB_WAKE_STAGGER_MS);
    expect(transportsFor(b)).toHaveLength(2);
    releaseB();
  });

  it("keeps the routed environment through six hidden minutes of throttled ticks", async () => {
    const a = hubNode(1);
    await signIn([a], 3);
    await route(a);
    establish(a);
    const releaseEnvironment = vi.spyOn(hostedHubController, "releaseEnvironment");

    // A hidden tab's interval fires about once a minute, past the lease's TTL;
    // after the grace period the workspace plans as backgrounded.
    for (let minute = 1; minute <= 6; minute += 1) {
      await flush(60_000);
      if (minute === 2) await setHostedWorkspaceBackgrounded(true);
      renewalTicks.forEach((callback) => callback());
      await flush();
    }

    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(liveEnvironmentIds()).toEqual([a.environmentId]);
    expect(transportsFor(a)).toHaveLength(1);
    expect(readHostedWorkspaceState().demand.activeConnectionCount).toBe(1);
  });
});
