import type { HostedHubNode, HostedHubState } from "@ryco/client-runtime/authorization";
import type { EnvironmentId, OrchestrationShellSnapshot } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));

import {
  getCachedHubNodeRoster,
  resetCachedHubNodeRosterForTests,
  setCachedHubNodeRoster,
  type CachedHubNodeRecord,
} from "../hostedHub/nodeRoster";
import { useStore } from "../state/threadsRuntime";
import {
  boundStoredEnvironmentSnapshot,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
  type StoredEnvironmentSnapshot,
} from "./environmentSnapshotCodec";
import { createSnapshotPersistenceRuntime } from "./environmentSnapshotPersistence";
import { payloadByteLength, type SnapshotDb } from "./snapshotDb";

function createFakeSnapshotDb() {
  const snapshots = new Map<
    string,
    { schemaVersion: number; payload: string; updatedAt: number }
  >();
  let roster: { schemaVersion: number; payload: string } | null = null;
  const db: SnapshotDb = {
    loadEnvironmentSnapshot: async (environmentId) => {
      const row = snapshots.get(environmentId);
      return row ? { schemaVersion: row.schemaVersion, payload: row.payload } : null;
    },
    saveEnvironmentSnapshot: async (input) => {
      snapshots.set(input.environmentId, {
        schemaVersion: input.schemaVersion,
        payload: input.payload,
        updatedAt: input.updatedAt,
      });
    },
    removeEnvironmentSnapshot: async (environmentId) => {
      snapshots.delete(environmentId);
    },
    listEnvironmentSnapshotStats: async () =>
      [...snapshots.entries()].map(([environmentId, row]) => ({
        environmentId,
        payloadBytes: payloadByteLength(row.payload),
        updatedAt: row.updatedAt,
      })),
    loadHubNodeRoster: async () => roster,
    saveHubNodeRoster: async (input) => {
      roster = { schemaVersion: input.schemaVersion, payload: input.payload };
    },
    clearAll: async () => {
      snapshots.clear();
      roster = null;
    },
  };
  return { db, snapshots, getRoster: () => roster };
}

function wireSnapshot(projectId: string): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: projectId,
        title: `Project ${projectId}`,
        workspaceRoot: `/${projectId}`,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        scripts: [],
      },
    ],
    worktrees: [],
    threads: [],
    updatedAt: "2026-08-20T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
}

function storedRecord(environmentId: EnvironmentId): StoredEnvironmentSnapshot {
  return {
    schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt: 1_000,
    projects: [
      {
        id: "project-1" as never,
        environmentId,
        name: "Cached project",
        cwd: "/cached",
        defaultModelSelection: null,
        scripts: [],
      },
    ],
    worktrees: [],
    threads: [],
  };
}

function hubNode(input: {
  readonly nodeId: string;
  readonly environmentId: EnvironmentId;
  readonly revokedAt?: number | null;
  readonly online?: boolean;
}): HostedHubNode {
  return {
    id: input.nodeId,
    environmentId: input.environmentId,
    label: `Node ${input.nodeId}`,
    effectiveRole: "operator",
    revokedAt: input.revokedAt ?? null,
    lastAuthenticatedAt: 500,
    presence: { online: input.online ?? false, lastHeartbeatAt: 900 },
  } as never;
}

function rosterRecord(node: HostedHubNode, observedAt: number): CachedHubNodeRecord {
  return {
    nodeId: node.id,
    environmentId: node.environmentId,
    label: node.label,
    effectiveRole: node.effectiveRole,
    revokedAt: node.revokedAt,
    presenceOnline: node.presence.online,
    lastHeartbeatAt: node.presence.lastHeartbeatAt,
    lastAuthenticatedAt: node.lastAuthenticatedAt,
    observedAt,
  };
}

function createFakeHostedStore(initial: Partial<HostedHubState>) {
  let state = { directoryStatus: "idle", nodes: [] as ReadonlyArray<HostedHubNode>, ...initial };
  const listeners = new Set<() => void>();
  return {
    getState: () => state as HostedHubState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    patch: (next: Partial<HostedHubState>) => {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

const usedEnvironmentIds: EnvironmentId[] = [];
function env(id: string): EnvironmentId {
  const environmentId = id as EnvironmentId;
  usedEnvironmentIds.push(environmentId);
  return environmentId;
}

describe("environment snapshot persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetCachedHubNodeRosterForTests();
    for (const environmentId of usedEnvironmentIds.splice(0)) {
      useStore.getState().removeEnvironmentState(environmentId);
    }
  });

  it("captures a settled environment on markDirty, debounced", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1_755_000_000_000,
      hasDirectEnvironment: () => true,
    });
    const environmentId = env("persist-capture");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("project-live"), environmentId);

    runtime.markDirty(environmentId);
    await vi.advanceTimersByTimeAsync(499);
    expect(snapshots.size).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(snapshots.size).toBe(1);
    const payload = snapshots.get(environmentId)?.payload ?? "";
    expect(JSON.parse(payload)).toMatchObject({
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      environmentId,
      projects: [{ name: "Project project-live" }],
    });
    runtime.dispose();
  });

  it("clears after an in-flight write and cancels a pending debounced capture", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = db.saveEnvironmentSnapshot;
    const started = vi.fn();
    const runtime = createSnapshotPersistenceRuntime({
      db: {
        ...db,
        saveEnvironmentSnapshot: async (input) => {
          started();
          await barrier;
          await save(input);
        },
      },
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const id = env("clear-during-write");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("live"), id);
    const capture = runtime.capture(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveBeenCalledOnce();
    runtime.markDirty(id);
    const clearing = runtime.purgeEnvironment(id);
    release();
    await Promise.all([capture, clearing]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshots.has(id)).toBe(false);
    expect(useStore.getState().environmentStateById[id]?.bootstrapComplete).toBe(true);
    runtime.dispose();
  });

  it("never captures an unsettled or cache-provenance environment", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const hydratedId = env("persist-hydrated");
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        { capturedAt: 1, projects: [], worktrees: [], threads: [] },
        hydratedId,
      );
    const unknownId = env("persist-unknown");

    runtime.markDirty(hydratedId);
    runtime.markDirty(unknownId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshots.size).toBe(0);
    runtime.dispose();
  });

  it("hydrates cached environments on cold start and discards a bumped schema version", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const goodId = env("persist-good");
    const bumpedId = env("persist-bumped");
    await db.saveEnvironmentSnapshot({
      environmentId: goodId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      payload: boundStoredEnvironmentSnapshot(storedRecord(goodId)).payload,
      updatedAt: 1,
    });
    await db.saveEnvironmentSnapshot({
      environmentId: bumpedId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION + 1,
      payload: JSON.stringify({
        ...storedRecord(bumpedId),
        schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION + 1,
      }),
      updatedAt: 2,
    });

    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
    });
    await runtime.hydrate();

    const state = useStore.getState();
    expect(state.environmentStateById[goodId]?.projectIds).toHaveLength(1);
    expect(state.environmentStateById[goodId]?.hydratedFromCacheAt).toBe(1_000);
    expect(state.environmentStateById[goodId]?.bootstrapComplete).toBe(false);
    // The bumped record is discarded rather than mis-decoded, and its row dropped.
    expect(state.environmentStateById[bumpedId]).toBeUndefined();
    expect(snapshots.has(bumpedId)).toBe(false);
    runtime.dispose();
  });

  it("purges an orphan snapshot no roster entry or catalog record can name", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const orphanId = env("persist-orphan");
    await db.saveEnvironmentSnapshot({
      environmentId: orphanId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      payload: boundStoredEnvironmentSnapshot(storedRecord(orphanId)).payload,
      updatedAt: 1,
    });
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => false,
    });
    await runtime.hydrate();
    expect(snapshots.has(orphanId)).toBe(false);
    expect(useStore.getState().environmentStateById[orphanId]).toBeUndefined();
    runtime.dispose();
  });

  it("purges a node's cached content when the directory reports it revoked", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const environmentId = env("persist-revoked");
    const node = hubNode({ nodeId: "node-1", environmentId });
    setCachedHubNodeRoster([rosterRecord(node, 100)]);
    await db.saveEnvironmentSnapshot({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      payload: boundStoredEnvironmentSnapshot(storedRecord(environmentId)).payload,
      updatedAt: 1,
    });
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        { capturedAt: 1, projects: [], worktrees: [], threads: [] },
        environmentId,
      );

    const hostedStore = createFakeHostedStore({ directoryStatus: "ready", nodes: [node] });
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 200,
      hasDirectEnvironment: () => false,
    });
    runtime.installHostedRosterMirror(hostedStore);

    hostedStore.patch({
      nodes: [hubNode({ nodeId: "node-1", environmentId, revokedAt: 150 })],
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(snapshots.has(environmentId)).toBe(false);
    expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
    expect(getCachedHubNodeRoster()[0]?.revokedAt).toBe(150);
    runtime.dispose();
  });

  it("purges the roster and every hub environment's cache on explicit sign-out", async () => {
    const { db, snapshots, getRoster } = createFakeSnapshotDb();
    const environmentId = env("persist-signout");
    const node = hubNode({ nodeId: "node-1", environmentId });
    setCachedHubNodeRoster([rosterRecord(node, 100)]);
    await db.saveEnvironmentSnapshot({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      payload: boundStoredEnvironmentSnapshot(storedRecord(environmentId)).payload,
      updatedAt: 1,
    });
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        { capturedAt: 1, projects: [], worktrees: [], threads: [] },
        environmentId,
      );

    const hostedStore = createFakeHostedStore({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [node],
    } as never);
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 200,
      hasDirectEnvironment: () => false,
    });
    runtime.installHostedRosterMirror(hostedStore);

    // Sign-out teardown patches back to the initial state: signed out, idle
    // directory, empty node list. The purge must fire on the account edge, not
    // on the (deliberately ignored) empty directory.
    hostedStore.patch({ accountStatus: "signed-out", directoryStatus: "idle", nodes: [] } as never);
    await vi.advanceTimersByTimeAsync(10);

    expect(snapshots.has(environmentId)).toBe(false);
    expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
    expect(getCachedHubNodeRoster()).toEqual([]);
    expect(getRoster()?.payload).toContain('"nodes":[]');
    runtime.dispose();
  });

  it("does not purge on session expiry — same account, cache is the point", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const environmentId = env("persist-expiry");
    const node = hubNode({ nodeId: "node-1", environmentId });
    setCachedHubNodeRoster([rosterRecord(node, 100)]);
    await db.saveEnvironmentSnapshot({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      payload: boundStoredEnvironmentSnapshot(storedRecord(environmentId)).payload,
      updatedAt: 1,
    });

    const hostedStore = createFakeHostedStore({
      accountStatus: "authenticated",
      directoryStatus: "ready",
      nodes: [node],
    } as never);
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 200,
      hasDirectEnvironment: () => false,
    });
    runtime.installHostedRosterMirror(hostedStore);
    hostedStore.patch({
      accountStatus: "session-expired",
      directoryStatus: "idle",
      nodes: [],
    } as never);
    await vi.advanceTimersByTimeAsync(10);

    expect(snapshots.has(environmentId)).toBe(true);
    expect(getCachedHubNodeRoster()).toHaveLength(1);
    runtime.dispose();
  });

  it("evicts the least recently written snapshots beyond the caps", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    let clock = 1_000;
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => (clock += 1_000),
      hasDirectEnvironment: () => true,
      caps: { maxEntries: 2, maxBytes: 10_000_000 },
    });
    for (const suffix of ["one", "two", "three"]) {
      const environmentId = env(`persist-evict-${suffix}`);
      useStore.getState().syncServerShellSnapshot(wireSnapshot(suffix), environmentId);
      runtime.markDirty(environmentId);
      await vi.advanceTimersByTimeAsync(600);
    }
    expect([...snapshots.keys()]).toEqual(["persist-evict-two", "persist-evict-three"]);
    runtime.dispose();
  });
});
