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
import { hostedHubController, hostedHubStore } from "./state";
import { hostedWebConnectionScopes } from "./hostedConnectionScopes";
import { installHostedNodeHistory, resetHostedNodeRoutesForTests } from "./nodeRoutes";
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
let select: MockInstance<typeof hostedHubController.selectNode>;
let history: ReturnType<typeof installHostedNodeHistory>;
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  hostedHubController.resetForTests();
  resetHostedNodeRoutesForTests();
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
  select = vi.spyOn(hostedHubController, "selectNode").mockImplementation(async (id) => {
    hostedHubStore.setState({
      selectedNode: nodes.find((entry) => entry.id === id) ?? node(3),
      transportStatus: "connecting",
      sessionEstablished: false,
    });
  });
  vi.spyOn(hostedHubController, "returnToDirectory").mockImplementation(async () => {
    const environmentId = hostedHubStore.getState().selectedNode?.environmentId;
    if (environmentId)
      useStore.getState().demoteEnvironmentStateToCachedSnapshot(environmentId, Date.now());
    hostedHubStore.setState({
      selectedNode: null,
      transportStatus: "idle",
      sessionEstablished: false,
    });
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  resetHostedNodeRoutesForTests();
  hostedHubController.resetForTests();
  hostedWebConnectionScopes.reset();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function start() {
  stop = startHostedWorkspaceCoordinator({
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
  hostedHubStore.setState({ transportStatus: "online", sessionEstablished: true });
  await vi.advanceTimersByTimeAsync(110);
  await settle();
}

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
    expect(select.mock.calls).toEqual([[nodes[0]!.id]]);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBe(nodes[0]!.environmentId);
    await complete(nodes[0]!.environmentId);
    expect(select.mock.calls).toEqual([[nodes[0]!.id], [nodes[1]!.id]]);
    await complete(nodes[1]!.environmentId);
    expect(selectSidebarThreadsAcrossEnvironments(useStore.getState())).toHaveLength(2);
    expect(readHostedWorkspaceState().workspace.threads).toHaveLength(2);
    expect(readHostedWorkspaceState().homeDiscovery.environmentId).toBeNull();
    expect(history.location.pathname).toBe("/");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(select).toHaveBeenCalledTimes(2);
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
    expect(select.mock.calls).toEqual([[nodes[1]!.id]]);
    await complete(nodes[1]!.environmentId, true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(select).toHaveBeenCalledTimes(1);
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
    hostedHubStore.setState({ transportStatus: "online", sessionEstablished: true });

    for (let index = 0; index < 10; index++) {
      await vi.advanceTimersByTimeAsync(20);
      useStore.setState((state) => ({ environmentStateById: { ...state.environmentStateById } }));
    }
    await settle();

    expect(select.mock.calls).toEqual([[nodes[0]!.id], [nodes[1]!.id]]);
    expect(readHostedWorkspaceState().workspace.threads).toHaveLength(1);
  });

  it("moves past a failed device and supports an explicit retry", async () => {
    start();
    await settle();
    hostedHubStore.setState({ transportStatus: "terminal-failure" });
    await settle();
    expect(select.mock.calls).toEqual([[nodes[0]!.id], [nodes[1]!.id]]);
    expect(readHostedWorkspaceState().homeDiscovery.failedEnvironmentIds).toEqual([
      nodes[0]!.environmentId,
    ]);
    await complete(nodes[1]!.environmentId);
    retryHostedHomeDiscovery();
    await settle();
    expect(select.mock.calls.at(-1)).toEqual([nodes[0]!.id]);
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
    expect(select.mock.calls).toEqual([[nodes[0]!.id], [node(3).id]]);
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
    expect(select).toHaveBeenCalledTimes(1);
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
    expect(select).not.toHaveBeenCalled();
    hostedHubStore.setState({ nodes: [...nodes] });
    await settle();
    resolve?.(cached);
    await settle();
    expect(readHostedWorkspaceState().workspace.threads).toHaveLength(1);
    expect(select.mock.calls).toEqual([[nodes[1]!.id]]);
  });

  it("does not discover on account pages or after sign-out", async () => {
    history.push("/account");
    history.flush();
    start();
    await settle();
    expect(select).not.toHaveBeenCalled();
    hostedHubStore.setState({ accountStatus: "signed-out", account: null });
    history.push("/");
    history.flush();
    await settle();
    expect(select).not.toHaveBeenCalled();
  });
});
