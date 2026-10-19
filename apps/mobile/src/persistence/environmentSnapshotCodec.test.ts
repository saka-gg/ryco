import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES,
} from "@ryco/client-runtime/state/workspace";
import {
  createThreadContentCapture,
  fullThreadEntry,
  isArchivedThreadStub,
  THREAD_CONTENT_CACHE_MAX_THREADS,
  type ArchivedThreadStub,
} from "@ryco/client-runtime/state/threads";
import type {
  ChatMessage,
  EnvironmentState,
  Project,
  SidebarThreadSummary,
  ThreadShell,
  ThreadSession,
} from "../state/threadsRuntime";
import {
  boundStoredEnvironmentSnapshot,
  captureEnvironmentContentCandidates,
  captureEnvironmentSnapshotRecord,
  createEnvironmentSnapshotSerializer,
  decodeStoredEnvironmentSnapshot,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
  MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT,
  MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT,
  toCachedEnvironmentShellSnapshot,
  toWorkspaceMetadataSnapshot,
  withoutStoredContent,
} from "./environmentSnapshotCodec";

const ENV = "env-codec" as EnvironmentId;

function project(id: string): Project {
  return {
    id: id as never,
    environmentId: ENV,
    name: id,
    cwd: `/${id}`,
    defaultModelSelection: null,
    scripts: [],
  };
}

function shell(id: string, overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: id as never,
    environmentId: ENV,
    codexThreadId: null,
    projectId: "project-1" as never,
    title: id,
    modelSelection: { model: "claude" } as never,
    runtimeMode: "full-access",
    interactionMode: "default",
    error: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    archivedAt: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function summary(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: id as never,
    environmentId: ENV,
    projectId: "project-1" as never,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function environmentState(threads: ReadonlyArray<string>): EnvironmentState {
  return {
    projectIds: ["project-1" as never],
    projectById: { ["project-1" as never]: project("project-1") },
    worktreeIds: [],
    worktreeIdsByProjectId: {},
    worktreeById: {},
    threadIds: threads as never,
    threadIdsByProjectId: {},
    threadShellById: Object.fromEntries(threads.map((id) => [id, shell(id)])) as never,
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    pendingMessagesByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: Object.fromEntries(
      threads.map((id) => [
        id,
        summary(id, {
          session: {
            provider: "claudeAgent" as never,
            status: "running",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            orchestrationStatus: "running" as never,
          } as ThreadSession,
          backgroundLiveness: "working",
        }),
      ]),
    ) as never,
    bootstrapComplete: true,
  };
}

describe("environment snapshot codec", () => {
  it("captures the settled projection with sessions and liveness stripped", () => {
    const record = captureEnvironmentSnapshotRecord(environmentState(["thread-1"]), ENV, 123);
    expect(record.schemaVersion).toBe(ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION);
    expect(record.capturedAt).toBe(123);
    expect(record.projects).toHaveLength(1);
    expect(record.threads).toHaveLength(1);
    expect(fullThreadEntry(record.threads[0]?.summary)?.session).toBeNull();
    expect(fullThreadEntry(record.threads[0]?.summary)?.backgroundLiveness).toBeNull();
  });

  it("round-trips through encode and decode", () => {
    const record = captureEnvironmentSnapshotRecord(environmentState(["thread-1"]), ENV, 123);
    const { payload } = boundStoredEnvironmentSnapshot(record);
    expect(decodeStoredEnvironmentSnapshot(payload, ENV)).toEqual(record);
  });

  it("projects the byte-compatible mobile record into shared metadata", () => {
    const record = captureEnvironmentSnapshotRecord(environmentState(["thread-1"]), ENV, 123);
    const shared = toWorkspaceMetadataSnapshot(record);
    expect(shared).toMatchObject({
      schemaVersion: 1,
      environmentId: ENV,
      capturedAt: 123,
      projects: [{ environmentId: ENV, id: "project-1" }],
      threads: [
        {
          environmentId: ENV,
          id: "thread-1",
          projectId: "project-1",
          deliveryUnknown: false,
        },
      ],
    });
    expect(shared).not.toHaveProperty("messages");
    expect(shared.threads[0]).not.toHaveProperty("session");
  });

  it("keeps a valid shell lineage in shared metadata and drops a malformed one", () => {
    const lineage = {
      parentThreadId: "thread-parent" as never,
      rootThreadId: "thread-parent" as never,
      relationship: "delegated",
    };
    const state = environmentState(["thread-valid", "thread-malformed", "thread-root"]);
    const record = captureEnvironmentSnapshotRecord(
      {
        ...state,
        threadShellById: {
          ...state.threadShellById,
          ["thread-valid" as never]: shell("thread-valid", { lineage }),
          ["thread-malformed" as never]: shell("thread-malformed", {
            lineage: { parentThreadId: "", relationship: 7 } as never,
          }),
        },
      },
      ENV,
      123,
    );
    const threads = new Map(
      toWorkspaceMetadataSnapshot(record).threads.map((thread) => [thread.id, thread]),
    );
    expect(threads.get("thread-valid" as never)?.lineage).toEqual(lineage);
    expect(threads.get("thread-malformed" as never)).not.toHaveProperty("lineage");
    expect(threads.get("thread-root" as never)).not.toHaveProperty("lineage");
  });

  it("discards a record whose schemaVersion literal it does not know — a bump in either direction", () => {
    const record = captureEnvironmentSnapshotRecord(environmentState(["thread-1"]), ENV, 123);
    const { payload } = boundStoredEnvironmentSnapshot(record);
    for (const schemaVersion of [ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION + 1, 0]) {
      const bumped = JSON.stringify({
        ...(JSON.parse(payload) as Record<string, unknown>),
        schemaVersion,
      });
      expect(decodeStoredEnvironmentSnapshot(bumped, ENV)).toBeNull();
    }
  });

  const archivedStub = (id: string): ArchivedThreadStub => ({
    shellDetail: "archived-stub",
    id: id as never,
    environmentId: ENV,
    projectId: "project-1" as never,
    title: id,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    archivedAt: "2026-08-02T00:00:00.000Z",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    latestUserMessageAt: null,
    lineage: null,
  });
  const withStub = (state: EnvironmentState, id: string): EnvironmentState => ({
    ...state,
    threadIds: [...state.threadIds, id as never],
    threadShellById: { ...state.threadShellById, [id]: archivedStub(id) } as never,
    sidebarThreadSummaryById: {
      ...state.sidebarThreadSummaryById,
      [id]: archivedStub(id),
    } as never,
  });

  it("writes stubs whole and round-trips them", () => {
    const record = captureEnvironmentSnapshotRecord(
      withStub(environmentState(["thread-1"]), "archived-1"),
      ENV,
      123,
    );
    expect(record.schemaVersion).toBe(ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION);
    const stored = record.threads.find((thread) => thread.shell.id === "archived-1");
    expect(isArchivedThreadStub(stored?.shell)).toBe(true);
    // A stub claims no live state; it is stored as is.
    expect(stored?.summary).toEqual(archivedStub("archived-1"));
    const { payload } = boundStoredEnvironmentSnapshot(record);
    expect(decodeStoredEnvironmentSnapshot(payload, ENV)).toEqual(record);
    // The incremental serializer writes the same bytes.
    const serialized = createEnvironmentSnapshotSerializer().serialize(
      withStub(environmentState(["thread-1"]), "archived-1"),
      ENV,
      123,
    );
    expect(serialized.payload).toBe(payload);
  });

  it("still reads a v1 record, which only ever held full shells", () => {
    const record = captureEnvironmentSnapshotRecord(environmentState(["thread-1"]), ENV, 123);
    const legacy = JSON.stringify({ ...record, schemaVersion: 1 });
    const decoded = decodeStoredEnvironmentSnapshot(legacy, ENV);
    expect(decoded?.threads.map((thread) => thread.shell.id)).toEqual(["thread-1"]);
  });

  it("still reads a v2 record, stubs included, which carries no content", () => {
    const record = captureEnvironmentSnapshotRecord(
      withStub(environmentState(["thread-1"]), "archived-1"),
      ENV,
      123,
    );
    const legacy = JSON.stringify({
      ...record,
      schemaVersion: 2,
      // A v2 writer never stored content; a stray key is not read as it.
      content: { "thread-1": { messages: [] } },
    });
    const decoded = decodeStoredEnvironmentSnapshot(legacy, ENV);
    expect(decoded?.schemaVersion).toBe(2);
    expect(decoded?.threads.map((thread) => thread.shell.id)).toEqual(["thread-1", "archived-1"]);
    expect(decoded).not.toHaveProperty("content");
  });

  it("discards a v1 record that claims a stub, and half a stub in any record", () => {
    const record = captureEnvironmentSnapshotRecord(
      withStub(environmentState([]), "archived-1"),
      ENV,
      123,
    );
    const { payload } = boundStoredEnvironmentSnapshot(record);
    expect(
      decodeStoredEnvironmentSnapshot(
        JSON.stringify({ ...(JSON.parse(payload) as object), schemaVersion: 1 }),
        ENV,
      ),
    ).toBeNull();
    const half = JSON.parse(payload) as { threads: Array<{ summary: unknown }> };
    half.threads[0]!.summary = summary("archived-1");
    expect(decodeStoredEnvironmentSnapshot(JSON.stringify(half), ENV)).toBeNull();
  });

  it("projects a stored stub into shared metadata as a marked stub", () => {
    const record = captureEnvironmentSnapshotRecord(
      withStub(environmentState(["thread-1"]), "archived-1"),
      ENV,
      123,
    );
    const threads = new Map(
      toWorkspaceMetadataSnapshot(record).threads.map((thread) => [thread.id, thread]),
    );
    expect(threads.get("archived-1" as never)).toMatchObject({
      shellDetail: "archived-stub",
      archivedAt: "2026-08-02T00:00:00.000Z",
      modelSelection: null,
    });
    expect(threads.get("thread-1" as never)).not.toHaveProperty("shellDetail");
  });

  it("discards corrupt JSON and identity mismatches", () => {
    const record = captureEnvironmentSnapshotRecord(environmentState(["thread-1"]), ENV, 123);
    const { payload } = boundStoredEnvironmentSnapshot(record);
    expect(decodeStoredEnvironmentSnapshot("{not-json", ENV)).toBeNull();
    expect(decodeStoredEnvironmentSnapshot(payload, "other-env" as EnvironmentId)).toBeNull();
  });

  it("caps threads at the per-environment bound, dropping archived and oldest first", () => {
    const state = environmentState(["old", "archived", "new"]);
    const shells = state.threadShellById as Record<string, ThreadShell>;
    shells["archived"] = shell("archived", { archivedAt: "2026-08-02T00:00:00.000Z" });
    const summaries = state.sidebarThreadSummaryById as Record<string, SidebarThreadSummary>;
    summaries["old"] = summary("old", { updatedAt: "2026-08-01T00:00:00.000Z" });
    summaries["archived"] = summary("archived", { updatedAt: "2026-08-03T00:00:00.000Z" });
    summaries["new"] = summary("new", { updatedAt: "2026-08-04T00:00:00.000Z" });

    const record = captureEnvironmentSnapshotRecord(state, ENV, 1);
    const { record: bounded } = boundStoredEnvironmentSnapshot(record, {
      maxThreads: 1,
      maxPayloadBytes: 10_000_000,
    });
    expect(bounded.threads.map((thread) => thread.shell.id)).toEqual(["new"]);
  });

  it("re-serializes under the byte cap by shedding threads while keeping projects", () => {
    const state = environmentState(["a", "b", "c", "d"]);
    const record = captureEnvironmentSnapshotRecord(state, ENV, 1);
    const { record: bounded, payload } = boundStoredEnvironmentSnapshot(record, {
      maxThreads: 100,
      maxPayloadBytes: 1_200,
    });
    expect(bounded.threads.length).toBeLessThan(4);
    expect(bounded.projects).toHaveLength(1);
    expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(1_200);
  });
});

describe("incremental environment snapshot serializer", () => {
  const caps = { maxThreads: 100, maxPayloadBytes: 10_000_000 };
  function expectSameAsFullSerialization(
    state: EnvironmentState,
    serialized: { readonly payload: string; readonly payloadBytes: number },
    capturedAt: number,
    bounds = caps,
  ) {
    const full = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, capturedAt),
      bounds,
    );
    expect(serialized.payload).toBe(full.payload);
    expect(serialized.payloadBytes).toBe(new TextEncoder().encode(serialized.payload).byteLength);
    expect(serialized.payloadBytes).toBe(full.payloadBytes);
  }

  it("writes the payload the full serialization writes, byte for byte", () => {
    const state = environmentState(["a", "b", "c"]);
    const shells = state.threadShellById as Record<string, ThreadShell>;
    // Non-ASCII, astral and lone-surrogate text all measure like TextEncoder.
    shells["b"] = shell("b", { title: "Grüße 👋 \ud800 end" });
    const serializer = createEnvironmentSnapshotSerializer(caps);
    expectSameAsFullSerialization(state, serializer.serialize(state, ENV, 5), 5);
    expectSameAsFullSerialization(
      environmentState([]),
      createEnvironmentSnapshotSerializer(caps).serialize(environmentState([]), ENV, 5),
      5,
    );
  });

  it("re-serializes only the threads whose shell or summary changed", () => {
    const state = environmentState(["a", "b", "c", "d"]);
    const serializer = createEnvironmentSnapshotSerializer(caps);
    serializer.serialize(state, ENV, 1);
    expect(serializer.serializedThreadCount()).toBe(4);

    // A streaming turn bumps one thread's updatedAt: its shell and summary are
    // replaced, every other row keeps its store objects.
    const summaries = state.sidebarThreadSummaryById as Record<string, SidebarThreadSummary>;
    const shells = state.threadShellById as Record<string, ThreadShell>;
    const next: EnvironmentState = {
      ...state,
      threadShellById: { ...shells, c: { ...shells["c"]!, updatedAt: "2026-08-05T00:00:00.000Z" } },
      sidebarThreadSummaryById: {
        ...summaries,
        c: { ...summaries["c"]!, updatedAt: "2026-08-05T00:00:00.000Z" },
      },
    } as EnvironmentState;
    const serialized = serializer.serialize(next, ENV, 2);
    expect(serializer.serializedThreadCount()).toBe(5);
    expectSameAsFullSerialization(next, serialized, 2);

    // Nothing changed: nothing is re-serialized.
    serializer.serialize(next, ENV, 3);
    expect(serializer.serializedThreadCount()).toBe(5);
  });

  it("drops a removed thread and bounds threads like the full serialization", () => {
    const state = environmentState(["old", "archived", "new"]);
    const shells = state.threadShellById as Record<string, ThreadShell>;
    shells["archived"] = shell("archived", { archivedAt: "2026-08-02T00:00:00.000Z" });
    const summaries = state.sidebarThreadSummaryById as Record<string, SidebarThreadSummary>;
    summaries["old"] = summary("old", { updatedAt: "2026-08-01T00:00:00.000Z" });
    summaries["archived"] = summary("archived", { updatedAt: "2026-08-03T00:00:00.000Z" });
    summaries["new"] = summary("new", { updatedAt: "2026-08-04T00:00:00.000Z" });

    const byCount = { maxThreads: 1, maxPayloadBytes: 10_000_000 };
    const serializer = createEnvironmentSnapshotSerializer(byCount);
    const serialized = serializer.serialize(state, ENV, 1);
    expect(serialized.threads).toBe(1);
    expectSameAsFullSerialization(state, serialized, 1, byCount);

    const removed = { ...state, threadIds: ["old", "new"] } as unknown as EnvironmentState;
    expectSameAsFullSerialization(removed, serializer.serialize(removed, ENV, 2), 2, byCount);
  });

  it("serializes and retains only the threads that survive the count cap", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `t${index}`);
    const state = environmentState(ids);
    const summaries = state.sidebarThreadSummaryById as Record<string, SidebarThreadSummary>;
    // Shuffled recency, so the survivors are not a prefix of the store order.
    ids.forEach((id, index) => {
      const minute = String((index * 7) % 12).padStart(2, "0");
      summaries[id] = summary(id, { updatedAt: `2026-08-01T00:${minute}:00.000Z` });
    });
    const byCount = { maxThreads: 4, maxPayloadBytes: 10_000_000 };
    const serializer = createEnvironmentSnapshotSerializer(byCount);
    const serialized = serializer.serialize(state, ENV, 1);
    expect(serialized.threads).toBe(4);
    expect(serializer.serializedThreadCount()).toBe(4);
    expectSameAsFullSerialization(state, serialized, 1, byCount);

    // An unchanged capture reuses the survivors' fragments.
    expectSameAsFullSerialization(state, serializer.serialize(state, ENV, 2), 2, byCount);
    expect(serializer.serializedThreadCount()).toBe(4);
  });

  it("sheds threads under the byte cap exactly like the full serialization", () => {
    const state = environmentState(["a", "b", "c", "d", "e", "f"]);
    const byBytes = { maxThreads: 100, maxPayloadBytes: 1_500 };
    const serialized = createEnvironmentSnapshotSerializer(byBytes).serialize(state, ENV, 1);
    expect(serialized.threads).toBeLessThan(6);
    expect(serialized.payloadBytes).toBeLessThanOrEqual(1_500);
    expectSameAsFullSerialization(state, serialized, 1, byBytes);
  });
});

function chatMessage(id: string, text: string): ChatMessage {
  return {
    id: id as never,
    role: "assistant",
    text,
    createdAt: "2026-08-01T00:00:00.000Z",
    streaming: false,
  };
}

/** Gives each listed thread messages, and orders the threads by their latest activity. */
function withMessages(
  state: EnvironmentState,
  byThread: Readonly<Record<string, ReadonlyArray<ChatMessage>>>,
): EnvironmentState {
  const summaries = { ...state.sidebarThreadSummaryById } as Record<string, SidebarThreadSummary>;
  Object.keys(byThread).forEach((id, index) => {
    summaries[id] = {
      ...summaries[id]!,
      updatedAt: `2026-08-02T00:${String(index).padStart(2, "0")}:00.000Z`,
    };
  });
  return {
    ...state,
    sidebarThreadSummaryById: summaries as never,
    messageIdsByThreadId: Object.fromEntries(
      Object.entries(byThread).map(([id, messages]) => [id, messages.map((entry) => entry.id)]),
    ) as never,
    messageByThreadId: Object.fromEntries(
      Object.entries(byThread).map(([id, messages]) => [
        id,
        Object.fromEntries(messages.map((entry) => [entry.id, entry])),
      ]),
    ) as never,
  };
}

const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;

describe("recent conversation content", () => {
  const roomy = { maxThreads: 400, maxPayloadBytes: 10_000_000 };
  const conversations = () =>
    withMessages(environmentState(["thread-1", "thread-2", "thread-3"]), {
      "thread-1": [chatMessage("m1", "first conversation"), chatMessage("m2", "its reply")],
      "thread-2": [chatMessage("m3", "second conversation, with naïve 日本語 text")],
    });
  const candidatesOf = (state: EnvironmentState) =>
    captureEnvironmentContentCandidates(state, ENV, createThreadContentCapture());

  it("round-trips bounded message text with the shell", () => {
    const state = conversations();
    const { record, payload } = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 123),
      roomy,
      candidatesOf(state),
    );
    expect(Object.keys(record.content ?? {})).toEqual(["thread-1", "thread-2"]);
    const decoded = decodeStoredEnvironmentSnapshot(payload, ENV);
    expect(decoded).toEqual(record);
    expect(decoded?.content?.["thread-1"]?.messages.map((entry) => entry.text)).toEqual([
      "first conversation",
      "its reply",
    ]);
    expect(decoded?.threads).toHaveLength(3);
  });

  it("writes no content key when there is nothing to keep", () => {
    const state = environmentState(["thread-1"]);
    const { payload } = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 1),
      roomy,
      candidatesOf(state),
    );
    expect(JSON.parse(payload)).not.toHaveProperty("content");
  });

  it("lists the least recently active conversations first, at most the shared thread limit", () => {
    const ids = Array.from({ length: THREAD_CONTENT_CACHE_MAX_THREADS + 8 }, (_, i) => `t${i}`);
    const state = withMessages(
      environmentState(ids),
      Object.fromEntries(ids.map((id) => [id, [chatMessage(`m-${id}`, id)]])),
    );
    const candidates = candidatesOf(state);
    expect(candidates).toHaveLength(THREAD_CONTENT_CACHE_MAX_THREADS);
    // Activity follows the order of `ids`, so the newest conversation is last
    // and the eight oldest are the ones left out.
    expect(candidates.at(0)?.threadId).toBe("t8");
    expect(candidates.at(-1)?.threadId).toBe(ids.at(-1));
  });

  it("drops the least recently active content first and never a thread of the shell", () => {
    const text = (label: string) => `${label} ${"x".repeat(2_000)}`;
    const state = withMessages(environmentState(["old", "middle", "new"]), {
      old: [chatMessage("m1", text("old"))],
      middle: [chatMessage("m2", text("middle"))],
      new: [chatMessage("m3", text("new"))],
    });
    const candidates = candidatesOf(state);
    const shellOnly = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 1),
      roomy,
    );
    const body = shellOnly.payloadBytes + utf8Length(',"content":');
    const entryBytes = (id: string) => candidates.find((c) => c.threadId === id)!.entryBytes;

    // Room for two of the three entries: the oldest is dropped.
    const twoEntries = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 1),
      { ...roomy, maxPayloadBytes: body + 2 + entryBytes("middle") + entryBytes("new") + 1 },
      candidates,
    );
    expect(Object.keys(twoEntries.record.content ?? {})).toEqual(["middle", "new"]);
    expect(twoEntries.record.threads).toHaveLength(3);
    expect(twoEntries.payloadBytes).toBe(utf8Length(twoEntries.payload));

    // One byte less and the next entry goes too.
    const oneEntry = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 1),
      { ...roomy, maxPayloadBytes: body + 2 + entryBytes("middle") + entryBytes("new") },
      candidates,
    );
    expect(Object.keys(oneEntry.record.content ?? {})).toEqual(["new"]);

    // A cap the shell alone fills leaves no content, and still the whole shell.
    const none = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 1),
      { ...roomy, maxPayloadBytes: shellOnly.payloadBytes },
      candidates,
    );
    expect(none.record).not.toHaveProperty("content");
    expect(none.record.threads).toHaveLength(3);
    expect(none.payload).toBe(shellOnly.payload);
  });

  it("holds message text to its own cap, below the record cap", () => {
    const text = (label: string) => `${label} ${"x".repeat(2_000)}`;
    const state = withMessages(environmentState(["old", "middle", "new"]), {
      old: [chatMessage("m1", text("old"))],
      middle: [chatMessage("m2", text("middle"))],
      new: [chatMessage("m3", text("new"))],
    });
    const candidates = candidatesOf(state);
    const entryBytes = (id: string) => candidates.find((c) => c.threadId === id)!.entryBytes;
    const contentObjectBytes = 2 + entryBytes("middle") + entryBytes("new") + 1;

    // The record cap leaves room for all three; the text cap keeps the two newest.
    const capped = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 1),
      { ...roomy, maxContentBytes: contentObjectBytes },
      candidates,
    );
    expect(Object.keys(capped.record.content ?? {})).toEqual(["middle", "new"]);
    expect(capped.record.threads).toHaveLength(3);

    const tighter = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 1),
      { ...roomy, maxContentBytes: contentObjectBytes - 1 },
      candidates,
    );
    expect(Object.keys(tighter.record.content ?? {})).toEqual(["new"]);

    // The incremental serializer holds to the same cap.
    const serialized = createEnvironmentSnapshotSerializer({
      ...roomy,
      maxContentBytes: contentObjectBytes,
    }).serialize(state, ENV, 1, { content: true });
    expect(serialized.contentThreads).toBe(2);
    expect(serialized.payload).toBe(capped.payload);

    // By default the cap is an equal share of the total cache budget.
    expect(MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT).toBe(
      MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES / MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
    );
    expect(MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT).toBeLessThan(
      MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT,
    );
  });

  it("keeps content only for threads the shell keeps", () => {
    const state = withMessages(environmentState(["old", "new"]), {
      old: [chatMessage("m1", "old text")],
      new: [chatMessage("m2", "new text")],
    });
    const summaries = state.sidebarThreadSummaryById as Record<string, SidebarThreadSummary>;
    summaries["old"] = summary("old", { updatedAt: "2026-08-01T00:00:00.000Z" });
    summaries["new"] = summary("new", { updatedAt: "2026-08-09T00:00:00.000Z" });
    const { record } = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 1),
      { maxThreads: 1, maxPayloadBytes: 10_000_000 },
      candidatesOf(state),
    );
    expect(record.threads.map((thread) => thread.shell.id)).toEqual(["new"]);
    expect(Object.keys(record.content ?? {})).toEqual(["new"]);
  });

  it("ignores content that does not decode and keeps the rest of the record", () => {
    const state = conversations();
    const { payload } = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 123),
      roomy,
      candidatesOf(state),
    );
    const stored = JSON.parse(payload) as { content: Record<string, unknown> };
    const decode = (content: unknown) =>
      decodeStoredEnvironmentSnapshot(JSON.stringify({ ...stored, content }), ENV);

    const partial = decode({
      "thread-1": { messages: "not a list" },
      "thread-2": stored.content["thread-2"],
      "thread-3": { messages: [{ id: "" }] },
      "no-such-thread": stored.content["thread-1"],
    });
    expect(Object.keys(partial?.content ?? {})).toEqual(["thread-2"]);
    expect(partial?.threads).toHaveLength(3);

    for (const garbage of ["text", 7, null, [], { "thread-1": 4 }]) {
      const decoded = decode(garbage);
      expect(decoded?.threads).toHaveLength(3);
      expect(decoded).not.toHaveProperty("content");
    }
  });

  it("hands stored content to the store only when asked to", () => {
    const state = conversations();
    const { record } = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 123),
      roomy,
      candidatesOf(state),
    );
    const shown = toCachedEnvironmentShellSnapshot(record, { includeContent: true });
    expect(
      Object.fromEntries(
        shown.threads.map((thread) => [thread.shell.id, thread.content?.messages.length]),
      ),
    ).toEqual({ "thread-1": 2, "thread-2": 1, "thread-3": undefined });

    const hidden = toCachedEnvironmentShellSnapshot(record, { includeContent: false });
    expect(hidden.threads).toBe(record.threads);
    expect(hidden.threads.some((thread) => "content" in thread)).toBe(false);
  });

  it("removes stored content from a payload and leaves the shell as written", () => {
    const state = conversations();
    const withContent = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 123),
      roomy,
      candidatesOf(state),
    );
    const shellOnly = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 123),
      roomy,
    );
    expect(withoutStoredContent(withContent.payload)).toBe(shellOnly.payload);
    expect(withoutStoredContent(shellOnly.payload)).toBeNull();
    expect(withoutStoredContent("{not-json")).toBeNull();
    expect(withoutStoredContent("[]")).toBeNull();
  });
});

describe("incremental serializer with content", () => {
  const roomy = { maxThreads: 400, maxPayloadBytes: 10_000_000 };
  const ids = ["a", "b", "c", "d"];
  const stateWithMessages = () =>
    withMessages(environmentState(ids), {
      a: [chatMessage("ma", "Grüße 👋 \ud800 from a")],
      b: [chatMessage("mb", "plain b"), chatMessage("mb2", "second b")],
      c: [chatMessage("mc", "c")],
    });

  function expectSameAsFull(
    state: EnvironmentState,
    serialized: { readonly payload: string; readonly payloadBytes: number },
    caps = roomy,
  ) {
    const full = boundStoredEnvironmentSnapshot(
      captureEnvironmentSnapshotRecord(state, ENV, 5),
      caps,
      captureEnvironmentContentCandidates(state, ENV, createThreadContentCapture()),
    );
    expect(serialized.payload).toBe(full.payload);
    expect(serialized.payloadBytes).toBe(utf8Length(serialized.payload));
    expect(serialized.payloadBytes).toBe(full.payloadBytes);
  }

  it("writes the payload the full serialization writes, byte for byte", () => {
    const state = stateWithMessages();
    const serialized = createEnvironmentSnapshotSerializer(roomy).serialize(state, ENV, 5, {
      content: true,
    });
    expect(serialized.contentThreads).toBe(3);
    expect(JSON.parse(serialized.payload).content).toHaveProperty("a");
    expectSameAsFull(state, serialized);
    expect(decodeStoredEnvironmentSnapshot(serialized.payload, ENV)?.content).toBeDefined();
  });

  it("writes no content unless asked, even when threads hold messages", () => {
    const state = stateWithMessages();
    const serializer = createEnvironmentSnapshotSerializer(roomy);
    const without = serializer.serialize(state, ENV, 5);
    expect(without.contentThreads).toBe(0);
    expect(without.payload).toBe(
      boundStoredEnvironmentSnapshot(captureEnvironmentSnapshotRecord(state, ENV, 5), roomy)
        .payload,
    );
    expect(serializer.serialize(state, ENV, 5, { content: false }).payload).toBe(without.payload);
    // Turned on again, the content is back.
    expect(serializer.serialize(state, ENV, 5, { content: true }).contentThreads).toBe(3);
  });

  it("follows changes to a thread's messages and to the threads kept", () => {
    const state = stateWithMessages();
    const serializer = createEnvironmentSnapshotSerializer(roomy);
    expectSameAsFull(state, serializer.serialize(state, ENV, 5, { content: true }));

    const changed = withMessages(state, {
      a: [chatMessage("ma", "Grüße 👋 \ud800 from a")],
      b: [chatMessage("mb", "plain b"), chatMessage("mb2", "second b"), chatMessage("mb3", "new")],
      c: [chatMessage("mc", "c")],
    });
    expectSameAsFull(changed, serializer.serialize(changed, ENV, 5, { content: true }));

    const removed = { ...changed, threadIds: ["a", "c"] } as unknown as EnvironmentState;
    const serialized = serializer.serialize(removed, ENV, 5, { content: true });
    expectSameAsFull(removed, serialized);
    expect(Object.keys(JSON.parse(serialized.payload).content)).toEqual(["a", "c"]);
  });

  it("trims content to the byte cap exactly like the full serialization", () => {
    const state = withMessages(environmentState(["x", "y", "z"]), {
      x: [chatMessage("mx", `x ${"1".repeat(3_000)}`)],
      y: [chatMessage("my", `y ${"2".repeat(3_000)}`)],
      z: [chatMessage("mz", `z ${"3".repeat(3_000)}`)],
    });
    const shellBytes = createEnvironmentSnapshotSerializer(roomy).serialize(
      state,
      ENV,
      5,
    ).payloadBytes;
    for (const room of [0, 3_500, 7_000, 12_000]) {
      const caps = { ...roomy, maxPayloadBytes: shellBytes + room };
      const serialized = createEnvironmentSnapshotSerializer(caps).serialize(state, ENV, 5, {
        content: true,
      });
      expect(serialized.payloadBytes).toBeLessThanOrEqual(caps.maxPayloadBytes);
      expectSameAsFull(state, serialized, caps);
    }
    // The tightest cap keeps every shell thread and no content.
    const tight = createEnvironmentSnapshotSerializer({
      ...roomy,
      maxPayloadBytes: shellBytes,
    }).serialize(state, ENV, 5, { content: true });
    expect(tight.threads).toBe(3);
    expect(tight.contentThreads).toBe(0);
  });
});
