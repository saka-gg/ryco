import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  EnvironmentState,
  Project,
  SidebarThreadSummary,
  ThreadShell,
  ThreadSession,
} from "../state/threadsRuntime";
import {
  boundStoredEnvironmentSnapshot,
  captureEnvironmentSnapshotRecord,
  createEnvironmentSnapshotSerializer,
  decodeStoredEnvironmentSnapshot,
  ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION,
  toWorkspaceMetadataSnapshot,
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
    expect(record.threads[0]?.summary.session).toBeNull();
    expect(record.threads[0]?.summary.backgroundLiveness).toBeNull();
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

  it("discards a record whose schemaVersion literal does not match — a bump in either direction", () => {
    const record = captureEnvironmentSnapshotRecord(environmentState(["thread-1"]), ENV, 123);
    const { payload } = boundStoredEnvironmentSnapshot(record);
    const bumped = JSON.stringify({
      ...(JSON.parse(payload) as Record<string, unknown>),
      schemaVersion: ENVIRONMENT_SNAPSHOT_SCHEMA_VERSION + 1,
    });
    expect(decodeStoredEnvironmentSnapshot(bumped, ENV)).toBeNull();
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
