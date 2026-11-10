import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
  buildThreadInbox,
  selectEnvironmentShellLive,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarWorktreesAcrossEnvironments,
} from "@ryco/client-runtime/state/threads";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { selectEnvironmentState, useStore } from "../store";
import { fullThreadEntry } from "../types";
import { useUiStateStore } from "../uiStateStore";
import {
  capturePrimaryShellSnapshot,
  decodePrimaryShellCacheRecord,
  dropPrimaryShellCacheConversations,
  hydratePrimaryShellFromCache,
  type PrimaryShellCacheRecord,
  type PrimaryShellCacheStorage,
} from "./primaryShellCache";
import { isPrimaryShellCacheEligible } from "./primaryShellCacheEligibility";
import {
  PRIMARY_SHELL_CACHE_MAX_WRITE_WAIT_MS,
  PRIMARY_SHELL_CACHE_WRITE_DELAY_MS,
  startPrimaryShellCacheWriter,
  type PrimaryShellCacheWriterInput,
} from "./primaryShellCacheWriter";
import {
  readThreadReadingAnchor,
  rememberThreadReadingAnchor,
  threadReadingPositions,
} from "./threadReadingPositions";

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
  threadReadingPositions.clear();
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
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
    startPrimaryShellCacheWriter({
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

const message = (id: string, text = `text of ${id}`) => ({
  id: MessageId.make(id),
  role: "assistant" as const,
  text,
  createdAt: date,
  streaming: false,
});

/** Replaces the live conversations of the given threads, as the store does when their messages change. */
function setConversations(
  conversations: Readonly<Record<string, ReadonlyArray<string>>>,
  text?: (id: string) => string,
) {
  const environment = useStore.getState().environmentStateById[environmentId]!;
  const messageIdsByThreadId = { ...environment.messageIdsByThreadId };
  const messageByThreadId = { ...environment.messageByThreadId };
  for (const [name, ids] of Object.entries(conversations)) {
    const threadId = ThreadId.make(name);
    messageIdsByThreadId[threadId] = ids.map((id) => MessageId.make(id));
    messageByThreadId[threadId] = Object.fromEntries(
      ids.map((id) => [MessageId.make(id), message(id, text?.(id))]),
    );
  }
  useStore.setState({
    environmentStateById: {
      ...useStore.getState().environmentStateById,
      [environmentId]: { ...environment, messageIdsByThreadId, messageByThreadId },
    },
  });
}

const resetStore = () => useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
const recordBytes = (record: unknown) =>
  new TextEncoder().encode(JSON.stringify(record)).byteLength;
const keyOf = (threadId: string) =>
  scopedThreadKey({ environmentId, threadId: ThreadId.make(threadId) });

describe("primary shell cache conversations", () => {
  const startWriter = (
    storage: PrimaryShellCacheStorage,
    overrides: Partial<PrimaryShellCacheWriterInput> = {},
  ) =>
    startPrimaryShellCacheWriter({
      environmentId,
      storage,
      origin,
      now: () => 5_000,
      whenIdle: (callback) => callback(),
      keepsConversations: () => true,
      onPageHidden: () => () => undefined,
      ...overrides,
    });

  it("saves recent conversations and paints them, before any connection, as last-known state", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      const stop = startWriter(storage);
      goLive([thread("a"), thread("b")]);
      setConversations({ a: ["a-1", "a-2"], b: ["b-1"] });
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      stop();

      const record = records.get(origin)!;
      expect(Object.keys(record.content ?? {}).toSorted()).toEqual(["a", "b"]);
      resetStore();

      expect(hydratePrimaryShellFromCache({ value: record, environmentId, origin })).toBe(true);
      const state = useStore.getState();
      const environment = selectEnvironmentState(state, environmentId);
      expect(environment.messageIdsByThreadId[ThreadId.make("a")]).toEqual(["a-1", "a-2"]);
      expect(environment.messageByThreadId[ThreadId.make("a")]?.[MessageId.make("a-2")]?.text).toBe(
        "text of a-2",
      );
      expect(environment.bootstrapComplete).toBe(false);
      expect(environment.hydratedFromCacheAt).toBe(5_000);
      expect(selectEnvironmentShellLive(state, environmentId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a typical workspace well inside the shared record budget", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      const stop = startWriter(storage);
      const names = Array.from({ length: 40 }, (_, index) => `t-${index}`);
      goLive(names.map((name) => thread(name)));
      // 20 conversations of 30 messages of about 600 characters each.
      setConversations(
        Object.fromEntries(
          names
            .slice(0, 20)
            .map((name) => [name, Array.from({ length: 30 }, (_, index) => `${name}-m${index}`)]),
        ),
        (id) => `${id} `.repeat(600 / (id.length + 1)),
      );
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      stop();
      const record = records.get(origin)!;
      expect(Object.keys(record.content ?? {})).toHaveLength(20);
      expect(recordBytes(record)).toBeLessThan(THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES / 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("trims the least recently visited conversations to the shared record budget", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      const stop = startWriter(storage);
      goLive([thread("old"), thread("middle"), thread("recent")]);
      useUiStateStore.setState({
        threadLastVisitedAtById: {
          [keyOf("old")]: "2026-10-01T00:00:00.000Z",
          [keyOf("middle")]: "2026-10-02T00:00:00.000Z",
          [keyOf("recent")]: "2026-10-03T00:00:00.000Z",
        },
      });
      setConversations({ old: ["o"], middle: ["m"], recent: ["r"] }, () => "x".repeat(800_000));
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      stop();

      const record = records.get(origin)!;
      expect(Object.keys(record.content ?? {}).toSorted()).toEqual(["middle", "recent"]);
      expect(recordBytes(record)).toBeLessThanOrEqual(THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves no conversations while the device keeps none, and drops the saved ones", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      let keeps = true;
      let flush = () => undefined as void;
      const stop = startWriter(storage, {
        keepsConversations: () => keeps,
        onPageHidden: (callback) => {
          flush = callback;
          return () => undefined;
        },
      });
      goLive([thread("a")]);
      setConversations({ a: ["a-1"] });
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      expect(records.get(origin)?.content).toBeDefined();

      // Turned off with nothing else changing: hiding the window rewrites the record.
      keeps = false;
      flush();
      expect(storage.write).toHaveBeenCalledTimes(2);
      expect(records.get(origin)?.content).toBeUndefined();
      expect(records.get(origin)?.snapshot.threads.map((entry) => entry.id)).toEqual(["a"]);

      setConversations({ a: ["a-1", "a-2"] });
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      expect(records.get(origin)?.content).toBeUndefined();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rewrites only when a conversation changed, not on every store update", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      const stop = startWriter(storage);
      goLive([thread("a"), thread("b")]);
      setConversations({ a: ["a-1"], b: ["b-1"] });
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      const first = records.get(origin)!;

      useStore
        .getState()
        .syncServerShellSnapshot(
          { ...shellSnapshot([thread("a"), thread("b")]), snapshotSequence: 9 },
          environmentId,
        );
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      expect(storage.write).toHaveBeenCalledTimes(1);

      setConversations({ b: ["b-1", "b-2"] });
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      expect(storage.write).toHaveBeenCalledTimes(2);
      const second = records.get(origin)!;
      // The unchanged conversation is the same captured entry, not a re-serialized copy.
      expect(second.content?.["a"]).toBe(first.content?.["a"]);
      expect(second.content?.["b"]?.messages).toHaveLength(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a conversation that streams without a pause within the longest wait", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      const stop = startWriter(storage);
      goLive([thread("a")]);
      const ids: string[] = [];
      for (let elapsed = 0; elapsed < PRIMARY_SHELL_CACHE_MAX_WRITE_WAIT_MS; elapsed += 500) {
        ids.push(`token-${elapsed}`);
        setConversations({ a: ids });
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(storage.write).toHaveBeenCalledTimes(1);
      expect(records.get(origin)?.content?.["a"]?.messages.length).toBeGreaterThan(50);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes what is waiting at once when the page is hidden", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      let flush = () => undefined as void;
      const stop = startWriter(storage, {
        onPageHidden: (callback) => {
          flush = callback;
          return () => undefined;
        },
      });
      goLive([thread("a")]);
      setConversations({ a: ["a-1"] });
      flush();
      expect(storage.write).toHaveBeenCalledTimes(1);
      expect(records.get(origin)?.content?.["a"]?.messages).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_MAX_WRITE_WAIT_MS);
      expect(storage.write).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves and restores where this environment's threads were left", async () => {
    vi.useFakeTimers();
    try {
      const { storage, records } = memoryStorage();
      const stop = startWriter(storage);
      goLive([thread("a"), thread("b")]);
      rememberThreadReadingAnchor(keyOf("a"), { rowId: "a-1", offsetWithinRow: 12 });
      rememberThreadReadingAnchor("environment-other:thread-x", { rowId: "x", offsetWithinRow: 1 });
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      expect(Object.keys(records.get(origin)?.readingPositions ?? {})).toEqual([keyOf("a")]);

      // A scroll alone is written too.
      rememberThreadReadingAnchor(keyOf("b"), { rowId: "b-1", offsetWithinRow: -4 });
      await vi.advanceTimersByTimeAsync(PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
      expect(storage.write).toHaveBeenCalledTimes(2);
      stop();

      const record = records.get(origin)!;
      resetStore();
      threadReadingPositions.clear();
      expect(hydratePrimaryShellFromCache({ value: record, environmentId, origin })).toBe(true);
      expect(readThreadReadingAnchor(keyOf("a"))).toMatchObject({
        rowId: "a-1",
        offsetWithinRow: 12,
      });
      expect(readThreadReadingAnchor(keyOf("b"))).toMatchObject({
        rowId: "b-1",
        offsetWithinRow: -4,
      });
      expect(readThreadReadingAnchor("environment-other:thread-x")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a record from before conversations were kept, and drops what does not decode", () => {
    const record = capturedRecord([thread("a")]);
    expect(record).not.toHaveProperty("content");
    const decoded = decodePrimaryShellCacheRecord(record, origin, environmentId);
    expect(decoded).not.toHaveProperty("content");
    expect(decoded).not.toHaveProperty("readingPositions");

    const untrusted = decodePrimaryShellCacheRecord(
      {
        ...record,
        content: {
          a: { messages: [{ id: "", role: "assistant", text: "x", createdAt: date }] },
          ghost: { messages: [] },
          constructor: { messages: [] },
        },
        readingPositions: {
          [keyOf("a")]: { rowId: " padded ", offsetWithinRow: 1 },
          [`environment-other:a`]: { rowId: "a-1", offsetWithinRow: 1 },
        },
        futureField: { anything: true },
      },
      origin,
      environmentId,
    );
    expect(untrusted?.content).toEqual({});
    expect(untrusted?.readingPositions).toEqual({});
    expect(untrusted).not.toHaveProperty("futureField");

    expect(hydratePrimaryShellFromCache({ value: record, environmentId, origin })).toBe(true);
    expect(selectEnvironmentState(useStore.getState(), environmentId).threadIds).toEqual(["a"]);
  });

  it("discards conversations and anchors saved for another environment", async () => {
    const { storage } = memoryStorage();
    const record = capturedRecord([thread("a")]);
    const other = EnvironmentId.make("environment-old");
    const value = {
      ...record,
      environmentId: other,
      content: { a: { messages: [message("a-1")] } },
      readingPositions: {
        [scopedThreadKey({ environmentId: other, threadId: ThreadId.make("a") })]: {
          rowId: "a-1",
          offsetWithinRow: 3,
        },
      },
    };

    expect(hydratePrimaryShellFromCache({ value, environmentId, origin, storage })).toBe(false);
    await vi.waitFor(() => expect(storage.remove).toHaveBeenCalledWith(origin));
    expect(useStore.getState().environmentStateById[environmentId]).toBeUndefined();
    let anchors = 0;
    threadReadingPositions.forEach(() => anchors++);
    expect(anchors).toBe(0);
  });
});

describe("dropping saved conversations", () => {
  it("keeps the shell and drops the conversations and reading positions", async () => {
    const records = new Map<string, unknown>();
    const storage: PrimaryShellCacheStorage = {
      read: async (key) => records.get(key) ?? null,
      write: async (record) => {
        records.set(record.origin, record);
      },
      remove: async (key) => {
        records.delete(key);
      },
    };
    records.set(origin, {
      origin,
      environmentId,
      savedAt: 1,
      snapshot: { marker: "shell" },
      content: { thread: { messages: [] } },
      readingPositions: { key: { rowId: "row", offsetWithinRow: 1, leftAt: 1 } },
    });
    await dropPrimaryShellCacheConversations(storage, origin);
    expect(records.get(origin)).toEqual({
      origin,
      environmentId,
      savedAt: 1,
      snapshot: { marker: "shell" },
    });
    // Nothing to drop writes nothing.
    const write = vi.spyOn(storage, "write");
    await dropPrimaryShellCacheConversations(storage, origin);
    expect(write).not.toHaveBeenCalled();
  });
});
