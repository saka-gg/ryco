import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import {
  buildThreadInbox,
  selectEnvironmentShellLive,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarWorktreesAcrossEnvironments,
} from "@ryco/client-runtime/state/threads";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { selectEnvironmentState, useStore } from "../store";
import { fullThreadEntry } from "../types";
import {
  capturePrimaryShellSnapshot,
  decodePrimaryShellCacheRecord,
  hydratePrimaryShellFromCache,
  PRIMARY_SHELL_CACHE_WRITE_DELAY_MS,
  startPrimaryShellCachePersistence,
  type PrimaryShellCacheRecord,
  type PrimaryShellCacheStorage,
} from "./primaryShellCache";
import { isPrimaryShellCacheEligible } from "./primaryShellCacheEligibility";

const origin = "http://127.0.0.1:3773";
const environmentId = EnvironmentId.make("environment-primary");
const date = "2026-10-12T00:00:00.000Z";

const thread = (id: string, archivedAt: string | null = null): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-a"),
  title: `Thread ${id}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  goal: null,
  createdAt: date,
  updatedAt: date,
  archivedAt,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const shellSnapshot = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 3,
  updatedAt: date,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/repo/a",
      defaultModelSelection: null,
      scripts: [],
      createdAt: date,
      updatedAt: date,
    },
  ],
  worktrees: [],
  threads,
});

const goLive = (threads: ReadonlyArray<OrchestrationThreadShell>) =>
  useStore.getState().syncServerShellSnapshot(shellSnapshot(threads), environmentId);

function memoryStorage() {
  const records = new Map<string, PrimaryShellCacheRecord>();
  const storage: PrimaryShellCacheStorage = {
    read: vi.fn(async (key: string) => records.get(key) ?? null),
    write: vi.fn(async (record: PrimaryShellCacheRecord) => {
      records.set(record.origin, record);
    }),
    remove: vi.fn(async (key: string) => {
      records.delete(key);
    }),
  };
  return { records, storage };
}

function capturedRecord(threads: ReadonlyArray<OrchestrationThreadShell>): PrimaryShellCacheRecord {
  goLive(threads);
  const snapshot = capturePrimaryShellSnapshot(environmentId, useStore.getState(), 1_000)!;
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  return { origin, environmentId, savedAt: 1_000, snapshot };
}

afterEach(() => {
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
});

describe("primary shell cache eligibility", () => {
  it("persists for the desktop app and loopback pages only", () => {
    expect(isPrimaryShellCacheEligible({ hostname: "127.0.0.1", desktop: false })).toBe(true);
    expect(isPrimaryShellCacheEligible({ hostname: "localhost", desktop: false })).toBe(true);
    expect(isPrimaryShellCacheEligible({ hostname: "[::1]", desktop: false })).toBe(true);
    expect(isPrimaryShellCacheEligible({ hostname: "my-mac.tailnet.ts.net", desktop: true })).toBe(
      true,
    );
    expect(isPrimaryShellCacheEligible({ hostname: "192.168.1.20", desktop: false })).toBe(false);
  });
});

describe("primary shell cache records", () => {
  it("accepts only this origin's record for this environment", () => {
    const record = capturedRecord([thread("a")]);
    expect(decodePrimaryShellCacheRecord(record, origin, environmentId)).toEqual(record);
    expect(
      decodePrimaryShellCacheRecord(record, "http://localhost:9999", environmentId),
    ).toBeNull();
    expect(
      decodePrimaryShellCacheRecord(record, origin, EnvironmentId.make("environment-other")),
    ).toBeNull();
    expect(
      decodePrimaryShellCacheRecord(
        { ...record, snapshot: { broken: true } },
        origin,
        environmentId,
      ),
    ).toBeNull();
  });
});

describe("primary shell cache hydration", () => {
  it("paints the cached shell as last-known state that is neither live nor bootstrapped", () => {
    const record = capturedRecord([thread("a"), thread("b")]);

    expect(hydratePrimaryShellFromCache({ value: record, environmentId, origin })).toBe(true);

    const state = useStore.getState();
    const environment = selectEnvironmentState(state, environmentId);
    expect(environment.threadIds).toEqual(["a", "b"]);
    expect(environment.bootstrapComplete).toBe(false);
    expect(environment.hydratedFromCacheAt).toBe(1_000);
    expect(selectEnvironmentShellLive(state, environmentId)).toBe(false);
    for (const id of environment.threadIds) {
      expect(environment.threadSessionById[id]).toBeNull();
      expect(fullThreadEntry(environment.sidebarThreadSummaryById[id])?.session).toBeNull();
    }
  });

  it("never overwrites an environment that already has state", () => {
    const record = capturedRecord([thread("cached")]);
    goLive([thread("live")]);

    expect(hydratePrimaryShellFromCache({ value: record, environmentId, origin })).toBe(false);
    expect(selectEnvironmentState(useStore.getState(), environmentId).threadIds).toEqual(["live"]);
    expect(selectEnvironmentShellLive(useStore.getState(), environmentId)).toBe(true);
  });

  it("discards a record that belongs to another environment", async () => {
    const { storage, records } = memoryStorage();
    const record = capturedRecord([thread("a")]);
    records.set(origin, { ...record, environmentId: EnvironmentId.make("environment-old") });

    expect(
      hydratePrimaryShellFromCache({ value: records.get(origin), environmentId, origin, storage }),
    ).toBe(false);
    await vi.waitFor(() => expect(storage.remove).toHaveBeenCalledWith(origin));
    expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
  });

  it("gives way to the live snapshot, which drops rows the server no longer has", () => {
    hydratePrimaryShellFromCache({
      value: capturedRecord([thread("kept"), thread("deleted-since")]),
      environmentId,
      origin,
    });

    goLive([thread("kept"), thread("new")]);

    const environment = selectEnvironmentState(useStore.getState(), environmentId);
    expect(environment.threadIds).toEqual(["kept", "new"]);
    expect(environment.hydratedFromCacheAt).toBeUndefined();
    expect(selectEnvironmentShellLive(useStore.getState(), environmentId)).toBe(true);
  });
});

describe("primary shell cache persistence", () => {
  const startWithFakeTimers = (storage: PrimaryShellCacheStorage) =>
    startPrimaryShellCachePersistence({
      environmentId,
      storage,
      origin,
      now: () => 5_000,
      whenIdle: (callback) => callback(),
    });

  it("writes the live shell once the changes have settled", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      const stop = startWithFakeTimers(storage);
      goLive([thread("a")]);
      goLive([thread("a"), thread("b")]);
      expect(storage.write).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);

      expect(storage.write).toHaveBeenCalledTimes(1);
      expect(records.get(origin)?.snapshot.threads.map((entry) => entry.id)).toEqual(["a", "b"]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a write when nothing the cache holds changed", async () => {
    vi.useFakeTimers();
    try {
      const { storage } = memoryStorage();
      const stop = startWithFakeTimers(storage);
      goLive([thread("a")]);
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      // A new snapshot with the same rows replaces the environment state object.
      useStore
        .getState()
        .syncServerShellSnapshot(
          { ...shellSnapshot([thread("a")]), snapshotSequence: 4 },
          environmentId,
        );
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);

      expect(storage.write).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never writes a shell that is itself last-known state", async () => {
    vi.useFakeTimers();
    try {
      const { storage } = memoryStorage();
      const record = capturedRecord([thread("a")]);
      const stop = startWithFakeTimers(storage);
      hydratePrimaryShellFromCache({ value: record, environmentId, origin });
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS * 2);

      expect(storage.write).not.toHaveBeenCalled();
      expect(capturePrimaryShellSnapshot(environmentId, useStore.getState(), 1)).toBeNull();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops writing when stopped, and a second start replaces the first", async () => {
    vi.useFakeTimers();
    try {
      const first = memoryStorage();
      const second = memoryStorage();
      startWithFakeTimers(first.storage);
      const stop = startWithFakeTimers(second.storage);
      goLive([thread("a")]);
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      expect(first.storage.write).not.toHaveBeenCalled();
      expect(second.storage.write).toHaveBeenCalledTimes(1);

      stop();
      goLive([thread("a"), thread("b")]);
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      expect(second.storage.write).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the cache bounded: archived rows go before unarchived ones", () => {
    goLive([
      ...Array.from({ length: 450 }, (_, index) => thread(`archived-${index}`, date)),
      thread("live"),
    ]);
    const snapshot = capturePrimaryShellSnapshot(environmentId, useStore.getState(), 1)!;
    expect(snapshot.threads.length).toBeLessThanOrEqual(400);
    expect(snapshot.threads.some((entry) => entry.id === "live")).toBe(true);
  });
});

describe("primary shell cache and the inbox", () => {
  it("settles cached rows the way the live shell does", () => {
    const old = "2026-01-01T00:00:00.000Z";
    const ended: OrchestrationThreadShell = {
      ...thread("old"),
      createdAt: old,
      updatedAt: old,
      latestUserMessageAt: old,
      latestTurn: {
        turnId: TurnId.make("turn-old"),
        state: "completed",
        requestedAt: old,
        startedAt: old,
        completedAt: old,
        assistantMessageId: null,
      },
    };
    const classify = () => {
      const state = useStore.getState();
      return buildThreadInbox({
        projects: selectProjectsAcrossEnvironments(state),
        worktrees: selectSidebarWorktreesAcrossEnvironments(state),
        threads: selectSidebarThreadsAcrossEnvironments(state),
        environments: [
          {
            environmentId,
            label: "Primary",
            threadSettlementSupported: true,
            connected: true,
            mutationReady: false,
            shellCurrent: false,
          },
        ],
        autoSettleAfterDays: 7,
        nowMs: Date.parse("2026-10-12T00:00:00.000Z"),
      });
    };
    const record = capturedRecord([ended]);
    goLive([ended]);
    const live = classify();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    hydratePrimaryShellFromCache({ value: record, environmentId, origin });
    const cached = classify();

    expect(live.settled).toHaveLength(1);
    expect(cached.settled).toHaveLength(1);
    expect(cached.active).toHaveLength(0);
  });
});
