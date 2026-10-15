import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationArchivedThreadStub,
  type OrchestrationStubbedShellSnapshot,
  type OrchestrationThreadShell,
  type ThreadLineage,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "../../scoped.ts";
import { listThreadLifecycleActions } from "../lifecycle/index.ts";
import { readQueueThreadView } from "../message-queue/threadView.ts";
import { sidebarUndoThreadRevision } from "./sidebarUndo.ts";
import {
  applyLoadedThreadShells,
  applyOrchestrationEvent,
  applyShellEvent,
  applyThreadPriorities,
  demoteEnvironmentStateToCachedSnapshot,
  hydrateEnvironmentStateFromCache,
  selectDelegatedChildThreadsForThreadRef,
  selectEnvironmentState,
  selectSidebarThreadSummaryByRef,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadAvailabilityByRef,
  selectThreadByRef,
  selectThreadExistsByRef,
  selectThreadShellsAcrossEnvironments,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  type AppState,
} from "./store.ts";
import { buildThreadInbox } from "./threadInbox.ts";
import { createThreadNotificationProjector } from "./threadNotifications.ts";
import {
  fullThreadEntry,
  isArchivedThreadStub,
  isUnarchivedThreadEntry,
  type ArchivedThreadStub,
} from "./types.ts";

const env = EnvironmentId.make("environment-stubs");
const projectId = ProjectId.make("project-stubs");
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";
const empty: AppState = { activeEnvironmentId: null, environmentStateById: {} };

const shell = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId,
  title: `Thread ${id}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  goal: null,
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: T0,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const stubOf = (
  id: string,
  overrides: Partial<OrchestrationArchivedThreadStub> = {},
): OrchestrationArchivedThreadStub => ({
  id: ThreadId.make(id),
  projectId,
  title: `Thread ${id}`,
  branch: "feature",
  worktreePath: "/tmp/feature",
  worktreeId: null,
  createdAt: T0,
  updatedAt: T1,
  archivedAt: T1,
  latestUserMessageAt: T0,
  lineage: null,
  ...overrides,
});

const snapshot = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  archivedThreadStubs?: ReadonlyArray<OrchestrationArchivedThreadStub>,
  snapshotSequence = 10,
): OrchestrationStubbedShellSnapshot => ({
  snapshotSequence,
  projects: [],
  threads,
  ...(archivedThreadStubs === undefined ? {} : { archivedThreadStubs }),
  updatedAt: T0,
});

const ref = (id: string) => scopeThreadRef(env, ThreadId.make(id));
const entryOf = (state: AppState, id: string) =>
  selectEnvironmentState(state, env).threadShellById[ThreadId.make(id)];

describe("archived thread stubs in the threads store", () => {
  it("keeps every live thread, archived ones as stubs that compose no thread", () => {
    const state = syncServerShellSnapshot(
      empty,
      snapshot([shell("live")], [stubOf("archived")]),
      env,
    );
    const environment = selectEnvironmentState(state, env);
    expect(environment.threadIds).toEqual(["live", "archived"]);
    expect(environment.threadIdsByProjectId[projectId]).toEqual(["live", "archived"]);
    expect(environment.bootstrapComplete).toBe(true);

    const archived = entryOf(state, "archived");
    expect(isArchivedThreadStub(archived)).toBe(true);
    // One stub object stands in for the shell and the summary, with nothing it does not know.
    expect(environment.sidebarThreadSummaryById[ThreadId.make("archived")]).toBe(archived);
    expect(archived).not.toHaveProperty("modelSelection");
    expect(archived).not.toHaveProperty("session");
    expect(archived).not.toHaveProperty("latestTurn");
    expect(environment.threadSessionById).not.toHaveProperty("archived");
    expect(environment.threadTurnStateById).not.toHaveProperty("archived");

    // It exists (a deep link renders and loads it) but is no thread to render yet.
    expect(selectThreadExistsByRef(state, ref("archived"))).toBe(true);
    expect(selectThreadAvailabilityByRef(state, ref("archived"))).toBe("available");
    expect(selectThreadByRef(state, ref("archived"))).toBeUndefined();
    expect(selectThreadByRef(state, ref("live"))?.modelSelection.model).toBe("gpt-5.4");

    // List selectors carry stubs; the archive and lineage read them as rows.
    expect(selectThreadShellsAcrossEnvironments(state).map((thread) => thread.id)).toEqual([
      "live",
      "archived",
    ]);
    expect(
      selectSidebarThreadsAcrossEnvironments(state)
        .filter(isUnarchivedThreadEntry)
        .map((thread) => thread.id),
    ).toEqual(["live"]);
  });

  it("stores full archived shells from a server that sent no stubs (an older server)", () => {
    const state = syncServerShellSnapshot(
      empty,
      snapshot([shell("live"), shell("archived", { archivedAt: T1 })]),
      env,
    );
    expect(isArchivedThreadStub(entryOf(state, "archived"))).toBe(false);
    expect(selectThreadByRef(state, ref("archived"))?.archivedAt).toBe(T1);
  });

  it("replaces a stub with the full shell a live upsert carries (unarchive or any event)", () => {
    let state = syncServerShellSnapshot(empty, snapshot([], [stubOf("archived")]), env);
    state = applyShellEvent(
      state,
      {
        kind: "thread-upserted",
        sequence: 11,
        thread: shell("archived", { archivedAt: null, updatedAt: T2 }),
      },
      env,
    );
    const entry = entryOf(state, "archived");
    expect(isArchivedThreadStub(entry)).toBe(false);
    expect(fullThreadEntry(entry)?.archivedAt).toBeNull();
    expect(selectThreadByRef(state, ref("archived"))?.archivedAt).toBeNull();
    expect(
      fullThreadEntry(selectSidebarThreadSummaryByRef(state, ref("archived")))?.hasPendingApprovals,
    ).toBe(false);
    expect(selectEnvironmentState(state, env).threadIds).toEqual(["archived"]);
  });

  it("removes a stub with its thread", () => {
    let state = syncServerShellSnapshot(empty, snapshot([], [stubOf("archived")]), env);
    state = applyShellEvent(
      state,
      { kind: "thread-removed", sequence: 11, threadId: ThreadId.make("archived") },
      env,
    );
    expect(selectThreadExistsByRef(state, ref("archived"))).toBe(false);
    expect(selectEnvironmentState(state, env).threadIdsByProjectId[projectId]).toBeUndefined();
  });

  it("upgrades a stub with an on-demand shell, never a full shell or a newer stub", () => {
    let state = syncServerShellSnapshot(
      empty,
      snapshot([shell("full")], [stubOf("a"), stubOf("b", { updatedAt: T2 })]),
      env,
    );
    state = applyLoadedThreadShells(
      state,
      [
        shell("a", { archivedAt: T1, updatedAt: T1 }),
        // Read before the stub's own update: stale, so the stub stays.
        shell("b", { archivedAt: T1, updatedAt: T1 }),
        // Already full (a live upsert won the race): untouched.
        shell("full", { title: "Older read" }),
        // Deleted meanwhile: never resurrected.
        shell("gone", { archivedAt: T1 }),
      ],
      env,
    );
    expect(fullThreadEntry(entryOf(state, "a"))?.modelSelection.model).toBe("gpt-5.4");
    expect(isArchivedThreadStub(entryOf(state, "b"))).toBe(true);
    expect(entryOf(state, "full")?.title).toBe("Thread full");
    expect(entryOf(state, "gone")).toBeUndefined();
    expect(selectEnvironmentState(state, env).threadIds).toEqual(["full", "a", "b"]);
  });

  it("keeps a loaded archived shell across a re-snapshot that lists it unchanged", () => {
    let state = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    state = applyLoadedThreadShells(
      state,
      [
        shell("a", {
          archivedAt: T1,
          updatedAt: T1,
          branch: "feature",
          worktreePath: "/tmp/feature",
        }),
      ],
      env,
    );
    const loaded = entryOf(state, "a");
    // Reconnect: the same stub again keeps the open thread full (no flash, no reload).
    state = syncServerShellSnapshot(state, snapshot([], [stubOf("a")], 12), env);
    expect(entryOf(state, "a")).toBe(loaded);
    // A stub that moved on (renamed while away) is the newer truth: back to a stub.
    state = syncServerShellSnapshot(
      state,
      snapshot([], [stubOf("a", { title: "Renamed", updatedAt: T2 })], 13),
      env,
    );
    expect(isArchivedThreadStub(entryOf(state, "a"))).toBe(true);
    expect(entryOf(state, "a")?.title).toBe("Renamed");
  });

  it("never keeps a cache-painted row over a live stub, even when the fields agree", () => {
    const fullArchived = shell("a", {
      archivedAt: T1,
      updatedAt: T1,
      branch: "feature",
      worktreePath: "/tmp/feature",
    });
    // Live, then demoted to last-known state (a node switch), then a live stubbed snapshot.
    let state = syncServerShellSnapshot(empty, snapshot([fullArchived]), env);
    state = demoteEnvironmentStateToCachedSnapshot(state, env, 5);
    state = syncServerShellSnapshot(state, snapshot([], [stubOf("a")], 12), env);
    expect(isArchivedThreadStub(entryOf(state, "a"))).toBe(true);
  });

  it("applies no on-demand shell to rows painted from a cache", () => {
    let state = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    state = demoteEnvironmentStateToCachedSnapshot(state, env, 5);
    const next = applyLoadedThreadShells(
      state,
      [shell("a", { archivedAt: T1, updatedAt: T1 })],
      env,
    );
    expect(next).toBe(state);
  });

  it("keeps one stub in both records, at the listed time, through detail events", () => {
    let state = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    // An opened archived thread's detail stream speaks before its full shell lands.
    state = applyOrchestrationEvent(
      state,
      {
        sequence: 11,
        eventId: EventId.make("event-stub-message"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("a"),
        occurredAt: T2,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: T2,
          updatedAt: T2,
        },
      } as never,
      env,
    );
    const environment = selectEnvironmentState(state, env);
    const shellEntry = environment.threadShellById[ThreadId.make("a")];
    expect(environment.sidebarThreadSummaryById[ThreadId.make("a")]).toBe(shellEntry);
    expect(shellEntry?.updatedAt).toBe(T1);
    // So the full shell read at the listed time still replaces the stub.
    state = applyLoadedThreadShells(state, [shell("a", { archivedAt: T1, updatedAt: T1 })], env);
    expect(isArchivedThreadStub(entryOf(state, "a"))).toBe(false);
  });

  it("paints a cached stub's read content back with it", () => {
    const stub: ArchivedThreadStub = {
      shellDetail: "archived-stub",
      id: ThreadId.make("a"),
      environmentId: env,
      projectId,
      title: "Cached",
      createdAt: T0,
      updatedAt: T1,
      archivedAt: T1,
      branch: null,
      worktreePath: null,
      worktreeId: null,
      latestUserMessageAt: null,
      lineage: null,
    };
    const message = {
      id: MessageId.make("message-a"),
      role: "assistant" as const,
      text: "read offline",
      createdAt: T0,
    };
    const state = hydrateEnvironmentStateFromCache(
      empty,
      {
        capturedAt: 1,
        projects: [],
        worktrees: [],
        threads: [{ shell: stub, summary: stub, content: { messages: [message] } as never }],
      },
      env,
    );
    const environment = selectEnvironmentState(state, env);
    expect(environment.messageIdsByThreadId[ThreadId.make("a")]).toEqual(["message-a"]);
    expect(environment.messageByThreadId[ThreadId.make("a")]?.[message.id]?.text).toBe(
      "read offline",
    );
    expect(environment.cachedMessageThreadIds?.[ThreadId.make("a")]).toBe(true);
  });

  it("gives a stub an undo revision of its own, which a full summary does not share", () => {
    const stubbed = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    const again = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    const stub = selectSidebarThreadSummaryByRef(stubbed, ref("a"))!;
    expect(sidebarUndoThreadRevision(stub)).toBe(
      sidebarUndoThreadRevision(selectSidebarThreadSummaryByRef(again, ref("a"))!),
    );
    const renamed = syncServerShellSnapshot(
      empty,
      snapshot([], [stubOf("a", { title: "Renamed" })]),
      env,
    );
    expect(sidebarUndoThreadRevision(selectSidebarThreadSummaryByRef(renamed, ref("a"))!)).not.toBe(
      sidebarUndoThreadRevision(stub),
    );
    const full = syncServerShellSnapshot(
      empty,
      snapshot([shell("a", { archivedAt: T1, updatedAt: T1 })]),
      env,
    );
    expect(sidebarUndoThreadRevision(selectSidebarThreadSummaryByRef(full, ref("a"))!)).not.toBe(
      sidebarUndoThreadRevision(stub),
    );
  });

  it("reuses an unchanged stub object across re-snapshots", () => {
    let state = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    const first = entryOf(state, "a");
    state = syncServerShellSnapshot(state, snapshot([], [stubOf("a")], 11), env);
    expect(entryOf(state, "a")).toBe(first);
  });

  it("lets the thread detail stream make an opened stub full", () => {
    let state = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    state = syncServerThreadDetail(
      state,
      {
        ...shell("a", { archivedAt: T1, updatedAt: T1 }),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      } as never,
      env,
    );
    expect(selectThreadByRef(state, ref("a"))?.archivedAt).toBe(T1);
    expect(selectEnvironmentState(state, env).threadIdsByProjectId[projectId]).toEqual(["a"]);
  });

  it("ranks no stub", () => {
    let state = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    const before = selectEnvironmentState(state, env).sidebarThreadSummaryById;
    state = applyThreadPriorities(
      state,
      {
        kind: "thread-priorities",
        priorities: [{ threadId: ThreadId.make("a"), priority: {} as never }],
      },
      env,
    );
    expect(selectEnvironmentState(state, env).sidebarThreadSummaryById).toBe(before);
  });

  it("hydrates cached stubs whole and drops half a stub", () => {
    const stub: ArchivedThreadStub = {
      shellDetail: "archived-stub",
      id: ThreadId.make("a"),
      environmentId: env,
      projectId,
      title: "Cached",
      createdAt: T0,
      updatedAt: T1,
      archivedAt: T1,
      branch: null,
      worktreePath: null,
      worktreeId: null,
      latestUserMessageAt: null,
      lineage: null,
    };
    const state = hydrateEnvironmentStateFromCache(
      empty,
      {
        capturedAt: 1,
        projects: [],
        worktrees: [],
        threads: [
          // Persisted JSON: equal, not identical, halves.
          { shell: stub, summary: { ...stub } },
          { shell: { ...stub, id: ThreadId.make("half") }, summary: { id: "half" } as never },
        ],
      },
      env,
    );
    expect(isArchivedThreadStub(entryOf(state, "a"))).toBe(true);
    expect(entryOf(state, "half")).toBeUndefined();
    expect(selectEnvironmentState(state, env).hydratedFromCacheAt).toBe(1);
    // Demotion keeps a stub as it is: it claims no live activity.
    const live = syncServerShellSnapshot(empty, snapshot([], [stubOf("a")]), env);
    const demoted = demoteEnvironmentStateToCachedSnapshot(live, env, 5);
    expect(selectSidebarThreadSummaryByRef(demoted, ref("a"))).toBe(entryOf(live, "a"));
  });
});

describe("archived thread stubs in client-runtime consumers", () => {
  const lineage: ThreadLineage = {
    parentThreadId: ThreadId.make("parent"),
    rootThreadId: ThreadId.make("parent"),
    relationship: "delegated",
  };
  const state = syncServerShellSnapshot(
    empty,
    snapshot(
      [shell("parent"), shell("child-live", { lineage })],
      [stubOf("child-archived", { lineage }), stubOf("plain")],
    ),
    env,
  );

  it("never lists an archived stub as a delegated child", () => {
    expect(
      selectDelegatedChildThreadsForThreadRef(state, ref("parent")).map((thread) => thread.id),
    ).toEqual(["child-live"]);
  });

  it("excludes stubs from the inbox like every archived thread, and counts them", () => {
    const inbox = buildThreadInbox({
      projects: [],
      worktrees: [],
      threads: selectSidebarThreadsAcrossEnvironments(state),
      environments: [
        {
          environmentId: env,
          label: "Node",
          threadSettlementSupported: true,
          threadSnoozeSupported: true,
          connected: true,
          mutationReady: true,
          shellCurrent: true,
        },
      ],
      nowMs: Date.parse(T2),
    });
    const listed = [...inbox.focus, ...inbox.active, ...inbox.settled, ...inbox.snoozed].map(
      (entry) => entry.thread?.id,
    );
    expect(listed).not.toContain("plain");
    expect(listed).not.toContain("child-archived");
    expect(inbox.excludedCount).toBe(2);
  });

  it("gives a queued message on a stub an archived view, never a missing thread", () => {
    const view = readQueueThreadView(state, ref("plain"));
    expect(view?.archived).toBe(true);
    expect(view?.detailLoaded).toBe(false);
    expect(view?.running).toBe(false);
    expect(view?.modelSelection).toBeNull();
  });

  it("offers a stub only what a stub knows: unarchive and delete", () => {
    const stub = entryOf(state, "plain");
    expect(isArchivedThreadStub(stub)).toBe(true);
    expect(listThreadLifecycleActions(stub as ArchivedThreadStub).map((item) => item.id)).toEqual([
      "unarchive",
      "delete",
    ]);
  });

  it("baselines notifications without stubs, so a later full shell never notifies at once", () => {
    const generation = {};
    const projector = createThreadNotificationProjector({ readGeneration: () => generation });
    projector.baseline({
      environmentId: env,
      generation,
      sequence: 10,
      threads: selectSidebarThreadsAcrossEnvironments(state),
      nowMs: Date.parse(T2),
    });
    const notification = projector.observe({
      generation,
      sequence: 11,
      thread: {
        ...fullThreadEntry(selectSidebarThreadSummaryByRef(state, ref("parent")))!,
        id: ThreadId.make("plain"),
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: T0,
          startedAt: T0,
          completedAt: T1,
          assistantMessageId: null,
        },
      },
      nowMs: Date.parse(T2),
    });
    expect(notification).toBeNull();
  });
});
