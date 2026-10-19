import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCache,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isHostedEnvironmentSessionLive,
  resetHostedEnvironmentSessionsForTests,
  type HostedBrowserStatus,
  type HostedHubNode,
  type HostedHubState,
} from "@ryco/client-runtime/authorization";

import {
  MAX_HOSTED_WEB_CONNECTIONS,
  createHostedConnectionCoordinator,
  hostedDemandUnblocked,
  readHostedDemandReadiness,
  readHostedNodeMutationLease,
  readHostedWorkspaceState,
  startHostedWorkspaceCoordinator,
} from "./hostedConnectionCoordinator";
import { createHostedWebScopeStore, hostedWebConnectionScopes } from "./hostedConnectionScopes";
import { HOSTED_WEB_RETAINED_ENVIRONMENT_SESSIONS } from "./runtime";
import { getHostedEnvironmentSessions, hostedHubController, hostedHubStore } from "./state";

const environment = (index: number) => EnvironmentId.make(`env_${String(index).padStart(22, "0")}`);
const thread = (index: number) => ThreadId.make(`thread_${String(index)}`);

function harness(foregroundEnvironmentId?: () => EnvironmentId | null) {
  let now = 1;
  const connected = new Set<EnvironmentId>();
  const connects: Array<{ environmentId: EnvironmentId }> = [];
  const releases: EnvironmentId[] = [];
  const scopes = createHostedWebScopeStore();
  const coordinator = createHostedConnectionCoordinator({
    scopes,
    ...(foregroundEnvironmentId ? { foregroundEnvironmentId } : {}),
    now: () => now,
    connect: async (environmentId) => {
      connects.push({ environmentId });
      connected.add(environmentId);
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
    tick: () => {
      now += 1;
    },
  };
}

describe("hosted Web connection coordinator", () => {
  it("holds the named one-connection ceiling under a five-node fixture", async () => {
    const test = harness();
    const releases = Array.from({ length: 5 }, (_, index) => {
      test.tick();
      return test.scopes.retain(environment(index), {
        type: "thread-detail",
        threadId: thread(index),
      });
    });

    await test.coordinator.reconcile();

    expect(MAX_HOSTED_WEB_CONNECTIONS).toBe(1);
    expect(test.connected.size).toBe(1);
    expect(test.coordinator.snapshot().activeConnectionCount).toBe(1);
    expect(test.coordinator.snapshot().queuedEnvironmentIds).toHaveLength(4);
    expect(test.connects).toHaveLength(1);
    releases.forEach((release) => release());
    test.coordinator.dispose();
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
    expect(test.connected).toEqual(new Set([environment(1)]));
    expect(test.coordinator.snapshot().queuedEnvironmentIds).toEqual([environment(2)]);

    releaseRoute();
    await test.coordinator.reconcile();
    expect(test.connected).toEqual(new Set([environment(1)]));
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

  it("switches to the routed device while the outgoing shell still retains its scopes", async () => {
    let foreground = environment(1);
    const test = harness(() => foreground);
    const releaseA = test.scopes.retain(environment(1), {
      type: "thread-detail",
      threadId: thread(1),
    });
    const releaseProvider = test.scopes.retain(environment(1), { type: "provider-status" });
    await test.coordinator.reconcile();

    foreground = environment(2);
    const releaseB = test.scopes.retain(environment(2), {
      type: "thread-detail",
      threadId: thread(2),
    });
    await test.coordinator.reconcile();

    expect(test.connected).toEqual(new Set([environment(2)]));
    expect(test.releases).toEqual([environment(1)]);
    expect(test.coordinator.snapshot().queuedEnvironmentIds).toEqual([]);
    // Scope ownership is preserved for the mounted views. Switching Back can
    // reactivate A without waiting for a React cleanup or the renewal timer.
    expect(test.scopes.list()).toHaveLength(3);
    foreground = environment(1);
    await test.coordinator.reconcile();
    expect(test.connected).toEqual(new Set([environment(1)]));
    releaseA();
    releaseProvider();
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
    const stop = startHostedWorkspaceCoordinator({
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
  hostedHubStore.setState({
    accountStatus: "authenticated",
    account: { id: "account-a", displayName: "Ada", role: "owner", createdAt: 1, disabledAt: null },
    directoryStatus: "ready",
    browserStatus,
    nodes,
  });
}

/** Let the coordinator finish the connect attempt the retained scope queued. */
async function settleCoordinator(): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

function startWithoutRenewalTick() {
  // The renewal tick is what used to rescue refused demand ~25s later; with it
  // stubbed out, anything that connects did so because the state changed.
  return startHostedWorkspaceCoordinator({
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
    const selectNode = vi
      .spyOn(hostedHubController, "selectNode")
      .mockImplementation(async (nodeId) => {
        const node = hostedHubStore.getState().nodes.find((candidate) => candidate.id === nodeId);
        hostedHubStore.setState({ selectedNode: node ?? null });
      });
    const releaseWatch = vi.fn();
    const watch = vi
      .spyOn(hostedHubController, "watchDirectoryPresence")
      .mockReturnValue(releaseWatch);
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(5),
    });

    // Demand for an offline node is refused, and the directory is asked to
    // watch presence at its faster cadence meanwhile.
    await settleCoordinator();
    expect(watch).toHaveBeenCalledOnce();
    expect(selectNode).not.toHaveBeenCalled();

    hostedHubStore.setState({ nodes: [hubNode(env, true)] });

    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledWith("node_bbbbbbbbbbbbbbbbbbbbbb"));
    expect(releaseWatch).toHaveBeenCalledOnce();
    releaseScope();
    stop();
  });

  it("connects held demand as soon as a stale browser becomes current again", async () => {
    const env = environment(6);
    signedInDirectory([hubNode(env, true)], "stale");
    const selectNode = vi
      .spyOn(hostedHubController, "selectNode")
      .mockImplementation(async (nodeId) => {
        const node = hostedHubStore.getState().nodes.find((candidate) => candidate.id === nodeId);
        hostedHubStore.setState({ selectedNode: node ?? null });
      });
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(6),
    });
    await settleCoordinator();
    expect(selectNode).not.toHaveBeenCalled();

    hostedHubStore.setState({ browserStatus: "current" });

    await vi.waitFor(() => expect(selectNode).toHaveBeenCalledOnce());
    releaseScope();
    stop();
  });

  it.each([
    [
      "an E2EE-fatal handshake close",
      (generation: number) =>
        hostedHubController.failure(generation, {
          kind: "protocol",
          retryable: false,
          closeReason: "channel_rejected",
        }),
    ],
    [
      "a revoked grant",
      (generation: number) =>
        hostedHubController.failure(generation, { kind: "revoked", retryable: false }),
    ],
    [
      // The session-sync deadline hands a `synchronizing` browser back the same
      // way: terminal transport and `current` browser in one patch.
      "the session-sync deadline",
      () =>
        hostedHubStore.setState({ transportStatus: "terminal-failure", browserStatus: "current" }),
    ],
  ])("never hot-retries a relay channel after %s hands the browser back", async (_label, fail) => {
    const env = environment(8);
    const node = hubNode(env, true);
    signedInDirectory([node], "synchronizing");
    hostedHubStore.setState({
      selectedNode: node,
      selectionStatus: "online",
      transportStatus: "connecting",
      generation: 3,
    });
    const selectNode = vi.spyOn(hostedHubController, "selectNode").mockResolvedValue();
    const retrySelectedNode = vi
      .spyOn(hostedHubController, "retrySelectedNode")
      .mockResolvedValue();
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(8),
    });
    await settleCoordinator();

    fail(3);
    expect(hostedHubStore.getState()).toMatchObject({
      transportStatus: "terminal-failure",
      browserStatus: "current",
    });
    await settleCoordinator();
    await settleCoordinator();

    // The browser turning `current` here is the failure itself, not a new
    // reason the node could be served; only the renewal tick may retry it.
    expect(retrySelectedNode).not.toHaveBeenCalled();
    expect(selectNode).not.toHaveBeenCalled();
    releaseScope();
    stop();
  });

  it("still reconnects a terminally failed node once the directory sees it come back", async () => {
    const env = environment(9);
    signedInDirectory([hubNode(env, false)]);
    hostedHubStore.setState({
      selectedNode: hubNode(env, false),
      selectionStatus: "offline",
      transportStatus: "terminal-failure",
      generation: 3,
    });
    vi.spyOn(hostedHubController, "watchDirectoryPresence").mockReturnValue(() => undefined);
    const retrySelectedNode = vi
      .spyOn(hostedHubController, "retrySelectedNode")
      .mockImplementation(async () => {
        // A retry opens a fresh relay attempt for the same selection.
        hostedHubStore.setState({ transportStatus: "connecting" });
      });
    const stop = startWithoutRenewalTick();
    const releaseScope = hostedWebConnectionScopes.retain(env, {
      type: "thread-detail",
      threadId: thread(9),
    });
    await settleCoordinator();
    expect(retrySelectedNode).not.toHaveBeenCalled();

    // A presence edge is a new signal from the directory, not the failure
    // echoing back, so it re-plans at once.
    hostedHubStore.setState({ nodes: [hubNode(env, true)] });

    await vi.waitFor(() => expect(retrySelectedNode).toHaveBeenCalledOnce());
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

describe("hosted Web single-session machine catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    hostedWebConnectionScopes.reset();
    hostedHubController.resetForTests();
  });

  const ownerNode = (environmentId: EnvironmentId): HostedHubNode => ({
    ...hubNode(environmentId, true),
    grant: { id: "grant_bbbbbbbbbbbbbbbbbbbbbb", role: "owner" },
    effectiveRole: "owner",
  });

  /** The selected node with a cached shell, so its lease only waits on the session. */
  function startSelected(node: HostedHubNode, session: Partial<HostedHubState>) {
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
    hostedHubStore.setState({ selectedNode: node, selectionStatus: "online", ...session });
    vi.spyOn(hostedHubController, "returnToDirectory").mockResolvedValue();
    return startHostedWorkspaceCoordinator({
      cache: { ...emptyCache, list: async () => [record] },
      hubOrigin: "https://hub.example.test",
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
  }

  it.each(["ready", "replaying", "delivery-unknown"] as const)(
    "shows an online, established selected session that is %s as connected and leases it",
    async (sessionStatus) => {
      const env = environment(11);
      const stop = startSelected(ownerNode(env), {
        transportStatus: "online",
        sessionEstablished: true,
        sessionStatus,
        effectiveRole: "owner",
      });

      await vi.waitFor(() =>
        expect(readHostedWorkspaceState().machines).toMatchObject([
          {
            environmentId: env,
            connectionState: "connected",
            deliveryUnknown: sessionStatus === "delivery-unknown",
            canMutate: true,
          },
        ]),
      );
      await vi.waitFor(() => expect(readHostedNodeMutationLease(env)).not.toBeNull());
      stop();
    },
  );

  it("shows a selected session that is still being established as disconnected", async () => {
    const env = environment(12);
    const stop = startSelected(ownerNode(env), {
      transportStatus: "connecting",
      sessionEstablished: false,
      sessionStatus: "synchronizing",
      // The directory's role stands while one session is being established.
      effectiveRole: "viewer",
    });

    await vi.waitFor(() =>
      expect(readHostedWorkspaceState().machines).toMatchObject([
        {
          environmentId: env,
          connectionState: "disconnected",
          deliveryUnknown: false,
          effectiveRole: "owner",
        },
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
  });

  it("keeps retained sessions off until more than one connection is allowed", () => {
    expect(HOSTED_WEB_RETAINED_ENVIRONMENT_SESSIONS).toBe(MAX_HOSTED_WEB_CONNECTIONS > 1);
  });

  function retainedHarness(input: { readonly foreground: () => EnvironmentId | null }) {
    const scopes = createHostedWebScopeStore();
    const startedAt = Date.now();
    const connects: Array<{ readonly environmentId: EnvironmentId; readonly at: number }> = [];
    const live = new Set<EnvironmentId>();
    let mostLive = 0;
    const coordinator = createHostedConnectionCoordinator({
      scopes,
      mode: "retained",
      maxConnections: 3,
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

  function retainedNode(index: number, online = true): HostedHubNode {
    return {
      ...hubNode(environment(index), online),
      id: `node_${String(index).padStart(22, "0")}`,
      label: `Node ${index}`,
    };
  }

  /**
   * The workspace coordinator in retained mode over the real session registry;
   * the lifecycle owner's acquire and release are recorded and write the
   * registry as the controller would.
   */
  function startRetained(
    nodes: ReadonlyArray<HostedHubNode>,
    options?: {
      /** Nodes whose records are live before the coordinator starts. */
      readonly warm?: ReadonlyArray<HostedHubNode>;
    },
  ) {
    signedInDirectory(nodes);
    resetHostedEnvironmentSessionsForTests();
    const sessions = getHostedEnvironmentSessions();
    for (const node of options?.warm ?? []) {
      sessions.markConnectRequested(node.environmentId, sessions.ensureRecord(node).generation);
    }
    let mostLive = 0;
    sessions.subscribe(() => {
      const live = sessions.list().filter((record) => isHostedEnvironmentSessionLive(record));
      mostLive = Math.max(mostLive, live.length);
    });
    const acquired: EnvironmentId[] = [];
    const released: EnvironmentId[] = [];
    vi.spyOn(hostedHubController, "acquireEnvironment").mockImplementation(async (nodeId) => {
      const node = hostedHubStore.getState().nodes.find((candidate) => candidate.id === nodeId)!;
      const record = sessions.ensureRecord(node);
      sessions.markConnectRequested(node.environmentId, record.generation);
      acquired.push(node.environmentId);
      return "connecting";
    });
    vi.spyOn(hostedHubController, "releaseEnvironment").mockImplementation(
      async (environmentId) => {
        released.push(environmentId);
        sessions.release(environmentId);
      },
    );
    const watchPresence = vi
      .spyOn(hostedHubController, "watchDirectoryPresence")
      .mockReturnValue(() => undefined);
    const ticks: Array<() => void> = [];
    const stop = startHostedWorkspaceCoordinator({
      cache: emptyCache,
      hubOrigin: "https://hub.example.test",
      mode: "retained",
      maxConnections: 3,
      setInterval: (callback) => ticks.push(callback),
      clearInterval: () => undefined,
    });
    return {
      sessions,
      acquired,
      released,
      watchPresence,
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
