import type { HostedHubNode, HostedHubState } from "@ryco/client-runtime/authorization";
import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
} from "@ryco/contracts";
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
const kvEntries = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (key: string) => kvEntries.get(key) ?? null,
    setItem: async (key: string, value: string) => void kvEntries.set(key, value),
    removeItem: async (key: string) => void kvEntries.delete(key),
  },
}));
// The app singleton opens its database lazily; a test hands it a fake one.
const sharedDb = vi.hoisted(() => ({ current: null as import("./snapshotDb").SnapshotDb | null }));
vi.mock("./snapshotDb", async (importOriginal) => {
  const original = await importOriginal<typeof import("./snapshotDb")>();
  return {
    ...original,
    createSnapshotDb: () => sharedDb.current ?? original.createSnapshotDb(),
  };
});
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
  decodeStoredEnvironmentSnapshot,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
  type StoredEnvironmentSnapshot,
} from "./environmentSnapshotCodec";
import { resetPreferencesStoreForTests } from "../state/preferencesStore";
import {
  createSnapshotPersistenceRuntime,
  initializeMobileSnapshotPersistence,
  resetMobileSnapshotPersistenceForTests,
  SNAPSHOT_WRITE_DEBOUNCE_MS,
  SNAPSHOT_WRITE_MAX_WAIT_MS,
  type ThreadContentCacheSetting,
} from "./environmentSnapshotPersistence";
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
      return row
        ? { schemaVersion: row.schemaVersion, payload: row.payload, updatedAt: row.updatedAt }
        : null;
    },
    loadEnvironmentSnapshots: async () =>
      [...snapshots.entries()]
        .map(([environmentId, row]) => ({
          environmentId,
          schemaVersion: row.schemaVersion,
          payload: row.payload,
          updatedAt: row.updatedAt,
        }))
        .toSorted((left, right) => right.updatedAt - left.updatedAt),
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

function shellThread(id: string) {
  return {
    id,
    projectId: "project-1",
    title: `Thread ${id}`,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function wireSnapshotWithThreads(threadIds: ReadonlyArray<string>): OrchestrationShellSnapshot {
  return {
    ...wireSnapshot("project-1"),
    threads: threadIds.map(shellThread),
  } as unknown as OrchestrationShellSnapshot;
}

function threadDetail(id: string, texts: ReadonlyArray<string>): OrchestrationThread {
  return {
    ...shellThread(id),
    deletedAt: null,
    messages: texts.map((text, index) => ({
      id: `${id}-message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text,
      turnId: null,
      streaming: false,
      createdAt: `2026-08-20T00:0${index}:00.000Z`,
      updatedAt: `2026-08-20T00:0${index}:00.000Z`,
    })),
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  } as unknown as OrchestrationThread;
}

/** A live environment with the given threads, the first few of them opened with messages. */
function goLive(
  environmentId: EnvironmentId,
  threads: Readonly<Record<string, ReadonlyArray<string>>>,
) {
  const store = useStore.getState();
  store.syncServerShellSnapshot(wireSnapshotWithThreads(Object.keys(threads)), environmentId);
  for (const [threadId, texts] of Object.entries(threads)) {
    if (texts.length > 0)
      store.syncServerThreadDetail(threadDetail(threadId, texts), environmentId);
  }
}

function messageTexts(environmentId: EnvironmentId, threadId: string): string[] {
  const state = useStore.getState().environmentStateById[environmentId];
  return (state?.messageIdsByThreadId[threadId as never] ?? []).map(
    (messageId) => state?.messageByThreadId[threadId as never]?.[messageId]?.text ?? "",
  );
}

/** A device setting a test can flip, with the listeners the runtime registers. */
function createFakeContentSetting(initial: boolean) {
  let enabled = initial;
  const listeners = new Set<() => void>();
  const setting: ThreadContentCacheSetting = {
    isEnabled: () => enabled,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    setting,
    set: (next: boolean) => {
      enabled = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function storedContent(
  snapshots: ReadonlyMap<string, { readonly payload: string }>,
  environmentId: EnvironmentId,
): Record<string, { messages: Array<{ text: string }> }> | undefined {
  const payload = snapshots.get(environmentId)?.payload;
  return payload ? JSON.parse(payload).content : undefined;
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
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS - 1);
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
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MAX_WAIT_MS);
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

    const yields = vi.fn(async () => undefined);
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
      yieldToEventLoop: yields,
    });
    const loadOne = vi.spyOn(db, "loadEnvironmentSnapshot");
    await runtime.hydrate();

    // One read for every row; two small environments need no yield.
    expect(loadOne).not.toHaveBeenCalled();
    expect(yields).not.toHaveBeenCalled();
    const state = useStore.getState();
    expect(state.environmentStateById[goodId]?.projectIds).toHaveLength(1);
    expect(state.environmentStateById[goodId]?.hydratedFromCacheAt).toBe(1_000);
    expect(state.environmentStateById[goodId]?.bootstrapComplete).toBe(false);
    // The bumped record is discarded rather than mis-decoded, and its row dropped.
    expect(state.environmentStateById[bumpedId]).toBeUndefined();
    expect(snapshots.has(bumpedId)).toBe(false);
    runtime.dispose();
  });

  it("commits small cached environments together and yields between large ones", async () => {
    const { db } = createFakeSnapshotDb();
    const small = [env("persist-small-1"), env("persist-small-2"), env("persist-small-3")];
    const large = [env("persist-large-1"), env("persist-large-2")];
    for (const [index, environmentId] of small.entries()) {
      await db.saveEnvironmentSnapshot({
        environmentId,
        schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
        payload: boundStoredEnvironmentSnapshot(storedRecord(environmentId)).payload,
        updatedAt: 10 - index,
      });
    }
    const bulky = (environmentId: EnvironmentId): StoredEnvironmentSnapshot => ({
      ...storedRecord(environmentId),
      projects: [{ ...storedRecord(environmentId).projects[0]!, cwd: `/${"x".repeat(80_000)}` }],
    });
    for (const [index, environmentId] of large.entries()) {
      await db.saveEnvironmentSnapshot({
        environmentId,
        schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
        payload: JSON.stringify(bulky(environmentId)),
        updatedAt: 100 - index,
      });
    }
    const commits = vi.spyOn(useStore.getState(), "hydrateEnvironmentStatesFromCache");
    const yields = vi.fn(async () => undefined);
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 200,
      hasDirectEnvironment: () => true,
      yieldToEventLoop: yields,
    });

    await runtime.hydrate();

    // Most recent first: each large environment fills a slice on its own and
    // is committed before the next decode; the small ones share one commit.
    expect(
      commits.mock.calls.map(([entries]) => entries.map((entry) => entry.environmentId)),
    ).toEqual([[large[0]], [large[1]], small]);
    expect(yields).toHaveBeenCalledTimes(2);
    for (const environmentId of [...small, ...large]) {
      expect(useStore.getState().environmentStateById[environmentId]?.hydratedFromCacheAt).toBe(
        1_000,
      );
    }
    commits.mockRestore();
    runtime.dispose();
  });

  it("leaves an environment the live connection already populated to it", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const environmentId = env("persist-live-first");
    await db.saveEnvironmentSnapshot({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      payload: boundStoredEnvironmentSnapshot(storedRecord(environmentId)).payload,
      updatedAt: 1,
    });
    // The direct plane connects as soon as the catalog is hydrated, so its
    // first snapshot can land before the cache is read.
    useStore.getState().syncServerShellSnapshot(wireSnapshot("live"), environmentId);
    const commits = vi.spyOn(useStore.getState(), "hydrateEnvironmentStatesFromCache");
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
    });

    await runtime.hydrate();

    const state = useStore.getState().environmentStateById[environmentId];
    expect(state?.bootstrapComplete).toBe(true);
    expect(state?.hydratedFromCacheAt).toBeUndefined();
    expect(commits).not.toHaveBeenCalled();
    expect(snapshots.has(environmentId)).toBe(true);
    commits.mockRestore();
    runtime.dispose();
  });

  it("does not discard a row a live capture replaced while hydration was reading", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const environmentId = env("persist-replaced-during-hydration");
    await db.saveEnvironmentSnapshot({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION + 1,
      payload: "{}",
      updatedAt: 1,
    });
    let runtime: ReturnType<typeof createSnapshotPersistenceRuntime> | undefined;
    const loadAll = db.loadEnvironmentSnapshots;
    runtime = createSnapshotPersistenceRuntime({
      db: {
        ...db,
        loadEnvironmentSnapshots: async () => {
          const rows = await loadAll();
          // The live snapshot arrives and is captured after the rows were read.
          useStore.getState().syncServerShellSnapshot(wireSnapshot("live"), environmentId);
          await runtime!.capture(environmentId);
          useStore.getState().removeEnvironmentState(environmentId);
          return rows;
        },
      },
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
    });

    await runtime.hydrate();

    // The stale row was unreadable, but the stored one is now the live capture.
    expect(snapshots.get(environmentId)?.schemaVersion).toBe(ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION);
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
      await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS + 100);
    }
    expect([...snapshots.keys()]).toEqual(["persist-evict-two", "persist-evict-three"]);
    runtime.dispose();
  });

  it("skips a capture when no persisted slice changed since the last write", async () => {
    const { db } = createFakeSnapshotDb();
    const save = vi.spyOn(db, "saveEnvironmentSnapshot");
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const environmentId = env("persist-unchanged");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("same"), environmentId);

    await runtime.capture(environmentId);
    // A mark from an event that touched nothing the snapshot persists.
    await runtime.capture(environmentId);
    expect(save).toHaveBeenCalledTimes(1);

    useStore.getState().syncServerShellSnapshot(wireSnapshot("changed"), environmentId);
    await runtime.capture(environmentId);
    expect(save).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("keeps skipping an unchanged environment when another environment's row is removed", async () => {
    const { db } = createFakeSnapshotDb();
    const save = vi.spyOn(db, "saveEnvironmentSnapshot");
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const kept = env("persist-epoch-kept");
    const purged = env("persist-epoch-purged");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("kept"), kept);
    useStore.getState().syncServerShellSnapshot(wireSnapshot("purged"), purged);

    await runtime.capture(kept);
    await runtime.capture(purged);
    expect(save).toHaveBeenCalledTimes(2);
    await runtime.purgeEnvironment(purged);
    // The other environment's row was not touched: no redundant rewrite.
    await runtime.capture(kept);
    expect(save).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("writes again after its stored row was removed, even with unchanged slices", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const environmentId = env("persist-rewrite-after-purge");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("same"), environmentId);

    await runtime.capture(environmentId);
    await runtime.purgeEnvironment(environmentId);
    expect(snapshots.has(environmentId)).toBe(false);
    await runtime.capture(environmentId);
    expect(snapshots.has(environmentId)).toBe(true);
    runtime.dispose();
  });

  it("writes a continuously active environment by the maximum wait", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const environmentId = env("persist-max-wait");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("busy"), environmentId);

    // Marks arrive faster than the debounce window, so it never goes quiet.
    for (let elapsed = 0; elapsed < SNAPSHOT_WRITE_MAX_WAIT_MS - 500; elapsed += 500) {
      runtime.markDirty(environmentId);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(snapshots.has(environmentId)).toBe(false);
    runtime.markDirty(environmentId);
    await vi.advanceTimersByTimeAsync(500);
    expect(snapshots.has(environmentId)).toBe(true);
    runtime.dispose();
  });

  it("flushes pending captures when the app goes to the background", async () => {
    const { db, snapshots } = createFakeSnapshotDb();
    let background: () => void = () => undefined;
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
      subscribeBackground: (listener) => {
        background = listener;
        return () => undefined;
      },
    });
    const environmentId = env("persist-background");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("pending"), environmentId);

    runtime.markDirty(environmentId);
    background();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.has(environmentId)).toBe(true);
    runtime.dispose();
  });

  describe("recent conversation text", () => {
    function contentRuntime(
      db: SnapshotDb,
      setting: ThreadContentCacheSetting,
      overrides: { readonly now?: () => number; readonly hubOnly?: boolean } = {},
    ) {
      return createSnapshotPersistenceRuntime({
        db,
        store: useStore,
        now: overrides.now ?? (() => 1_000),
        hasDirectEnvironment: () => !overrides.hubOnly,
        contentCache: setting,
      });
    }

    it("shows the last messages of a thread from the cache before any live data", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-cold-start");
      goLive(environmentId, {
        "thread-opened": ["How do I rebase?", "Use git rebase."],
        "thread-unopened": [],
      });
      const writer = contentRuntime(db, createFakeContentSetting(true).setting);
      await writer.capture(environmentId);
      writer.dispose();
      expect(Object.keys(storedContent(snapshots, environmentId) ?? {})).toEqual(["thread-opened"]);

      // A new process: nothing in the store yet.
      useStore.getState().removeEnvironmentState(environmentId);
      const reader = contentRuntime(db, createFakeContentSetting(true).setting);
      await reader.hydrate();

      const cached = useStore.getState().environmentStateById[environmentId];
      expect(cached?.bootstrapComplete).toBe(false);
      expect(cached?.hydratedFromCacheAt).toBeDefined();
      expect(messageTexts(environmentId, "thread-opened")).toEqual([
        "How do I rebase?",
        "Use git rebase.",
      ]);
      expect(cached?.cachedMessageThreadIds?.["thread-opened" as never]).toBe(true);
      expect(messageTexts(environmentId, "thread-unopened")).toEqual([]);
      expect(cached?.threadIds).toHaveLength(2);

      // Live data wins: the thread's own snapshot replaces the cached text.
      useStore
        .getState()
        .syncServerShellSnapshot(
          wireSnapshotWithThreads(["thread-opened", "thread-unopened"]),
          environmentId,
        );
      expect(messageTexts(environmentId, "thread-opened")).toEqual([
        "How do I rebase?",
        "Use git rebase.",
      ]);
      // A thread not opened since stays cached, so the next capture keeps its text.
      await reader.capture(environmentId);
      expect(storedContent(snapshots, environmentId)?.["thread-opened"]?.messages).toHaveLength(2);
      useStore
        .getState()
        .syncServerThreadDetail(
          threadDetail("thread-opened", ["How do I rebase?", "Use git rebase.", "Thanks."]),
          environmentId,
        );
      const live = useStore.getState().environmentStateById[environmentId];
      expect(messageTexts(environmentId, "thread-opened")).toHaveLength(3);
      expect(live?.cachedMessageThreadIds?.["thread-opened" as never]).toBeUndefined();
      expect(live?.bootstrapComplete).toBe(true);
      reader.dispose();
    });

    it("keeps only the newest conversations a record can hold and never captures a cache view", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-limit");
      const threads = Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`thread-${index}`, [`text ${index}`]]),
      );
      goLive(environmentId, threads);
      const runtime = contentRuntime(db, createFakeContentSetting(true).setting);
      await runtime.capture(environmentId);
      const stored = Object.keys(storedContent(snapshots, environmentId) ?? {});
      expect(stored).toHaveLength(32);

      // A state hydrated from the cache is never written back.
      useStore.getState().removeEnvironmentState(environmentId);
      await runtime.hydrate();
      const before = snapshots.get(environmentId)?.payload;
      await runtime.capture(environmentId);
      expect(snapshots.get(environmentId)?.payload).toBe(before);
      runtime.dispose();
    });

    it("keeps message text in the record when only a thread's messages changed", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-message-change");
      goLive(environmentId, { "thread-1": ["first"] });
      const runtime = contentRuntime(db, createFakeContentSetting(true).setting);
      await runtime.capture(environmentId);
      expect(storedContent(snapshots, environmentId)?.["thread-1"]?.messages).toHaveLength(1);

      // The detail snapshot of a thread marks nothing dirty by itself; the
      // runtime notices the messages and writes after the usual debounce.
      useStore
        .getState()
        .syncServerThreadDetail(threadDetail("thread-1", ["first", "second"]), environmentId);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS - 1);
      expect(storedContent(snapshots, environmentId)?.["thread-1"]?.messages).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(
        storedContent(snapshots, environmentId)?.["thread-1"]?.messages.map(({ text }) => text),
      ).toEqual(["first", "second"]);
      runtime.dispose();
    });

    it("stores no message text and shows none while the setting is off", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-off");
      goLive(environmentId, { "thread-1": ["private text"] });
      const setting = createFakeContentSetting(false);
      const runtime = contentRuntime(db, setting.setting);

      await runtime.capture(environmentId);
      expect(snapshots.get(environmentId)?.payload).not.toContain("private text");
      expect(snapshots.get(environmentId)?.payload).not.toContain('"content"');

      // A message change does not write while the setting is off.
      useStore
        .getState()
        .syncServerThreadDetail(threadDetail("thread-1", ["private text", "more"]), environmentId);
      const save = vi.spyOn(db, "saveEnvironmentSnapshot");
      await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MAX_WAIT_MS);
      expect(save).not.toHaveBeenCalled();
      runtime.dispose();
    });

    it("does not show stored text left from before the setting was turned off, and removes it", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-left-over");
      goLive(environmentId, { "thread-1": ["left over"] });
      const writer = contentRuntime(db, createFakeContentSetting(true).setting);
      await writer.capture(environmentId);
      writer.dispose();
      const updatedAt = (await db.loadEnvironmentSnapshots())[0]?.updatedAt;
      expect(snapshots.get(environmentId)?.payload).toContain("left over");

      useStore.getState().removeEnvironmentState(environmentId);
      const reader = contentRuntime(db, createFakeContentSetting(false).setting, {
        now: () => 99_999,
      });
      await reader.hydrate();
      await vi.advanceTimersByTimeAsync(0);

      const state = useStore.getState().environmentStateById[environmentId];
      expect(state?.hydratedFromCacheAt).toBeDefined();
      expect(state?.threadIds).toHaveLength(1);
      expect(messageTexts(environmentId, "thread-1")).toEqual([]);
      expect(state?.cachedMessageThreadIds).toEqual({});
      expect(snapshots.get(environmentId)?.payload).not.toContain("left over");
      // The shell is untouched and the row keeps its place in eviction order.
      expect(
        decodeStoredEnvironmentSnapshot(snapshots.get(environmentId)!.payload, environmentId),
      ).toMatchObject({ projects: [{ name: "Project project-1" }], threads: [{}] });
      expect((await db.loadEnvironmentSnapshots())[0]?.updatedAt).toBe(updatedAt);
      reader.dispose();
    });

    it("removes left-over text at launch even when it does not decode", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-undecodable");
      await db.saveEnvironmentSnapshot({
        environmentId,
        schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
        payload: JSON.stringify({
          ...storedRecord(environmentId),
          content: { "thread-x": { messages: [{ text: "not a message" }] } },
        }),
        updatedAt: 7,
      });

      const reader = contentRuntime(db, createFakeContentSetting(false).setting);
      await reader.hydrate();
      await vi.advanceTimersByTimeAsync(0);

      expect(snapshots.get(environmentId)?.payload).not.toContain("not a message");
      expect(snapshots.get(environmentId)?.payload).not.toContain('"content"');
      expect(snapshots.get(environmentId)?.updatedAt).toBe(7);
      expect(useStore.getState().environmentStateById[environmentId]?.projectIds).toHaveLength(1);
      reader.dispose();
    });

    it("waits for the saved setting before deciding what to show", async () => {
      const { db } = createFakeSnapshotDb();
      const environmentId = env("persist-content-ready");
      goLive(environmentId, { "thread-1": ["kept"] });
      const writer = contentRuntime(db, createFakeContentSetting(true).setting);
      await writer.capture(environmentId);
      writer.dispose();
      useStore.getState().removeEnvironmentState(environmentId);

      // The preference has not loaded yet, so the setting reads as off.
      let enabled = false;
      let loaded!: () => void;
      const ready = new Promise<void>((resolve) => {
        loaded = resolve;
      });
      const reader = contentRuntime(db, { isEnabled: () => enabled, ready });
      const hydrating = reader.hydrate();
      await vi.advanceTimersByTimeAsync(0);
      expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();

      enabled = true;
      loaded();
      await hydrating;
      expect(messageTexts(environmentId, "thread-1")).toEqual(["kept"]);
      reader.dispose();
    });

    it("removes every environment's stored text when the setting is turned off, and keeps the shells", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const first = env("persist-content-purge-1");
      const second = env("persist-content-purge-2");
      goLive(first, { "thread-1": ["secret one"] });
      goLive(second, { "thread-2": ["secret two"] });
      const setting = createFakeContentSetting(true);
      let clock = 1_000;
      const runtime = contentRuntime(db, setting.setting, { now: () => (clock += 1_000) });
      await runtime.capture(first);
      await runtime.capture(second);
      // An environment that is not live (only its row exists) is purged too.
      const dormant = env("persist-content-purge-dormant");
      await db.saveEnvironmentSnapshot({
        environmentId: dormant,
        schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
        payload: JSON.stringify({
          ...storedRecord(dormant),
          content: { "thread-x": { messages: [] } },
        }),
        updatedAt: 1,
      });
      const timesBefore = Object.fromEntries(
        (await db.loadEnvironmentSnapshots()).map((row) => [row.environmentId, row.updatedAt]),
      );

      setting.set(false);
      await vi.advanceTimersByTimeAsync(0);

      for (const environmentId of [first, second, dormant]) {
        expect(snapshots.get(environmentId)?.payload).not.toContain("secret");
        expect(snapshots.get(environmentId)?.payload).not.toContain('"content"');
        expect(
          decodeStoredEnvironmentSnapshot(snapshots.get(environmentId)!.payload, environmentId)
            ?.projects,
        ).toHaveLength(1);
      }
      expect(
        Object.fromEntries(
          (await db.loadEnvironmentSnapshots()).map((row) => [row.environmentId, row.updatedAt]),
        ),
      ).toEqual(timesBefore);
      // Live state is untouched; the setting only governs what is stored.
      expect(messageTexts(first, "thread-1")).toEqual(["secret one"]);

      // Turned back on, the live environments are captured again with their text.
      setting.set(true);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS);
      expect(storedContent(snapshots, first)?.["thread-1"]?.messages[0]?.text).toBe("secret one");
      expect(storedContent(snapshots, second)?.["thread-2"]?.messages[0]?.text).toBe("secret two");
      expect(storedContent(snapshots, dormant)).toBeUndefined();
      runtime.dispose();
    });

    it("finds the stored rows without reading their payloads when the setting is turned off", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-stats-only");
      goLive(environmentId, { "thread-1": ["secret"] });
      const setting = createFakeContentSetting(true);
      const runtime = contentRuntime(db, setting.setting);
      await runtime.capture(environmentId);
      const loadAll = vi.spyOn(db, "loadEnvironmentSnapshots");

      setting.set(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(loadAll).not.toHaveBeenCalled();
      expect(snapshots.get(environmentId)?.payload).not.toContain("secret");
      runtime.dispose();
    });

    it("keeps the timestamp of a row written while the text was being removed", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-timestamp");
      goLive(environmentId, { "thread-1": ["first"] });
      const setting = createFakeContentSetting(true);
      let clock = 1_000;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const save = db.saveEnvironmentSnapshot;
      let saves = 0;
      const runtime = contentRuntime(
        {
          ...db,
          saveEnvironmentSnapshot: async (input) => {
            saves += 1;
            // The second capture's write is held back until the removal is waiting.
            if (saves === 2) await barrier;
            await save(input);
          },
        },
        setting.setting,
        { now: () => (clock += 1_000) },
      );
      await runtime.capture(environmentId);
      const firstWrittenAt = snapshots.get(environmentId)?.updatedAt;

      useStore
        .getState()
        .syncServerThreadDetail(threadDetail("thread-1", ["first", "second"]), environmentId);
      const capture = runtime.capture(environmentId);
      await vi.advanceTimersByTimeAsync(0);
      expect(saves).toBe(2);

      // The listing sees the first write; the second lands before the removal reads.
      setting.set(false);
      await vi.advanceTimersByTimeAsync(0);
      release();
      await capture;
      await vi.advanceTimersByTimeAsync(0);

      const row = snapshots.get(environmentId);
      expect(row?.payload).not.toContain("second");
      expect(row?.payload).not.toContain('"content"');
      expect(row?.updatedAt).toBeGreaterThan(firstWrittenAt!);
      runtime.dispose();
    });

    it("removes the text of a write that was still in flight when the setting was turned off", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-in-flight");
      goLive(environmentId, { "thread-1": ["in flight"] });
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const save = db.saveEnvironmentSnapshot;
      const started = vi.fn();
      const setting = createFakeContentSetting(true);
      const runtime = contentRuntime(
        {
          ...db,
          saveEnvironmentSnapshot: async (input) => {
            started();
            await barrier;
            await save(input);
          },
        },
        setting.setting,
      );
      const capture = runtime.capture(environmentId);
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toHaveBeenCalledOnce();
      // The row does not exist yet, so listing the stored rows does not find it.
      expect(snapshots.has(environmentId)).toBe(false);

      setting.set(false);
      release();
      await capture;
      await vi.advanceTimersByTimeAsync(0);

      expect(snapshots.has(environmentId)).toBe(true);
      expect(snapshots.get(environmentId)?.payload).not.toContain("in flight");
      runtime.dispose();
    });

    it("removes stored text together with the shell on revocation and sign-out", async () => {
      for (const scenario of ["revocation", "sign-out"] as const) {
        const { db, snapshots } = createFakeSnapshotDb();
        const environmentId = env(`persist-content-${scenario}`);
        const node = hubNode({ nodeId: `node-${scenario}`, environmentId });
        setCachedHubNodeRoster([rosterRecord(node, 100)]);
        goLive(environmentId, { "thread-1": ["node conversation"] });
        const writer = contentRuntime(db, createFakeContentSetting(true).setting);
        await writer.capture(environmentId);
        writer.dispose();
        expect(snapshots.get(environmentId)?.payload).toContain("node conversation");

        const hostedStore = createFakeHostedStore({
          accountStatus: "authenticated",
          directoryStatus: "ready",
          nodes: [node],
        } as never);
        const runtime = contentRuntime(db, createFakeContentSetting(true).setting, {
          hubOnly: true,
        });
        runtime.installHostedRosterMirror(hostedStore);
        hostedStore.patch(
          scenario === "revocation"
            ? { nodes: [hubNode({ nodeId: `node-${scenario}`, environmentId, revokedAt: 150 })] }
            : ({ accountStatus: "signed-out", directoryStatus: "idle", nodes: [] } as never),
        );
        await vi.advanceTimersByTimeAsync(10);

        expect(snapshots.has(environmentId)).toBe(false);
        expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
        runtime.dispose();
        resetCachedHubNodeRosterForTests();
      }
    });

    it("removes stored text with the row when an environment is purged", async () => {
      const { db, snapshots } = createFakeSnapshotDb();
      const environmentId = env("persist-content-removal");
      goLive(environmentId, { "thread-1": ["to be removed"] });
      const runtime = contentRuntime(db, createFakeContentSetting(true).setting);
      await runtime.capture(environmentId);
      expect(snapshots.get(environmentId)?.payload).toContain("to be removed");

      await runtime.purgeEnvironment(environmentId);
      expect(snapshots.has(environmentId)).toBe(false);
      runtime.dispose();
    });
  });
});

describe("recent conversation text through the app singleton", () => {
  beforeEach(() => {
    kvEntries.clear();
    resetPreferencesStoreForTests();
  });
  afterEach(() => {
    resetMobileSnapshotPersistenceForTests();
    sharedDb.current = null;
    resetPreferencesStoreForTests();
    kvEntries.clear();
    for (const environmentId of usedEnvironmentIds.splice(0)) {
      useStore.getState().removeEnvironmentState(environmentId);
    }
  });

  /** A stored row holding one conversation, and an empty threads store as after a restart. */
  async function storeConversation(environmentId: EnvironmentId) {
    const { db, snapshots } = createFakeSnapshotDb();
    goLive(environmentId, { "thread-1": ["from last session"] });
    const writer = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1_000,
      hasDirectEnvironment: () => true,
      contentCache: { isEnabled: () => true },
    });
    await writer.capture(environmentId);
    writer.dispose();
    useStore.getState().removeEnvironmentState(environmentId);
    sharedDb.current = db;
    return snapshots;
  }

  const start = () =>
    initializeMobileSnapshotPersistence({
      kv: {
        getItem: async (key) => kvEntries.get(key) ?? null,
        setItem: async (key, value) => void kvEntries.set(key, value),
        removeItem: async (key) => void kvEntries.delete(key),
      },
      hasDirectEnvironment: () => true,
    });

  it("keeps conversations on by default, so a cold start shows the last messages", async () => {
    const environmentId = env("persist-singleton-default");
    await storeConversation(environmentId);

    await start();

    expect(messageTexts(environmentId, "thread-1")).toEqual(["from last session"]);
  });

  it("shows and keeps no conversation text once the user turned the setting off", async () => {
    const environmentId = env("persist-singleton-off");
    const snapshots = await storeConversation(environmentId);
    kvEntries.set("ryco.preferences", JSON.stringify({ rememberThreadContent: false }));

    await start();

    expect(useStore.getState().environmentStateById[environmentId]?.threadIds).toHaveLength(1);
    expect(messageTexts(environmentId, "thread-1")).toEqual([]);
    // The leftover text is removed from the stored row too.
    await vi.waitFor(() =>
      expect(snapshots.get(environmentId)?.payload).not.toContain("from last session"),
    );
  });
});
