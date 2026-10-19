import { EnvironmentId, ProjectId, ThreadId, WorktreeId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { reconcileWorkspaceMachine } from "./machineCatalog.js";
import {
  boundWorkspaceMetadataSnapshot,
  decodeWorkspaceMetadataSnapshot,
  isWorkspaceMetadataSnapshot,
  planWorkspaceMetadataCacheEvictions,
  reconcileWorkspaceCacheForMachine,
  reconcileWorkspaceMetadataSnapshot,
  workspaceMetadataPayloadBytes,
} from "./metadataSnapshot.js";
import {
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  type WorkspaceMetadataCacheRecord,
  type WorkspaceMetadataSnapshot,
} from "./types.js";

function snapshot(environment: string, capturedAt = 1): WorkspaceMetadataSnapshot {
  const environmentId = EnvironmentId.make(environment);
  const projectId = ProjectId.make("project");
  const worktreeId = WorktreeId.make("worktree");
  return {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt,
    projects: [
      {
        environmentId,
        id: projectId,
        name: "Ryco",
        cwd: "/ryco",
        repositoryIdentity: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    worktrees: [
      {
        environmentId,
        id: worktreeId,
        projectId,
        title: null,
        branch: "main",
        worktreePath: "/ryco",
        workItemLabel: null,
        pullRequestNumber: null,
        archivedAt: null,
        updatedAt: "2026-08-23T00:00:00.000Z",
      },
    ],
    threads: [
      {
        environmentId,
        id: ThreadId.make("thread"),
        projectId,
        worktreeId,
        title: "Thread",
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
        archivedAt: null,
        modelSelection: null,
        providerDriver: null,
        branch: "main",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        deliveryUnknown: false,
      },
    ],
  };
}

function record(
  environment: string,
  updatedAt: number,
  payloadBytes = 10,
): WorkspaceMetadataCacheRecord {
  const value = snapshot(environment, updatedAt);
  return {
    namespace: {
      hubOrigin: "https://hub.example",
      accountId: "account",
      environmentId: value.environmentId,
    },
    snapshot: value,
    payloadBytes,
    updatedAt,
  };
}

describe("workspace metadata snapshots", () => {
  it("strictly validates version, embedded environment, parents, and scoped ids", () => {
    const value = snapshot("a");
    expect(isWorkspaceMetadataSnapshot(value, value.environmentId)).toBe(true);
    expect(decodeWorkspaceMetadataSnapshot(JSON.stringify(value), value.environmentId)).toEqual(
      value,
    );
    expect(
      decodeWorkspaceMetadataSnapshot(JSON.stringify(value), EnvironmentId.make("b")),
    ).toBeNull();
    expect(
      isWorkspaceMetadataSnapshot({
        ...value,
        threads: [{ ...value.threads[0], projectId: ProjectId.make("missing") }],
      }),
    ).toBe(false);
    expect(isWorkspaceMetadataSnapshot({ ...value, schemaVersion: 2 })).toBe(false);
  });

  it("preserves the last complete snapshot across partial, corrupt, and older refreshes", () => {
    const current = snapshot("a", 10);
    expect(
      reconcileWorkspaceMetadataSnapshot(
        current,
        { environmentId: current.environmentId },
        current.environmentId,
      ),
    ).toEqual({ snapshot: current, replaced: false });
    expect(
      reconcileWorkspaceMetadataSnapshot(current, snapshot("a", 9), current.environmentId),
    ).toEqual({ snapshot: current, replaced: false });
    const next = snapshot("a", 11);
    expect(reconcileWorkspaceMetadataSnapshot(current, next, current.environmentId)).toEqual({
      snapshot: next,
      replaced: true,
    });
  });

  it("bounds thread metadata without dropping projects or worktrees", () => {
    const value = snapshot("a");
    const threads = Array.from({ length: 8 }, (_, index) => ({
      ...value.threads[0]!,
      id: ThreadId.make(`thread-${index}`),
      archivedAt: index < 4 ? "2026-08-23T00:00:00.000Z" : null,
      updatedAt: `2026-08-23T00:00:0${index}.000Z`,
    }));
    const bounded = boundWorkspaceMetadataSnapshot(
      { ...value, threads },
      { maxThreads: 4, maxPayloadBytes: Number.MAX_SAFE_INTEGER },
    );
    expect(bounded.projects).toEqual(value.projects);
    expect(bounded.worktrees).toEqual(value.worktrees);
    expect(bounded.threads).toHaveLength(4);
    expect(bounded.threads.every((thread) => thread.archivedAt === null)).toBe(true);
  });

  it("plans deterministic per-account count and byte eviction", () => {
    const first = record("a", 1, 40);
    const second = record("b", 2, 40);
    const incoming = record("c", 3, 40);
    expect(
      planWorkspaceMetadataCacheEvictions({
        existing: [second, first],
        incoming,
        maxEntries: 2,
        maxBytes: 80,
      }),
    ).toEqual({ accepted: true, evict: [first.namespace] });
    expect(
      planWorkspaceMetadataCacheEvictions({
        existing: [],
        incoming: { ...incoming, payloadBytes: 81 },
        maxEntries: 2,
        maxBytes: 80,
      }),
    ).toEqual({ accepted: false, evict: [] });
    expect(workspaceMetadataPayloadBytes(snapshot("a"))).toBeGreaterThan(0);
  });

  describe("payload bytes", () => {
    const encodedBytes = (value: WorkspaceMetadataSnapshot) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength;

    it("matches the encoded serialization", () => {
      const value = snapshot("a");
      expect(workspaceMetadataPayloadBytes(value)).toBe(encodedBytes(value));
      const empty = { ...value, projects: [], worktrees: [], threads: [] };
      expect(workspaceMetadataPayloadBytes(empty)).toBe(encodedBytes(empty));
      const multibyte = {
        ...value,
        projects: [{ ...value.projects[0]!, name: "Projekt üß 日本語 🚀 \ud800" }],
        threads: [{ ...value.threads[0]!, title: 'quote " slash \\ newline \n', branch: null }],
      };
      expect(workspaceMetadataPayloadBytes(multibyte)).toBe(encodedBytes(multibyte));
    });

    it("accounts for fixed fields, their order and extra properties", () => {
      const value = snapshot("a");
      const reordered = {
        capturedAt: 1_700_000_000_000,
        threads: value.threads,
        environmentId: value.environmentId,
        projects: value.projects,
        schemaVersion: value.schemaVersion,
        worktrees: value.worktrees,
        note: "extra",
        omitted: undefined,
      } as unknown as WorkspaceMetadataSnapshot;
      expect(workspaceMetadataPayloadBytes(reordered)).toBe(encodedBytes(reordered));
    });

    it("follows a changed capture time while the member arrays are reused", () => {
      const value = snapshot("a", 9);
      const initial = workspaceMetadataPayloadBytes(value);
      const later = { ...value, capturedAt: 1_700_000_000_000 };
      expect(workspaceMetadataPayloadBytes(later)).toBe(encodedBytes(later));
      expect(workspaceMetadataPayloadBytes(later)).toBeGreaterThan(initial);
      const grown = { ...later, threads: [...later.threads, ...later.threads] };
      expect(workspaceMetadataPayloadBytes(grown)).toBe(encodedBytes(grown));
    });

    it("measures reused arrays and repeated snapshots only once", () => {
      const value = snapshot("a");
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        const first = workspaceMetadataPayloadBytes(value);
        const afterFirst = stringify.mock.calls.length;
        expect(workspaceMetadataPayloadBytes(value)).toBe(first);
        expect(stringify.mock.calls.length).toBe(afterFirst);

        const next = { ...value, capturedAt: value.capturedAt + 1 };
        workspaceMetadataPayloadBytes(next);
        const serialized = stringify.mock.calls.slice(afterFirst).map(([argument]) => argument);
        expect(serialized).toHaveLength(1);
        expect(serialized[0]).not.toBe(value.threads);
        expect(serialized[0]).toMatchObject({ projects: 0, worktrees: 0, threads: 0 });
      } finally {
        stringify.mockRestore();
      }
    });
  });

  it("maps machine eligibility to retain, lock, and purge cache actions", () => {
    const base = {
      environmentId: EnvironmentId.make("a"),
      label: "A",
      clientTier: "native" as const,
      requiresNativeVerification: true,
      effectiveRole: "operator" as const,
      online: true,
      lastSeenAt: null,
      observedAt: 1,
    };
    expect(
      reconcileWorkspaceCacheForMachine(
        reconcileWorkspaceMachine({ ...base, nativeTrust: "verified" }),
      ),
    ).toEqual({ type: "retain" });
    expect(
      reconcileWorkspaceCacheForMachine(
        reconcileWorkspaceMachine({ ...base, nativeTrust: "identity-conflict" }),
      ),
    ).toEqual({ type: "lock-stale" });
    expect(
      reconcileWorkspaceCacheForMachine(
        reconcileWorkspaceMachine({ ...base, nativeTrust: "unverified" }),
      ),
    ).toEqual({ type: "purge" });
  });
});
