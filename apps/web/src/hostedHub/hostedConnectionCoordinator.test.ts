import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  UNIFIED_WORKSPACE_MAX_CONNECTIONS,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canAdoptHostedEnvironmentSession,
  isHostedEnvironmentConnectBlocked,
  isHostedEnvironmentSessionLive,
  isJoinableHostedEnvironmentSession,
  resetHostedEnvironmentSessionsForTests,
  type HostedBrowserStatus,
  type HostedEnvironmentSessions,
  type HostedHubNode,
} from "@ryco/client-runtime/authorization";

import { useMessageQueueStore, type WebQueuedMessage } from "../messageQueueStore";
import { useStore } from "../store";
import { workspaceMetadataToCachedShellSnapshot } from "../workspaceMetadataProjection";
import {
  MAX_HOSTED_WEB_CONNECTIONS,
  canPreconnectHostedEnvironment,
  createHostedConnectionCoordinator,
  hostedDemandUnblocked,
  isHostedEnvironmentDemanded,
  readHostedDemandReadiness,
  readHostedNodeMutationLease,
  readHostedWorkspaceState,
  setHostedWorkspaceBackgrounded,
  startHostedWorkspaceCoordinator,
} from "./hostedConnectionCoordinator";
import {
  HOSTED_WEB_INTENT_SCOPE_TTL_MS,
  createHostedWebScopeStore,
  hostedWebConnectionScopes,
  retainHostedIntentScope,
  startQueuedSendScopeRetention,
} from "./hostedConnectionScopes";
import { getHostedEnvironmentSessions, hostedHubController, hostedHubStore } from "./state";

const environment = (index: number) => EnvironmentId.make(`env_${String(index).padStart(22, "0")}`);
const thread = (index: number) => ThreadId.make(`thread_${String(index)}`);

function harness(foregroundEnvironmentId?: () => EnvironmentId | null) {
  let now = 1;
  const connected = new Set<EnvironmentId>();
  const connects: Array<{ environmentId: EnvironmentId }> = [];
  const releases: EnvironmentId[] = [];
  let mostConnected = 0;
  const scopes = createHostedWebScopeStore();
  const coordinator = createHostedConnectionCoordinator({
    scopes,
    ...(foregroundEnvironmentId ? { foregroundEnvironmentId } : {}),
    now: () => now,
    connect: async (environmentId) => {
      connects.push({ environmentId });
      connected.add(environmentId);
      mostConnected = Math.max(mostConnected, connected.size);
      return "connected";
    },
    release: async (environmentId) => {
      releases.push(environmentId);
      connected.delete(environmentId);
    },
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  return {
    coordinator,
    scopes,
    connected,
    connects,
    releases,
    mostConnected: () => mostConnected,
    tick: () => {
      now += 1;
    },
  };
}

describe("hosted Web connection coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the named ceiling of three connections under a five-node fixture", async () => {
    vi.useFakeTimers();
    const test = harness();
    const releases = Array.from({ length: 5 }, (_, index) => {
      test.tick();
      return test.scopes.retain(environment(index), {
        type: "thread-detail",
        threadId: thread(index),
      });
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(MAX_HOSTED_WEB_CONNECTIONS).toBe(3);
    expect(MAX_HOSTED_WEB_CONNECTIONS).toBeLessThanOrEqual(UNIFIED_WORKSPACE_MAX_CONNECTIONS);
    expect(test.mostConnected()).toBe(3);
    expect(test.connected.size).toBe(3);
    expect(test.coordinator.snapshot().activeConnectionCount).toBe(3);
    expect(test.coordinator.snapshot().queuedEnvironmentIds).toHaveLength(2);
    expect(test.connects).toHaveLength(3);
    releases.forEach((release) => release());
    test.coordinator.dispose();
  });

  it("refuses a connection ceiling above the unified one", () => {
    expect(() => harnessWithMax(UNIFIED_WORKSPACE_MAX_CONNECTIONS + 1)).toThrow(RangeError);
  });

  it("keeps LRU state on route release, releases it in background, and restores retained demand once", async () => {
    const test = harness();
    const releaseA = test.scopes.retain(environment(1), {
      type: "thread-detail",
      threadId: thread(1),
    });
    await test.coordinator.reconcile();
    releaseA();
    await test.coordinator.reconcile();
    expect(test.connected.size).toBe(1);

    await test.coordinator.setBackgrounded(true);
    expect(test.connected.size).toBe(0);
    expect(test.releases).toEqual([environment(1)]);

    test.scopes.retain(environment(2), {
      type: "provider-status",
      instanceId: "codex",
    });
    await test.coordinator.setBackgrounded(false);
    expect(test.connected).toEqual(new Set([environment(2)]));
    expect(test.connects.filter((entry) => entry.environmentId === environment(2))).toHaveLength(1);
    test.coordinator.dispose();
  });

  it("releasing directory-route demand cannot disconnect an unrelated retained thread", async () => {
    const test = harness();
    const releaseRetained = test.scopes.retain(environment(1), {
      type: "thread-detail",
      threadId: thread(1),
    });
    await test.coordinator.reconcile();
    const releaseRoute = test.scopes.retain(environment(2), {
      type: "thread-detail",
      threadId: thread(2),
    });
    await test.coordinator.reconcile();
    expect(test.connected).toEqual(new Set([environment(1), environment(2)]));

    releaseRoute();
    await test.coordinator.reconcile();
    // The route's environment stays warm, and the retained thread is untouched.
    expect(test.connected).toEqual(new Set([environment(1), environment(2)]));
    expect(test.releases).toEqual([]);
    releaseRetained();
    test.coordinator.dispose();
  });

  it("refcounts identical mounted scopes and releases demand only after the final unmount", () => {
    const scopes = createHostedWebScopeStore();
    const first = scopes.retain(environment(1), { type: "vcs-status", cwd: "/repo" });
    const second = scopes.retain(environment(1), { type: "vcs-status", cwd: "/repo" });
    expect(scopes.list()).toMatchObject([{ refCount: 2 }]);
    first();
    expect(scopes.list()).toMatchObject([{ refCount: 1 }]);
    second();
    expect(scopes.list()).toEqual([]);
  });

  it("keeps A warm through a switch to B and back: no release, no connect on the switch back", async () => {
    let foreground = environment(1);
    const test = harness(() => foreground);
    const releaseA = test.scopes.retain(environment(1), {
      type: "thread-detail",
      threadId: thread(1),
    });
    await test.coordinator.reconcile();

    // The route moves to B; A's thread scope goes with the outgoing view.
    foreground = environment(2);
    releaseA();
    const releaseB = test.scopes.retain(environment(2), {
      type: "thread-detail",
      threadId: thread(2),
    });
    await test.coordinator.reconcile();
    expect(test.connected).toEqual(new Set([environment(1), environment(2)]));

    foreground = environment(1);
    const releaseAgain = test.scopes.retain(environment(1), {
      type: "thread-detail",
      threadId: thread(1),
    });
    await test.coordinator.reconcile();

    expect(test.releases).toEqual([]);
    expect(test.connects.map((entry) => entry.environmentId)).toEqual([
      environment(1),
      environment(2),
    ]);
    releaseAgain();
    releaseB();
    test.coordinator.dispose();
  });

  it("purges native-only cache entries and the exact account namespace on sign-out", async () => {
    const environmentId = environment(9);
    const snapshot = {
      schemaVersion: 1 as const,
      environmentId,
      capturedAt: 1,
      projects: [
        {
          environmentId,
          id: ProjectId.make("project"),
          name: "Project",
          cwd: "/project",
          repositoryIdentity: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      worktrees: [],
      threads: [],
    };
    const record = {
      namespace: { hubOrigin: "https://hub.example.test", accountId: "account-a", environmentId },
      snapshot,
      payloadBytes: workspaceMetadataPayloadBytes(snapshot),
      updatedAt: 1,
    };
    const purgeEnvironment = vi.fn(async () => undefined);
    const purgeAccount = vi.fn(async () => undefined);
    const cache: WorkspaceMetadataCache = {
      load: async () => null,
      list: async () => [record],
      replace: async () => undefined,
      purgeEnvironment,
      purgeAccount,
    };
    hostedHubController.resetForTests();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: {
        id: "account-a",
        displayName: "Ada",
        role: "owner",
        createdAt: 1,
        disabledAt: null,
      },
      directoryStatus: "ready",
      nodes: [
        {
          id: "node_aaaaaaaaaaaaaaaaaaaaaa",
          environmentId,
          label: "Native only",
          platformOs: "linux",
          platformArch: "x64",
          clientVersion: "1",
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1,
          revokedAt: null,
          revocationReasonCode: null,
          grant: { id: "grant_aaaaaaaaaaaaaaaaaaaaaa", role: "operator" },
          effectiveRole: "operator",
          presence: { online: true, lastHeartbeatAt: 1 },
          capabilities: { repositoryIdentity: true, nativeClientRequired: true },
        },
      ],
    });
    const stop = startCoordinator({
      cache,
      hubOrigin: "https://hub.example.test",
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    await vi.waitFor(() => expect(purgeEnvironment).toHaveBeenCalledWith(record.namespace));

    hostedHubStore.setState({ accountStatus: "signed-out", account: null });
    await vi.waitFor(() =>
      expect(purgeAccount).toHaveBeenCalledWith({
        hubOrigin: "https://hub.example.test",
        accountId: "account-a",
      }),
    );
    stop();
    hostedHubController.resetForTests();
  });
});

function harnessWithMax(maxConnections: number) {
  return createHostedConnectionCoordinator({
    scopes: createHostedWebScopeStore(),
    maxConnections,
    now: () => 1,
    connect: async () => "connected",
    release: async () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
}

function hubNode(environmentId: EnvironmentId, online: boolean): HostedHubNode {
  return {
    id: "node_bbbbbbbbbbbbbbbbbbbbbb",
    environmentId,
    label: "Laptop",
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "1",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant_bbbbbbbbbbbbbbbbbbbbbb", role: "operator" },
    effectiveRole: "operator",
    presence: { online, lastHeartbeatAt: 1 },
  };
}

function retainedNode(index: number, online = true): HostedHubNode {
  return {
    ...hubNode(environment(index), online),
    id: `node_${String(index).padStart(22, "0")}`,
    label: `Node ${index}`,
  };
}

const emptyCache: WorkspaceMetadataCache = {
  load: async () => null,
  list: async () => [],
  replace: async () => undefined,
  purgeEnvironment: async () => undefined,
  purgeAccount: async () => undefined,
};

function signedInDirectory(
  nodes: ReadonlyArray<HostedHubNode>,
  browserStatus: HostedBrowserStatus = "current",
) {
  hostedHubController.resetForTests();
  hostedWebConnectionScopes.reset();
  resetHostedEnvironmentSessionsForTests();
  hostedHubStore.setState({
    accountStatus: "authenticated",
    account: { id: "account-a", displayName: "Ada", role: "owner", createdAt: 1, disabledAt: null },
    directoryStatus: "ready",
    browserStatus,
    nodes,
  });
}

/** Workspace coordinators a test started; each is stopped after the test, failed or not. */
const runningCoordinators = new Set<() => void>();

function startCoordinator(
  input: Parameters<typeof startHostedWorkspaceCoordinator>[0],
): () => void {
  const stop = startHostedWorkspaceCoordinator(input);
  const tracked = () => {
    runningCoordinators.delete(tracked);
    stop();
  };
  runningCoordinators.add(tracked);
  return tracked;
}

afterEach(() => {
  for (const stop of Array.from(runningCoordinators)) stop();
});

/** Let the coordinator finish the connect attempt the retained scope queued. */
async function settleCoordinator(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

/**
 * The lifecycle owner's acquire, as the controller decides it over the real
 * session registry: adopt a session that is live, join one on its way, refuse
 * one a terminal failure blocks, and otherwise start a fresh generation. The
 * directory entry is refreshed first, as a directory load does.
 */
function modelAcquire(sessions: HostedEnvironmentSessions) {
  const acquired: EnvironmentId[] = [];
  const spy = vi
    .spyOn(hostedHubController, "acquireEnvironment")
    .mockImplementation(async (nodeId) => {
      const node = hostedHubStore.getState().nodes.find((candidate) => candidate.id === nodeId)!;
      const existing = sessions.read(node.environmentId);
      let generation: number;
      if (existing === undefined) {
        generation = sessions.ensureRecord(node).generation;
      } else {
        const record = sessions.ensureRecord(node, { access: false });
        if (canAdoptHostedEnvironmentSession(record)) return "adopted";
        if (isJoinableHostedEnvironmentSession(record)) return "joined";
        if (isHostedEnvironmentConnectBlocked(record)) return "refused";
        generation = sessions.renew(node.environmentId)!.generation;
      }
      sessions.markConnectRequested(node.environmentId, generation);
      acquired.push(node.environmentId);
      return "connecting";
    });
  const released: EnvironmentId[] = [];
  vi.spyOn(hostedHubController, "releaseEnvironment").mockImplementation(async (environmentId) => {
    released.push(environmentId);
    sessions.release(environmentId);
  });
  return { acquired, released, spy };
}

/** The environment's own relay attempt came online and accepted its shell snapshot. */
function establishRecord(sessions: HostedEnvironmentSessions, environmentId: EnvironmentId): void {
  const { generation } = sessions.read(environmentId)!;
  sessions.transportStatus(environmentId, generation, "online");
  sessions.markSessionReady(environmentId, generation);
}

function startWithoutRenewalTick() {
  // The renewal tick is what used to rescue refused demand ~25s later; with it
  // stubbed out, anything that connects did so because the state changed.
  return startCoordinator({
    cache: emptyCache,
    hubOrigin: "https://hub.example.test",
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
}

describe("hosted Web demand follows directory state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    hostedWebConnectionScopes.reset();
    hostedHubController.resetForTests();
    resetHostedEnvironmentSessionsForTests();
  });

  it("only unblocks demand on a directory or browser edge for a demanded node", () => {
    const env = environment(3);
    const other = environment(4);
    const offline = readHostedDemandReadiness({
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [hubNode(env, false)],
    });
    const online = readHostedDemandReadiness({
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [hubNode(env, true)],
    });
    const stale = readHostedDemandReadiness({
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "stale",
      nodes: [hubNode(env, true)],
    });

    expect(hostedDemandUnblocked(offline, online, [env])).toBe(true);
    expect(hostedDemandUnblocked(stale, online, [env])).toBe(true);
    expect(hostedDemandUnblocked(online, online, [env])).toBe(false);
    expect(hostedDemandUnblocked(offline, online, [other])).toBe(false);
    expect(hostedDemandUnblocked(online, offline, [env])).toBe(false);
    expect(hostedDemandUnblocked(offline, stale, [env])).toBe(false);

    // A terminal relay failure hands a synchronizing browser back as current;
    // that edge is the failure, but a presence edge is still the directory's.
    const synchronizing = readHostedDemandReadiness({
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "synchronizing",
      nodes: [hubNode(env, true)],
      selectedNode: hubNode(env, true),
      transportStatus: "connecting",
    });
    const failed = readHostedDemandReadiness({
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [hubNode(env, true)],
      selectedNode: hubNode(env, true),
      transportStatus: "terminal-failure",
    });
    expect(hostedDemandUnblocked(synchronizing, failed, [env])).toBe(false);
    expect(hostedDemandUnblocked(offline, failed, [env])).toBe(true);
  });

  it("connects held demand as soon as the directory sees its node come online", async () => {
    const env = environment(5);
    signedInDirectory([hubNode(env, false)]);
    const { acquired } = modelAcquire(getHostedEnvironmentSessions());
    const releaseWatch = vi.fn();
    const watch = vi
      .spyOn(hostedHubController, "watchDirectoryPresence")
      .mockReturnValue(releaseWatch);
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(5),
    });

    // Demand for an offline node holds no lease, and the directory is asked
    // to watch presence at its faster cadence meanwhile.
    await settleCoordinator();
    expect(watch).toHaveBeenCalledOnce();
    expect(acquired).toEqual([]);

    hostedHubStore.setState({ nodes: [hubNode(env, true)] });

    await vi.waitFor(() => expect(acquired).toEqual([env]));
    expect(releaseWatch).toHaveBeenCalledOnce();
    releaseScope();
    stop();
  });

  it("connects held demand as soon as a stale browser becomes current again", async () => {
    const env = environment(6);
    signedInDirectory([hubNode(env, true)], "stale");
    const sessions = getHostedEnvironmentSessions();
    const acquire = vi
      .spyOn(hostedHubController, "acquireEnvironment")
      .mockImplementation(async (nodeId) => {
        // A transient failure while the browser revalidates, which only a
        // planned reconcile retries.
        if (hostedHubStore.getState().browserStatus !== "current") {
          throw new Error("Hosted Web directory is not current.");
        }
        const node = hostedHubStore.getState().nodes.find((candidate) => candidate.id === nodeId)!;
        sessions.markConnectRequested(node.environmentId, sessions.ensureRecord(node).generation);
        return "connecting";
      });
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(6),
    });
    await settleCoordinator();
    expect(sessions.read(env)).toBeUndefined();

    hostedHubStore.setState({ browserStatus: "current" });

    await vi.waitFor(() => expect(sessions.read(env)?.connectRequested).toBe(true));
    expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(2);
    releaseScope();
    stop();
  });

  it.each([
    [
      "an E2EE-fatal handshake close",
      (sessions: HostedEnvironmentSessions, environmentId: EnvironmentId) =>
        sessions.failure(environmentId, sessions.read(environmentId)!.generation, {
          kind: "protocol",
          retryable: false,
          closeReason: "channel_rejected",
        }),
    ],
    [
      "a revoked grant",
      (sessions: HostedEnvironmentSessions, environmentId: EnvironmentId) =>
        sessions.failure(environmentId, sessions.read(environmentId)!.generation, {
          kind: "revoked",
          retryable: false,
        }),
    ],
    [
      "the session-sync deadline",
      (sessions: HostedEnvironmentSessions, environmentId: EnvironmentId) =>
        sessions.reportShellSnapshotFailure(
          environmentId,
          sessions.read(environmentId)!.generation,
        ),
    ],
  ])("never opens a fresh relay attempt after %s", async (_label, fail) => {
    const env = environment(8);
    signedInDirectory([hubNode(env, true)]);
    const sessions = getHostedEnvironmentSessions();
    const { acquired } = modelAcquire(sessions);
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(8),
    });
    await vi.waitFor(() => expect(acquired).toEqual([env]));
    const generation = sessions.read(env)!.generation;

    fail(sessions, env);
    expect(sessions.read(env)?.transportStatus).toBe("terminal-failure");
    hostedHubStore.setState({ browserStatus: "current" });
    await settleCoordinator();
    await settleCoordinator();

    // The failed record frees its slot, and the re-plan that follows is
    // refused: the failure blocks reconnecting until its directory entry
    // changes or the user retries.
    expect(acquired).toEqual([env]);
    expect(sessions.read(env)?.generation).toBe(generation);
    releaseScope();
    stop();
  });

  it("still reconnects a terminally failed node once the directory sees it come back", async () => {
    const env = environment(9);
    signedInDirectory([hubNode(env, true)]);
    const sessions = getHostedEnvironmentSessions();
    const { acquired } = modelAcquire(sessions);
    vi.spyOn(hostedHubController, "watchDirectoryPresence").mockReturnValue(() => undefined);
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(9),
    });
    await vi.waitFor(() => expect(acquired).toEqual([env]));
    sessions.failure(env, sessions.read(env)!.generation, { kind: "offline", retryable: false });
    // The lifecycle owner refreshes each record from the directory it loads.
    const loadDirectory = (online: boolean) => {
      hostedHubStore.setState({ nodes: [hubNode(env, online)] });
      sessions.ensureRecord(hubNode(env, online), { access: false });
    };
    loadDirectory(false);
    await settleCoordinator();
    expect(acquired).toEqual([env]);

    // A presence edge is a new signal from the directory, not the failure
    // echoing back, so it re-plans at once.
    loadDirectory(true);

    await vi.waitFor(() => expect(acquired).toEqual([env, env]));
    releaseScope();
    stop();
  });

  it("releases its presence watch when the coordinator stops", async () => {
    const env = environment(7);
    signedInDirectory([hubNode(env, false)]);
    const releaseWatch = vi.fn();
    vi.spyOn(hostedHubController, "watchDirectoryPresence").mockReturnValue(releaseWatch);
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(7),
    });

    stop();

    expect(releaseWatch).toHaveBeenCalledOnce();
    releaseScope();
  });
});

describe("hosted Web machine catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    hostedWebConnectionScopes.reset();
    hostedHubController.resetForTests();
    resetHostedEnvironmentSessionsForTests();
  });

  const ownerNode = (environmentId: EnvironmentId): HostedHubNode => ({
    ...hubNode(environmentId, true),
    grant: { id: "grant_bbbbbbbbbbbbbbbbbbbbbb", role: "owner" },
    effectiveRole: "owner",
  });

  /** A node with a cached shell, so its lease only waits on its own session. */
  function startWithCachedShell(node: HostedHubNode) {
    const environmentId = node.environmentId;
    const snapshot = {
      schemaVersion: 1 as const,
      environmentId,
      capturedAt: 1,
      projects: [],
      worktrees: [],
      threads: [],
    };
    const record = {
      namespace: { hubOrigin: "https://hub.example.test", accountId: "account-a", environmentId },
      snapshot,
      payloadBytes: workspaceMetadataPayloadBytes(snapshot),
      updatedAt: 1,
    };
    signedInDirectory([node]);
    return startCoordinator({
      cache: { ...emptyCache, list: async () => [record] },
      hubOrigin: "https://hub.example.test",
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
  }

  it("shows an environment whose own session is online and ready as connected and leases it", async () => {
    const env = environment(11);
    const node = ownerNode(env);
    const stop = startWithCachedShell(node);
    const sessions = getHostedEnvironmentSessions();
    const { generation } = sessions.ensureRecord(node);
    sessions.markConnectRequested(env, generation);
    sessions.role(env, generation, "owner");
    establishRecord(sessions, env);

    await vi.waitFor(() =>
      expect(readHostedWorkspaceState().machines).toMatchObject([
        {
          environmentId: env,
          connectionState: "connected",
          deliveryUnknown: false,
          canMutate: true,
        },
      ]),
    );
    await vi.waitFor(() =>
      expect(readHostedNodeMutationLease(env)).toMatchObject({ environmentId: env }),
    );
    expect(readHostedNodeMutationLease(env)?.snapshotGeneration).toBe(generation);
    stop();
  });

  it.each([
    ["suspended", (sessions: HostedEnvironmentSessions) => void sessions.suspendAll()],
    [
      "interrupted",
      (sessions: HostedEnvironmentSessions, env: EnvironmentId) =>
        sessions.transportStatus(env, sessions.read(env)!.generation, "reconnecting"),
    ],
    [
      "downgraded",
      (sessions: HostedEnvironmentSessions, env: EnvironmentId) =>
        sessions.role(env, sessions.read(env)!.generation, "viewer"),
    ],
    [
      "released",
      (sessions: HostedEnvironmentSessions, env: EnvironmentId) => sessions.release(env),
    ],
    [
      "replaying",
      (sessions: HostedEnvironmentSessions, env: EnvironmentId) =>
        sessions.markSessionReplaying(env, sessions.read(env)!.generation),
    ],
    [
      "unsure of its delivery",
      (sessions: HostedEnvironmentSessions, env: EnvironmentId) =>
        sessions.markDeliveryUnknown(env, sessions.read(env)!.generation),
    ],
  ] as const)("revokes the lease in the same turn its record is %s", async (_change, change) => {
    const env = environment(13);
    const node = ownerNode(env);
    const stop = startWithCachedShell(node);
    const sessions = getHostedEnvironmentSessions();
    const { generation } = sessions.ensureRecord(node);
    sessions.markConnectRequested(env, generation);
    sessions.role(env, generation, "owner");
    establishRecord(sessions, env);
    await vi.waitFor(() =>
      expect(readHostedNodeMutationLease(env)).toMatchObject({ environmentId: env }),
    );

    change(sessions, env);

    expect(readHostedNodeMutationLease(env)).toBeNull();
    stop();
  });

  it.each([
    ["its directory turns stale", () => hostedHubStore.setState({ directoryStatus: "stale" })],
    ["the browser is suspended", () => hostedHubStore.setState({ browserStatus: "suspended" })],
    [
      "its node goes offline",
      (node: HostedHubNode) =>
        hostedHubStore.setState({
          nodes: [{ ...node, presence: { ...node.presence, online: false } }],
        }),
    ],
    ["its node leaves the directory", () => hostedHubStore.setState({ nodes: [] })],
    [
      "its node is revoked",
      (node: HostedHubNode) => hostedHubStore.setState({ nodes: [{ ...node, revokedAt: 1 }] }),
    ],
  ] as const)("revokes the lease in the same turn %s", async (_change, change) => {
    const env = environment(14);
    const node = ownerNode(env);
    const stop = startWithCachedShell(node);
    const sessions = getHostedEnvironmentSessions();
    const { generation } = sessions.ensureRecord(node);
    sessions.markConnectRequested(env, generation);
    sessions.role(env, generation, "owner");
    establishRecord(sessions, env);
    await vi.waitFor(() =>
      expect(readHostedNodeMutationLease(env)).toMatchObject({ environmentId: env }),
    );

    change(node);

    expect(readHostedNodeMutationLease(env)).toBeNull();
    stop();
  });

  it("shows a session that is still being established as connecting and grants no lease", async () => {
    const env = environment(12);
    const node = ownerNode(env);
    const stop = startWithCachedShell(node);
    const sessions = getHostedEnvironmentSessions();
    const { generation } = sessions.ensureRecord(node);
    sessions.markConnectRequested(env, generation);
    sessions.transportStatus(env, generation, "connecting");

    await vi.waitFor(() =>
      expect(readHostedWorkspaceState().machines).toMatchObject([
        { environmentId: env, connectionState: "connecting", deliveryUnknown: false },
      ]),
    );
    expect(readHostedNodeMutationLease(env)).toBeNull();
    stop();
  });
});

describe("hosted Web retained environment sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    hostedWebConnectionScopes.reset();
    hostedHubController.resetForTests();
    resetHostedEnvironmentSessionsForTests();
    useMessageQueueStore.getState().reset();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  });

  function retainedHarness(input: { readonly foreground: () => EnvironmentId | null }) {
    const scopes = createHostedWebScopeStore();
    const startedAt = Date.now();
    const connects: Array<{ readonly environmentId: EnvironmentId; readonly at: number }> = [];
    const live = new Set<EnvironmentId>();
    let mostLive = 0;
    const coordinator = createHostedConnectionCoordinator({
      scopes,
      foregroundEnvironmentId: input.foreground,
      now: () => Date.now(),
      connect: async (environmentId) => {
        connects.push({ environmentId, at: Date.now() - startedAt });
        live.add(environmentId);
        mostLive = Math.max(mostLive, live.size);
        return "connected";
      },
      release: async (environmentId) => {
        live.delete(environmentId);
      },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    return { coordinator, scopes, connects, live, mostLive: () => mostLive };
  }

  it("connects a routed environment at once while staggered wakes are still pending", async () => {
    vi.useFakeTimers();
    let routed: EnvironmentId | null = null;
    const test = retainedHarness({ foreground: () => routed });
    for (let index = 1; index <= 3; index += 1) {
      test.scopes.retain(environment(index), { type: "thread-detail", threadId: thread(index) });
    }
    await vi.advanceTimersByTimeAsync(0);
    // The first wake starts at once, the others 750 ms apart.
    expect(test.connects).toEqual([{ environmentId: environment(1), at: 0 }]);
    expect(test.coordinator.executorSnapshot().pendingWakes).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(10);
    routed = environment(4);
    test.scopes.retain(environment(4), { type: "thread-detail", threadId: thread(4) });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.connects.at(-1)).toEqual({ environmentId: environment(4), at: 10 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.mostLive()).toBeLessThanOrEqual(3);
    expect(test.coordinator.snapshot().activeConnectionCount).toBe(3);
    expect(test.coordinator.snapshot().queuedEnvironmentIds).toHaveLength(1);
    test.coordinator.dispose();
  });

  it("never holds more than three connections for five demanded nodes", async () => {
    vi.useFakeTimers();
    const test = retainedHarness({ foreground: () => null });
    for (let index = 1; index <= 5; index += 1) {
      test.scopes.retain(environment(index), { type: "thread-detail", threadId: thread(index) });
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(test.mostLive()).toBe(3);
    expect(test.live.size).toBe(3);
    expect(test.coordinator.snapshot().queuedEnvironmentIds).toHaveLength(2);
    test.coordinator.dispose();
  });

  /**
   * The workspace coordinator over the real session registry; the lifecycle
   * owner's acquire and release are modelled on the registry as the controller
   * runs them.
   */
  function startRetained(
    nodes: ReadonlyArray<HostedHubNode>,
    options?: {
      /** Nodes whose records are live before the coordinator starts. */
      readonly warm?: ReadonlyArray<HostedHubNode>;
      readonly cache?: WorkspaceMetadataCache;
    },
  ) {
    signedInDirectory(nodes);
    const sessions = getHostedEnvironmentSessions();
    for (const node of options?.warm ?? []) {
      sessions.markConnectRequested(node.environmentId, sessions.ensureRecord(node).generation);
    }
    let mostLive = 0;
    sessions.subscribe(() => {
      const live = sessions.list().filter((record) => isHostedEnvironmentSessionLive(record));
      mostLive = Math.max(mostLive, live.length);
    });
    const { acquired, released } = modelAcquire(sessions);
    const watchPresence = vi
      .spyOn(hostedHubController, "watchDirectoryPresence")
      .mockReturnValue(() => undefined);
    const returnToDirectory = vi.spyOn(hostedHubController, "returnToDirectory");
    const ticks: Array<() => void> = [];
    const stop = startCoordinator({
      cache: options?.cache ?? emptyCache,
      hubOrigin: "https://hub.example.test",
      setInterval: (callback) => ticks.push(callback),
      clearInterval: () => undefined,
    });
    return {
      sessions,
      acquired,
      released,
      watchPresence,
      returnToDirectory,
      mostLive: () => mostLive,
      tick: () => ticks.forEach((callback) => callback()),
      stop,
    };
  }

  it("counts the live records an earlier coordinator left against the cap", async () => {
    const nodes = [1, 2, 3, 4].map((index) => retainedNode(index));
    const test = startRetained(nodes, { warm: nodes.slice(0, 3) });
    const routed = environment(4);
    const releaseView = hostedWebConnectionScopes.retain(routed, {
      type: "thread-detail",
      threadId: thread(4),
    });

    // The warm records hold every slot, so one of them makes room first.
    await vi.waitFor(() => expect(test.acquired).toEqual([routed]));
    expect(test.released).toHaveLength(1);
    expect(test.mostLive()).toBeLessThanOrEqual(3);
    expect(
      test.sessions.list().filter((record) => isHostedEnvironmentSessionLive(record)),
    ).toHaveLength(3);
    releaseView();
    test.stop();
  });

  it("swaps between three environments without leaving for the directory or releasing", async () => {
    const nodes = [1, 2, 3].map((index) => retainedNode(index));
    const test = startRetained(nodes);
    let releaseRoute = hostedWebConnectionScopes.retain(environment(1), {
      type: "thread-detail",
      threadId: thread(1),
    });
    await vi.waitFor(() => expect(test.acquired).toEqual([environment(1)]));
    establishRecord(test.sessions, environment(1));

    // What a route swap does to demand: the outgoing route's scope goes, the
    // incoming one's arrives.
    for (const index of [2, 3, 1]) {
      releaseRoute();
      releaseRoute = hostedWebConnectionScopes.retain(environment(index), {
        type: "thread-detail",
        threadId: thread(index),
      });
      await settleCoordinator();
      const record = test.sessions.read(environment(index))!;
      if (!canAdoptHostedEnvironmentSession(record))
        establishRecord(test.sessions, record.environmentId);
    }

    expect(test.acquired).toEqual([environment(1), environment(2), environment(3)]);
    expect(test.released).toEqual([]);
    expect(test.returnToDirectory).not.toHaveBeenCalled();
    expect(test.mostLive()).toBe(3);
    releaseRoute();
    test.stop();
  });

  it("releases warm environments nothing demands once the workspace is backgrounded", async () => {
    const nodes = [retainedNode(1), retainedNode(2)];
    const test = startRetained(nodes);
    const releaseView = hostedWebConnectionScopes.retain(environment(1), {
      type: "thread-detail",
      threadId: thread(1),
    });
    const releaseWarm = hostedWebConnectionScopes.retain(environment(2), {
      type: "thread-detail",
      threadId: thread(2),
    });
    await vi.waitFor(() =>
      expect(test.acquired.toSorted()).toEqual([environment(1), environment(2)]),
    );
    releaseWarm();
    await settleCoordinator();
    expect(test.released).toEqual([]);

    await setHostedWorkspaceBackgrounded(true);

    expect(test.released).toEqual([environment(2)]);
    expect(test.sessions.read(environment(1))).toBeDefined();
    await setHostedWorkspaceBackgrounded(false);
    releaseView();
    test.stop();
  });

  it("connects a pressed environment for three seconds of intent demand", async () => {
    const nodes = [retainedNode(1)];
    const test = startRetained(nodes);
    expect(HOSTED_WEB_INTENT_SCOPE_TTL_MS).toBe(3_000);
    expect(canPreconnectHostedEnvironment(environment(1))).toBe(true);

    retainHostedIntentScope(environment(1), 300);

    await vi.waitFor(() => expect(test.acquired).toEqual([environment(1)]));
    expect(hostedWebConnectionScopes.list()).toMatchObject([
      { environmentId: environment(1), scope: { type: "interactive" } },
    ]);
    expect(isHostedEnvironmentDemanded(environment(1))).toBe(true);
    // A session on its way is joined by the navigation, not pre-connected again.
    expect(canPreconnectHostedEnvironment(environment(1))).toBe(false);

    await vi.waitFor(() => expect(hostedWebConnectionScopes.list()).toEqual([]));
    expect(isHostedEnvironmentDemanded(environment(1))).toBe(false);
    // The environment stays warm until its slot is needed.
    expect(test.released).toEqual([]);
    test.stop();
  });

  it("never displaces a mounted view for intent demand", async () => {
    const nodes = [1, 2, 3, 4].map((index) => retainedNode(index));
    const test = startRetained(nodes);
    const releases = [1, 2, 3].map((index) =>
      hostedWebConnectionScopes.retain(environment(index), {
        type: "thread-detail",
        threadId: thread(index),
      }),
    );
    await vi.waitFor(() => expect(test.acquired).toHaveLength(3), { timeout: 5_000 });

    const releaseIntent = retainHostedIntentScope(environment(4));
    await settleCoordinator();

    expect(test.released).toEqual([]);
    expect(test.acquired).not.toContain(environment(4));
    expect(readHostedWorkspaceState().demand.queuedEnvironmentIds).toContain(environment(4));
    releaseIntent();
    releases.forEach((release) => release());
    test.stop();
  });

  it("does not pre-connect an environment whose session is live or whose node is offline", async () => {
    const nodes = [retainedNode(1), retainedNode(2, false)];
    const test = startRetained(nodes);
    const release = hostedWebConnectionScopes.retain(environment(1), {
      type: "thread-detail",
      threadId: thread(1),
    });
    await vi.waitFor(() => expect(test.acquired).toEqual([environment(1)]));
    establishRecord(test.sessions, environment(1));

    expect(canPreconnectHostedEnvironment(environment(1))).toBe(false);
    expect(canPreconnectHostedEnvironment(environment(2))).toBe(false);
    expect(canPreconnectHostedEnvironment(environment(9))).toBe(false);
    release();
    test.stop();
    expect(canPreconnectHostedEnvironment(environment(1))).toBe(false);
  });

  it("holds demand while a server thread has queued sends, and none for a draft-only queue", async () => {
    const nodes = [retainedNode(1), retainedNode(2)];
    const test = startRetained(nodes);
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        workspaceMetadataToCachedShellSnapshot(metadataWithThread(environment(1))),
        environment(1),
      );
    const serverKey = `${environment(1)}:${thread(1)}`;
    const draftKey = `${environment(2)}:draft-thread`;

    useMessageQueueStore.getState().enqueue(draftKey, queuedMessage("draft"));
    await settleCoordinator();
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    expect(test.acquired).toEqual([]);

    useMessageQueueStore.getState().enqueue(serverKey, queuedMessage("first"));
    useMessageQueueStore.getState().enqueue(serverKey, queuedMessage("second"));
    await vi.waitFor(() => expect(test.acquired).toEqual([environment(1)]));
    expect(hostedWebConnectionScopes.list()).toMatchObject([
      { environmentId: environment(1), scope: { type: "interactive" }, refCount: 1 },
    ]);

    useMessageQueueStore.getState().remove(serverKey, "first");
    expect(hostedWebConnectionScopes.list()).toHaveLength(1);
    useMessageQueueStore.getState().remove(serverKey, "second");
    expect(hostedWebConnectionScopes.list()).toEqual([]);

    // An account reset clears every queue, and with it the demand.
    useMessageQueueStore.getState().enqueue(serverKey, queuedMessage("third"));
    expect(hostedWebConnectionScopes.list()).toHaveLength(1);
    useMessageQueueStore.getState().reset();
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    test.stop();
  });

  it("publishes a live snapshot only when its environment's slices change", async () => {
    const replace = vi.fn(async () => undefined);
    const nodes = [retainedNode(1)];
    const test = startRetained(nodes, { cache: { ...emptyCache, replace } });
    const env = environment(1);
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        workspaceMetadataToCachedShellSnapshot(metadataWithThread(env)),
        env,
      );
    useStore.setState((state) => ({
      environmentStateById: {
        ...state.environmentStateById,
        [env]: { ...state.environmentStateById[env]!, bootstrapComplete: true },
      },
    }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(readHostedWorkspaceState().workspace.threads).toHaveLength(1));
    const published = readHostedWorkspaceState();

    // A store change that leaves every slice of the environment as it was.
    for (let index = 0; index < 3; index += 1) {
      useStore.setState((state) => ({ environmentStateById: { ...state.environmentStateById } }));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
    }
    expect(replace).toHaveBeenCalledOnce();
    expect(readHostedWorkspaceState()).toBe(published);

    useStore.setState((state) => ({
      environmentStateById: {
        ...state.environmentStateById,
        [env]: { ...state.environmentStateById[env]!, threadIds: [] },
      },
    }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(readHostedWorkspaceState().workspace.threads).toHaveLength(0));
    test.stop();
  });

  it("synchronizes once per burst of hosted patches and skips patches it does not read", async () => {
    const nodes = [retainedNode(1)];
    const test = startRetained(nodes);
    await settleCoordinator();
    const read = vi.spyOn(test.sessions, "read");

    // Fields the workspace never reads from the hosted store.
    hostedHubStore.setState({ errorMessage: "transient" });
    hostedHubStore.setState({ errorMessage: null });
    await settleCoordinator();
    expect(read).not.toHaveBeenCalled();

    // Three directory refreshes in one turn are one pass.
    hostedHubStore.setState({ nodes: [retainedNode(1)] });
    hostedHubStore.setState({ nodes: [retainedNode(1)] });
    hostedHubStore.setState({ nodes: [retainedNode(1)] });
    await settleCoordinator();
    expect(
      read.mock.calls.filter(([environmentId]) => environmentId === environment(1)),
    ).toHaveLength(1);
    test.stop();
  });

  it("releases background demand a rate limit hit instead of retrying it", async () => {
    const nodes = [retainedNode(1), retainedNode(2)];
    const test = startRetained(nodes);
    const background = environment(1);
    const view = environment(2);
    const releaseDraft = hostedWebConnectionScopes.retain(background, { type: "interactive" });
    const releaseView = hostedWebConnectionScopes.retain(view, {
      type: "thread-detail",
      threadId: thread(2),
    });
    await vi.waitFor(() => expect(test.acquired.toSorted()).toEqual([background, view]));

    for (const environmentId of [background, view]) {
      const record = test.sessions.read(environmentId)!;
      test.sessions.failure(environmentId, record.generation, {
        kind: "rate-limited",
        retryable: true,
      });
    }

    // The background demand stands down; the mounted view keeps its backoff.
    await vi.waitFor(() => expect(test.released).toEqual([background]));
    test.tick();
    test.tick();
    test.tick();
    await settleCoordinator();
    expect(test.acquired.filter((environmentId) => environmentId === background)).toHaveLength(1);
    expect(test.sessions.read(view)).toBeDefined();

    // New demand is a new edge.
    releaseDraft();
    const releaseAgain = hostedWebConnectionScopes.retain(background, { type: "interactive" });
    await vi.waitFor(() =>
      expect(test.acquired.filter((environmentId) => environmentId === background)).toHaveLength(2),
    );
    releaseAgain();
    releaseView();
    test.stop();
  });

  it("releases a non-selected record whose node went offline until the node is back", async () => {
    const nodes = [retainedNode(1), retainedNode(2)];
    const test = startRetained(nodes);
    const selected = environment(1);
    const other = environment(2);
    hostedHubStore.setState({ selectedNode: nodes[0]! });
    const releaseSelected = hostedWebConnectionScopes.retain(selected, {
      type: "thread-detail",
      threadId: thread(1),
    });
    const releaseOther = hostedWebConnectionScopes.retain(other, {
      type: "thread-detail",
      threadId: thread(2),
    });
    await vi.waitFor(() => expect(test.acquired.toSorted()).toEqual([selected, other]));

    hostedHubStore.setState({ nodes: [retainedNode(1, false), retainedNode(2, false)] });

    // Only the selected record keeps its transport's backoff.
    await vi.waitFor(() => expect(test.released).toEqual([other]));
    expect(test.watchPresence).toHaveBeenCalled();
    test.tick();
    await settleCoordinator();
    expect(test.acquired.filter((environmentId) => environmentId === other)).toHaveLength(1);

    hostedHubStore.setState({ nodes });
    await vi.waitFor(() =>
      expect(test.acquired.filter((environmentId) => environmentId === other)).toHaveLength(2),
    );
    expect(test.released).toEqual([other]);
    releaseSelected();
    releaseOther();
    test.stop();
  });
});

describe("queued-send scope retention", () => {
  it("retains one scope per environment with a queued server thread", () => {
    const scopes = createHostedWebScopeStore();
    let queued: ReadonlyArray<string> = [];
    const servers = new Set([`${environment(1)}:${thread(1)}`, `${environment(1)}:${thread(2)}`]);
    const listeners = new Set<() => void>();
    const stop = startQueuedSendScopeRetention(
      {
        queuedThreadKeys: () => queued,
        isServerThread: (ref) => servers.has(`${ref.environmentId}:${ref.threadId}`),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      scopes,
    );
    const update = (next: ReadonlyArray<string>) => {
      queued = next;
      listeners.forEach((listener) => listener());
    };

    update([`${environment(1)}:${thread(1)}`, `${environment(1)}:${thread(2)}`]);
    expect(scopes.list()).toMatchObject([
      { environmentId: environment(1), scope: { type: "interactive" }, refCount: 1 },
    ]);
    // A local draft's queue, and a key that names no thread, hold nothing.
    update([`${environment(2)}:draft`, "malformed"]);
    expect(scopes.list()).toEqual([]);

    update([`${environment(1)}:${thread(2)}`]);
    stop();
    expect(scopes.list()).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});

function metadataWithThread(environmentId: EnvironmentId): WorkspaceMetadataSnapshot {
  return {
    schemaVersion: 1,
    environmentId,
    capturedAt: 1,
    projects: [
      {
        environmentId,
        id: ProjectId.make("project"),
        name: "Project",
        cwd: "/project",
        repositoryIdentity: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    worktrees: [],
    threads: [
      {
        environmentId,
        id: thread(1),
        projectId: ProjectId.make("project"),
        worktreeId: null,
        title: "Thread",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: null,
        archivedAt: null,
        modelSelection: null,
        providerDriver: null,
        branch: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        deliveryUnknown: false,
      },
    ],
  };
}

function queuedMessage(id: string): WebQueuedMessage {
  return { id } as unknown as WebQueuedMessage;
}
