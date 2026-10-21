import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import * as HostedIdentity from "@ryco/contracts/hosted-identity";
import type {
  WorkspaceMetadataCache,
  WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vite-plus/test";

import { createFakeHistoryWindow } from "../../test/fakeHistoryWindow";
import { useStore, selectSidebarThreadsAcrossEnvironments } from "../store";
import { workspaceMetadataToCachedShellSnapshot } from "../workspaceMetadataProjection";
import {
  isHostedEnvironmentSessionLive,
  resetHostedEnvironmentSessionsForTests,
} from "@ryco/client-runtime/authorization";
import { getHostedEnvironmentSessions, hostedHubController, hostedHubStore } from "./state";
import { hostedWebConnectionScopes } from "./hostedConnectionScopes";
import {
  clearHostedNodeRoute,
  installHostedNodeHistory,
  leaveHostedNodeRouteToHubDirectory,
  resetHostedNodeRoutesForTests,
} from "./nodeRoutes";
import {
  readHostedWorkspaceState,
  retryHostedHomeDiscovery,
  setHostedWorkspaceBackgrounded,
  startHostedWorkspaceCoordinator,
} from "./hostedConnectionCoordinator";
import type { HostedHubNode } from "./types";

const node = (id: number): HostedHubNode => ({
  id: `node_${String(id).padStart(22, "0")}`,
  environmentId: EnvironmentId.make(`env_${String(id).padStart(22, "0")}`),
  label: `Device ${id}`,
  platformOs: "darwin",
  platformArch: "arm64",
  clientVersion: "1",
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
  grant: { id: `grant_${id}`, role: "owner" },
  effectiveRole: "owner",
  presence: { online: true, lastHeartbeatAt: 1 },
});
const nodes = [node(1), node(2)];
const account = {
  id: "account-home",
  displayName: "Home",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};
const metadata = (environmentId: EnvironmentId): WorkspaceMetadataSnapshot => ({
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
      id: ThreadId.make("thread"),
      projectId: ProjectId.make("project"),
      worktreeId: null,
      title: `Thread on ${environmentId}`,
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
});
let stop: (() => void) | undefined;
let cached: Awaited<ReturnType<WorkspaceMetadataCache["list"]>>;
let list: ReturnType<typeof vi.fn<WorkspaceMetadataCache["list"]>>;
let acquire: MockInstance<typeof hostedHubController.acquireEnvironment>;
let select: MockInstance<typeof hostedHubController.selectNode>;
let history: ReturnType<typeof installHostedNodeHistory>;
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
/** The nodes acquired so far, in id order. */
const acquisitions = () => acquire.mock.calls.map(([nodeId]) => nodeId).toSorted();

beforeEach(() => {
  vi.useFakeTimers();
  hostedHubController.resetForTests();
  resetHostedNodeRoutesForTests();
  resetHostedEnvironmentSessionsForTests();
  hostedWebConnectionScopes.reset();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  history = installHostedNodeHistory(
    createFakeHistoryWindow("/") as unknown as Window & typeof globalThis,
  );
  cached = [];
  list = vi.fn(async () => cached);
  hostedHubStore.setState({
    accountStatus: "authenticated",
    account,
    directoryStatus: "ready",
    browserStatus: "current",
    nodes,
  });
  // The lifecycle owner's acquire opens the environment's own session; the
  // coordinator never moves the selection.
  acquire = vi.spyOn(hostedHubController, "acquireEnvironment").mockImplementation(async (id) => {
    const target = hostedHubStore.getState().nodes.find((entry) => entry.id === id)!;
    const sessions = getHostedEnvironmentSessions();
    const record = sessions.ensureRecord(target);
    sessions.markConnectRequested(target.environmentId, record.generation);
    return "connecting";
  });
  vi.spyOn(hostedHubController, "releaseEnvironment").mockImplementation(async (environmentId) =>
    getHostedEnvironmentSessions().release(environmentId),
  );
  select = vi.spyOn(hostedHubController, "selectNode");
});
afterEach(() => {
  releaseView = null;
  stop?.();
  stop = undefined;
  expect(select).not.toHaveBeenCalled();
  resetHostedNodeRoutesForTests();
  hostedHubController.resetForTests();
  resetHostedEnvironmentSessionsForTests();
  hostedWebConnectionScopes.reset();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function start(
  startReadCache?: Parameters<typeof startHostedWorkspaceCoordinator>[0] extends
    | { readonly startReadCache?: infer T }
    | undefined
    ? T
    : never,
) {
  stop = startHostedWorkspaceCoordinator({
    ...(startReadCache ? { startReadCache } : {}),
    hubOrigin: "https://hub.example.test",
    cache: {
      list,
      load: async () => null,
      replace: async () => undefined,
      purgeAccount: async () => undefined,
      purgeEnvironment: async () => undefined,
    },
  });
}
/** The environment's own relay attempt came online and accepted its shell snapshot. */
function establish(environmentId: EnvironmentId) {
  const sessions = getHostedEnvironmentSessions();
  const { generation } = sessions.read(environmentId)!;
  sessions.transportStatus(environmentId, generation, "online");
  sessions.markSessionReady(environmentId, generation);
}
async function complete(environmentId: EnvironmentId, empty = false) {
  const snapshot = metadata(environmentId);
  useStore
    .getState()
    .hydrateEnvironmentStateFromCache(
      workspaceMetadataToCachedShellSnapshot(
        empty ? { ...snapshot, projects: [], threads: [] } : snapshot,
      ),
      environmentId,
    );
  useStore.setState((state) => ({
    environmentStateById: {
      ...state.environmentStateById,
      [environmentId]: {
        ...state.environmentStateById[environmentId]!,
        bootstrapComplete: true,
        hydratedFromCacheAt: undefined,
      },
    },
  }));
  establish(environmentId);
  await vi.advanceTimersByTimeAsync(110);
  await settle();
}
/** Starts with a Hub cache shell for each of `shells`, so discovery passes over them. */
function startWithShells(shells: ReadonlyArray<HostedHubNode>) {
  start((onSnapshot) => {
    for (const entry of shells) onSnapshot(metadata(entry.environmentId));
    return () => {};
  });
}
/** Routes a thread on the device: only a thread or a draft names a node. */
function routeTo(target: HostedHubNode) {
  history.push(`/${target.environmentId}/thread`);
  history.flush();
}
/** Leaves a node route for home, or for the node directory page. */
function leaveNode(to: "home" | "directory") {
  if (to === "home") clearHostedNodeRoute();
  else leaveHostedNodeRouteToHubDirectory();
  history.flush();
}
let releaseView: (() => void) | null = null;
function closeView() {
  releaseView?.();
  releaseView = null;
}
/** Opens a thread on the device in place of the previous one, as a route swap does. */
async function open(target: HostedHubNode, established: boolean) {
  closeView();
  routeTo(target);
  releaseView = hostedWebConnectionScopes.retain(target.environmentId, {
    type: "thread-detail",
    threadId: ThreadId.make("thread"),
  });
  await vi.advanceTimersByTimeAsync(10);
  await settle();
  if (!established) return;
  establish(target.environmentId);
  await settle();
}
/** Environments whose session is live or on its way, in id order. */
const liveEnvironmentIds = () =>
  getHostedEnvironmentSessions()
    .list()
    .filter((record) => isHostedEnvironmentSessionLive(record))
    .map((record) => record.environmentId)
    .toSorted();
/** Environments the published demand holds a warm lease for, in restore order. */
const warmEnvironmentIds = () =>
  readHostedWorkspaceState()
    .demand.demand.leases.filter((lease) => lease.warm === true)
    .map((lease) => lease.environmentId);

describe("hosted home discovery", () => {
  it("does not clear the latest session when an earlier namespace purge finishes", async () => {
    history.push("/account");
    const session = {
      id: "session-a",
      accountId: account.id,
      createdAt: 1,
      expiresAt: 9999999999999,
      lastSeenAt: 1,
      revokedAt: null,
      revocationReasonCode: null,
    };
    hostedHubStore.setState({ session });
    let resume: (() => void) | undefined;
    const purgeAccount = vi.fn<WorkspaceMetadataCache["purgeAccount"]>(async () => undefined);
    purgeAccount.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    stop = startHostedWorkspaceCoordinator({
      hubOrigin: "https://hub.example.test",
      cache: {
        list,
        load: async () => null,
        replace: async () => undefined,
        purgeAccount,
        purgeEnvironment: async () => undefined,
      },
    });
    await settle();
    hostedHubStore.setState({ session: { ...session, id: "session-b" } });
    hostedHubStore.setState({ session: { ...session, id: "session-c" } });
    await settle();
    const environmentId = nodes[0]!.environmentId;
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        workspaceMetadataToCachedShellSnapshot(metadata(environmentId)),
        environmentId,
      );
    resume?.();
    await settle();
    expect(useStore.getState().environmentStateById[environmentId]).toBeDefined();
    expect(purgeAccount).toHaveBeenCalledTimes(2);
  });
  it("fences a paused cached-directory pass when its session changes", async () => {
    history.push("/account");
    const session = {
      id: "session-a",
      accountId: account.id,
      createdAt: 1,
      expiresAt: 9999999999999,
      lastSeenAt: 1,
      revokedAt: null,
      revocationReasonCode: null,
    };
    hostedHubStore.setState({ session });
    const old = metadata(node(9).environmentId);
    const eligible = metadata(nodes[0]!.environmentId);
    list.mockResolvedValueOnce(
      [old, eligible].map((snapshot) => ({
        namespace: {
          hubOrigin: "https://hub.example.test",
          accountId: account.id,
          environmentId: snapshot.environmentId,
        },
        snapshot,
        payloadBytes: 1,
        updatedAt: 1,
      })),
    );
    let resume: (() => void) | undefined;
    const purgeEnvironment = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    stop = startHostedWorkspaceCoordinator({
      hubOrigin: "https://hub.example.test",
      cache: {
        list,
        load: async () => null,
        replace: async () => undefined,
        purgeAccount: async () => undefined,
        purgeEnvironment,
      },
    });
    await settle();
    expect(purgeEnvironment).toHaveBeenCalledOnce();
    hostedHubStore.setState({ session: { ...session, id: "session-b" } });
    await settle();
    resume?.();
    await settle();
    expect(useStore.getState().environmentStateById[eligible.environmentId]).toBeUndefined();
  });
  it.each(["session", "space"] as const)(
    "clears retained rows synchronously on a same-account %s change",
    async (change) => {
      const session = {
        id: "session-a",
        accountId: account.id,
        createdAt: 1,
        expiresAt: 9999999999999,
        lastSeenAt: 1,
        revokedAt: null,
        revocationReasonCode: null,
      };
      hostedHubStore.setState({ session });
      history.push("/account");
      start();
      await settle();
      const environmentId = nodes[0]!.environmentId;
      useStore
        .getState()
        .hydrateEnvironmentStateFromCache(
          workspaceMetadataToCachedShellSnapshot(metadata(environmentId)),
          environmentId,
        );
      expect(useStore.getState().environmentStateById[environmentId]).toBeDefined();
      const release = hostedWebConnectionScopes.retain(environmentId, {
        type: "thread-detail",
        threadId: ThreadId.make("thread"),
      });
      hostedHubStore.setState({
        session:
          change === "session"
            ? { ...session, id: "session-b" }
            : {
                ...session,
                activeSpaceId: HostedIdentity.HubSpaceId.make("space_aaaaaaaaaaaaaaaaaaaaaa"),
              },
      });
      expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
      await settle();
      expect(selectSidebarThreadsAcrossEnvironments(useStore.getState())).toHaveLength(0);
      expect(hostedWebConnectionScopes.list()).toEqual([
        expect.objectContaining({
          environmentId,
          scope: { type: "thread-detail", threadId: ThreadId.make("thread") },
        }),
      ]);
      release();
    },
  );
  it("fills an empty home from two devices in sequence without changing its URL", async () => {
    start();
    await settle();
    expect(acquire.mock.calls).toEqual([[nodes[0]!.id]]);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBe(nodes[0]!.environmentId);
    await complete(nodes[0]!.environmentId);
    expect(acquire.mock.calls).toEqual([[nodes[0]!.id], [nodes[1]!.id]]);
    await complete(nodes[1]!.environmentId);
    expect(selectSidebarThreadsAcrossEnvironments(useStore.getState())).toHaveLength(2);
    expect(readHostedWorkspaceState().workspace.threads).toHaveLength(2);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBeNull();
    expect(history.location.pathname).toBe("/");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("waits, bounded, for Hub cache shells in flight instead of waking those devices", async () => {
    let reportShellReads: (nodeIds: ReadonlySet<string>) => void = () => {};
    let deliver: (snapshot: WorkspaceMetadataSnapshot) => void = () => {};
    start((onSnapshot, onShellReadsChanged) => {
      deliver = onSnapshot;
      reportShellReads = onShellReadsChanged ?? (() => {});
      return () => {};
    });
    reportShellReads(new Set([nodes[0]!.id, nodes[1]!.id]));
    await settle();
    expect(acquire).not.toHaveBeenCalled();
    // The first device's cached shell lands: it never needs a relay wake-up.
    deliver(metadata(nodes[0]!.environmentId));
    reportShellReads(new Set([nodes[1]!.id]));
    await settle();
    expect(acquire).not.toHaveBeenCalled();
    // The second device's read is still pending at the bound: wake it anyway.
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    expect(acquire.mock.calls).toEqual([[nodes[1]!.id]]);
  });

  it("passes over a device whose Hub cache read is in flight and wakes the next", async () => {
    let reportShellReads: (nodeIds: ReadonlySet<string>) => void = () => {};
    start((_onSnapshot, onShellReadsChanged) => {
      reportShellReads = onShellReadsChanged ?? (() => {});
      return () => {};
    });
    reportShellReads(new Set([nodes[0]!.id]));
    await settle();
    expect(acquire.mock.calls).toEqual([[nodes[1]!.id]]);
  });

  it("treats an empty current shell as complete and skips cached, offline, revoked and native-only devices", async () => {
    const snapshot = metadata(nodes[0]!.environmentId);
    cached = [
      {
        namespace: {
          hubOrigin: "https://hub.example.test",
          accountId: account.id,
          environmentId: snapshot.environmentId,
        },
        snapshot,
        payloadBytes: 0,
        updatedAt: 1,
      },
    ];
    hostedHubStore.setState({
      nodes: [
        ...nodes,
        { ...node(3), presence: { online: false, lastHeartbeatAt: 1 } },
        { ...node(4), revokedAt: 1 },
        { ...node(5), capabilities: { repositoryIdentity: true, nativeClientRequired: true } },
      ],
    });
    start();
    await settle();
    // Discovery wakes only the device without a shell; the remembered
    // browser's cached device is restored warm, not discovered.
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBe(nodes[1]!.environmentId);
    expect(acquisitions()).toEqual([nodes[0]!.id, nodes[1]!.id]);
    await complete(nodes[1]!.environmentId, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBeNull();
  });

  it("discovers the next device while the current device streams continuous updates", async () => {
    start();
    await settle();
    const environmentId = nodes[0]!.environmentId;
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        workspaceMetadataToCachedShellSnapshot(metadata(environmentId)),
        environmentId,
      );
    useStore.setState((state) => ({
      environmentStateById: {
        ...state.environmentStateById,
        [environmentId]: {
          ...state.environmentStateById[environmentId]!,
          bootstrapComplete: true,
          hydratedFromCacheAt: undefined,
        },
      },
    }));
    establish(environmentId);

    for (let index = 0; index < 10; index++) {
      await vi.advanceTimersByTimeAsync(20);
      useStore.setState((state) => ({ environmentStateById: { ...state.environmentStateById } }));
    }
    await settle();

    expect(acquire.mock.calls).toEqual([[nodes[0]!.id], [nodes[1]!.id]]);
    expect(readHostedWorkspaceState().workspace.threads).toHaveLength(1);
  });

  it("moves past a failed device and supports an explicit retry", async () => {
    start();
    await settle();
    const sessions = getHostedEnvironmentSessions();
    sessions.failure(nodes[0]!.environmentId, sessions.read(nodes[0]!.environmentId)!.generation, {
      kind: "incompatible",
      retryable: false,
    });
    await settle();
    expect(acquire.mock.calls).toEqual([[nodes[0]!.id], [nodes[1]!.id]]);
    expect(readHostedWorkspaceState().homeDiscovery.failedEnvironmentIds).toEqual([
      nodes[0]!.environmentId,
    ]);
    await complete(nodes[1]!.environmentId);
    retryHostedHomeDiscovery();
    await settle();
    expect(acquire.mock.calls.at(-1)).toEqual([nodes[0]!.id]);
  });

  it("stops discovery for navigation and gives a retained thread the next connection", async () => {
    start();
    await settle();
    history.push(`/node/${node(3).id}/${node(3).environmentId}/thread`);
    history.flush();
    hostedHubStore.setState({ nodes: [...nodes, node(3)] });
    const release = hostedWebConnectionScopes.retain(node(3).environmentId, {
      type: "thread-detail",
      threadId: ThreadId.make("thread"),
    });
    await settle();
    expect(acquire.mock.calls).toEqual([[nodes[0]!.id], [node(3).id]]);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBeNull();
    release();
  });

  it("pauses in the background and resumes only after directory revalidation", async () => {
    start();
    await settle();
    await setHostedWorkspaceBackgrounded(true);
    await settle();
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBeNull();
    hostedHubStore.setState({ directoryStatus: "stale", browserStatus: "checking-access" });
    await setHostedWorkspaceBackgrounded(false);
    await settle();
    expect(acquire).toHaveBeenCalledTimes(1);
    hostedHubStore.setState({ directoryStatus: "ready", browserStatus: "current" });
    await settle();
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBe(nodes[0]!.environmentId);
  });

  it("loads persisted metadata after a concurrent directory update instead of silently losing it", async () => {
    let resolve: ((value: typeof cached) => void) | undefined;
    list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const snapshot = metadata(nodes[0]!.environmentId);
    cached = [
      {
        namespace: {
          hubOrigin: "https://hub.example.test",
          accountId: account.id,
          environmentId: snapshot.environmentId,
        },
        snapshot,
        payloadBytes: 0,
        updatedAt: 1,
      },
    ];
    start();
    await settle();
    expect(acquire).not.toHaveBeenCalled();
    hostedHubStore.setState({ nodes: [...nodes] });
    await settle();
    resolve?.(cached);
    await settle();
    expect(readHostedWorkspaceState().workspace.threads).toHaveLength(1);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBe(nodes[1]!.environmentId);
    // The listed device is restored warm, the other one discovered.
    expect(acquisitions()).toEqual([nodes[0]!.id, nodes[1]!.id]);
  });

  it("hands a single slot from one discovered device to the next and never moves the selection", async () => {
    const release = vi.mocked(hostedHubController.releaseEnvironment);
    stop = startHostedWorkspaceCoordinator({
      hubOrigin: "https://hub.example.test",
      maxConnections: 1,
      cache: {
        list,
        load: async () => null,
        replace: async () => undefined,
        purgeAccount: async () => undefined,
        purgeEnvironment: async () => undefined,
      },
    });
    await settle();
    expect(acquire.mock.calls).toEqual([[nodes[0]!.id]]);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBe(nodes[0]!.environmentId);

    await complete(nodes[0]!.environmentId);
    // The discovered device leaves its one slot to the next.
    expect(release).toHaveBeenCalledWith(nodes[0]!.environmentId);
    expect(acquire.mock.calls).toEqual([[nodes[0]!.id], [nodes[1]!.id]]);
    expect(hostedHubStore.getState().selectedNode).toBeNull();
  });

  it("restores nothing at boot from the Hub's cached shells alone", async () => {
    history.push("/account");
    history.flush();
    startWithShells(nodes);
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    // The Hub caches a shell for every device; only this browser's own cache
    // seeds a restore.
    expect(acquire).not.toHaveBeenCalled();
    expect(warmEnvironmentIds()).toEqual([]);
  });

  it("holds the warm restore after the background until the directory is revalidated", async () => {
    history.push("/account");
    history.flush();
    startWithShells(nodes);
    await settle();
    await open(nodes[0]!, true);
    closeView();
    leaveNode("directory");
    await setHostedWorkspaceBackgrounded(true);
    await settle();
    expect(vi.mocked(hostedHubController.releaseEnvironment)).toHaveBeenCalledWith(
      nodes[0]!.environmentId,
    );

    hostedHubStore.setState({ directoryStatus: "stale", browserStatus: "checking-access" });
    await setHostedWorkspaceBackgrounded(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(acquire.mock.calls).toEqual([[nodes[0]!.id]]);

    hostedHubStore.setState({ directoryStatus: "ready", browserStatus: "current" });
    await settle();
    expect(acquire.mock.calls).toEqual([[nodes[0]!.id], [nodes[0]!.id]]);
  });

  it("re-warms the recently used devices on returning home, without a thread or a URL change", async () => {
    const devices = [node(1), node(2), node(3), node(4), node(5)];
    hostedHubStore.setState({ nodes: devices });
    history.push("/account");
    history.flush();
    startWithShells(devices);
    await settle();
    const ids = (...indexes: ReadonlyArray<number>) =>
      indexes.map((index) => node(index).environmentId);
    // Three devices used in turn, then two opened but never established,
    // which take the slots of the least recently used ones.
    for (const device of devices.slice(0, 3)) await open(device, true);
    for (const device of devices.slice(3)) await open(device, false);
    closeView();
    expect(liveEnvironmentIds()).toEqual(ids(3, 4, 5));
    const release = vi.mocked(hostedHubController.releaseEnvironment);
    release.mockClear();
    acquire.mockClear();

    leaveNode("home");
    await settle();
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    // The devices still connecting keep their slots: a warm device takes only
    // a free one.
    expect(warmEnvironmentIds()).toEqual(ids(3, 2, 1));
    expect(release).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(liveEnvironmentIds()).toEqual(ids(3, 4, 5));

    // A slot that frees goes to the most recently used warm device.
    const sessions = getHostedEnvironmentSessions();
    sessions.failure(node(5).environmentId, sessions.read(node(5).environmentId)!.generation, {
      kind: "incompatible",
      retryable: false,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(acquire.mock.calls).toEqual([[node(2).id]]);
    expect(release).not.toHaveBeenCalled();
    expect(liveEnvironmentIds()).toEqual(ids(2, 3, 4));
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    expect(history.location.pathname).toBe("/");
  });

  it("lets discovery displace the least recently used warm device, which reconnects once a slot is free", async () => {
    const devices = [node(1), node(2), node(3), node(4)];
    hostedHubStore.setState({ nodes: devices });
    history.push("/account");
    history.flush();
    startWithShells(devices.slice(0, 3));
    await settle();
    for (const device of devices.slice(0, 3)) await open(device, true);
    closeView();
    const release = vi.mocked(hostedHubController.releaseEnvironment);
    release.mockClear();
    acquire.mockClear();

    leaveNode("home");
    await settle();
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBe(node(4).environmentId);
    expect(release.mock.calls).toEqual([[node(1).environmentId]]);
    expect(acquire.mock.calls).toEqual([[node(4).id]]);

    // The discovered device keeps its connection once discovery is done: a
    // warm device never closes one to make room.
    await complete(node(4).environmentId);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBeNull();
    expect(release.mock.calls).toEqual([[node(1).environmentId]]);
    expect(acquire.mock.calls).toEqual([[node(4).id]]);
    expect(warmEnvironmentIds()).toEqual([3, 2, 1].map((index) => node(index).environmentId));

    const sessions = getHostedEnvironmentSessions();
    sessions.failure(node(4).environmentId, sessions.read(node(4).environmentId)!.generation, {
      kind: "incompatible",
      retryable: false,
    });
    await settle();
    expect(release.mock.calls).toEqual([[node(1).environmentId]]);
    expect(acquire.mock.calls).toEqual([[node(4).id], [node(1).id]]);
  });

  it("skips a rate-limited warm device on returning home until the user routes to it", async () => {
    history.push("/account");
    history.flush();
    startWithShells(nodes);
    await settle();
    for (const device of nodes) await open(device, true);
    closeView();
    leaveNode("directory");
    await setHostedWorkspaceBackgrounded(true);
    await setHostedWorkspaceBackgrounded(false);
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    expect(warmEnvironmentIds()).toEqual([nodes[1]!.environmentId, nodes[0]!.environmentId]);

    const sessions = getHostedEnvironmentSessions();
    sessions.failure(nodes[0]!.environmentId, sessions.read(nodes[0]!.environmentId)!.generation, {
      kind: "rate-limited",
      retryable: true,
    });
    await settle();
    expect(warmEnvironmentIds()).toEqual([nodes[1]!.environmentId]);

    leaveNode("home");
    await settle();
    expect(warmEnvironmentIds()).toEqual([nodes[1]!.environmentId]);

    // Routing to the device is a demand edge that ends its cooldown.
    routeTo(nodes[0]!);
    await settle();
    leaveNode("home");
    await settle();
    expect(warmEnvironmentIds()).toEqual([nodes[1]!.environmentId, nodes[0]!.environmentId]);
  });

  it("switches to each of the last three devices without a new connection after a background", async () => {
    const devices = [node(1), node(2), node(3)];
    hostedHubStore.setState({ nodes: devices });
    history.push("/account");
    history.flush();
    startWithShells(devices);
    await settle();
    for (const device of devices) await open(device, true);
    closeView();
    leaveNode("directory");

    // Hidden past the grace period: everything nothing on screen holds goes.
    await setHostedWorkspaceBackgrounded(true);
    await settle();
    expect(liveEnvironmentIds()).toEqual([]);

    await setHostedWorkspaceBackgrounded(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    expect(liveEnvironmentIds()).toEqual(devices.map((device) => device.environmentId));
    for (const device of devices) establish(device.environmentId);
    await settle();
    const acquisitionsBefore = acquire.mock.calls.length;
    const release = vi.mocked(hostedHubController.releaseEnvironment);
    const releasesBefore = release.mock.calls.length;

    for (const device of [devices[0]!, devices[2]!, devices[1]!]) await open(device, false);
    closeView();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(acquire.mock.calls).toHaveLength(acquisitionsBefore);
    expect(release.mock.calls).toHaveLength(releasesBefore);
    expect(liveEnvironmentIds()).toEqual(devices.map((device) => device.environmentId));
  });

  it.each(["hidden", "offline"] as const)(
    "restores the warm set after a suspension (%s) and switches to it without a new connection",
    async (reason) => {
      const devices = [node(1), node(2), node(3)];
      const ids = (...indexes: ReadonlyArray<number>) =>
        indexes.map((index) => node(index).environmentId);
      hostedHubStore.setState({ nodes: devices });
      history.push("/account");
      history.flush();
      startWithShells(devices);
      await settle();
      for (const device of devices) await open(device, true);
      closeView();
      leaveNode("home");
      await settle();
      expect(warmEnvironmentIds()).toEqual(ids(3, 2, 1));

      // A freeze, pagehide or offline event withdraws authority before the
      // workspace plans as backgrounded.
      hostedHubController.suspendBrowser(reason);
      await setHostedWorkspaceBackgrounded(true);
      await settle();
      expect(liveEnvironmentIds()).toEqual([]);
      expect(warmEnvironmentIds()).toEqual([]);
      acquire.mockClear();

      // The foreground recovery revalidates access, then plans in the foreground.
      hostedHubStore.setState({ browserStatus: "current" });
      await setHostedWorkspaceBackgrounded(false);
      await vi.advanceTimersByTimeAsync(1_500);
      await settle();
      expect(warmEnvironmentIds()).toEqual(ids(3, 2, 1));
      expect(acquire.mock.calls).toEqual(devices.toReversed().map((device) => [device.id]));
      for (const device of devices) establish(device.environmentId);
      await settle();
      const release = vi.mocked(hostedHubController.releaseEnvironment);
      const releasesBefore = release.mock.calls.length;
      acquire.mockClear();

      for (const device of [devices[0]!, devices[2]!, devices[1]!]) await open(device, false);
      closeView();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(acquire).not.toHaveBeenCalled();
      expect(release.mock.calls).toHaveLength(releasesBefore);
      expect(liveEnvironmentIds()).toEqual(ids(1, 2, 3));
    },
  );

  it("does not discover on account pages or after sign-out", async () => {
    history.push("/account");
    history.flush();
    start();
    await settle();
    expect(acquire).not.toHaveBeenCalled();
    hostedHubStore.setState({ accountStatus: "signed-out", account: null });
    history.push("/");
    history.flush();
    await settle();
    expect(acquire).not.toHaveBeenCalled();
  });
});
