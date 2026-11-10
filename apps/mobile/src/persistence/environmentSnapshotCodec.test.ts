import type { EnvironmentId, OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
  MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES,
} from "@ryco/client-runtime/state/workspace";
import {
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
  createEnvironmentRowSerializer,
  decodeStoredEnvironmentEnvelope,
  decodeStoredEnvironmentSnapshot,
  decodeStoredEnvironmentThread,
  decodeStoredThreadBody,
  encodeStoredThreadBody,
  environmentRowsFromLegacyRecord,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
  MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT,
  MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT,
  toWorkspaceMetadataSnapshot,
  type StoredEnvironmentSnapshot,
} from "./environmentSnapshotCodec";
import { payloadHash } from "./snapshotDb";

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
const roomy = { maxThreads: 400, maxPayloadBytes: 10_000_000 };

/** The rows of a state, decoded back. */
function decodedRows(state: EnvironmentState, caps = roomy) {
  const rows = createEnvironmentRowSerializer(caps).serialize(state, ENV);
  return {
    rows,
    envelope: decodeStoredEnvironmentEnvelope(rows.envelope.payload, ENV),
    threads: rows.threads.map((row) => decodeStoredEnvironmentThread(row.payload, ENV)),
  };
}

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

/** A single-row record as a v1 to v3 build wrote it. */
function legacyRecord(
  state: EnvironmentState,
  schemaVersion: 1 | 2 | 3,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion,
    environmentId: ENV,
    capturedAt: 123,
    projects: state.projectIds.map((id) => state.projectById[id]),
    worktrees: [],
    threads: state.threadIds.map((id) => ({
      shell: state.threadShellById[id],
      summary: isArchivedThreadStub(state.sidebarThreadSummaryById[id])
        ? state.sidebarThreadSummaryById[id]
        : { ...state.sidebarThreadSummaryById[id], session: null, backgroundLiveness: null },
    })),
    ...extra,
  });
}

describe("environment rows", () => {
  it("writes the envelope without capture time and threads with sessions and liveness stripped", () => {
    const { rows, envelope, threads } = decodedRows(environmentState(["thread-1"]));
    expect(envelope).toMatchObject({
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
      environmentId: ENV,
      projects: [{ id: "project-1" }],
    });
    expect(JSON.parse(rows.envelope.payload)).not.toHaveProperty("capturedAt");
    expect(rows.projectCount).toBe(1);
    expect(threads).toHaveLength(1);
    expect(fullThreadEntry(threads[0]?.summary)?.session).toBeNull();
    expect(fullThreadEntry(threads[0]?.summary)?.backgroundLiveness).toBeNull();
    for (const row of rows.threads) {
      expect(row.bytes).toBe(utf8Length(row.payload));
      expect(row.hash).toBe(payloadHash(row.payload));
    }
    expect(rows.envelope.bytes).toBe(utf8Length(rows.envelope.payload));
  });

  it("measures non-ASCII, astral and lone-surrogate text like TextEncoder", () => {
    const state = environmentState(["a", "b"]);
    (state.threadShellById as Record<string, ThreadShell>)["b"] = shell("b", {
      title: "Grüße 👋 \ud800 end",
    });
    const { rows } = decodedRows(state);
    let total = rows.envelope.bytes;
    for (const row of rows.threads) {
      expect(row.bytes).toBe(utf8Length(row.payload));
      total += row.bytes;
    }
    expect(rows.bytes).toBe(total);
  });

  it("writes stubs whole and reads them back; half a stub is left out", () => {
    const { threads } = decodedRows(withStub(environmentState(["thread-1"]), "archived-1"));
    const stored = threads.find((thread) => thread?.shell.id === "archived-1");
    expect(isArchivedThreadStub(stored?.shell)).toBe(true);
    expect(stored?.summary).toEqual(archivedStub("archived-1"));
    const half = JSON.stringify({
      shell: archivedStub("archived-1"),
      summary: summary("archived-1"),
    });
    expect(decodeStoredEnvironmentThread(half, ENV)).toBeNull();
  });

  it("discards an envelope of another version or machine, and corrupt rows", () => {
    const { rows } = decodedRows(environmentState(["thread-1"]));
    for (const schemaVersion of [ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION + 1, 3, 0]) {
      const bumped = JSON.stringify({ ...JSON.parse(rows.envelope.payload), schemaVersion });
      expect(decodeStoredEnvironmentEnvelope(bumped, ENV)).toBeNull();
    }
    expect(
      decodeStoredEnvironmentEnvelope(rows.envelope.payload, "other" as EnvironmentId),
    ).toBeNull();
    expect(decodeStoredEnvironmentEnvelope("{not-json", ENV)).toBeNull();
    expect(decodeStoredEnvironmentThread("{not-json", ENV)).toBeNull();
    expect(
      decodeStoredEnvironmentThread(rows.threads[0]!.payload, "other" as EnvironmentId),
    ).toBeNull();
  });

  it("caps threads at the per-environment bound, dropping archived and oldest first", () => {
    const state = environmentState(["old", "archived", "new"]);
    const shells = state.threadShellById as Record<string, ThreadShell>;
    shells["archived"] = shell("archived", { archivedAt: "2026-08-02T00:00:00.000Z" });
    const summaries = state.sidebarThreadSummaryById as Record<string, SidebarThreadSummary>;
    summaries["old"] = summary("old", { updatedAt: "2026-08-01T00:00:00.000Z" });
    summaries["archived"] = summary("archived", { updatedAt: "2026-08-03T00:00:00.000Z" });
    summaries["new"] = summary("new", { updatedAt: "2026-08-04T00:00:00.000Z" });

    const serializer = createEnvironmentRowSerializer({
      maxThreads: 1,
      maxPayloadBytes: 10_000_000,
    });
    expect(serializer.serialize(state, ENV).threads.map((row) => row.threadId)).toEqual(["new"]);
    // Threads beyond the cap are not even serialized.
    expect(serializer.serializedThreadCount()).toBe(1);
  });

  it("sheds threads under the byte cap while keeping projects", () => {
    const state = environmentState(["a", "b", "c", "d"]);
    const rows = createEnvironmentRowSerializer({
      maxThreads: 100,
      maxPayloadBytes: 1_200,
    }).serialize(state, ENV);
    expect(rows.threads.length).toBeLessThan(4);
    expect(rows.projectCount).toBe(1);
    expect(rows.bytes).toBeLessThanOrEqual(1_200);
  });

  it("re-serializes only the threads whose shell or summary changed", () => {
    const state = environmentState(["a", "b", "c", "d"]);
    const serializer = createEnvironmentRowSerializer(roomy);
    const first = serializer.serialize(state, ENV);
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
    const second = serializer.serialize(next, ENV);
    expect(serializer.serializedThreadCount()).toBe(5);
    const changed = second.threads.filter((row, index) => row.hash !== first.threads[index]?.hash);
    expect(changed.map((row) => row.threadId)).toEqual(["c"]);
    expect(second.envelope.payload).toBe(first.envelope.payload);

    serializer.serialize(next, ENV);
    expect(serializer.serializedThreadCount()).toBe(5);
  });
});

describe("thread bodies", () => {
  const conversations = () =>
    withMessages(environmentState(["thread-1", "thread-2", "thread-3"]), {
      "thread-1": [chatMessage("m1", "first conversation"), chatMessage("m2", "its reply")],
      "thread-2": [chatMessage("m3", "second conversation, with naïve 日本語 text")],
    });

  it("keeps bodies only while asked to, for threads with messages, least recent first", () => {
    const state = conversations();
    const serializer = createEnvironmentRowSerializer(roomy);
    expect(serializer.serialize(state, ENV).bodies).toEqual([]);
    const rows = serializer.serialize(state, ENV, { content: true });
    expect(rows.bodies.map((body) => body.threadId)).toEqual(["thread-1", "thread-2"]);
    const decoded = decodeStoredThreadBody(rows.bodies[0]!.payload);
    expect(decoded?.content?.messages.map((entry) => entry.text)).toEqual([
      "first conversation",
      "its reply",
    ]);
    expect(decoded?.prompts).toEqual([]);
    expect(rows.bytes).toBe(
      rows.envelope.bytes +
        rows.threads.reduce((sum, row) => sum + row.bytes, 0) +
        rows.bodies.reduce((sum, row) => sum + row.bytes, 0),
    );
  });

  it("saves each body with the sequence its thread window was current to", () => {
    const rows = createEnvironmentRowSerializer(roomy).serialize(conversations(), ENV, {
      content: true,
      readSequence: (threadId) => (threadId === "thread-1" ? 42 : null),
    });
    expect(rows.bodies.map((body) => [body.threadId, body.sequence])).toEqual([
      ["thread-1", 42],
      ["thread-2", null],
    ]);
  });

  it("lists at most the shared thread limit, the newest kept", () => {
    const ids = Array.from({ length: THREAD_CONTENT_CACHE_MAX_THREADS + 8 }, (_, i) => `t${i}`);
    const state = withMessages(
      environmentState(ids),
      Object.fromEntries(ids.map((id) => [id, [chatMessage(`m-${id}`, id)]])),
    );
    const bodies = createEnvironmentRowSerializer(roomy).serialize(state, ENV, {
      content: true,
    }).bodies;
    expect(bodies).toHaveLength(THREAD_CONTENT_CACHE_MAX_THREADS);
    expect(bodies.at(0)?.threadId).toBe("t8");
    expect(bodies.at(-1)?.threadId).toBe(ids.at(-1));
  });

  it("drops the least recently active bodies first under both caps, never a thread", () => {
    const text = (label: string) => `${label} ${"x".repeat(2_000)}`;
    const state = withMessages(environmentState(["old", "middle", "new"]), {
      old: [chatMessage("m1", text("old"))],
      middle: [chatMessage("m2", text("middle"))],
      new: [chatMessage("m3", text("new"))],
    });
    const all = createEnvironmentRowSerializer(roomy).serialize(state, ENV, { content: true });
    const shellBytes = all.bytes - all.bodies.reduce((sum, body) => sum + body.bytes, 0);
    const bytesOf = (id: string) => all.bodies.find((body) => body.threadId === id)!.bytes;
    // `trimContentToBudget` counts two braces and a comma between entries.
    const room = 2 + bytesOf("middle") + bytesOf("new") + 1;
    const kept = (caps: { maxPayloadBytes: number; maxContentBytes?: number }) =>
      createEnvironmentRowSerializer({ maxThreads: 400, ...caps }).serialize(state, ENV, {
        content: true,
      });

    const byPayload = kept({ maxPayloadBytes: shellBytes + room });
    expect(byPayload.bodies.map((body) => body.threadId)).toEqual(["middle", "new"]);
    expect(byPayload.threads).toHaveLength(3);
    expect(kept({ maxPayloadBytes: shellBytes + room - 1 }).bodies.map((b) => b.threadId)).toEqual([
      "new",
    ]);
    const byContent = kept({ maxPayloadBytes: 10_000_000, maxContentBytes: room });
    expect(byContent.bodies.map((body) => body.threadId)).toEqual(["middle", "new"]);
    const none = kept({ maxPayloadBytes: shellBytes });
    expect(none.bodies).toEqual([]);
    expect(none.threads).toHaveLength(3);

    // By default the text cap is an equal share of the total cache budget.
    expect(MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT).toBe(
      MAX_WORKSPACE_SNAPSHOT_TOTAL_BYTES / MAX_WORKSPACE_SNAPSHOT_ENVIRONMENTS,
    );
    expect(MAX_SNAPSHOT_CONTENT_BYTES_PER_ENVIRONMENT).toBeLessThan(
      MAX_SNAPSHOT_PAYLOAD_BYTES_PER_ENVIRONMENT,
    );
  });

  it("keeps bodies only for threads the machine keeps", () => {
    const state = withMessages(environmentState(["old", "new"]), {
      old: [chatMessage("m1", "old text")],
      new: [chatMessage("m2", "new text")],
    });
    const summaries = state.sidebarThreadSummaryById as Record<string, SidebarThreadSummary>;
    summaries["old"] = summary("old", { updatedAt: "2026-08-01T00:00:00.000Z" });
    summaries["new"] = summary("new", { updatedAt: "2026-08-09T00:00:00.000Z" });
    const rows = createEnvironmentRowSerializer({
      maxThreads: 1,
      maxPayloadBytes: 10_000_000,
    }).serialize(state, ENV, { content: true });
    expect(rows.threads.map((row) => row.threadId)).toEqual(["new"]);
    expect(rows.bodies.map((row) => row.threadId)).toEqual(["new"]);
  });

  it("re-captures only the bodies whose messages or activities changed", () => {
    const state = conversations();
    const serializer = createEnvironmentRowSerializer(roomy);
    const first = serializer.serialize(state, ENV, { content: true });
    expect(serializer.serializedBodyCount()).toBe(2);
    const changed = withMessages(state, {
      "thread-1": [chatMessage("m1", "first conversation"), chatMessage("m2", "its reply")],
      "thread-2": [chatMessage("m3", "second"), chatMessage("m4", "more")],
    });
    // `withMessages` rebuilds every thread's slices: both are captured again,
    // and only the one whose text changed hashes differently.
    const second = serializer.serialize(changed, ENV, { content: true });
    expect(second.bodies[0]?.hash).toBe(first.bodies[0]?.hash);
    expect(second.bodies[1]?.hash).not.toBe(first.bodies[1]?.hash);
    const before = serializer.serializedBodyCount();
    serializer.serialize(changed, ENV, { content: true });
    expect(serializer.serializedBodyCount()).toBe(before);
  });

  it("saves open approval and question cards with a thread's body, and nothing answered", () => {
    const activity = (
      id: string,
      kind: string,
      payload: Record<string, unknown>,
      createdAt: string,
    ): OrchestrationThreadActivity =>
      ({
        id,
        kind,
        tone: "approval",
        summary: kind,
        payload,
        turnId: "turn-1",
        createdAt,
      }) as never;
    const activities = [
      activity(
        "a1",
        "approval.requested",
        { requestId: "req-open", requestKind: "command", detail: "rm -rf build", secretToken: "x" },
        "2026-08-02T00:00:00.000Z",
      ),
      activity(
        "a2",
        "approval.requested",
        { requestId: "req-done", requestKind: "command" },
        "2026-08-02T00:01:00.000Z",
      ),
      activity("a3", "approval.resolved", { requestId: "req-done" }, "2026-08-02T00:02:00.000Z"),
      activity("a4", "tool.completed", { output: "long tool output" }, "2026-08-02T00:03:00.000Z"),
    ];
    const state = {
      ...conversations(),
      activityIdsByThreadId: { "thread-1": activities.map((entry) => entry.id) },
      activityByThreadId: {
        "thread-1": Object.fromEntries(activities.map((entry) => [entry.id, entry])),
      },
    } as unknown as EnvironmentState;
    const rows = createEnvironmentRowSerializer(roomy).serialize(state, ENV, { content: true });
    const body = decodeStoredThreadBody(rows.bodies[0]!.payload);
    expect(body?.prompts.map((entry) => entry.id)).toEqual(["a1"]);
    expect(body?.prompts[0]?.payload).toEqual({
      requestId: "req-open",
      requestKind: "command",
      detail: "rm -rf build",
    });
  });

  it("reads back what it wrote and drops what does not decode", () => {
    const encoded = encodeStoredThreadBody({
      content: { messages: [chatMessage("m1", "hello")] },
      prompts: [],
    });
    expect(decodeStoredThreadBody(encoded!)?.content?.messages[0]?.text).toBe("hello");
    expect(encodeStoredThreadBody({ content: { messages: [] }, prompts: [] })).toBeNull();
    for (const garbage of ["{not-json", "[]", '{"messages":"x"}', '{"messages":[{"id":""}]}']) {
      expect(decodeStoredThreadBody(garbage)).toBeNull();
    }
  });
});

describe("single-row records of older builds", () => {
  it("still reads v1, v2 and v3 records", () => {
    const state = withStub(environmentState(["thread-1"]), "archived-1");
    expect(
      decodeStoredEnvironmentSnapshot(legacyRecord(environmentState(["thread-1"]), 1), ENV)
        ?.threads,
    ).toHaveLength(1);
    const v2 = decodeStoredEnvironmentSnapshot(
      // A v2 writer never stored content; a stray key is not read as it.
      legacyRecord(state, 2, { content: { "thread-1": { messages: [] } } }),
      ENV,
    );
    expect(v2?.threads.map((thread) => thread.shell.id)).toEqual(["thread-1", "archived-1"]);
    expect(v2).not.toHaveProperty("content");
    const v3 = decodeStoredEnvironmentSnapshot(
      legacyRecord(state, 3, {
        content: {
          "thread-1": { messages: [chatMessage("m1", "kept")] },
          "no-such-thread": { messages: [chatMessage("m2", "dropped")] },
          "archived-1": { messages: "not a list" },
        },
      }),
      ENV,
    );
    expect(Object.keys(v3?.content ?? {})).toEqual(["thread-1"]);
  });

  it("discards a record of an unknown version, a v1 stub, half a stub, corrupt JSON and another machine", () => {
    const state = withStub(environmentState([]), "archived-1");
    for (const schemaVersion of [ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION, 0]) {
      expect(
        decodeStoredEnvironmentSnapshot(legacyRecord(state, 3, { schemaVersion }), ENV),
      ).toBeNull();
    }
    expect(decodeStoredEnvironmentSnapshot(legacyRecord(state, 1), ENV)).toBeNull();
    const half = JSON.parse(legacyRecord(state, 2)) as { threads: Array<{ summary: unknown }> };
    half.threads[0]!.summary = summary("archived-1");
    expect(decodeStoredEnvironmentSnapshot(JSON.stringify(half), ENV)).toBeNull();
    expect(decodeStoredEnvironmentSnapshot("{not-json", ENV)).toBeNull();
    expect(
      decodeStoredEnvironmentSnapshot(legacyRecord(state, 2), "other-env" as EnvironmentId),
    ).toBeNull();
  });

  it("moves a record into rows, its text into bodies", () => {
    const record = decodeStoredEnvironmentSnapshot(
      legacyRecord(environmentState(["thread-1", "thread-2"]), 3, {
        content: { "thread-2": { messages: [chatMessage("m1", "kept text")] } },
      }),
      ENV,
    ) as StoredEnvironmentSnapshot;
    const rows = environmentRowsFromLegacyRecord(record);
    expect(decodeStoredEnvironmentEnvelope(rows.envelope.payload, ENV)?.projects).toHaveLength(1);
    expect(
      rows.threads.map((row) => decodeStoredEnvironmentThread(row.payload, ENV)?.shell.id),
    ).toEqual(["thread-1", "thread-2"]);
    expect(rows.bodies.map((row) => row.threadId)).toEqual(["thread-2"]);
    expect(decodeStoredThreadBody(rows.bodies[0]!.payload)?.content?.messages[0]?.text).toBe(
      "kept text",
    );
  });

  it("projects a record into shared metadata, stubs marked and lineage checked", () => {
    const lineage = {
      parentThreadId: "thread-parent" as never,
      rootThreadId: "thread-parent" as never,
      relationship: "delegated",
    };
    const state = withStub(environmentState(["thread-valid", "thread-malformed"]), "archived-1");
    (state.threadShellById as Record<string, ThreadShell>)["thread-valid"] = shell("thread-valid", {
      lineage,
    });
    (state.threadShellById as Record<string, ThreadShell>)["thread-malformed"] = shell(
      "thread-malformed",
      { lineage: { parentThreadId: "", relationship: 7 } as never },
    );
    const record = decodeStoredEnvironmentSnapshot(legacyRecord(state, 2), ENV)!;
    const shared = toWorkspaceMetadataSnapshot(record);
    expect(shared).toMatchObject({ schemaVersion: 1, environmentId: ENV, capturedAt: 123 });
    expect(shared.threads[0]).not.toHaveProperty("session");
    const threads = new Map(shared.threads.map((thread) => [thread.id, thread]));
    expect(threads.get("thread-valid" as never)?.lineage).toEqual(lineage);
    expect(threads.get("thread-malformed" as never)).not.toHaveProperty("lineage");
    expect(threads.get("archived-1" as never)).toMatchObject({
      shellDetail: "archived-stub",
      modelSelection: null,
    });
  });
});
