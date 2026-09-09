import { EnvironmentId, ProjectId, ThreadId, type RelayEffectiveRole } from "@ryco/contracts";
import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import {
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  type WorkspaceMetadataCache,
  type WorkspaceMetadataCacheRecord,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { describe, expect, it, vi } from "vite-plus/test";
import { projectDesktopWorkspaceState } from "./desktopWorkspaceIpc.ts";

import {
  DesktopWorkspaceClient,
  type DesktopWorkspaceIdentityStatus,
} from "./desktopWorkspaceClient.ts";

function node(
  index: number,
  input: {
    readonly online?: boolean;
    readonly role?: RelayEffectiveRole;
    readonly environmentId?: string;
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
    presence: { online: input.online ?? true, lastHeartbeatAt: 1 },
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

function snapshot(environmentId: EnvironmentId, title = "Thread"): WorkspaceMetadataSnapshot {
  return {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt: 10,
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
    readonly trustedNodeIds?: ReadonlySet<string>;
    readonly identityStatus?: DesktopWorkspaceIdentityStatus;
    readonly cache?: WorkspaceMetadataCache;
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
  const disconnect = vi.fn(async () => undefined);
  const connectCalls: Array<{ environmentId: EnvironmentId; delayMs: number }> = [];
  const releaseCalls: EnvironmentId[] = [];
  const client = new DesktopWorkspaceClient({
    hubOrigin: "https://hub.example",
    identity: {
      resume: vi.fn(async () => identityStatus),
      connect: vi.fn(async () => identityStatus),
      disconnect,
      listNodes: vi.fn(async () => directory),
    },
    trust: {
      read: vi.fn(async (_origin, _account, nodeId) => {
        const match = directory.find((entry) => entry.id === nodeId);
        return match && trusted.has(nodeId) ? { environmentId: match.environmentId } : null;
      }),
    },
    cache: input.cache ?? memoryCache(),
    connection: {
      connect: async (request) => void connectCalls.push(request),
      release: async (environmentId) => void releaseCalls.push(environmentId),
    },
    ...(input.verification ? { verification: input.verification } : {}),
    now: (() => {
      let current = 100;
      return () => ++current;
    })(),
  });
  return {
    client,
    connectCalls,
    releaseCalls,
    disconnect,
    setDirectory: (next: HostedHubNode[]) => {
      directory = next;
    },
  };
}

describe("DesktopWorkspaceClient", () => {
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
    expect(invalidated.workspace.machines).toEqual([]);
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
    expect(state.workspace.threads).toHaveLength(1);
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

    expect(state.workspace.threads.map((thread) => [thread.environmentId, thread.title])).toEqual([
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
