import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadWindowSnapshot,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deepFreeze } from "../../../test/deepFreeze.ts";
import { scopeThreadRef } from "../../scoped.ts";
import { createEnvironmentEventBatcher } from "./eventBatching.ts";
import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  applyShellEvent,
  demoteEnvironmentStateToCachedSnapshot,
  registerThreadStoreMutationBarrier,
  selectDelegatedChildThreadsForThreadRef,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForProjectRefs,
  selectSidebarWorktreesAcrossEnvironments,
  selectSidebarWorktreesForProjectRef,
  selectSidebarWorktreesForProjectRefs,
  selectThreadByRef,
  selectThreadShellsAcrossEnvironments,
  syncServerShellSnapshot,
  syncServerThreadWindow,
  useStore,
  type AppState,
} from "./store.ts";

const environmentId = EnvironmentId.make("environment-sharing");
const otherEnvironmentId = EnvironmentId.make("environment-other");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");

function makeThreadShell(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<ReturnType<typeof makeThreadShell>>,
  sequence = 1,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: sequence,
    projects: [projectId, otherProjectId].map((id) => ({
      id,
      title: `Project ${id}`,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    })),
    worktrees: [
      {
        worktreeId: WorktreeId.make("worktree-1"),
        projectId,
        title: null,
        branch: "feature",
        worktreePath: "/tmp/project-1-feature",
        origin: "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      },
    ],
    threads,
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
}

const emptyState: AppState = { activeEnvironmentId: null, environmentStateById: {} };

function environmentOf(state: AppState) {
  return state.environmentStateById[environmentId]!;
}

describe("shell snapshot structural sharing", () => {
  it("keeps every row object and container when an identical snapshot is re-applied", () => {
    const threads = [makeThreadShell("a"), makeThreadShell("b")];
    const first = syncServerShellSnapshot(emptyState, makeSnapshot(threads), environmentId);
    const second = syncServerShellSnapshot(first, makeSnapshot(threads, 2), environmentId);
    const before = environmentOf(first);
    const after = environmentOf(second);

    expect(after.threadIds).toBe(before.threadIds);
    expect(after.threadIdsByProjectId).toBe(before.threadIdsByProjectId);
    expect(after.threadShellById).toBe(before.threadShellById);
    expect(after.threadSessionById).toBe(before.threadSessionById);
    expect(after.threadTurnStateById).toBe(before.threadTurnStateById);
    expect(after.sidebarThreadSummaryById).toBe(before.sidebarThreadSummaryById);
    expect(after.projectIds).toBe(before.projectIds);
    expect(after.projectById).toBe(before.projectById);
    expect(after.worktreeIds).toBe(before.worktreeIds);
    expect(after.worktreeById).toBe(before.worktreeById);
    expect(selectSidebarThreadsAcrossEnvironments(second)).toBe(
      selectSidebarThreadsAcrossEnvironments(first),
    );
  });

  it("replaces only the rows that changed", () => {
    const first = syncServerShellSnapshot(
      emptyState,
      makeSnapshot([makeThreadShell("a"), makeThreadShell("b")]),
      environmentId,
    );
    const second = syncServerShellSnapshot(
      first,
      makeSnapshot([makeThreadShell("a"), makeThreadShell("b", { title: "Renamed" })], 2),
      environmentId,
    );
    const before = environmentOf(first);
    const after = environmentOf(second);
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");

    expect(after.threadIds).toBe(before.threadIds);
    expect(after.sidebarThreadSummaryById).not.toBe(before.sidebarThreadSummaryById);
    expect(after.sidebarThreadSummaryById[a]).toBe(before.sidebarThreadSummaryById[a]);
    expect(after.threadShellById[a]).toBe(before.threadShellById[a]);
    expect(after.sidebarThreadSummaryById[b]).not.toBe(before.sidebarThreadSummaryById[b]);
    expect(after.sidebarThreadSummaryById[b]?.title).toBe("Renamed");
    // The unchanged session and turn records keep their containers.
    expect(after.threadSessionById).toBe(before.threadSessionById);
    expect(after.threadTurnStateById).toBe(before.threadTurnStateById);

    const rows = selectSidebarThreadsAcrossEnvironments(second);
    expect(rows).not.toBe(selectSidebarThreadsAcrossEnvironments(first));
    expect(rows[0]).toBe(before.sidebarThreadSummaryById[a]);
  });

  it("drops rows that left the snapshot", () => {
    const first = syncServerShellSnapshot(
      emptyState,
      makeSnapshot([makeThreadShell("a"), makeThreadShell("b")]),
      environmentId,
    );
    const second = syncServerShellSnapshot(
      first,
      makeSnapshot([makeThreadShell("a")], 2),
      environmentId,
    );
    const after = environmentOf(second);
    expect(after.threadIds).toEqual([ThreadId.make("a")]);
    expect(Object.keys(after.sidebarThreadSummaryById)).toEqual(["a"]);
    expect(selectSidebarThreadsAcrossEnvironments(second).map((thread) => thread.id)).toEqual([
      "a",
    ]);
  });
});

describe("published state immutability", () => {
  // Snapshot capture (mobile) skips writes when the id lists and row records
  // keep their identity; that is only sound if no transition mutates a
  // container it has already published.
  it("never mutates published containers on shell events or snapshot re-application", () => {
    const first = deepFreeze(
      syncServerShellSnapshot(
        emptyState,
        makeSnapshot([makeThreadShell("a"), makeThreadShell("b")]),
        environmentId,
      ),
    );
    const upserted = applyShellEvent(
      first,
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShell("a", { title: "Renamed", updatedAt: "2026-10-02T00:00:00.000Z" }),
      } as never,
      environmentId,
    );
    const added = deepFreeze(
      applyShellEvent(
        deepFreeze(upserted),
        { kind: "thread-upserted", sequence: 3, thread: makeThreadShell("c") } as never,
        environmentId,
      ),
    );
    const removed = deepFreeze(
      applyShellEvent(
        added,
        { kind: "thread-removed", sequence: 4, threadId: "b" } as never,
        environmentId,
      ),
    );
    const resynced = syncServerShellSnapshot(
      removed,
      makeSnapshot([makeThreadShell("a", { title: "Renamed again" }), makeThreadShell("d")], 5),
      environmentId,
    );

    expect(environmentOf(first).threadShellById[ThreadId.make("a")]?.title).toBe("Thread a");
    expect(environmentOf(upserted).threadShellById[ThreadId.make("a")]?.title).toBe("Renamed");
    expect(environmentOf(removed).threadIds).toEqual([ThreadId.make("a"), ThreadId.make("c")]);
    expect(environmentOf(resynced).threadIds).toEqual([ThreadId.make("a"), ThreadId.make("d")]);
    // Untouched slices keep their identity across the upsert.
    expect(environmentOf(upserted).projectById).toBe(environmentOf(first).projectById);
    expect(environmentOf(upserted).worktreeById).toBe(environmentOf(first).worktreeById);
  });
});

describe("slice-memoized selectors", () => {
  it("return the previous array while the selected slices are unchanged", () => {
    const state = syncServerShellSnapshot(
      emptyState,
      makeSnapshot([makeThreadShell("a"), makeThreadShell("b")]),
      environmentId,
    );
    const threads = selectSidebarThreadsAcrossEnvironments(state);
    const projects = selectProjectsAcrossEnvironments(state);
    const worktrees = selectSidebarWorktreesAcrossEnvironments(state);
    const shells = selectThreadShellsAcrossEnvironments(state);
    const refs = [
      { environmentId, projectId },
      { environmentId, projectId: otherProjectId },
    ];
    const projectThreads = selectSidebarThreadsForProjectRefs(state, refs);

    // A new environment record that only touches thread-detail content (the
    // shape of every streaming delta commit).
    const unrelated: AppState = {
      ...state,
      environmentStateById: {
        ...state.environmentStateById,
        [environmentId]: { ...environmentOf(state), messageIdsByThreadId: {} },
      },
    };
    expect(selectSidebarThreadsAcrossEnvironments(unrelated)).toBe(threads);
    expect(selectProjectsAcrossEnvironments(unrelated)).toBe(projects);
    expect(selectSidebarWorktreesAcrossEnvironments(unrelated)).toBe(worktrees);
    expect(selectThreadShellsAcrossEnvironments(unrelated)).toBe(shells);
    expect(selectSidebarThreadsForProjectRefs(unrelated, refs)).toBe(projectThreads);
    expect(threads.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(projectThreads.map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("keep worktree rows for projects without worktrees and delegated children", () => {
    const delegated = (parent: string) => ({
      lineage: {
        parentThreadId: ThreadId.make(parent),
        rootThreadId: ThreadId.make(parent),
        relationship: "delegated",
      },
    });
    const state = syncServerShellSnapshot(
      emptyState,
      makeSnapshot([
        makeThreadShell("parent"),
        makeThreadShell("child-2", {
          ...delegated("parent"),
          createdAt: "2026-10-03T00:00:00.000Z",
        }),
        makeThreadShell("child-1", {
          ...delegated("parent"),
          createdAt: "2026-10-02T00:00:00.000Z",
        }),
        makeThreadShell("other"),
      ]),
      environmentId,
    );
    const unrelated: AppState = {
      ...state,
      environmentStateById: {
        ...state.environmentStateById,
        [environmentId]: { ...environmentOf(state), messageIdsByThreadId: {} },
      },
    };
    const noWorktrees = { environmentId, projectId: otherProjectId };
    const refs = [{ environmentId, projectId }, noWorktrees];
    const parentRef = { environmentId, threadId: ThreadId.make("parent") };
    const draftRef = { environmentId, threadId: ThreadId.make("draft-without-shell") };

    const emptyWorktrees = selectSidebarWorktreesForProjectRef(state, noWorktrees);
    const combinedWorktrees = selectSidebarWorktreesForProjectRefs(state, refs);
    const children = selectDelegatedChildThreadsForThreadRef(state, parentRef);
    const draftChildren = selectDelegatedChildThreadsForThreadRef(state, draftRef);

    expect(emptyWorktrees).toEqual([]);
    expect(combinedWorktrees.map((worktree) => worktree.id)).toEqual(["worktree-1"]);
    expect(children.map((thread) => thread.id)).toEqual(["child-1", "child-2"]);
    expect(draftChildren).toEqual([]);
    expect(selectSidebarWorktreesForProjectRef(unrelated, noWorktrees)).toBe(emptyWorktrees);
    expect(selectSidebarWorktreesForProjectRefs(unrelated, refs)).toBe(combinedWorktrees);
    expect(selectDelegatedChildThreadsForThreadRef(unrelated, parentRef)).toBe(children);
    expect(selectDelegatedChildThreadsForThreadRef(unrelated, draftRef)).toBe(draftChildren);

    // Archiving a child changes its summary, so the children are recomputed.
    const archived = applyShellEvent(
      state,
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShell("child-1", {
          ...delegated("parent"),
          createdAt: "2026-10-02T00:00:00.000Z",
          archivedAt: "2026-10-04T00:00:00.000Z",
        }),
      } as never,
      environmentId,
    );
    expect(
      selectDelegatedChildThreadsForThreadRef(archived, parentRef).map((thread) => thread.id),
    ).toEqual(["child-2"]);
  });

  it("combine environments and follow environment removal", () => {
    const local = syncServerShellSnapshot(
      emptyState,
      makeSnapshot([makeThreadShell("a")]),
      environmentId,
    );
    const both = syncServerShellSnapshot(
      local,
      makeSnapshot([makeThreadShell("remote")]),
      otherEnvironmentId,
    );
    expect(selectSidebarThreadsAcrossEnvironments(both).map((thread) => thread.id)).toEqual([
      "a",
      "remote",
    ]);
    const { [otherEnvironmentId]: _removed, ...rest } = both.environmentStateById;
    const removed: AppState = { ...both, environmentStateById: rest };
    expect(selectSidebarThreadsAcrossEnvironments(removed).map((thread) => thread.id)).toEqual([
      "a",
    ]);
  });
});

describe("environment event batcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeBatcher(options: { maxPendingEvents?: number } = {}) {
    const frames: Array<() => void> = [];
    const applied: Array<{ environmentId: EnvironmentId; events: string[] }> = [];
    const batcher = createEnvironmentEventBatcher<string>({
      apply: (id, events) => applied.push({ environmentId: id, events: [...events] }),
      scheduleFrame: (callback) => frames.push(callback),
      scheduleFallback: () => undefined,
      registerStoreBarrier: false,
      ...(options.maxPendingEvents !== undefined
        ? { maxPendingEvents: options.maxPendingEvents }
        : {}),
    });
    return { batcher, frames, applied };
  }

  it("applies one batch per environment run per frame, in arrival order", () => {
    const { batcher, frames, applied } = makeBatcher();
    batcher.enqueue(environmentId, "1");
    batcher.enqueue(environmentId, "2");
    batcher.enqueue(otherEnvironmentId, "3");
    batcher.enqueue(environmentId, "4");
    expect(applied).toEqual([]);
    expect(frames).toHaveLength(1);
    frames[0]!();
    expect(applied).toEqual([
      { environmentId, events: ["1", "2"] },
      { environmentId: otherEnvironmentId, events: ["3"] },
      { environmentId, events: ["4"] },
    ]);
    expect(batcher.hasPending()).toBe(false);
  });

  it("applies synchronously once the pending bound is reached", () => {
    const { batcher, applied } = makeBatcher({ maxPendingEvents: 2 });
    batcher.enqueue(environmentId, "1");
    expect(applied).toEqual([]);
    batcher.enqueue(environmentId, "2");
    expect(applied).toEqual([{ environmentId, events: ["1", "2"] }]);
  });

  it("falls back to a timer when no frame runs", () => {
    vi.useFakeTimers();
    const applied: string[][] = [];
    const batcher = createEnvironmentEventBatcher<string>({
      apply: (_id, events) => applied.push([...events]),
      scheduleFrame: () => undefined,
      fallbackDelayMs: 50,
      registerStoreBarrier: false,
    });
    batcher.enqueue(environmentId, "1");
    vi.advanceTimersByTime(49);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual([["1"]]);
    batcher.dispose();
  });

  it("flushes buffered events before any other store mutation", () => {
    const order: string[] = [];
    const batcher = createEnvironmentEventBatcher<string>({
      apply: (_id, events) => order.push(...events.map((event) => `event:${event}`)),
      scheduleFrame: () => undefined,
      scheduleFallback: () => undefined,
    });
    try {
      batcher.enqueue(environmentId, "1");
      batcher.enqueue(environmentId, "2");
      useStore.getState().setActiveEnvironmentId(environmentId);
      order.push("mutation");
      expect(order).toEqual(["event:1", "event:2", "mutation"]);
    } finally {
      batcher.dispose();
    }
  });

  it("keeps applying later batches when one batch throws", () => {
    const applied: string[] = [];
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const batcher = createEnvironmentEventBatcher<string>({
        apply: (id, events) => {
          if (id === environmentId) throw new Error("bad batch");
          applied.push(...events);
        },
        scheduleFrame: () => undefined,
        scheduleFallback: () => undefined,
        registerStoreBarrier: false,
      });
      batcher.enqueue(environmentId, "1");
      batcher.enqueue(otherEnvironmentId, "2");
      expect(() => batcher.flush()).not.toThrow();
      expect(applied).toEqual(["2"]);
      expect(reportError).toHaveBeenCalledTimes(1);
    } finally {
      reportError.mockRestore();
    }
  });

  it("keeps scheduling frames after an event arrives while a batch applies", () => {
    const frames: Array<() => void> = [];
    const applied: string[][] = [];
    let enqueueDuringApply: string | null = "late";
    const batcher: ReturnType<typeof createEnvironmentEventBatcher<string>> =
      createEnvironmentEventBatcher<string>({
        apply: (_id, events) => {
          applied.push([...events]);
          if (enqueueDuringApply !== null) {
            const event = enqueueDuringApply;
            enqueueDuringApply = null;
            batcher.enqueue(environmentId, event);
          }
        },
        scheduleFrame: (callback) => frames.push(callback),
        scheduleFallback: () => undefined,
        registerStoreBarrier: false,
      });
    batcher.enqueue(environmentId, "1");
    frames.shift()!();
    // The late event was drained by the same flush; its scheduled run is stale.
    expect(applied).toEqual([["1"], ["late"]]);
    for (const frame of frames.splice(0)) frame();

    batcher.enqueue(environmentId, "2");
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(applied).toEqual([["1"], ["late"], ["2"]]);
  });

  it("re-enters safely when applying a batch mutates the store", () => {
    const applied: string[] = [];
    const unregister = registerThreadStoreMutationBarrier(() => undefined);
    const batcher = createEnvironmentEventBatcher<string>({
      apply: (_id, events) => {
        applied.push(...events);
        useStore.getState().setActiveEnvironmentId(environmentId);
      },
      scheduleFrame: () => undefined,
      scheduleFallback: () => undefined,
    });
    try {
      batcher.enqueue(environmentId, "1");
      batcher.enqueue(environmentId, "2");
      batcher.flush();
      expect(applied).toEqual(["1", "2"]);
      expect(batcher.hasPending()).toBe(false);
    } finally {
      batcher.dispose();
      unregister();
    }
  });
});

describe("frame-batched orchestration events", () => {
  afterEach(() => {
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  });

  function messageSent(sequence: number, threadId: string) {
    return {
      sequence,
      eventId: `event-${sequence}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-10-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: `message-${sequence}`,
        role: "assistant",
        text: `delta ${sequence}`,
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    } as unknown as OrchestrationEvent;
  }

  it("loses only the failing event of a batch, not the whole batch", () => {
    useStore
      .getState()
      .syncServerShellSnapshot(
        makeSnapshot([makeThreadShell("a"), makeThreadShell("b")]),
        environmentId,
      );
    // A malformed event makes the reducer throw.
    const malformed = {
      ...messageSent(3, "a"),
      type: "project.created",
      payload: null,
    } as unknown as OrchestrationEvent;
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      useStore
        .getState()
        .applyOrchestrationEvents(
          [messageSent(2, "a"), malformed, messageSent(4, "b")],
          environmentId,
        );
      expect(reportError).toHaveBeenCalledTimes(1);
    } finally {
      reportError.mockRestore();
    }

    const environment = useStore.getState().environmentStateById[environmentId]!;
    expect(environment.messageIdsByThreadId[ThreadId.make("a")]).toEqual(["message-2"]);
    expect(environment.messageIdsByThreadId[ThreadId.make("b")]).toEqual(["message-4"]);
  });

  it("still throws a lone failing event to the caller", () => {
    useStore
      .getState()
      .syncServerShellSnapshot(makeSnapshot([makeThreadShell("a")]), environmentId);
    const malformed = {
      ...messageSent(2, "a"),
      type: "project.created",
      payload: null,
    } as unknown as OrchestrationEvent;
    expect(() =>
      useStore.getState().applyOrchestrationEvents([malformed], environmentId),
    ).toThrow();
  });
});

describe("batch-owned containers", () => {
  afterEach(() => {
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  });

  function detailEvent(
    sequence: number,
    type: "thread.message-sent" | "thread.activity-appended" | "thread.session-set",
    threadId: string,
  ): OrchestrationEvent {
    const occurredAt = `2026-10-02T00:00:${String(sequence).padStart(2, "0")}.000Z`;
    const payload =
      type === "thread.message-sent"
        ? {
            threadId,
            messageId: `message-${threadId}`,
            role: "assistant",
            text: `delta ${sequence} `,
            turnId: "turn-1",
            streaming: true,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          }
        : type === "thread.activity-appended"
          ? {
              threadId,
              activity: {
                id: `activity-${sequence}`,
                tone: "tool",
                kind: "tool.started",
                summary: `tool ${sequence}`,
                payload: {},
                turnId: "turn-1",
                createdAt: occurredAt,
              },
            }
          : {
              threadId,
              session: {
                threadId,
                status: "running",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: "turn-1",
                lastError: null,
                updatedAt: occurredAt,
              },
            };
    return {
      sequence,
      eventId: `event-${sequence}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    } as unknown as OrchestrationEvent;
  }

  it("folds a detail batch like one event at a time without touching the published state", () => {
    const published = deepFreeze(
      syncServerShellSnapshot(
        emptyState,
        makeSnapshot([makeThreadShell("a"), makeThreadShell("b"), makeThreadShell("c")]),
        environmentId,
      ),
    );
    const events = [
      detailEvent(2, "thread.message-sent", "a"),
      detailEvent(3, "thread.activity-appended", "a"),
      detailEvent(4, "thread.message-sent", "b"),
      detailEvent(5, "thread.message-sent", "a"),
      detailEvent(6, "thread.session-set", "b"),
      detailEvent(7, "thread.message-sent", "b"),
      detailEvent(8, "thread.activity-appended", "a"),
    ];

    const batched = applyOrchestrationEvents(published, events, environmentId);
    const sequential = events.reduce(
      (state, event) => applyOrchestrationEvent(deepFreeze(state), event, environmentId),
      published,
    );

    expect(environmentOf(batched)).toEqual(environmentOf(sequential));
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    expect(environmentOf(batched).messageByThreadId[a]?.[`message-a` as never]?.text).toBe(
      "delta 2 delta 5 ",
    );
    expect(environmentOf(batched).activityIdsByThreadId[a]).toEqual(["activity-3", "activity-8"]);
    expect(environmentOf(batched).threadShellById[b]?.updatedAt).toBe("2026-10-02T00:00:07.000Z");
    // The untouched thread keeps its shell; the published state is unchanged.
    expect(environmentOf(batched).threadShellById[ThreadId.make("c")]).toBe(
      environmentOf(published).threadShellById[ThreadId.make("c")],
    );
    expect(environmentOf(published).messageIdsByThreadId[a]).toBeUndefined();
    expect(environmentOf(published).threadShellById[a]?.updatedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("copies the per-thread records once for a frame of shell upserts", () => {
    useStore
      .getState()
      .syncServerShellSnapshot(
        makeSnapshot([makeThreadShell("a"), makeThreadShell("b"), makeThreadShell("c")]),
        environmentId,
      );
    const published = deepFreeze(useStore.getState());
    useStore.setState(published, true);
    const upsert = (sequence: number, id: string) =>
      ({
        kind: "thread-upserted",
        sequence,
        thread: makeThreadShell(id, {
          title: `Renamed ${sequence}`,
          updatedAt: `2026-10-02T00:00:0${sequence}.000Z`,
        }),
      }) as never;
    const events = [upsert(2, "a"), upsert(3, "b"), upsert(4, "c"), upsert(5, "a")];
    const intermediate: AppState[] = [];

    useStore.getState().applyShellEvents(events, environmentId, (state) => {
      intermediate.push(state);
    });

    const next = useStore.getState();
    const sequential = events.reduce<AppState>(
      (state, event) => applyShellEvent(deepFreeze(state), event, environmentId),
      published,
    );
    expect(environmentOf(next)).toEqual(environmentOf(sequential));
    expect(environmentOf(next).threadShellById[ThreadId.make("a")]?.title).toBe("Renamed 5");
    // Every upsert after the first writes into the record the batch copied.
    const shells = intermediate.slice(1).map((state) => environmentOf(state).threadShellById);
    for (const shellById of shells) {
      expect(shellById).toBe(environmentOf(next).threadShellById);
    }
    expect(environmentOf(next).threadShellById).not.toBe(environmentOf(published).threadShellById);
    expect(environmentOf(next).sidebarThreadSummaryById).not.toBe(
      environmentOf(published).sidebarThreadSummaryById,
    );
    expect(environmentOf(published).threadShellById[ThreadId.make("a")]?.title).toBe("Thread a");
  });
});

describe("thread window structural sharing", () => {
  const windowThreadId = ThreadId.make("window-thread");
  const ref = scopeThreadRef(environmentId, windowThreadId);
  const windowSize = 150;
  const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString();

  function windowMessages() {
    return Array.from({ length: windowSize }, (_, index) => ({
      id: MessageId.make(`window-message-${index}`),
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Message ${index}`,
      turnId: null,
      streaming: false,
      createdAt: at(index),
      updatedAt: at(index),
    }));
  }

  function windowActivities() {
    return Array.from({ length: windowSize }, (_, index) => ({
      id: EventId.make(`window-activity-${index}`),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: `Tool ${index}`,
      payload: { index, detail: { nested: [index] } },
      turnId: null,
      sequence: index,
      createdAt: at(index),
    }));
  }

  // Every call decodes fresh objects, like a window arriving over the wire again.
  function makeWindow(
    content: {
      messages?: ReturnType<typeof windowMessages>;
      activities?: ReturnType<typeof windowActivities>;
    } = {},
  ): OrchestrationThreadWindowSnapshot {
    const historyPage = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };
    return {
      snapshotSequence: 10,
      thread: {
        id: windowThreadId,
        projectId,
        title: "Window thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        worktreeId: null,
        manualStatusBucket: null,
        manualPosition: 0,
        latestTurn: null,
        createdAt: at(0),
        updatedAt: at(0),
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: content.messages ?? windowMessages(),
        proposedPlans: [
          {
            id: "window-plan",
            turnId: null,
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: at(1),
            updatedAt: at(1),
          },
        ],
        activities: content.activities ?? windowActivities(),
        checkpoints: [
          {
            turnId: "window-turn",
            checkpointTurnCount: 1,
            checkpointRef: "window-ref",
            status: "ready",
            files: [{ path: "src/a.ts", kind: "added", additions: 3, deletions: 0 }],
            assistantMessageId: null,
            completedAt: at(2),
          },
        ],
        session: null,
      },
      history: {
        messages: historyPage,
        proposedPlans: historyPage,
        activities: historyPage,
        checkpoints: historyPage,
      },
    } as unknown as OrchestrationThreadWindowSnapshot;
  }

  const applyWindow = (state: AppState, window = makeWindow()) =>
    syncServerThreadWindow(state, window, environmentId);

  const sliceRecordKeys = [
    "messageIdsByThreadId",
    "messageByThreadId",
    "activityIdsByThreadId",
    "activityByThreadId",
    "proposedPlanIdsByThreadId",
    "proposedPlanByThreadId",
    "turnDiffIdsByThreadId",
    "turnDiffSummaryByThreadId",
  ] as const;

  it("keeps every message, activity and container when an identical window is re-applied", () => {
    const first = deepFreeze(applyWindow(emptyState));
    const second = applyWindow(first);
    const before = environmentOf(first);
    const after = environmentOf(second);

    expect(before.messageIdsByThreadId[windowThreadId]).toHaveLength(windowSize);
    expect(before.activityIdsByThreadId[windowThreadId]).toHaveLength(windowSize);
    for (const key of sliceRecordKeys) {
      expect(after[key]).toBe(before[key]);
      expect(after[key][windowThreadId]).toBe(before[key][windowThreadId]);
    }
    expect(after.threadHistoryByThreadId).toBe(before.threadHistoryByThreadId);
    expect(after).toBe(before);
    expect(second).toBe(first);
    const thread = selectThreadByRef(first, ref)!;
    expect(selectThreadByRef(second, ref)).toBe(thread);
    expect(thread.messages).toHaveLength(windowSize);
    expect(thread.activities).toHaveLength(windowSize);
  });

  it("replaces only the message whose text changed, and its by-id record", () => {
    const first = deepFreeze(applyWindow(emptyState));
    const edited = windowMessages();
    edited[75]!.text = "Edited";
    const second = applyWindow(first, makeWindow({ messages: edited }));
    const before = environmentOf(first);
    const after = environmentOf(second);
    const changedId = MessageId.make("window-message-75");

    expect(after.messageIdsByThreadId).toBe(before.messageIdsByThreadId);
    expect(after.messageIdsByThreadId[windowThreadId]).toBe(
      before.messageIdsByThreadId[windowThreadId],
    );
    expect(after.messageByThreadId[windowThreadId]).not.toBe(
      before.messageByThreadId[windowThreadId],
    );
    expect(after.messageByThreadId[windowThreadId]?.[changedId]).not.toBe(
      before.messageByThreadId[windowThreadId]?.[changedId],
    );
    expect(after.messageByThreadId[windowThreadId]?.[changedId]?.text).toBe("Edited");
    for (const id of before.messageIdsByThreadId[windowThreadId]!) {
      if (id === changedId) continue;
      expect(after.messageByThreadId[windowThreadId]?.[id]).toBe(
        before.messageByThreadId[windowThreadId]?.[id],
      );
    }
    for (const key of sliceRecordKeys.filter((entry) => entry !== "messageByThreadId")) {
      expect(after[key]).toBe(before[key]);
    }
    // The activities collection is untouched, so its thread-level array is too.
    expect(selectThreadByRef(second, ref)?.activities).toBe(
      selectThreadByRef(first, ref)?.activities,
    );
    expect(selectThreadByRef(second, ref)?.messages).not.toBe(
      selectThreadByRef(first, ref)?.messages,
    );
  });

  it("keeps existing activities when one is appended or changed", () => {
    const first = deepFreeze(applyWindow(emptyState));
    const activities = windowActivities();
    activities[10]!.summary = "Changed";
    activities.push({
      ...activities[0]!,
      id: EventId.make("window-activity-extra"),
      sequence: 999,
    });
    const appended = applyWindow(first, makeWindow({ activities }));
    const before = environmentOf(first);
    const after = environmentOf(appended);
    const changedId = EventId.make("window-activity-10");

    expect(after.activityIdsByThreadId[windowThreadId]).toHaveLength(windowSize + 1);
    expect(after.activityIdsByThreadId[windowThreadId]).not.toBe(
      before.activityIdsByThreadId[windowThreadId],
    );
    expect(after.activityByThreadId[windowThreadId]?.[changedId]?.summary).toBe("Changed");
    for (const id of before.activityIdsByThreadId[windowThreadId]!) {
      if (id === changedId) continue;
      expect(after.activityByThreadId[windowThreadId]?.[id]).toBe(
        before.activityByThreadId[windowThreadId]?.[id],
      );
    }
    expect(after.messageIdsByThreadId).toBe(before.messageIdsByThreadId);
    expect(after.messageByThreadId).toBe(before.messageByThreadId);
  });

  it("drops a message that left the window and keeps the rest", () => {
    const first = deepFreeze(applyWindow(emptyState));
    const second = applyWindow(first, makeWindow({ messages: windowMessages().slice(1) }));
    const before = environmentOf(first);
    const after = environmentOf(second);
    const droppedId = MessageId.make("window-message-0");

    expect(after.messageIdsByThreadId[windowThreadId]).toEqual(
      before.messageIdsByThreadId[windowThreadId]!.slice(1),
    );
    expect(Object.hasOwn(after.messageByThreadId[windowThreadId]!, droppedId)).toBe(false);
    for (const id of after.messageIdsByThreadId[windowThreadId]!) {
      expect(after.messageByThreadId[windowThreadId]?.[id]).toBe(
        before.messageByThreadId[windowThreadId]?.[id],
      );
    }
  });

  it("ends the cached-body state even when the live messages match the cached ones", () => {
    const first = deepFreeze(applyWindow(emptyState));
    const cachedState: AppState = {
      ...first,
      environmentStateById: {
        ...first.environmentStateById,
        [environmentId]: {
          ...environmentOf(first),
          cachedMessageThreadIds: { [windowThreadId]: true },
        },
      },
    };
    const second = applyWindow(cachedState);
    const before = environmentOf(cachedState);
    const after = environmentOf(second);

    expect(after.cachedMessageThreadIds?.[windowThreadId]).toBeUndefined();
    expect(after.messageIdsByThreadId).toBe(before.messageIdsByThreadId);
    expect(after.messageByThreadId).toBe(before.messageByThreadId);
  });
});

describe("demotion structural sharing", () => {
  const sessionOf = (threadId: string) => ({
    threadId,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: "turn-1",
    lastError: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  const a = ThreadId.make("a");
  const b = ThreadId.make("b");
  const c = ThreadId.make("c");

  it("keeps every summary and session when no thread holds a session", () => {
    const live = deepFreeze(
      syncServerShellSnapshot(
        emptyState,
        makeSnapshot([makeThreadShell("a"), makeThreadShell("b")]),
        environmentId,
      ),
    );
    const demoted = demoteEnvironmentStateToCachedSnapshot(live, environmentId, 42);
    const before = environmentOf(live);
    const after = environmentOf(demoted);

    expect(after.sidebarThreadSummaryById).toBe(before.sidebarThreadSummaryById);
    expect(after.threadSessionById).toBe(before.threadSessionById);
    expect(after.threadShellById).toBe(before.threadShellById);
    for (const id of [a, b]) {
      expect(after.sidebarThreadSummaryById[id]).toBe(before.sidebarThreadSummaryById[id]);
    }
    // The provenance of the environment itself still changes.
    expect(after.bootstrapComplete).toBe(false);
    expect(after.hydratedFromCacheAt).toBe(42);
    expect(after.retainedLiveSnapshot).toBe(true);
    expect(selectSidebarThreadsAcrossEnvironments(demoted)).toHaveLength(2);
  });

  it("strips only the threads that hold a session or background liveness", () => {
    const live = deepFreeze(
      syncServerShellSnapshot(
        emptyState,
        makeSnapshot([
          makeThreadShell("a"),
          makeThreadShell("b", { session: sessionOf("b") }),
          makeThreadShell("c", { backgroundLiveness: "working" }),
        ]),
        environmentId,
      ),
    );
    const demoted = demoteEnvironmentStateToCachedSnapshot(live, environmentId, 42);
    const before = environmentOf(live);
    const after = environmentOf(demoted);

    expect(before.threadSessionById[b]).not.toBeNull();
    expect(before.sidebarThreadSummaryById[b]).toMatchObject({ session: expect.anything() });
    expect(before.sidebarThreadSummaryById[c]).toMatchObject({ backgroundLiveness: "working" });

    expect(after.sidebarThreadSummaryById[a]).toBe(before.sidebarThreadSummaryById[a]);
    expect(after.sidebarThreadSummaryById[b]).not.toBe(before.sidebarThreadSummaryById[b]);
    expect(after.sidebarThreadSummaryById[b]).toEqual({
      ...before.sidebarThreadSummaryById[b],
      session: null,
      backgroundLiveness: null,
    });
    expect(after.sidebarThreadSummaryById[c]).toEqual({
      ...before.sidebarThreadSummaryById[c],
      session: null,
      backgroundLiveness: null,
    });
    expect(after.threadSessionById).toEqual({ [a]: null, [b]: null, [c]: null });
    expect(after.threadShellById).toBe(before.threadShellById);
    expect(after.threadTurnStateById).toBe(before.threadTurnStateById);
  });
});
