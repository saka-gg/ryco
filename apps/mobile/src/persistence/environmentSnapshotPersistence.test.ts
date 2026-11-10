import type { HostedHubNode, HostedHubState } from "@ryco/client-runtime/authorization";
import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ThreadId,
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
    createSnapshotDb: (open?: Parameters<typeof original.createSnapshotDb>[0]) =>
      sharedDb.current ?? original.createSnapshotDb(open),
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
  registerEnvironmentDevicePurge,
  resetEnvironmentDevicePurgesForTests,
} from "./environmentDevicePurge";
import {
  decodeStoredEnvironmentEnvelope,
  decodeStoredThreadBody,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
} from "./environmentSnapshotCodec";
import { resetPreferencesStoreForTests } from "../state/preferencesStore";
import {
  createSnapshotPersistenceRuntime,
  initializeMobileSnapshotPersistence,
  listEnvironmentCacheStorage,
  readSavedThreadSequence,
  resetMobileSnapshotPersistenceForTests,
  SNAPSHOT_BUSY_MAX_WAIT_MS,
  SNAPSHOT_WRITE_DEBOUNCE_MS,
  SNAPSHOT_WRITE_MAX_WAIT_MS,
  type ThreadContentCacheSetting,
} from "./environmentSnapshotPersistence";
import { hasSavedThreadBody, requestSavedThreadBody } from "./savedThreadBodies";
import { payloadByteLength, payloadHash, type SnapshotDb } from "./snapshotDb";
import { createTestSnapshotDb } from "./snapshotDb.testSupport";

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

/** The thread rows a machine has stored, by id. */
async function storedThreadIds(db: SnapshotDb, environmentId: EnvironmentId): Promise<string[]> {
  return (await db.loadEnvironmentThreads(environmentId)).map((row) => row.threadId).toSorted();
}

async function hasStoredMachine(db: SnapshotDb, environmentId: EnvironmentId): Promise<boolean> {
  return (await db.loadEnvironmentEnvelopes()).some((row) => row.environmentId === environmentId);
}

async function storedEnvelope(db: SnapshotDb, environmentId: EnvironmentId) {
  return (await db.loadEnvironmentEnvelopes()).find((row) => row.environmentId === environmentId);
}

/** The text of each saved body of a machine, by thread. */
async function storedBodies(
  db: SnapshotDb,
  environmentId: EnvironmentId,
): Promise<Record<string, string[]>> {
  const bodies: Record<string, string[]> = {};
  for (const key of await db.listThreadBodyKeys()) {
    if (key.environmentId !== environmentId) continue;
    const row = await db.loadThreadBody(environmentId, key.threadId);
    bodies[key.threadId] =
      decodeStoredThreadBody(row!.payload)?.content?.messages.map((message) => message.text) ?? [];
  }
  return bodies;
}

/** A machine stored by an earlier process: one project, the given threads, no text. */
async function seedMachine(
  db: SnapshotDb,
  environmentId: EnvironmentId,
  input: {
    readonly updatedAt?: number;
    readonly schemaVersion?: number;
    readonly cwd?: string;
    readonly threads?: ReadonlyArray<string>;
  } = {},
) {
  const envelope = JSON.stringify({
    schemaVersion: input.schemaVersion ?? ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    projects: [
      {
        id: "project-1",
        environmentId,
        name: "Cached project",
        cwd: input.cwd ?? "/cached",
        defaultModelSelection: null,
        scripts: [],
      },
    ],
    worktrees: [],
  });
  const threads = (input.threads ?? []).map((threadId) => {
    const thread = { ...shellThread(threadId), environmentId };
    const payload = JSON.stringify({ shell: thread, summary: thread });
    return { threadId, payload, bytes: payloadByteLength(payload), hash: payloadHash(payload) };
  });
  await db.writeEnvironmentRows({
    environmentId,
    schemaVersion: input.schemaVersion ?? ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
    updatedAt: input.updatedAt ?? 1_000,
    envelope: {
      payload: envelope,
      bytes: payloadByteLength(envelope),
      threadCount: threads.length,
      projectCount: 1,
    },
    upsertThreads: threads,
    deleteThreads: [],
    upsertBodies: [],
    bodySequences: [],
    deleteBodies: [],
  });
}

/** Counts each write of a machine's rows; `hold` keeps the next ones until released. */
function countingWrites(db: SnapshotDb) {
  const calls: Array<Parameters<SnapshotDb["writeEnvironmentRows"]>[0]> = [];
  let held: Promise<void> | null = null;
  const wrapped: SnapshotDb = {
    ...db,
    writeEnvironmentRows: async (input) => {
      calls.push(input);
      if (held) await held;
      await db.writeEnvironmentRows(input);
    },
  };
  return {
    db: wrapped,
    calls,
    hold: () => {
      let release!: () => void;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
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

const BOOT = 1_755_000_000_000;

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
    const { db } = await createTestSnapshotDb();
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => BOOT,
      hasDirectEnvironment: () => true,
    });
    const environmentId = env("persist-capture");
    useStore.getState().syncServerShellSnapshot(wireSnapshotWithThreads(["t1"]), environmentId);

    runtime.markDirty(environmentId);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS - 1);
    expect(await hasStoredMachine(db, environmentId)).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const envelope = await storedEnvelope(db, environmentId);
    expect(envelope).toMatchObject({ updatedAt: BOOT, threadCount: 1, projectCount: 1 });
    expect(decodeStoredEnvironmentEnvelope(envelope!.payload, environmentId)).toMatchObject({
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      projects: [{ name: "Project project-1" }],
    });
    expect(await storedThreadIds(db, environmentId)).toEqual(["t1"]);
    runtime.dispose();
  });

  it("clears after an in-flight write and cancels a pending debounced capture", async () => {
    const test = await createTestSnapshotDb();
    const writes = countingWrites(test.db);
    const release = writes.hold();
    const runtime = createSnapshotPersistenceRuntime({
      db: writes.db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const id = env("clear-during-write");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("live"), id);
    const capture = runtime.capture(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.calls).toHaveLength(1);
    runtime.markDirty(id);
    const clearing = runtime.purgeEnvironment(id);
    release();
    await Promise.all([capture, clearing]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await hasStoredMachine(test.db, id)).toBe(false);
    expect(useStore.getState().environmentStateById[id]?.bootstrapComplete).toBe(true);
    runtime.dispose();
  });

  it("never captures an unsettled or cache-provenance environment", async () => {
    const { db } = await createTestSnapshotDb();
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
    expect(await db.loadEnvironmentEnvelopes()).toEqual([]);
    runtime.dispose();
  });

  it("hydrates each machine's thread list on cold start and discards an envelope of another version", async () => {
    const { db } = await createTestSnapshotDb();
    const goodId = env("persist-good");
    const bumpedId = env("persist-bumped");
    await seedMachine(db, goodId, { updatedAt: 1_000, threads: ["t2", "t1"] });
    await seedMachine(db, bumpedId, {
      updatedAt: 2,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION + 1,
      threads: ["t1"],
    });

    const yields = vi.fn(async () => undefined);
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
      yieldToEventLoop: yields,
    });
    const loadBody = vi.spyOn(db, "loadThreadBody");
    await runtime.hydrate();

    // Two small environments need no yield, and no body is read at launch.
    expect(yields).not.toHaveBeenCalled();
    expect(loadBody).not.toHaveBeenCalled();
    const state = useStore.getState();
    expect(state.environmentStateById[goodId]?.projectIds).toHaveLength(1);
    expect(state.environmentStateById[goodId]?.threadIds).toEqual(["t1", "t2"]);
    expect(state.environmentStateById[goodId]?.hydratedFromCacheAt).toBe(1_000);
    expect(state.environmentStateById[goodId]?.bootstrapComplete).toBe(false);
    // The bumped machine is discarded rather than mis-decoded, its rows dropped.
    expect(state.environmentStateById[bumpedId]).toBeUndefined();
    expect(await hasStoredMachine(db, bumpedId)).toBe(false);
    expect(await storedThreadIds(db, bumpedId)).toEqual([]);
    runtime.dispose();
  });

  it("leaves out a thread row that does not decode and shows the others", async () => {
    const test = await createTestSnapshotDb();
    const environmentId = env("persist-bad-thread");
    await seedMachine(test.db, environmentId, { threads: ["good"] });
    await test.db.writeEnvironmentRows({
      environmentId,
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      updatedAt: 1_000,
      envelope: { bytes: 0, threadCount: 2, projectCount: 1 },
      upsertThreads: [{ threadId: "bad", payload: "{not-json", bytes: 9, hash: 1 }],
      deleteThreads: [],
      upsertBodies: [],
      bodySequences: [],
      deleteBodies: [],
    });
    const runtime = createSnapshotPersistenceRuntime({
      db: test.db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
    });
    await runtime.hydrate();
    expect(useStore.getState().environmentStateById[environmentId]?.threadIds).toEqual(["good"]);
    runtime.dispose();
  });

  it("commits small cached environments together and yields between large ones", async () => {
    const { db } = await createTestSnapshotDb();
    const small = [env("persist-small-1"), env("persist-small-2"), env("persist-small-3")];
    const large = [env("persist-large-1"), env("persist-large-2")];
    for (const [index, environmentId] of small.entries()) {
      await seedMachine(db, environmentId, { updatedAt: 10 - index });
    }
    for (const [index, environmentId] of large.entries()) {
      await seedMachine(db, environmentId, {
        updatedAt: 100 - index,
        cwd: `/${"x".repeat(80_000)}`,
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
      expect(
        useStore.getState().environmentStateById[environmentId]?.hydratedFromCacheAt,
      ).toBeDefined();
    }
    commits.mockRestore();
    runtime.dispose();
  });

  it("leaves an environment the live connection already populated to it", async () => {
    const { db } = await createTestSnapshotDb();
    const environmentId = env("persist-live-first");
    await seedMachine(db, environmentId, { threads: ["cached-thread"] });
    // The direct plane connects as soon as the catalog is hydrated, and a Hub
    // machine's relay handshake starts then too, so their first snapshot can
    // land before the cache is read.
    useStore.getState().syncServerShellSnapshot(wireSnapshot("live"), environmentId);
    const commits = vi.spyOn(useStore.getState(), "hydrateEnvironmentStatesFromCache");
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
    });
    const loadThreads = vi.spyOn(db, "loadEnvironmentThreads");

    await runtime.hydrate();

    const state = useStore.getState().environmentStateById[environmentId];
    expect(state?.bootstrapComplete).toBe(true);
    expect(state?.hydratedFromCacheAt).toBeUndefined();
    expect(state?.threadIds).toEqual([]);
    expect(commits).not.toHaveBeenCalled();
    // Its thread rows are not even read.
    expect(loadThreads).not.toHaveBeenCalled();
    expect(await hasStoredMachine(db, environmentId)).toBe(true);
    commits.mockRestore();
    runtime.dispose();
  });

  it("keeps a live snapshot that lands while the machine's thread rows are read", async () => {
    const { db } = await createTestSnapshotDb();
    const environmentId = env("persist-live-during-read");
    await seedMachine(db, environmentId, { threads: ["cached-thread"] });
    const runtime = createSnapshotPersistenceRuntime({
      db: {
        ...db,
        loadEnvironmentThreads: async (id) => {
          const rows = await db.loadEnvironmentThreads(id);
          useStore
            .getState()
            .syncServerShellSnapshot(wireSnapshotWithThreads(["live"]), environmentId);
          return rows;
        },
      },
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
    });

    await runtime.hydrate();

    const state = useStore.getState().environmentStateById[environmentId];
    expect(state?.hydratedFromCacheAt).toBeUndefined();
    expect(state?.threadIds).toEqual(["live"]);
    runtime.dispose();
  });

  it("does not discard rows a live capture replaced while hydration was reading", async () => {
    const { db } = await createTestSnapshotDb();
    const environmentId = env("persist-replaced-during-hydration");
    await seedMachine(db, environmentId, {
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION + 1,
    });
    let runtime: ReturnType<typeof createSnapshotPersistenceRuntime> | undefined;
    runtime = createSnapshotPersistenceRuntime({
      db: {
        ...db,
        loadEnvironmentEnvelopes: async () => {
          const rows = await db.loadEnvironmentEnvelopes();
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

    // The stale rows were unreadable, but the stored ones are now the live capture.
    expect((await storedEnvelope(db, environmentId))?.schemaVersion).toBe(
      ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
    );
    runtime.dispose();
  });

  it("keeps a switched-off node's rows stored but does not show them", async () => {
    const { db } = await createTestSnapshotDb();
    const offId = env("persist-switched-off");
    const onId = env("persist-switched-on");
    for (const environmentId of [offId, onId]) await seedMachine(db, environmentId);
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => true,
      isEnvironmentSwitchedOff: (environmentId) => environmentId === offId,
    });
    await runtime.hydrate();

    expect(useStore.getState().environmentStateById[offId]).toBeUndefined();
    expect(await hasStoredMachine(db, offId)).toBe(true);
    expect(useStore.getState().environmentStateById[onId]?.projectIds).toHaveLength(1);
    runtime.dispose();
  });

  it("purges an orphan machine no roster entry or catalog record can name", async () => {
    const { db } = await createTestSnapshotDb();
    const orphanId = env("persist-orphan");
    await seedMachine(db, orphanId, { threads: ["t1"] });
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 10,
      hasDirectEnvironment: () => false,
    });
    await runtime.hydrate();
    expect(await hasStoredMachine(db, orphanId)).toBe(false);
    expect(await storedThreadIds(db, orphanId)).toEqual([]);
    expect(useStore.getState().environmentStateById[orphanId]).toBeUndefined();
    runtime.dispose();
  });

  it("purges a node's cached content when the directory reports it revoked", async () => {
    const { db } = await createTestSnapshotDb();
    const environmentId = env("persist-revoked");
    const node = hubNode({ nodeId: "node-1", environmentId });
    setCachedHubNodeRoster([rosterRecord(node, 100)]);
    await seedMachine(db, environmentId, { threads: ["t1"] });
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

    expect(await hasStoredMachine(db, environmentId)).toBe(false);
    expect(await storedThreadIds(db, environmentId)).toEqual([]);
    expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
    expect(getCachedHubNodeRoster()[0]?.revokedAt).toBe(150);
    runtime.dispose();
  });

  it("purges the roster and every hub environment's cache on explicit sign-out", async () => {
    const { db } = await createTestSnapshotDb();
    const environmentId = env("persist-signout");
    const node = hubNode({ nodeId: "node-1", environmentId });
    setCachedHubNodeRoster([rosterRecord(node, 100)]);
    await seedMachine(db, environmentId, { threads: ["t1"] });
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
    const purgedDeviceData: string[] = [];
    registerEnvironmentDevicePurge((id) => {
      purgedDeviceData.push(id);
    });
    runtime.installHostedRosterMirror(hostedStore);

    // Sign-out teardown patches back to the initial state: signed out, idle
    // directory, empty node list. The purge must fire on the account edge, not
    // on the (deliberately ignored) empty directory.
    hostedStore.patch({ accountStatus: "signed-out", directoryStatus: "idle", nodes: [] } as never);
    await vi.advanceTimersByTimeAsync(10);

    expect(await hasStoredMachine(db, environmentId)).toBe(false);
    expect(await storedThreadIds(db, environmentId)).toEqual([]);
    // Device data kept outside the database (pull request drafts) goes with it.
    expect(purgedDeviceData).toEqual([environmentId]);
    resetEnvironmentDevicePurgesForTests();
    expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
    expect(getCachedHubNodeRoster()).toEqual([]);
    expect((await db.loadHubNodeRoster())?.payload).toContain('"nodes":[]');
    runtime.dispose();
  });

  it("does not purge on session expiry — same account, cache is the point", async () => {
    const { db } = await createTestSnapshotDb();
    const environmentId = env("persist-expiry");
    const node = hubNode({ nodeId: "node-1", environmentId });
    setCachedHubNodeRoster([rosterRecord(node, 100)]);
    await seedMachine(db, environmentId);

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

    expect(await hasStoredMachine(db, environmentId)).toBe(true);
    expect(getCachedHubNodeRoster()).toHaveLength(1);
    runtime.dispose();
  });

  it("evicts the least recently written machines beyond the count cap", async () => {
    const { db } = await createTestSnapshotDb();
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
      useStore.getState().syncServerShellSnapshot(wireSnapshotWithThreads(["t1"]), environmentId);
      runtime.markDirty(environmentId);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS + 100);
    }
    expect((await db.loadEnvironmentEnvelopes()).map((row) => row.environmentId)).toEqual([
      "persist-evict-three",
      "persist-evict-two",
    ]);
    expect(await storedThreadIds(db, env("persist-evict-one"))).toEqual([]);
    runtime.dispose();
  });

  it("evicts by the bytes of a machine's rows and bodies together", async () => {
    const { db } = await createTestSnapshotDb();
    let clock = 1_000;
    const first = env("persist-evict-bytes-1");
    const second = env("persist-evict-bytes-2");
    goLive(first, { t1: ["x".repeat(30_000)] });
    goLive(second, { t2: ["y".repeat(30_000)] });
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => (clock += 1_000),
      hasDirectEnvironment: () => true,
      contentCache: { isEnabled: () => true },
      caps: { maxEntries: 10, maxBytes: 50_000 },
    });
    await runtime.capture(first);
    expect(await hasStoredMachine(db, first)).toBe(true);
    // Each machine is small without its text; with it the two exceed the budget.
    await runtime.capture(second);
    expect(await hasStoredMachine(db, first)).toBe(false);
    expect(await db.listThreadBodyKeys()).toEqual([{ environmentId: second, threadId: "t2" }]);
    runtime.dispose();
  });

  it("skips a capture when no persisted slice changed since the last write", async () => {
    const test = await createTestSnapshotDb();
    const writes = countingWrites(test.db);
    const runtime = createSnapshotPersistenceRuntime({
      db: writes.db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const environmentId = env("persist-unchanged");
    useStore.getState().syncServerShellSnapshot(wireSnapshot("same"), environmentId);

    await runtime.capture(environmentId);
    // A mark from an event that touched nothing the snapshot persists.
    await runtime.capture(environmentId);
    expect(writes.calls).toHaveLength(1);

    useStore.getState().syncServerShellSnapshot(wireSnapshot("changed"), environmentId);
    await runtime.capture(environmentId);
    expect(writes.calls).toHaveLength(2);
    runtime.dispose();
  });

  it("writes only the rows that changed, and the envelope only when it changed", async () => {
    const test = await createTestSnapshotDb();
    const writes = countingWrites(test.db);
    const runtime = createSnapshotPersistenceRuntime({
      db: writes.db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
      contentCache: { isEnabled: () => true },
    });
    const environmentId = env("persist-changed-rows");
    goLive(environmentId, { t1: ["hello"], t2: ["other"], t3: [] });
    await runtime.capture(environmentId);
    expect(writes.calls[0]?.upsertThreads.map((row) => row.threadId)).toEqual(["t1", "t2", "t3"]);
    expect(writes.calls[0]?.envelope.payload).toBeDefined();

    // A streaming turn: one thread's row changes, and its text grows.
    useStore
      .getState()
      .syncServerThreadDetail(
        { ...threadDetail("t2", ["other", "more"]), title: "Renamed t2" },
        environmentId,
      );
    await runtime.capture(environmentId);
    const second = writes.calls[1]!;
    expect(second.upsertThreads.map((row) => row.threadId)).toEqual(["t2"]);
    expect(second.envelope.payload).toBeUndefined();
    expect(second.upsertBodies.map((row) => row.threadId)).toEqual(["t2"]);
    expect(second.deleteThreads).toEqual([]);
    expect(second.deleteBodies).toEqual([]);
    expect(await storedBodies(test.db, environmentId)).toEqual({
      t1: ["hello"],
      t2: ["other", "more"],
    });
    runtime.dispose();
  });

  it("writes nothing but the envelope's counters after a restart when nothing changed", async () => {
    const test = await createTestSnapshotDb();
    const environmentId = env("persist-restart-unchanged");
    goLive(environmentId, { t1: ["hello"], t2: [] });
    const first = createSnapshotPersistenceRuntime({
      db: test.db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
      contentCache: { isEnabled: () => true },
    });
    await first.capture(environmentId);
    first.dispose();

    // A new process with the same live data compares against the stored hashes.
    const writes = countingWrites(test.db);
    const second = createSnapshotPersistenceRuntime({
      db: writes.db,
      store: useStore,
      now: () => 2,
      hasDirectEnvironment: () => true,
      contentCache: { isEnabled: () => true },
    });
    await second.capture(environmentId);
    expect(writes.calls).toHaveLength(1);
    expect(writes.calls[0]).toMatchObject({
      upsertThreads: [],
      upsertBodies: [],
      deleteThreads: [],
    });
    second.dispose();
  });

  it("deletes the rows of threads that left the machine or its bounds", async () => {
    const { db } = await createTestSnapshotDb();
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
      contentCache: { isEnabled: () => true },
    });
    const environmentId = env("persist-thread-removed");
    goLive(environmentId, { t1: ["one"], t2: ["two"] });
    await runtime.capture(environmentId);
    expect(await storedThreadIds(db, environmentId)).toEqual(["t1", "t2"]);

    useStore.getState().syncServerShellSnapshot(wireSnapshotWithThreads(["t1"]), environmentId);
    await runtime.capture(environmentId);
    expect(await storedThreadIds(db, environmentId)).toEqual(["t1"]);
    expect(Object.keys(await storedBodies(db, environmentId))).toEqual(["t1"]);
    expect((await storedEnvelope(db, environmentId))?.threadCount).toBe(1);
    runtime.dispose();
  });

  it("keeps skipping an unchanged environment when another environment's rows are removed", async () => {
    const test = await createTestSnapshotDb();
    const writes = countingWrites(test.db);
    const runtime = createSnapshotPersistenceRuntime({
      db: writes.db,
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
    expect(writes.calls).toHaveLength(2);
    await runtime.purgeEnvironment(purged);
    // The other environment's rows were not touched: no redundant rewrite.
    await runtime.capture(kept);
    expect(writes.calls).toHaveLength(2);
    runtime.dispose();
  });

  it("writes again after its stored rows were removed, even with unchanged slices", async () => {
    const { db } = await createTestSnapshotDb();
    const runtime = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const environmentId = env("persist-rewrite-after-purge");
    useStore.getState().syncServerShellSnapshot(wireSnapshotWithThreads(["t1"]), environmentId);

    await runtime.capture(environmentId);
    await runtime.purgeEnvironment(environmentId);
    expect(await hasStoredMachine(db, environmentId)).toBe(false);
    await runtime.capture(environmentId);
    expect(await hasStoredMachine(db, environmentId)).toBe(true);
    expect(await storedThreadIds(db, environmentId)).toEqual(["t1"]);
    runtime.dispose();
  });

  it("writes a continuously active environment by the maximum wait", async () => {
    const { db } = await createTestSnapshotDb();
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
    expect(await hasStoredMachine(db, environmentId)).toBe(false);
    runtime.markDirty(environmentId);
    await vi.advanceTimersByTimeAsync(500);
    expect(await hasStoredMachine(db, environmentId)).toBe(true);
    runtime.dispose();
  });

  it("writes a busy environment at most once per busy window", async () => {
    const test = await createTestSnapshotDb();
    const writes: number[] = [];
    const runtime = createSnapshotPersistenceRuntime({
      db: {
        ...test.db,
        writeEnvironmentRows: async (input) => {
          writes.push(Date.now());
          await test.db.writeEnvironmentRows(input);
        },
      },
      store: useStore,
      now: () => 1,
      hasDirectEnvironment: () => true,
    });
    const environmentId = env("persist-busy-window");
    const start = Date.now();
    // An agent streams for a minute and a half: the projection changes every half second.
    for (let elapsed = 0, step = 0; elapsed < 90_000; elapsed += 500, step += 1) {
      useStore.getState().syncServerShellSnapshot(wireSnapshot(`busy-${step}`), environmentId);
      runtime.markDirty(environmentId);
      await vi.advanceTimersByTimeAsync(500);
    }
    const offsets = writes.map((at) => at - start);
    // The first write comes by the plain maximum wait; after that the
    // environment is busy and is written once per busy maximum wait.
    expect(offsets[0]).toBeLessThanOrEqual(SNAPSHOT_WRITE_MAX_WAIT_MS);
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]! - offsets[index - 1]!).toBeGreaterThanOrEqual(
        SNAPSHOT_BUSY_MAX_WAIT_MS - 500,
      );
    }
    expect(writes.length).toBeLessThanOrEqual(4);
    runtime.dispose();
  });

  it("flushes pending captures when the app goes to the background", async () => {
    const { db } = await createTestSnapshotDb();
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
    expect(await hasStoredMachine(db, environmentId)).toBe(true);
    runtime.dispose();
  });

  describe("machines saved by an older build", () => {
    function legacyPayload(environmentId: EnvironmentId, schemaVersion: number, extra = {}) {
      const thread = { ...shellThread("thread-1"), environmentId };
      return JSON.stringify({
        schemaVersion,
        environmentId,
        capturedAt: 4_000,
        projects: [
          {
            id: "project-1",
            environmentId,
            name: "Legacy project",
            cwd: "/legacy",
            defaultModelSelection: null,
            scripts: [],
          },
        ],
        worktrees: [],
        threads: [{ shell: thread, summary: thread }],
        ...extra,
      });
    }

    it("moves a v3 row into rows once, its text into a body, and shows it", async () => {
      const test = await createTestSnapshotDb();
      const environmentId = env("persist-legacy-v3");
      const brokenId = env("persist-legacy-broken");
      await test.insertLegacyRow({
        environmentId,
        schemaVersion: 3,
        payload: legacyPayload(environmentId, 3, {
          content: {
            "thread-1": {
              messages: [
                {
                  id: "m1",
                  role: "user",
                  text: "from the old layout",
                  createdAt: "2026-08-01T00:00:00.000Z",
                },
              ],
            },
          },
        }),
        updatedAt: 4_000,
      });
      await test.insertLegacyRow({
        environmentId: brokenId,
        schemaVersion: 3,
        payload: "{not-json",
        updatedAt: 1,
      });
      const runtime = createSnapshotPersistenceRuntime({
        db: test.db,
        store: useStore,
        now: () => 10,
        hasDirectEnvironment: () => true,
        contentCache: { isEnabled: () => true },
      });
      await runtime.hydrate();

      expect(await test.db.loadLegacyEnvironmentSnapshots()).toEqual([]);
      expect(await storedEnvelope(test.db, environmentId)).toMatchObject({
        updatedAt: 4_000,
        threadCount: 1,
        projectCount: 1,
      });
      expect(await storedThreadIds(test.db, environmentId)).toEqual(["thread-1"]);
      expect(await storedBodies(test.db, environmentId)).toEqual({
        "thread-1": ["from the old layout"],
      });
      expect(await hasStoredMachine(test.db, brokenId)).toBe(false);
      const state = useStore.getState().environmentStateById[environmentId];
      expect(state?.threadIds).toEqual(["thread-1"]);
      expect(state?.hydratedFromCacheAt).toBe(4_000);
      expect(hasSavedThreadBody(environmentId, "thread-1" as ThreadId)).toBe(true);
      await runtime.loadThreadBody(environmentId, "thread-1" as ThreadId);
      expect(messageTexts(environmentId, "thread-1")).toEqual(["from the old layout"]);
      runtime.dispose();
    });

    it("still moves v1 and v2 rows, which carry no text", async () => {
      const test = await createTestSnapshotDb();
      const v1 = env("persist-legacy-v1");
      const v2 = env("persist-legacy-v2");
      await test.insertLegacyRow({
        environmentId: v1,
        schemaVersion: 1,
        payload: legacyPayload(v1, 1),
        updatedAt: 1,
      });
      await test.insertLegacyRow({
        environmentId: v2,
        schemaVersion: 2,
        payload: legacyPayload(v2, 2),
        updatedAt: 2,
      });
      const runtime = createSnapshotPersistenceRuntime({
        db: test.db,
        store: useStore,
        now: () => 10,
        hasDirectEnvironment: () => true,
      });
      await runtime.hydrate();
      for (const environmentId of [v1, v2]) {
        expect(useStore.getState().environmentStateById[environmentId]?.threadIds).toEqual([
          "thread-1",
        ]);
      }
      expect(await test.db.listThreadBodyKeys()).toEqual([]);
      runtime.dispose();
    });
  });

  describe("recent conversation text", () => {
    function contentRuntime(
      db: SnapshotDb,
      setting: ThreadContentCacheSetting,
      overrides: {
        readonly now?: () => number;
        readonly hubOnly?: boolean;
        readonly readThreadSequence?: (
          environmentId: EnvironmentId,
          threadId: ThreadId,
        ) => number | null;
      } = {},
    ) {
      return createSnapshotPersistenceRuntime({
        db,
        store: useStore,
        now: overrides.now ?? (() => 1_000),
        hasDirectEnvironment: () => !overrides.hubOnly,
        contentCache: setting,
        ...(overrides.readThreadSequence
          ? { readThreadSequence: overrides.readThreadSequence }
          : {}),
      });
    }

    /** A new process: the machine's live state is gone from the store, its rows stay. */
    async function restart(
      db: SnapshotDb,
      environmentId: EnvironmentId,
      setting: ThreadContentCacheSetting = createFakeContentSetting(true).setting,
    ) {
      useStore.getState().removeEnvironmentState(environmentId);
      const reader = contentRuntime(db, setting);
      await reader.hydrate();
      return reader;
    }

    it("reads no text at launch and shows a thread's saved text when it opens", async () => {
      const test = await createTestSnapshotDb();
      const environmentId = env("persist-content-cold-start");
      goLive(environmentId, {
        "thread-opened": ["How do I rebase?", "Use git rebase."],
        "thread-unopened": [],
      });
      const writer = contentRuntime(test.db, createFakeContentSetting(true).setting);
      await writer.capture(environmentId);
      writer.dispose();
      expect(Object.keys(await storedBodies(test.db, environmentId))).toEqual(["thread-opened"]);

      test.counters.read = 0;
      const reader = await restart(test.db, environmentId);
      // The launch read holds no message text.
      expect(test.counters.read).toBeLessThan(5_000);
      const cached = useStore.getState().environmentStateById[environmentId];
      expect(cached?.bootstrapComplete).toBe(false);
      expect(cached?.hydratedFromCacheAt).toBeDefined();
      expect(cached?.threadIds).toHaveLength(2);
      expect(messageTexts(environmentId, "thread-opened")).toEqual([]);
      expect(hasSavedThreadBody(environmentId, "thread-opened" as ThreadId)).toBe(true);
      expect(hasSavedThreadBody(environmentId, "thread-unopened" as ThreadId)).toBe(false);

      await reader.loadThreadBody(environmentId, "thread-opened" as ThreadId);
      expect(messageTexts(environmentId, "thread-opened")).toEqual([
        "How do I rebase?",
        "Use git rebase.",
      ]);
      expect(
        useStore.getState().environmentStateById[environmentId]?.cachedMessageThreadIds?.[
          "thread-opened" as never
        ],
      ).toBe(true);

      // Live data wins: the live list keeps the saved text until the thread's own window.
      useStore
        .getState()
        .syncServerShellSnapshot(
          wireSnapshotWithThreads(["thread-opened", "thread-unopened"]),
          environmentId,
        );
      expect(messageTexts(environmentId, "thread-opened")).toHaveLength(2);
      // A thread not opened since stays cached, so the next capture keeps its text.
      await reader.capture(environmentId);
      expect(await storedBodies(test.db, environmentId)).toEqual({
        "thread-opened": ["How do I rebase?", "Use git rebase."],
      });
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

    it("never covers a thread's live body with its saved text, however late the read", async () => {
      const test = await createTestSnapshotDb();
      const environmentId = env("persist-content-live-wins");
      goLive(environmentId, { "thread-1": ["saved text"] });
      const writer = contentRuntime(test.db, createFakeContentSetting(true).setting);
      await writer.capture(environmentId);
      writer.dispose();
      useStore.getState().removeEnvironmentState(environmentId);

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reader = contentRuntime(
        {
          ...test.db,
          loadThreadBody: async (...args) => {
            await held;
            return test.db.loadThreadBody(...args);
          },
        },
        createFakeContentSetting(true).setting,
      );
      await reader.hydrate();
      const loading = reader.loadThreadBody(environmentId, "thread-1" as ThreadId);
      // The live list and the thread's own window land while the read is held.
      goLive(environmentId, { "thread-1": ["live text"] });
      release();
      await loading;
      expect(messageTexts(environmentId, "thread-1")).toEqual(["live text"]);
      expect(
        useStore.getState().environmentStateById[environmentId]?.cachedMessageThreadIds?.[
          "thread-1" as never
        ],
      ).toBeUndefined();

      // Opened again with the live body in the store, nothing is read.
      const loadBody = vi.spyOn(test.db, "loadThreadBody");
      await reader.loadThreadBody(environmentId, "thread-1" as ThreadId);
      expect(loadBody).not.toHaveBeenCalled();
      reader.dispose();
    });

    it("does not show a body whose machine was removed while it was read", async () => {
      const test = await createTestSnapshotDb();
      const environmentId = env("persist-content-removed-during-read");
      goLive(environmentId, { "thread-1": ["saved text"] });
      const writer = contentRuntime(test.db, createFakeContentSetting(true).setting);
      await writer.capture(environmentId);
      writer.dispose();
      useStore.getState().removeEnvironmentState(environmentId);
      let reader!: ReturnType<typeof contentRuntime>;
      reader = contentRuntime(
        {
          ...test.db,
          loadThreadBody: async (...args) => {
            const row = await test.db.loadThreadBody(...args);
            await reader.purgeEnvironment(environmentId);
            useStore
              .getState()
              .hydrateEnvironmentStateFromCache(
                { capturedAt: 1, projects: [], worktrees: [], threads: [] },
                environmentId,
              );
            return row;
          },
        },
        createFakeContentSetting(true).setting,
      );
      await reader.hydrate();
      await reader.loadThreadBody(environmentId, "thread-1" as ThreadId);
      expect(messageTexts(environmentId, "thread-1")).toEqual([]);
      reader.dispose();
    });

    it("keeps only the newest conversations a machine can hold and never captures a cache view", async () => {
      const test = await createTestSnapshotDb();
      const environmentId = env("persist-content-limit");
      const threads = Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`thread-${index}`, [`text ${index}`]]),
      );
      goLive(environmentId, threads);
      const runtime = contentRuntime(test.db, createFakeContentSetting(true).setting);
      await runtime.capture(environmentId);
      expect(Object.keys(await storedBodies(test.db, environmentId))).toHaveLength(32);

      // A state hydrated from the cache is never written back.
      useStore.getState().removeEnvironmentState(environmentId);
      await runtime.hydrate();
      const writes = vi.spyOn(test.db, "writeEnvironmentRows");
      await runtime.capture(environmentId);
      expect(writes).not.toHaveBeenCalled();
      runtime.dispose();
    });

    it("writes a thread's body again when only its messages changed", async () => {
      const { db } = await createTestSnapshotDb();
      const environmentId = env("persist-content-message-change");
      goLive(environmentId, { "thread-1": ["first"] });
      const runtime = contentRuntime(db, createFakeContentSetting(true).setting);
      await runtime.capture(environmentId);
      expect(await storedBodies(db, environmentId)).toEqual({ "thread-1": ["first"] });

      // The detail snapshot of a thread marks nothing dirty by itself; the
      // runtime notices the messages and writes after the usual debounce.
      useStore
        .getState()
        .syncServerThreadDetail(threadDetail("thread-1", ["first", "second"]), environmentId);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS - 1);
      expect(await storedBodies(db, environmentId)).toEqual({ "thread-1": ["first"] });
      await vi.advanceTimersByTimeAsync(2);
      expect(await storedBodies(db, environmentId)).toEqual({ "thread-1": ["first", "second"] });
      runtime.dispose();
    });

    it("stores no text and shows none while the setting is off", async () => {
      const test = await createTestSnapshotDb();
      const environmentId = env("persist-content-off");
      goLive(environmentId, { "thread-1": ["private text"] });
      const setting = createFakeContentSetting(false);
      const runtime = contentRuntime(test.db, setting.setting);

      test.counters.written = 0;
      await runtime.capture(environmentId);
      expect(await test.db.listThreadBodyKeys()).toEqual([]);
      expect(JSON.stringify(await test.rows("environment_threads"))).not.toContain("private text");

      // A message change does not write while the setting is off.
      useStore
        .getState()
        .syncServerThreadDetail(threadDetail("thread-1", ["private text", "more"]), environmentId);
      const writes = vi.spyOn(test.db, "writeEnvironmentRows");
      await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_MAX_WAIT_MS);
      expect(writes).not.toHaveBeenCalled();

      // Nor does opening a thread read any.
      useStore.getState().removeEnvironmentState(environmentId);
      const reader = await restart(test.db, environmentId, setting.setting);
      const loadBody = vi.spyOn(test.db, "loadThreadBody");
      await reader.loadThreadBody(environmentId, "thread-1" as ThreadId);
      expect(loadBody).not.toHaveBeenCalled();
      reader.dispose();
      runtime.dispose();
    });

    it("removes bodies left from before the setting was turned off at launch, and keeps the rest", async () => {
      const { db } = await createTestSnapshotDb();
      const environmentId = env("persist-content-left-over");
      goLive(environmentId, { "thread-1": ["left over"] });
      const writer = contentRuntime(db, createFakeContentSetting(true).setting);
      await writer.capture(environmentId);
      writer.dispose();
      const updatedAt = (await storedEnvelope(db, environmentId))?.updatedAt;

      const reader = await restart(db, environmentId, createFakeContentSetting(false).setting);

      const state = useStore.getState().environmentStateById[environmentId];
      expect(state?.hydratedFromCacheAt).toBeDefined();
      expect(state?.threadIds).toHaveLength(1);
      expect(messageTexts(environmentId, "thread-1")).toEqual([]);
      expect(await db.listThreadBodyKeys()).toEqual([]);
      expect(hasSavedThreadBody(environmentId, "thread-1" as ThreadId)).toBe(false);
      // The thread rows are untouched and the machine keeps its place in eviction order.
      expect(await storedThreadIds(db, environmentId)).toEqual(["thread-1"]);
      expect((await storedEnvelope(db, environmentId))?.updatedAt).toBe(updatedAt);
      reader.dispose();
    });

    it("lists which threads have a saved body only once the saved setting is known", async () => {
      const { db } = await createTestSnapshotDb();
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
      // The thread list does not wait for the setting.
      expect(useStore.getState().environmentStateById[environmentId]?.threadIds).toHaveLength(1);
      expect(hasSavedThreadBody(environmentId, "thread-1" as ThreadId)).toBe(false);

      enabled = true;
      loaded();
      await hydrating;
      expect(hasSavedThreadBody(environmentId, "thread-1" as ThreadId)).toBe(true);
      await reader.loadThreadBody(environmentId, "thread-1" as ThreadId);
      expect(messageTexts(environmentId, "thread-1")).toEqual(["kept"]);
      reader.dispose();
    });

    it("removes every machine's bodies when the setting is turned off, and keeps their threads", async () => {
      const { db } = await createTestSnapshotDb();
      const first = env("persist-content-purge-1");
      const second = env("persist-content-purge-2");
      goLive(first, { "thread-1": ["secret one"] });
      goLive(second, { "thread-2": ["secret two"] });
      const setting = createFakeContentSetting(true);
      let clock = 1_000;
      const runtime = contentRuntime(db, setting.setting, { now: () => (clock += 1_000) });
      await runtime.capture(first);
      await runtime.capture(second);
      const timesBefore = Object.fromEntries(
        (await db.loadEnvironmentEnvelopes()).map((row) => [row.environmentId, row.updatedAt]),
      );
      const loadBody = vi.spyOn(db, "loadThreadBody");

      setting.set(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(await db.listThreadBodyKeys()).toEqual([]);
      // Found without reading any body.
      expect(loadBody).not.toHaveBeenCalled();
      expect(await storedThreadIds(db, first)).toEqual(["thread-1"]);
      expect(
        Object.fromEntries(
          (await db.loadEnvironmentEnvelopes()).map((row) => [row.environmentId, row.updatedAt]),
        ),
      ).toEqual(timesBefore);
      // Live state is untouched; the setting only governs what is stored.
      expect(messageTexts(first, "thread-1")).toEqual(["secret one"]);

      // Turned back on, the live environments are captured again with their text.
      setting.set(true);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS);
      expect(await storedBodies(db, first)).toEqual({ "thread-1": ["secret one"] });
      expect(await storedBodies(db, second)).toEqual({ "thread-2": ["secret two"] });
      runtime.dispose();
    });

    it("removes saved screen answers when the setting is turned off, and with a machine's rows", async () => {
      const { db } = await createTestSnapshotDb();
      const first = env("persist-pr-purge-1");
      const setting = createFakeContentSetting(true);
      const runtime = contentRuntime(db, setting.setting);
      const save = (environmentId: string, key: string) =>
        db.saveSavedQuery({
          environmentId,
          key,
          schemaVersion: 1,
          payload: "{}",
          payloadBytes: 2,
          updatedAt: 1,
        });
      await save(first, "detail-1");
      await save("other", "detail-2");
      await runtime.purgeEnvironment(first);
      expect((await db.listSavedQueryStats()).map((stat) => stat.key)).toEqual(["detail-2"]);

      setting.set(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(await db.listSavedQueryStats()).toEqual([]);
      runtime.dispose();
    });

    it("removes the bodies of a write that was still in flight when the setting was turned off", async () => {
      const test = await createTestSnapshotDb();
      const writes = countingWrites(test.db);
      const environmentId = env("persist-content-in-flight");
      goLive(environmentId, { "thread-1": ["in flight"] });
      const release = writes.hold();
      const setting = createFakeContentSetting(true);
      const runtime = contentRuntime(writes.db, setting.setting);
      const capture = runtime.capture(environmentId);
      await vi.advanceTimersByTimeAsync(0);
      expect(writes.calls).toHaveLength(1);
      // The rows do not exist yet, so listing the stored machines does not find them.
      expect(await hasStoredMachine(test.db, environmentId)).toBe(false);

      setting.set(false);
      release();
      await capture;
      await vi.advanceTimersByTimeAsync(0);

      expect(await hasStoredMachine(test.db, environmentId)).toBe(true);
      expect(await test.db.listThreadBodyKeys()).toEqual([]);
      // The next capture with the setting off writes no body back.
      useStore
        .getState()
        .syncServerThreadDetail(threadDetail("thread-1", ["in flight", "more"]), environmentId);
      await runtime.capture(environmentId);
      expect(await test.db.listThreadBodyKeys()).toEqual([]);
      runtime.dispose();
    });

    it("removes bodies together with the threads on revocation and sign-out", async () => {
      for (const scenario of ["revocation", "sign-out"] as const) {
        const { db } = await createTestSnapshotDb();
        const environmentId = env(`persist-content-${scenario}`);
        const node = hubNode({ nodeId: `node-${scenario}`, environmentId });
        setCachedHubNodeRoster([rosterRecord(node, 100)]);
        goLive(environmentId, { "thread-1": ["node conversation"] });
        const writer = contentRuntime(db, createFakeContentSetting(true).setting);
        await writer.capture(environmentId);
        writer.dispose();
        expect(await storedBodies(db, environmentId)).toEqual({
          "thread-1": ["node conversation"],
        });

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

        expect(await hasStoredMachine(db, environmentId)).toBe(false);
        expect(await db.listThreadBodyKeys()).toEqual([]);
        expect(hasSavedThreadBody(environmentId, "thread-1" as ThreadId)).toBe(false);
        expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
        runtime.dispose();
        resetCachedHubNodeRosterForTests();
      }
    });

    it("removes bodies with the rows when a machine is purged", async () => {
      const { db } = await createTestSnapshotDb();
      const environmentId = env("persist-content-removal");
      goLive(environmentId, { "thread-1": ["to be removed"] });
      const runtime = contentRuntime(db, createFakeContentSetting(true).setting);
      await runtime.capture(environmentId);
      expect(Object.keys(await storedBodies(db, environmentId))).toEqual(["thread-1"]);

      await runtime.purgeEnvironment(environmentId);
      expect(await hasStoredMachine(db, environmentId)).toBe(false);
      expect(await db.listThreadBodyKeys()).toEqual([]);
      runtime.dispose();
    });

    it("saves the open approval card and the window's sequence, and shows the card on open", async () => {
      const { db } = await createTestSnapshotDb();
      const environmentId = env("persist-content-cards");
      goLive(environmentId, { "thread-1": ["Run the migration?"] });
      const activity = (
        id: string,
        kind: string,
        payload: Record<string, unknown>,
        minute: number,
      ): OrchestrationThreadActivity =>
        ({
          id,
          kind,
          tone: "approval",
          summary: kind,
          payload,
          turnId: "turn-1",
          createdAt: `2026-08-20T00:0${minute}:00.000Z`,
        }) as never;
      useStore.getState().syncServerThreadDetail(
        {
          ...threadDetail("thread-1", ["Run the migration?"]),
          activities: [
            activity(
              "a-open",
              "approval.requested",
              { requestId: "req-open", requestKind: "command", detail: "bun run migrate" },
              1,
            ),
            activity(
              "a-done",
              "approval.requested",
              { requestId: "req-done", requestKind: "command" },
              2,
            ),
            activity("a-done-r", "approval.resolved", { requestId: "req-done" }, 3),
          ],
        } as never,
        environmentId,
      );
      const writer = contentRuntime(db, createFakeContentSetting(true).setting, {
        readThreadSequence: (_environmentId, threadId) => (threadId === "thread-1" ? 77 : null),
      });
      await writer.capture(environmentId);
      writer.dispose();
      expect(await db.loadThreadBodySequence(environmentId, "thread-1")).toBe(77);

      const reader = await restart(db, environmentId);
      await reader.loadThreadBody(environmentId, "thread-1" as ThreadId);
      const cached = useStore.getState().environmentStateById[environmentId];
      expect(cached?.activityIdsByThreadId["thread-1" as never]).toEqual(["a-open"]);
      expect(cached?.activityByThreadId["thread-1" as never]?.["a-open"]?.payload).toEqual({
        requestId: "req-open",
        requestKind: "command",
        detail: "bun run migrate",
      });

      // The live window replaces the saved card like any body.
      useStore
        .getState()
        .syncServerShellSnapshot(wireSnapshotWithThreads(["thread-1"]), environmentId);
      useStore
        .getState()
        .syncServerThreadDetail(threadDetail("thread-1", ["Run the migration?"]), environmentId);
      expect(
        useStore.getState().environmentStateById[environmentId]?.activityIdsByThreadId[
          "thread-1" as never
        ],
      ).toEqual([]);
      reader.dispose();
    });
  });
});

describe("the app singleton", () => {
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

  /** Stored rows holding one conversation, and an empty threads store as after a restart. */
  async function storeConversation(environmentId: EnvironmentId) {
    const test = await createTestSnapshotDb();
    goLive(environmentId, { "thread-1": ["from last session"] });
    const writer = createSnapshotPersistenceRuntime({
      db: test.db,
      store: useStore,
      now: () => 1_000,
      hasDirectEnvironment: () => true,
      contentCache: { isEnabled: () => true },
      readThreadSequence: () => 12,
    });
    await writer.capture(environmentId);
    writer.dispose();
    useStore.getState().removeEnvironmentState(environmentId);
    sharedDb.current = test.db;
    return test;
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

  it("keeps conversations on by default: an opened thread shows its last messages", async () => {
    const environmentId = env("persist-singleton-default");
    await storeConversation(environmentId);
    // Asked before the cache has started (a notification tap at launch).
    requestSavedThreadBody(environmentId, "thread-1" as ThreadId);

    await start();

    await vi.waitFor(() =>
      expect(messageTexts(environmentId, "thread-1")).toEqual(["from last session"]),
    );
    expect(await readSavedThreadSequence(environmentId, "thread-1" as ThreadId)).toBe(12);
  });

  it("shows and keeps no conversation text once the user turned the setting off", async () => {
    const environmentId = env("persist-singleton-off");
    const test = await storeConversation(environmentId);
    kvEntries.set("ryco.preferences", JSON.stringify({ rememberThreadContent: false }));

    await start();
    requestSavedThreadBody(environmentId, "thread-1" as ThreadId);

    expect(useStore.getState().environmentStateById[environmentId]?.threadIds).toHaveLength(1);
    await vi.waitFor(async () => expect(await test.db.listThreadBodyKeys()).toEqual([]));
    expect(messageTexts(environmentId, "thread-1")).toEqual([]);
  });

  it("reports each machine's counts and size for Settings without reading a row", async () => {
    const environmentId = env("persist-singleton-storage");
    const test = await storeConversation(environmentId);
    test.counters.read = 0;

    const storage = await listEnvironmentCacheStorage();

    const entry = storage.find((item) => item.environmentId === environmentId);
    expect(entry).toMatchObject({ threads: 1, projects: 1 });
    expect(entry?.payloadBytes).toBeGreaterThan(0);
    // Only ids are read: no envelope, thread row or body.
    expect(test.counters.read).toBeLessThan(200);
  });
});
