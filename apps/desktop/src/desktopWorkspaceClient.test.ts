import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { EnvironmentId, ProjectId, ThreadId, type RelayEffectiveRole } from "@ryco/contracts";
import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import {
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  isWorkspaceMetadataSnapshot,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataCacheRecord,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDesktopWorkspaceMetadataCache } from "./desktopWorkspaceCache.ts";
import {
  createDesktopWorkspaceWarmSetStore,
  type DesktopWorkspaceWarmSetStore,
} from "./desktopWorkspaceWarmSet.ts";
import {
  createDesktopWorkspaceIpcHandlers,
  projectDesktopWorkspaceState,
} from "./desktopWorkspaceIpc.ts";

import {
  DesktopWorkspaceClient,
  type DesktopWorkspaceAccountE2ee,
  type DesktopWorkspaceClientSnapshot,
  type DesktopWorkspaceIdentityStatus,
} from "./desktopWorkspaceClient.ts";

vi.mock("@ryco/client-runtime/state/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/state/workspace")>();
  return {
    ...actual,
    isWorkspaceMetadataSnapshot: vi.fn(actual.isWorkspaceMetadataSnapshot),
    workspaceMetadataPayloadBytes: vi.fn(actual.workspaceMetadataPayloadBytes),
  };
});

function node(
  index: number,
  input: {
    readonly online?: boolean;
    readonly role?: RelayEffectiveRole;
    readonly environmentId?: string;
    readonly lastHeartbeatAt?: number;
  } = {},
): HostedHubNode {
  const role = input.role ?? "owner";
  return {
    id: `node_${String(index).padStart(22, "a")}`,
    environmentId: EnvironmentId.make(input.environmentId ?? `environment-${index}`),
    label: `Node ${index}`,
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant-${index}`, role },
    effectiveRole: role,
    presence: { online: input.online ?? true, lastHeartbeatAt: input.lastHeartbeatAt ?? 1 },
  } as HostedHubNode;
}

function memoryCache(): WorkspaceMetadataCache {
  const records = new Map<string, WorkspaceMetadataCacheRecord>();
  const key = (record: { hubOrigin: string; accountId: string; environmentId: EnvironmentId }) =>
    JSON.stringify(record);
  return {
    load: async (namespace) => records.get(key(namespace)) ?? null,
    list: async ({ hubOrigin, accountId }) =>
      Array.from(records.values()).filter(
        (record) =>
          record.namespace.hubOrigin === hubOrigin && record.namespace.accountId === accountId,
      ),
    replace: async (record) => void records.set(key(record.namespace), record),
    purgeEnvironment: async (namespace) => void records.delete(key(namespace)),
    purgeAccount: async ({ hubOrigin, accountId }) => {
      for (const [recordKey, record] of records) {
        if (record.namespace.hubOrigin === hubOrigin && record.namespace.accountId === accountId) {
          records.delete(recordKey);
        }
      }
    },
  };
}

function snapshot(
  environmentId: EnvironmentId,
  title = "Thread",
  capturedAt = 10,
): WorkspaceMetadataSnapshot {
  return {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt,
    projects: [
      {
        environmentId,
        id: ProjectId.make("colliding-project"),
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
        id: ThreadId.make("colliding-thread"),
        projectId: ProjectId.make("colliding-project"),
        worktreeId: null,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
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

function fixture(
  input: {
    readonly nodes?: HostedHubNode[];
    readonly connect?: (environmentId: EnvironmentId) => Promise<void>;
    readonly trustedNodeIds?: ReadonlySet<string>;
    readonly identityStatus?: DesktopWorkspaceIdentityStatus;
    readonly accountE2ee?: (accountId: string) => DesktopWorkspaceAccountE2ee;
    readonly cache?: WorkspaceMetadataCache;
    readonly warmSet?: DesktopWorkspaceWarmSetStore;
    readonly now?: () => number;
    readonly verification?: {
      readonly begin: (input: {
        readonly accountId: string;
        readonly nodeId: string;
        readonly environmentId: EnvironmentId;
      }) => Promise<{ readonly handle: string }>;
      readonly cancel: (handle: string) => Promise<void>;
      readonly verifyApproval: (input: {
        readonly accountId: string;
        readonly nodeId: string;
        readonly environmentId: EnvironmentId;
        readonly payload: string;
      }) => Promise<void>;
    };
  } = {},
) {
  const nodes = input.nodes ?? [node(1), node(2)];
  const trusted = input.trustedNodeIds ?? new Set(nodes.map((entry) => entry.id));
  let directory = nodes;
  const identityStatus =
    input.identityStatus ??
    ({
      status: "ready",
      accountId: "account-a",
      nodeId: nodes[0]!.id,
      localNodeHandle: "local-handle",
    } satisfies DesktopWorkspaceIdentityStatus);
  const renameNode = vi.fn(async (nodeId: string, label: string) => {
    directory = directory.map((entry) => (entry.id === nodeId ? { ...entry, label } : entry));
  });
  const disconnect = vi.fn(async () => undefined);
  const connectCalls: Array<{ environmentId: EnvironmentId; delayMs: number }> = [];
  const releaseCalls: EnvironmentId[] = [];
  const signIn = vi.fn(async () => identityStatus);
  const client = new DesktopWorkspaceClient({
    hubOrigin: "https://hub.example",
    identity: {
      resume: vi.fn(async () => identityStatus),
      connect: signIn,
      disconnect,
      listNodes: vi.fn(async () => directory),
      renameNode,
      ...(input.accountE2ee === undefined ? {} : { accountE2ee: input.accountE2ee }),
    },
    trust: {
      read: vi.fn(async (_origin, _account, nodeId) => {
        const match = directory.find((entry) => entry.id === nodeId);
        return match && trusted.has(nodeId) ? { environmentId: match.environmentId } : null;
      }),
    },
    cache: input.cache ?? memoryCache(),
    connection: {
      connect: async (request) => {
        connectCalls.push(request);
        await input.connect?.(request.environmentId);
      },
      release: async (environmentId) => void releaseCalls.push(environmentId),
    },
    ...(input.verification ? { verification: input.verification } : {}),
    ...(input.warmSet ? { warmSet: input.warmSet } : {}),
    now:
      input.now ??
      (() => {
        let current = 100;
        return () => ++current;
      })(),
  });
  return {
    client,
    connectCalls,
    releaseCalls,
    disconnect,
    renameNode,
    setDirectory: (next: HostedHubNode[]) => {
      directory = next;
    },
  };
}

describe("DesktopWorkspaceClient", () => {
  it("renames the exact device through bounded IPC and preserves its cached projects and conversations", async () => {
    const { client, renameNode } = fixture({ nodes: [node(1, { online: false }), node(2)] });
    await client.resume();
    const id = node(1).environmentId;
    await client.acceptWorkspaceSnapshot(snapshot(id, "Existing conversation"));
    const before = client.snapshot();
    const handlers = createDesktopWorkspaceIpcHandlers(client);
    const renamed = await handlers.renameDevice({ environmentId: id, label: "  Studio Mac  " });
    expect(renameNode).toHaveBeenCalledExactlyOnceWith(node(1).id, "Studio Mac");
    expect(renamed.machines.find((entry) => entry.environmentId === id)?.label).toBe("Studio Mac");
    expect(client.snapshot().snapshots).toEqual(before.snapshots);
    expect(
      renamed.machines.find((entry) => entry.environmentId === node(2).environmentId)?.label,
    ).toBe("Node 2");
    for (const invalid of [
      null,
      [],
      { environmentId: id, label: " " },
      { environmentId: id, label: "x".repeat(101) },
      { label: "Mac" },
    ]) {
      await expect(handlers.renameDevice(invalid)).rejects.toThrow();
    }
    expect(renameNode).toHaveBeenCalledTimes(1);
  });

  it("rejects device renames for operators, viewers, unknown devices, and signed-out clients", async () => {
    const nodes = [node(1), node(2, { role: "operator" }), node(3, { role: "viewer" })];
    const { client, renameNode } = fixture({ nodes });
    await client.resume();
    for (const id of [
      nodes[1]!.environmentId,
      nodes[2]!.environmentId,
      EnvironmentId.make("unknown"),
    ]) {
      await expect(client.renameDevice(id, "New name")).rejects.toThrow("Only the device owner");
    }
    client.invalidateAccess();
    await expect(client.renameDevice(nodes[0]!.environmentId, "New name")).rejects.toThrow(
      "Sign in",
    );
    expect(renameNode).not.toHaveBeenCalled();
  });

  it("projects exact node roles without promoting operators and removes offline authority", async () => {
    const nodes = [node(1), node(2, { role: "operator" }), node(3, { role: "viewer" })];
    const { client, setDirectory } = fixture({ nodes });
    const state = projectDesktopWorkspaceState(await client.resume());
    expect(state.machines.map((machine) => [machine.effectiveRole, machine.canMutate])).toEqual([
      ["owner", true],
      ["operator", true],
      ["viewer", false],
    ]);
    setDirectory([node(1, { online: false })]);
    expect(projectDesktopWorkspaceState(await client.refreshCatalog()).machines[0]).toMatchObject({
      effectiveRole: null,
      canRename: true,
      canMutate: false,
      canConnect: false,
    });
  });
  it("trusts only the colocated introduction and keeps remote nodes unverified", async () => {
    const nodes = [node(1), node(2)];
    const { client } = fixture({
      nodes,
      trustedNodeIds: new Set([nodes[0]!.id]),
    });
    const state = await client.resume();

    expect(state.catalog.map((entry) => [entry.environmentId, entry.nativeTrust])).toEqual([
      [nodes[0]!.environmentId, "verified"],
      [nodes[1]!.environmentId, "unverified"],
    ]);
    expect(state.catalog[1]?.canReadMetadata).toBe(false);
  });

  it("makes unpinned remote nodes connectable after automatic account enrollment", async () => {
    const nodes = [node(1), node(2)];
    const { client } = fixture({
      nodes,
      trustedNodeIds: new Set([nodes[0]!.id]),
      identityStatus: {
        status: "ready",
        accountId: "account-a",
        nodeId: nodes[0]!.id,
        localNodeHandle: "local-handle",
        accountE2eeReady: true,
      },
    });

    const state = await client.resume();

    expect(state.catalog.map((entry) => [entry.nativeTrust, entry.canConnect])).toEqual([
      ["verified", true],
      ["account-trusted", true],
    ]);
  });

  it("follows the live enrollment, so a retry that succeeds after sign-in trusts remote nodes", async () => {
    const nodes = [node(1), node(2)];
    let accountE2ee: DesktopWorkspaceAccountE2ee = "securing";
    const { client } = fixture({
      nodes,
      trustedNodeIds: new Set([nodes[0]!.id]),
      // Sign-in ended before enrollment did; the one-time status says so.
      accountE2ee: (accountId) => (accountId === "account-a" ? accountE2ee : "unavailable"),
    });

    const securing = await client.resume();
    expect(securing.catalog.map((entry) => entry.nativeTrust)).toEqual(["verified", "unverified"]);
    expect(securing.accountE2ee).toBe("securing");
    expect(projectDesktopWorkspaceState(securing).accountE2ee).toBe("securing");

    accountE2ee = "ready";
    const ready = await client.refreshCatalog();
    expect(ready.catalog.map((entry) => [entry.nativeTrust, entry.canConnect])).toEqual([
      ["verified", true],
      ["account-trusted", true],
    ]);
    expect(projectDesktopWorkspaceState(ready).accountE2ee).toBe("ready");
  });

  it("removes read and mutation readiness synchronously on account revocation", async () => {
    const nodes = [node(1)];
    const { client, releaseCalls } = fixture({ nodes });
    await client.resume();
    await client.retainScope({
      environmentId: nodes[0]!.environmentId,
      scope: { type: "provider-status" },
    });

    const invalidated = client.invalidateAccess();

    expect(invalidated).toMatchObject({
      status: "unavailable",
      accountId: null,
      catalog: [],
      queuedEnvironmentIds: [],
    });
    expect(invalidated.snapshots).toEqual([]);
    expect(releaseCalls).toContain(nodes[0]!.environmentId);
  });

  it("loads cached lists without connecting and connects only when a thread scope opens", async () => {
    const nodes = [node(1)];
    const cache = memoryCache();
    const warm = fixture({ nodes, cache });
    await warm.client.resume();
    await warm.client.acceptWorkspaceSnapshot(snapshot(nodes[0]!.environmentId));

    const restarted = fixture({ nodes, cache });
    const state = await restarted.client.resume();
    expect(state.snapshots.flatMap((entry) => entry.threads)).toHaveLength(1);
    expect(restarted.connectCalls).toEqual([]);

    await restarted.client.retainScope({
      environmentId: nodes[0]!.environmentId,
      scope: {
        type: "thread-detail",
        threadId: ThreadId.make("colliding-thread"),
      },
    });
    expect(restarted.connectCalls).toEqual([
      { environmentId: nodes[0]!.environmentId, delayMs: 0 },
    ]);
  });

  it("keeps colliding local and remote ids scoped to their owning environments", async () => {
    const nodes = [node(1), node(2)];
    const { client } = fixture({ nodes });
    await client.resume();
    await client.acceptWorkspaceSnapshot(snapshot(nodes[0]!.environmentId, "Local"));
    const state = await client.acceptWorkspaceSnapshot(snapshot(nodes[1]!.environmentId, "Remote"));

    expect(
      state.snapshots
        .flatMap((entry) => entry.threads)
        .map((thread) => [thread.environmentId, thread.title]),
    ).toEqual([
      [nodes[0]!.environmentId, "Local"],
      [nodes[1]!.environmentId, "Remote"],
    ]);
  });

  it("holds the absolute ceiling under five nodes with queue, cancellation, and LRU displacement", async () => {
    const nodes = [1, 2, 3, 4, 5].map((index) => node(index));
    const { client, connectCalls, releaseCalls } = fixture({ nodes });
    await client.resume();
    const leases: string[] = [];
    for (const target of nodes) {
      const retained = await client.retainScope({
        environmentId: target.environmentId,
        scope: { type: "provider-status" },
      });
      leases.push(retained.leaseId);
    }

    expect(new Set(connectCalls.map((call) => call.environmentId)).size).toBe(3);
    expect(client.snapshot().demand.connections.filter((entry) => entry.connected)).toHaveLength(3);
    expect(client.snapshot().queuedEnvironmentIds).toHaveLength(2);

    await client.releaseScope(leases[4]!);
    expect(connectCalls.some((call) => call.environmentId === nodes[4]!.environmentId)).toBe(false);
    await client.releaseScope(leases[0]!);
    expect(releaseCalls).toContain(nodes[0]!.environmentId);
    expect(connectCalls.some((call) => call.environmentId === nodes[3]!.environmentId)).toBe(true);
    expect(client.snapshot().demand.connections.filter((entry) => entry.connected)).toHaveLength(3);
  });

  it("releases non-retained connections in background without disturbing retained nodes", async () => {
    const nodes = [node(1), node(2)];
    const { client, releaseCalls } = fixture({ nodes });
    await client.resume();
    const first = await client.retainScope({
      environmentId: nodes[0]!.environmentId,
      scope: { type: "provider-status" },
    });
    await client.retainScope({
      environmentId: nodes[1]!.environmentId,
      scope: { type: "vcs-status", cwd: "/project" },
    });
    await client.releaseScope(first.leaseId);
    await client.setBackgrounded(true);

    expect(releaseCalls).toContain(nodes[0]!.environmentId);
    expect(releaseCalls).not.toContain(nodes[1]!.environmentId);
  });

  it("keeps client sign-out, node removal, and process restarts independent", async () => {
    const nodes = [node(1), node(2)];
    const cache = memoryCache();
    const first = fixture({ nodes, cache });
    await first.client.resume();
    first.setDirectory([nodes[1]!]);
    const afterNodeLeave = await first.client.refreshCatalog();
    expect(afterNodeLeave.status).toBe("ready");
    expect(first.disconnect).not.toHaveBeenCalled();

    const restarted = fixture({ nodes: [nodes[1]!], cache });
    expect((await restarted.client.resume()).status).toBe("ready");
    await restarted.client.signOut();
    expect(restarted.disconnect).toHaveBeenCalledOnce();
    // The lifecycle has no backend/node control port, so sign-out cannot stop or
    // unenroll the colocated node.
    expect(Object.keys(restarted.client)).not.toContain("backend");
  });

  it("fails exact-machine verification closed when node and environment do not match", async () => {
    const nodes = [node(1), node(2)];
    const begin = vi.fn(async () => ({ handle: "verification-handle-1" }));
    const { client } = fixture({
      nodes,
      trustedNodeIds: new Set([nodes[0]!.id]),
      verification: {
        begin,
        cancel: vi.fn(async () => undefined),
        verifyApproval: vi.fn(async () => undefined),
      },
    });
    await client.resume();

    await expect(
      client.beginVerification({
        nodeId: nodes[0]!.id,
        environmentId: nodes[1]!.environmentId,
      }),
    ).rejects.toThrow("does not match");
    expect(begin).not.toHaveBeenCalled();
    await expect(
      client.beginVerification({
        nodeId: nodes[1]!.id,
        environmentId: nodes[1]!.environmentId,
      }),
    ).resolves.toEqual({ handle: "verification-handle-1" });
  });

  it("starts verification for online unverified or account-trusted machines", async () => {
    const nodes = [node(1), node(2), node(3, { online: false })];
    const begin = vi.fn(async () => ({ handle: "verification-handle-1" }));
    const { client } = fixture({
      nodes,
      trustedNodeIds: new Set([nodes[0]!.id]),
      verification: {
        begin,
        cancel: vi.fn(async () => undefined),
        verifyApproval: vi.fn(async () => undefined),
      },
    });
    await client.resume();

    await expect(
      client.beginVerification({
        nodeId: nodes[0]!.id,
        environmentId: nodes[0]!.environmentId,
      }),
    ).rejects.toThrow("not eligible");
    await expect(
      client.beginVerification({
        nodeId: nodes[2]!.id,
        environmentId: nodes[2]!.environmentId,
      }),
    ).rejects.toThrow("not eligible");
    await expect(
      client.beginVerification({
        nodeId: nodes[1]!.id,
        environmentId: nodes[1]!.environmentId,
      }),
    ).resolves.toEqual({ handle: "verification-handle-1" });
    const accountReady = fixture({
      nodes,
      trustedNodeIds: new Set([nodes[0]!.id]),
      identityStatus: {
        status: "ready",
        accountId: "account-a",
        nodeId: nodes[0]!.id,
        localNodeHandle: "local-handle",
        accountE2eeReady: true,
      },
      verification: {
        begin,
        cancel: vi.fn(async () => undefined),
        verifyApproval: vi.fn(async () => undefined),
      },
    });
    await accountReady.client.resume();
    await expect(
      accountReady.client.beginVerification({
        nodeId: nodes[1]!.id,
        environmentId: nodes[1]!.environmentId,
      }),
    ).resolves.toEqual({ handle: "verification-handle-1" });
    expect(begin).toHaveBeenCalledTimes(2);
  });
});

describe("desktop workspace demand serialization", () => {
  it("coalesces concurrent scope retains while a connection is pending", async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const f = fixture({ connect: () => pending });
    await f.client.resume();
    const environmentId = node(2).environmentId;
    const first = f.client.retainScope({ environmentId, scope: { type: "interactive" } });
    await vi.waitFor(() => expect(f.connectCalls).toHaveLength(1));
    const second = f.client.retainScope({ environmentId, scope: { type: "provider-status" } });
    complete();
    await Promise.all([first, second]);
    expect(f.connectCalls).toHaveLength(1);
    expect(f.client.snapshot().demand.leases).toHaveLength(2);
  });

  it("releases a late connection after access is invalidated", async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const f = fixture({ connect: () => pending });
    await f.client.resume();
    const environmentId = node(2).environmentId;
    const retained = f.client.retainScope({ environmentId, scope: { type: "interactive" } });
    await vi.waitFor(() => expect(f.connectCalls).toHaveLength(1));
    f.client.invalidateAccess();
    complete();
    await retained;
    expect(f.releaseCalls).toEqual([environmentId]);
    expect(f.client.snapshot().demand.connections).toEqual([]);
  });

  it("reconnects a reloaded renderer once the gone one is reset", async () => {
    const f = fixture();
    await f.client.resume();
    const environmentId = node(2).environmentId;
    const { leaseId } = await f.client.retainScope({
      environmentId,
      scope: { type: "interactive" },
    });
    expect(f.connectCalls).toHaveLength(1);
    // A reloaded document retains again without releasing or reporting
    // anything. Until main learns the old document is gone, the connection it
    // made counts as standing and no connect command is sent.
    await f.client.retainScope({ environmentId, scope: { type: "interactive" } });
    expect(f.connectCalls).toHaveLength(1);
    await f.client.setBackgrounded(true);
    const catalogBefore = f.client.snapshot().catalog.map((entry) => entry.environmentId);

    const reset = f.client.resetRenderer();

    expect(reset.demand.leases).toEqual([]);
    expect(reset.demand.connections.filter((entry) => entry.connected)).toEqual([]);
    expect(reset.demand.backgrounded).toBe(true);
    expect(reset.status).toBe("ready");
    expect(reset.catalog.map((entry) => entry.environmentId)).toEqual(catalogBefore);
    expect(
      reset.catalog.find((entry) => entry.environmentId === environmentId)?.connectionState,
    ).toBe("disconnected");
    // Nobody is left to receive a release.
    expect(f.releaseCalls).toEqual([]);
    await expect(f.client.renewScope(leaseId)).rejects.toThrow("lease expired");

    await f.client.setBackgrounded(false);
    await f.client.retainScope({ environmentId, scope: { type: "interactive" } });
    expect(f.connectCalls.map((call) => call.environmentId)).toEqual([
      environmentId,
      environmentId,
    ]);
    expect(f.client.snapshot().demand.connections.filter((entry) => entry.connected)).toEqual([
      expect.objectContaining({ environmentId, connected: true }),
    ]);
  });

  it("does not record a connection asked of a renderer that was reset meanwhile", async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let calls = 0;
    const f = fixture({ connect: () => (++calls === 1 ? pending : Promise.resolve()) });
    await f.client.resume();
    const environmentId = node(2).environmentId;
    const first = f.client.retainScope({ environmentId, scope: { type: "interactive" } });
    await vi.waitFor(() => expect(f.connectCalls).toHaveLength(1));
    f.client.resetRenderer();
    complete();
    await first;
    expect(f.client.snapshot().demand.connections.filter((entry) => entry.connected)).toEqual([]);

    await f.client.retainScope({ environmentId, scope: { type: "interactive" } });
    expect(f.connectCalls).toHaveLength(2);
  });

  it("records no connection when no renderer can be asked to make it", async () => {
    let rendererPresent = false;
    const f = fixture({
      connect: async () => {
        if (!rendererPresent) throw new Error("No app window");
      },
    });
    await f.client.resume();
    const environmentId = node(2).environmentId;
    const { leaseId } = await f.client.retainScope({
      environmentId,
      scope: { type: "interactive" },
    });
    expect(f.client.snapshot().demand.connections.filter((entry) => entry.connected)).toEqual([]);
    rendererPresent = true;
    await f.client.renewScope(leaseId);
    expect(f.connectCalls).toHaveLength(2);
    expect(
      f.client.snapshot().demand.connections.find((entry) => entry.environmentId === environmentId)
        ?.connected,
    ).toBe(true);
  });

  it("rejects renewal of a removed lease so the renderer can reacquire demand", async () => {
    const f = fixture();
    await f.client.resume();
    const { leaseId } = await f.client.retainScope({
      environmentId: node(2).environmentId,
      scope: { type: "interactive" },
    });
    await f.client.releaseScope(leaseId);
    await expect(f.client.renewScope(leaseId)).rejects.toThrow("lease expired");
  });
});

describe("desktop workspace publication", () => {
  async function subscribed(input: Parameters<typeof fixture>[0] = {}) {
    const f = fixture(input);
    await f.client.resume();
    const published: DesktopWorkspaceClientSnapshot[] = [];
    f.client.subscribe((state) => void published.push(state));
    return { ...f, published };
  }

  it("publishes nothing for a renewal, focus change, or directory read that alters nothing", async () => {
    const f = await subscribed();
    const { leaseId } = await f.client.retainScope({
      environmentId: node(2).environmentId,
      scope: { type: "interactive" },
    });
    const afterRetain = f.published.length;
    expect(afterRetain).toBeGreaterThan(0);

    await f.client.renewScope(leaseId);
    await f.client.renewScope(leaseId);
    await f.client.setBackgrounded(true);
    await f.client.setBackgrounded(false);

    // Every directory read stamps a later observation time on each machine, and
    // a node's heartbeat moves between reads. Neither changes what a subscriber
    // can observe.
    const timestamps = () =>
      f.client
        .snapshot()
        .catalog.map((entry) => [entry.presence.observedAt, entry.presence.lastSeenAt]);
    for (const lastHeartbeatAt of [2, 3]) {
      const before = timestamps();
      f.setDirectory([node(1, { lastHeartbeatAt }), node(2, { lastHeartbeatAt })]);
      await f.client.refreshCatalog();
      expect(timestamps()).not.toEqual(before);
    }

    expect(f.published).toHaveLength(afterRetain);
  });

  it("publishes a connection change and marks the snapshots it repeats", async () => {
    const f = await subscribed();
    const environmentId = node(1).environmentId;
    await f.client.acceptWorkspaceSnapshot(snapshot(environmentId));
    const [accepted] = f.published.slice(-1);
    expect(accepted?.snapshots).toHaveLength(1);
    expect(accepted?.snapshotsUnchanged).toBeUndefined();

    f.client.reportConnection(environmentId, true);
    const [reported] = f.published.slice(-1);
    expect(reported).not.toBe(accepted);
    expect(reported?.snapshotsUnchanged).toBe(true);
    expect(reported?.snapshots).toHaveLength(1);
    expect(reported?.catalog.find((entry) => entry.environmentId === environmentId)).toMatchObject({
      connectionState: "connected",
    });
  });

  it("publishes a changed snapshot once and an identical one not at all", async () => {
    const f = await subscribed();
    const environmentId = node(1).environmentId;
    await f.client.acceptWorkspaceSnapshot(snapshot(environmentId, "First", 10));
    const afterFirst = f.published.length;

    await f.client.acceptWorkspaceSnapshot(snapshot(environmentId, "First", 10));
    expect(f.published).toHaveLength(afterFirst);

    await f.client.acceptWorkspaceSnapshot(snapshot(environmentId, "Second", 11));
    expect(f.published).toHaveLength(afterFirst + 1);
    const [latest] = f.published.slice(-1);
    expect(latest?.snapshotsUnchanged).toBeUndefined();
    expect(latest?.snapshots[0]?.threads[0]?.title).toBe("Second");
  });

  it("publishes the state that follows a purge or a loss of access", async () => {
    const f = await subscribed();
    const environmentId = node(1).environmentId;
    await f.client.acceptWorkspaceSnapshot(snapshot(environmentId));
    const before = f.published.length;

    await f.client.purgeCache(environmentId);
    expect(f.published).toHaveLength(before + 1);
    expect(f.published.at(-1)?.snapshots).toEqual([]);

    f.client.invalidateAccess();
    expect(f.published).toHaveLength(before + 2);
    expect(f.published.at(-1)).toMatchObject({ status: "unavailable", snapshotsUnchanged: true });
  });

  it("carries only the snapshots of machines whose metadata can be read", async () => {
    const nodes = [node(1), node(2)];
    const cache = memoryCache();
    const warm = fixture({ nodes, cache });
    await warm.client.resume();
    await warm.client.acceptWorkspaceSnapshot(snapshot(nodes[0]!.environmentId));
    await warm.client.acceptWorkspaceSnapshot(snapshot(nodes[1]!.environmentId));
    expect(warm.client.snapshot().snapshots).toHaveLength(2);

    // The second machine is no longer verified, so its cached metadata stays hidden.
    const restarted = fixture({ nodes, cache, trustedNodeIds: new Set([nodes[0]!.id]) });
    const state = await restarted.client.resume();
    expect(state.snapshots.map((entry) => entry.environmentId)).toEqual([nodes[0]!.environmentId]);
    await expect(
      restarted.client.acceptWorkspaceSnapshot(snapshot(nodes[1]!.environmentId)),
    ).rejects.toThrow("not eligible");
  });
});

describe("desktop workspace snapshot intake", () => {
  it("validates and measures a published snapshot once on its way to the cache file", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-desktop-workspace-intake-"));
    const cache = createDesktopWorkspaceMetadataCache(
      Path.join(directory, "desktop-workspace-client", "metadata-v1.json"),
    );
    const validate = vi.mocked(isWorkspaceMetadataSnapshot);
    const measure = vi.mocked(workspaceMetadataPayloadBytes);
    try {
      const f = fixture({ cache });
      await f.client.resume();
      const handlers = createDesktopWorkspaceIpcHandlers(f.client);
      const environmentId = node(1).environmentId;

      for (const [title, capturedAt] of [
        ["First", 10],
        ["Second", 11],
        ["Third", 12],
      ] as const) {
        validate.mockClear();
        measure.mockClear();
        await handlers.publishSnapshot(snapshot(environmentId, title, capturedAt));
        expect(validate).toHaveBeenCalledTimes(1);
        expect(measure).toHaveBeenCalledTimes(1);
      }

      await cache.flush();
      const stored = await cache.load({
        hubOrigin: "https://hub.example",
        accountId: "account-a",
        environmentId,
      });
      expect(stored?.snapshot.threads[0]?.title).toBe("Third");
      expect(stored?.payloadBytes).toBe(
        workspaceMetadataPayloadBytes(snapshot(environmentId, "Third", 12)),
      );
    } finally {
      await cache.dispose();
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("desktop workspace warm restore", () => {
  function memoryWarmSet(initial: ReadonlyArray<EnvironmentId> = []) {
    let stored: {
      readonly hubOrigin: string;
      readonly accountId: string;
      readonly environmentIds: ReadonlyArray<EnvironmentId>;
    } | null =
      initial.length === 0
        ? null
        : { hubOrigin: "https://hub.example", accountId: "account-a", environmentIds: initial };
    const store = {
      read: vi.fn((namespace: { readonly hubOrigin: string; readonly accountId: string }) =>
        stored?.hubOrigin === namespace.hubOrigin && stored.accountId === namespace.accountId
          ? stored.environmentIds
          : [],
      ),
      write: vi.fn(
        (
          namespace: { readonly hubOrigin: string; readonly accountId: string },
          environmentIds: ReadonlyArray<EnvironmentId>,
        ) => {
          stored = { ...namespace, environmentIds };
        },
      ),
      clear: vi.fn(() => {
        stored = null;
      }),
    } satisfies DesktopWorkspaceWarmSetStore;
    return { store, stored: () => stored?.environmentIds ?? null };
  }

  function clock(start = 1_000) {
    let current = start;
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms;
      },
    };
  }

  const ids = (indexes: ReadonlyArray<number>) => indexes.map((index) => node(index).environmentId);
  const connected = (state: DesktopWorkspaceClientSnapshot) =>
    state.demand.connections
      .filter((entry) => entry.connected)
      .map((entry) => entry.environmentId)
      .toSorted();
  const warmLeases = (state: DesktopWorkspaceClientSnapshot) =>
    state.demand.leases.filter((lease) => lease.warm === true).map((lease) => lease.environmentId);

  it("restores the stored warm set once at launch, after both the catalog and the renderer are ready", async () => {
    const warm = memoryWarmSet(ids([2, 3]));
    const nodes = [node(1), node(2), node(3)];
    const f = fixture({ nodes, warmSet: warm.store, now: clock().now });
    await f.client.resume();
    // No document receives connection commands yet.
    expect(f.connectCalls).toEqual([]);

    f.client.attachRenderer();
    await vi.waitFor(() => expect(f.connectCalls).toHaveLength(2));
    expect(f.connectCalls).toEqual([
      { environmentId: node(2).environmentId, delayMs: 0 },
      { environmentId: node(3).environmentId, delayMs: 250 },
    ]);
    expect(warmLeases(f.client.snapshot()).toSorted()).toEqual(ids([2, 3]));
    expect(connected(f.client.snapshot())).toEqual(ids([2, 3]));

    // Catalog refreshes, a second resume and another attach restore nothing again.
    await f.client.refreshCatalog();
    await f.client.resume();
    f.client.attachRenderer();
    await f.client.refreshCatalog();
    expect(f.connectCalls).toHaveLength(2);

    // Renderer attached first: the restore waits for the catalog instead.
    const early = fixture({ nodes, warmSet: memoryWarmSet(ids([3])).store, now: clock().now });
    early.client.attachRenderer();
    expect(early.connectCalls).toEqual([]);
    await early.client.resume();
    expect(early.connectCalls).toEqual([{ environmentId: node(3).environmentId, delayMs: 0 }]);
  });

  it("skips the local, offline, unconnectable and cooling machines and restores at most three", async () => {
    const nodes = [
      node(1),
      node(2, { online: false }),
      node(3),
      node(4),
      node(5),
      node(6),
      node(7),
    ];
    // The port may hold more than the limit; the restore never takes more.
    const warm = memoryWarmSet(ids([1, 2, 3, 4, 5, 6, 7]));
    const f = fixture({
      nodes,
      trustedNodeIds: new Set(nodes.filter((entry) => entry !== nodes[2]).map((entry) => entry.id)),
      warmSet: warm.store,
      now: clock().now,
    });
    f.client.attachRenderer();
    const state = await f.client.resume();
    expect(state.localEnvironmentId).toBe(node(1).environmentId);
    expect(f.connectCalls.map((call) => call.environmentId)).toEqual(ids([4, 5, 6]));
    expect(connected(f.client.snapshot())).toEqual(ids([4, 5, 6]));
    expect(f.client.snapshot().queuedEnvironmentIds).toEqual([]);
  });

  it("never displaces a mounted scope and takes only free slots", async () => {
    const nodes = [node(1), node(2), node(3), node(4)];
    const warm = memoryWarmSet(ids([4]));
    const f = fixture({ nodes, warmSet: warm.store, now: clock().now });
    await f.client.resume();
    // The local machine and two remote ones fill every slot.
    for (const index of [1, 2, 3]) {
      await f.client.retainScope({
        environmentId: node(index).environmentId,
        scope: { type: "thread-detail", threadId: ThreadId.make(`thread-${index}`) },
      });
    }
    // The local machine is reached directly and never joins the warm set.
    expect(warm.stored()).toEqual(ids([3, 2, 4]));
    f.connectCalls.length = 0;

    f.client.attachRenderer();
    await vi.waitFor(() => expect(warmLeases(f.client.snapshot())).toHaveLength(3));
    expect(f.connectCalls).toEqual([]);
    expect(f.releaseCalls).toEqual([]);
    expect(connected(f.client.snapshot())).toEqual(ids([1, 2, 3]));
    // A warm machine waiting for a slot is not shown as queued.
    expect(f.client.snapshot().queuedEnvironmentIds).toEqual([]);

    // A warm connection yields to a mounted view that needs its slot.
    const later = fixture({ nodes, warmSet: memoryWarmSet(ids([4])).store, now: clock().now });
    later.client.attachRenderer();
    await later.client.resume();
    expect(connected(later.client.snapshot())).toEqual(ids([4]));
    for (const index of [1, 2, 3]) {
      await later.client.retainScope({
        environmentId: node(index).environmentId,
        scope: { type: "interactive" },
      });
    }
    expect(later.releaseCalls).toEqual(ids([4]));
    expect(connected(later.client.snapshot())).toEqual(ids([1, 2, 3]));
    expect(later.client.snapshot().queuedEnvironmentIds).toEqual([]);
  });

  it("restores again after a return from the background and after a renderer reset", async () => {
    const f = fixture({ warmSet: memoryWarmSet(ids([2])).store, now: clock().now });
    f.client.attachRenderer();
    await f.client.resume();
    expect(f.connectCalls.map((call) => call.environmentId)).toEqual(ids([2]));

    await f.client.setBackgrounded(true);
    expect(f.releaseCalls).toEqual(ids([2]));
    expect(warmLeases(f.client.snapshot())).toEqual([]);
    // Nothing returns while backgrounded.
    await f.client.refreshCatalog();
    expect(f.connectCalls).toHaveLength(1);

    await f.client.setBackgrounded(false);
    expect(f.connectCalls.map((call) => call.environmentId)).toEqual(ids([2, 2]));
    // Only a return from the background owes a restore.
    await f.client.setBackgrounded(false);
    expect(f.connectCalls).toHaveLength(2);

    f.client.resetRenderer();
    await f.client.refreshCatalog();
    // The reloaded document has not started its bridge yet.
    expect(f.connectCalls).toHaveLength(2);
    f.client.attachRenderer();
    await vi.waitFor(() => expect(f.connectCalls).toHaveLength(3));
    expect(f.connectCalls[2]?.environmentId).toBe(node(2).environmentId);

    // A document reloaded while backgrounded gets its warm machines on the return.
    await f.client.setBackgrounded(true);
    f.client.resetRenderer();
    f.client.attachRenderer();
    await f.client.refreshCatalog();
    expect(f.connectCalls).toHaveLength(3);
    await f.client.setBackgrounded(false);
    expect(f.connectCalls).toHaveLength(4);
  });

  it("gives a warm machine one attempt and passes it over for the cooldown unless it is used", async () => {
    const time = clock();
    let failing = true;
    const f = fixture({
      nodes: [node(1), node(2), node(3)],
      warmSet: memoryWarmSet(ids([2, 3])).store,
      now: time.now,
      connect: async (environmentId) => {
        if (failing && environmentId === node(2).environmentId) throw new Error("unreachable");
      },
    });
    f.client.attachRenderer();
    await f.client.resume();
    expect(f.connectCalls.map((call) => call.environmentId)).toEqual(ids([2, 3]));
    expect(warmLeases(f.client.snapshot())).toEqual(ids([3]));
    failing = false;

    const restored = async () => {
      f.connectCalls.length = 0;
      await f.client.setBackgrounded(true);
      await f.client.setBackgrounded(false);
      return f.connectCalls.map((call) => call.environmentId);
    };
    expect(await restored()).toEqual(ids([3]));
    time.advance(300_000);
    expect(await restored()).toEqual(ids([2, 3]));

    // The renderer could not connect it, or lost it: released, and cooling again.
    f.releaseCalls.length = 0;
    f.client.reportConnection(node(2).environmentId, false);
    expect(f.releaseCalls).toEqual(ids([2]));
    expect(warmLeases(f.client.snapshot())).toEqual(ids([3]));
    expect(await restored()).toEqual(ids([3]));

    // Using the machine ends its cooldown.
    const { leaseId } = await f.client.retainScope({
      environmentId: node(2).environmentId,
      scope: { type: "interactive" },
    });
    await f.client.releaseScope(leaseId);
    expect(await restored()).toEqual(ids([2, 3]));
  });

  it("releases a warm-only machine whose relay dropped instead of letting it reconnect", async () => {
    const f = fixture({
      nodes: [node(1), node(2), node(3)],
      warmSet: memoryWarmSet(ids([2, 3])).store,
      now: clock().now,
    });
    f.client.attachRenderer();
    await f.client.resume();
    await f.client.retainScope({
      environmentId: node(3).environmentId,
      scope: { type: "interactive" },
    });

    f.client.reportTransportLost(node(3).environmentId);
    expect(f.releaseCalls).toEqual([]);

    const state = f.client.reportTransportLost(node(2).environmentId);
    expect(f.releaseCalls).toEqual(ids([2]));
    expect(connected(state)).toEqual(ids([3]));
    expect(warmLeases(state)).toEqual(ids([3]));
  });

  it("forgets and deletes the warm set on sign-out and revocation, and per account", async () => {
    const warm = memoryWarmSet(ids([2]));
    const f = fixture({ warmSet: warm.store, now: clock().now });
    f.client.attachRenderer();
    await f.client.resume();
    expect(warmLeases(f.client.snapshot())).toEqual(ids([2]));

    await f.client.signOut();
    expect(warm.store.clear).toHaveBeenCalledOnce();
    expect(warm.stored()).toBeNull();
    expect(f.client.snapshot().demand.leases).toEqual([]);

    // Signed in again, nothing is left to restore, and use starts a new list.
    f.connectCalls.length = 0;
    await f.client.connectIdentity();
    await f.client.setBackgrounded(true);
    await f.client.setBackgrounded(false);
    expect(f.connectCalls).toEqual([]);
    await f.client.retainScope({
      environmentId: node(2).environmentId,
      scope: { type: "interactive" },
    });
    expect(warm.stored()).toEqual(ids([2]));

    f.client.invalidateAccess();
    expect(warm.store.clear).toHaveBeenCalledTimes(2);
    expect(warm.stored()).toBeNull();

    // Another account on the same Hub reads no list of the first one.
    const other = memoryWarmSet(ids([2]));
    const g = fixture({
      warmSet: other.store,
      now: clock().now,
      identityStatus: {
        status: "ready",
        accountId: "account-b",
        nodeId: node(1).id,
        localNodeHandle: null,
      },
    });
    g.client.attachRenderer();
    await g.client.resume();
    expect(g.connectCalls).toEqual([]);
  });

  it("remembers the warm set across launches in an owner-only file", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-desktop-workspace-warm-"));
    const filePath = Path.join(directory, "desktop-workspace-client", "warm-set-v1.json");
    try {
      const nodes = [node(1), node(2), node(3), node(4)];
      const first = fixture({
        nodes,
        warmSet: createDesktopWorkspaceWarmSetStore(filePath),
        now: clock().now,
      });
      await first.client.resume();
      for (const index of [4, 3, 1, 2]) {
        await first.client.retainScope({
          environmentId: node(index).environmentId,
          scope: { type: "interactive" },
        });
      }
      if (process.platform !== "win32") {
        expect(FS.statSync(filePath).mode & 0o777).toBe(0o600);
      }
      expect(JSON.parse(FS.readFileSync(filePath, "utf8"))).toEqual({
        version: 1,
        hubOrigin: "https://hub.example",
        accountId: "account-a",
        environmentIds: ids([2, 3, 4]),
      });

      const relaunched = fixture({
        nodes,
        warmSet: createDesktopWorkspaceWarmSetStore(filePath),
        now: clock().now,
      });
      relaunched.client.attachRenderer();
      await relaunched.client.resume();
      expect(relaunched.connectCalls).toEqual([
        { environmentId: node(2).environmentId, delayMs: 0 },
        { environmentId: node(3).environmentId, delayMs: 250 },
        { environmentId: node(4).environmentId, delayMs: 500 },
      ]);

      const store = createDesktopWorkspaceWarmSetStore(filePath);
      expect(store.read({ hubOrigin: "https://HUB.example/", accountId: "account-a" })).toEqual(
        ids([2, 3, 4]),
      );
      expect(store.read({ hubOrigin: "https://hub.example", accountId: "account-b" })).toEqual([]);
      expect(store.read({ hubOrigin: "https://other.example", accountId: "account-a" })).toEqual(
        [],
      );

      await relaunched.client.signOut();
      expect(FS.existsSync(filePath)).toBe(false);

      FS.mkdirSync(Path.dirname(filePath), { recursive: true });
      FS.writeFileSync(filePath, "{not json");
      expect(store.read({ hubOrigin: "https://hub.example", accountId: "account-a" })).toEqual([]);
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
