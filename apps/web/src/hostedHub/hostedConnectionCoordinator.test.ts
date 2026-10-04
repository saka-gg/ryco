import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import {
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCache,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedBrowserStatus, HostedHubNode } from "@ryco/client-runtime/authorization";

import {
  MAX_HOSTED_WEB_CONNECTIONS,
  createHostedConnectionCoordinator,
  hostedDemandUnblocked,
  readHostedDemandReadiness,
  startHostedWorkspaceCoordinator,
} from "./hostedConnectionCoordinator";
import { createHostedWebScopeStore, hostedWebConnectionScopes } from "./hostedConnectionScopes";
import { hostedHubController, hostedHubStore } from "./state";

const environment = (index: number) => EnvironmentId.make(`env_${String(index).padStart(22, "0")}`);
const thread = (index: number) => ThreadId.make(`thread_${String(index)}`);

function harness() {
  let now = 1;
  const connected = new Set<EnvironmentId>();
  const connects: Array<{ environmentId: EnvironmentId; delayMs: number }> = [];
  const releases: EnvironmentId[] = [];
  const scopes = createHostedWebScopeStore();
  const coordinator = createHostedConnectionCoordinator({
    scopes,
    now: () => now,
    connect: async (environmentId, delayMs) => {
      connects.push({ environmentId, delayMs });
      connected.add(environmentId);
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
