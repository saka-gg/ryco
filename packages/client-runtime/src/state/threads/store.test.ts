import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  CheckpointRef,
  DEFAULT_MODEL,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationThreadHistoryCursor,
  ThreadId,
  TurnId,
  WorktreeId,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationStubbedShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationThreadWindowSnapshot,
  type ThreadLineage,
} from "@ryco/contracts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { describe, expect, it, vi } from "vite-plus/test";
import { configureThreadsRuntime, getThreadsRuntimeConfiguration } from "./runtime.ts";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  applyShellEvent,
  applyThreadPriorities,
  createShellEventCoalescer,
  demoteEnvironmentStateToCachedSnapshot,
  evictThreadBodies,
  hydrateEnvironmentStateFromCache,
  selectDelegatedChildThreadsForThreadRef,
  removeEnvironmentState,
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectThreadAvailabilityByRef,
  selectThreadByRef,
  selectThreadExistsByRef,
  setServerThreadHistoryLoadState,
  setSidebarWorktreeTitle,
  setThreadBranch,
  syncServerThreadHistoryPage,
  selectThreadsAcrossEnvironments,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  syncServerThreadWindow,
  type AppState,
  type EnvironmentState,
  useStore,
} from "./store.ts";
import { selectThreadDetailLoaded } from "./storeSelectors.ts";
import {
  localEnvironmentId,
  makeState,
  makeThread,
  withActiveEnvironmentState,
} from "./store.testSupport.ts";
import { deriveThreadActivityStatus } from "./threadActivityStatus.ts";
import { getThreadFromEnvironmentState } from "./threadDerivation.ts";
import { collectedByIdsCache, threadCache } from "./threadDerivationMemo.ts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  fullThreadEntry,
  isArchivedThreadStub,
  type Thread,
  type ThreadShell,
  type ThreadShellOrStub,
} from "./types.ts";

const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function makeEmptyState(overrides: Partial<AppState & EnvironmentState> = {}): AppState {
  const environmentState: EnvironmentState = {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
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
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState, overrides);
}

function localEnvironmentStateOf(state: AppState): EnvironmentState {
  return selectEnvironmentState(state, localEnvironmentId);
}

function environmentStateOf(state: AppState, environmentId: EnvironmentId): EnvironmentState {
  return selectEnvironmentState(state, environmentId);
}

function projectsOf(state: AppState) {
  return selectProjectsAcrossEnvironments(state);
}

function threadsOf(state: AppState) {
  return selectThreadsAcrossEnvironments(state);
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.make("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("environment state removal", () => {
  it("drops local state for removed environments", () => {
    const removedThread = makeThread({
      environmentId: remoteEnvironmentId,
      id: ThreadId.make("thread-removed"),
    });
    const keptThread = makeThread({ id: ThreadId.make("thread-kept") });
    const removedState = makeState(removedThread).environmentStateById[remoteEnvironmentId]!;
    const keptState = makeState(keptThread).environmentStateById[localEnvironmentId]!;
    const state: AppState = {
      activeEnvironmentId: remoteEnvironmentId,
      environmentStateById: {
        [remoteEnvironmentId]: removedState,
        [localEnvironmentId]: keptState,
      },
    };

    const next = removeEnvironmentState(state, remoteEnvironmentId);

    expect(next.activeEnvironmentId).toBeNull();
    expect(next.environmentStateById[remoteEnvironmentId]).toBeUndefined();
    expect(next.environmentStateById[localEnvironmentId]).toBe(keptState);
  });

  it("preserves active environment when removing a different environment", () => {
    const state = makeState(makeThread());

    const next = removeEnvironmentState(state, remoteEnvironmentId);

    expect(next).toBe(state);
  });
});

describe("worktree sidebar state", () => {
  it("updates a worktree title optimistically after a successful rename command", () => {
    const worktreeId = WorktreeId.make("worktree-main");
    const projectId = ProjectId.make("project-1");
    const state = makeEmptyState({
      projectIds: [projectId],
      projectById: {
        [projectId]: {
          id: projectId,
          environmentId: localEnvironmentId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: "2026-02-13T00:00:00.000Z",
          updatedAt: "2026-02-13T00:00:00.000Z",
          scripts: [],
        },
      },
      worktreeIds: [worktreeId],
      worktreeIdsByProjectId: {
        [projectId]: [worktreeId],
      },
      worktreeById: {
        [worktreeId]: {
          id: worktreeId,
          environmentId: localEnvironmentId,
          projectId,
          title: null,
          branch: "main",
          worktreePath: null,
          origin: "main",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          prState: null,
          prIsDraft: null,
          issueState: null,
          workItemProvider: null,
          workItemKey: null,
          workItemTitle: null,
          workItemState: null,
          workItemStateName: null,
          workItemUrl: null,
          createdAt: "2026-02-13T00:00:00.000Z",
          updatedAt: "2026-02-13T00:00:00.000Z",
          archivedAt: null,
          manualPosition: 0,
        },
      },
    });

    const next = setSidebarWorktreeTitle(
      state,
      localEnvironmentId,
      worktreeId,
      "Renamed Worktree",
      "2026-02-13T00:01:00.000Z",
    );

    expect(localEnvironmentStateOf(next).worktreeById?.[worktreeId]?.title).toBe(
      "Renamed Worktree",
    );

    const branchUpdated = applyOrchestrationEvent(
      next,
      makeEvent("worktree.metaUpdated", {
        worktreeId,
        branch: "feature/renamed",
        changedAt: "2026-02-13T00:02:00.000Z",
      }),
      localEnvironmentId,
    );

    expect(localEnvironmentStateOf(branchUpdated).worktreeById?.[worktreeId]).toMatchObject({
      branch: "feature/renamed",
      title: "Renamed Worktree",
    });

    // Checkout removal keeps the record, its branch and path; recreation clears it.
    const removed = applyOrchestrationEvent(
      branchUpdated,
      makeEvent(
        "worktree.checkoutRemoved",
        { worktreeId, reason: "removed", removedAt: "2026-02-13T00:03:00.000Z" },
        { aggregateKind: "worktree", aggregateId: worktreeId },
      ),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(removed).worktreeById?.[worktreeId]).toMatchObject({
      branch: "feature/renamed",
      checkoutRemovedAt: "2026-02-13T00:03:00.000Z",
      checkoutRemovalReason: "removed",
    });
    const recreated = applyOrchestrationEvent(
      removed,
      makeEvent(
        "worktree.checkoutRestored",
        { worktreeId, worktreePath: "/tmp/project-wt", restoredAt: "2026-02-13T00:04:00.000Z" },
        { aggregateKind: "worktree", aggregateId: worktreeId },
      ),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(recreated).worktreeById?.[worktreeId]).toMatchObject({
      worktreePath: "/tmp/project-wt",
      checkoutRemovedAt: null,
    });
  });

  it("hides a trashed thread like a deleted one; the shell stream restores it", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const trashed = applyOrchestrationEvent(
      state,
      makeEvent("thread.trashed", {
        threadId: thread.id,
        trashedAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      localEnvironmentId,
    );
    expect(threadsOf(trashed)).toEqual([]);
    const untrashed = applyOrchestrationEvent(
      trashed,
      makeEvent("thread.untrashed", {
        threadId: thread.id,
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    // The domain event carries no shell; the shell stream re-upserts the thread.
    expect(untrashed).toBe(trashed);
  });

  describe("PR terminal time", () => {
    const worktreeId = WorktreeId.make("worktree-pr");
    const projectId = ProjectId.make("project-1");
    const worktreeShell = (
      overrides: Partial<
        Extract<OrchestrationShellStreamEvent, { kind: "worktree-upserted" }>["worktree"]
      > = {},
    ): Extract<OrchestrationShellStreamEvent, { kind: "worktree-upserted" }>["worktree"] => ({
      worktreeId,
      projectId,
      title: null,
      branch: "feature/pr",
      worktreePath: "/tmp/project/pr",
      origin: "pr",
      prNumber: 12,
      issueNumber: null,
      prTitle: "Feature",
      issueTitle: null,
      prState: "merged",
      prIsDraft: false,
      issueState: null,
      workItemProvider: null,
      workItemKey: null,
      workItemTitle: null,
      workItemState: null,
      workItemStateName: null,
      workItemUrl: null,
      createdAt: "2026-02-13T00:00:00.000Z",
      updatedAt: "2026-02-13T01:00:00.000Z",
      archivedAt: null,
      manualPosition: 0,
      ...overrides,
    });
    const upsert = (
      state: AppState,
      worktree: Extract<OrchestrationShellStreamEvent, { kind: "worktree-upserted" }>["worktree"],
      sequence: number,
    ) =>
      applyShellEvent(state, { kind: "worktree-upserted", sequence, worktree }, localEnvironmentId);

    it("retargets an entire worktree without losing messages and fences late detail paths", () => {
      const thread = makeThread({ worktreeId, worktreePath: "/tmp/project/pr" });
      let state = upsert(makeState(thread), worktreeShell(), 1);
      const previousMessages = threadsOf(state)[0]!.messages;
      state = applyShellEvent(
        state,
        {
          kind: "worktree-relocated",
          sequence: 2,
          worktree: worktreeShell({ worktreePath: "/tmp/new-checkout" }),
          sourcePath: "/tmp/project/pr",
          destinationPath: "/tmp/new-checkout",
        },
        localEnvironmentId,
      );
      expect(threadsOf(state)[0]?.worktreePath).toBe("/tmp/new-checkout");
      expect(threadsOf(state)[0]?.messages).toBe(previousMessages);
      const delayed = applyOrchestrationEvent(
        state,
        makeEvent("thread.meta-updated", {
          threadId: thread.id,
          worktreePath: "/tmp/project/pr",
          updatedAt: thread.updatedAt!,
        }),
        localEnvironmentId,
      );
      expect(threadsOf(delayed)[0]?.worktreePath).toBe("/tmp/new-checkout");
    });

    it("publishes retired paths on a cold snapshot for persisted drafts and fences late detail replies", () => {
      const configuration = getThreadsRuntimeConfiguration();
      const previous = useStore.getState();
      const retarget = vi.fn();
      try {
        configureThreadsRuntime({ ...configuration, onCheckoutRelocated: retarget });
        useStore.setState(makeEmptyState());
        useStore.getState().syncServerShellSnapshot(
          {
            snapshotSequence: 2,
            projects: [],
            worktrees: [
              worktreeShell({
                worktreePath: "/tmp/new-checkout",
                relocatedFromPath: "/tmp/project/pr",
              }),
            ],
            threads: [],
            updatedAt: "2026-02-13T01:00:00.000Z",
          },
          localEnvironmentId,
        );
        expect(retarget).toHaveBeenCalledOnce();
        expect(retarget).toHaveBeenCalledWith({
          environmentId: localEnvironmentId,
          projectId,
          sourcePath: "/tmp/project/pr",
          destinationPath: "/tmp/new-checkout",
        });
        const delayed: OrchestrationThread = {
          ...makeThread({ worktreeId, worktreePath: "/tmp/project/pr" }),
          worktreeId,
          settledOverride: null,
          settledAt: null,
          updatedAt: "2026-02-13T00:00:00.000Z",
          deletedAt: null,
          latestTurn: null,
          session: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
        };
        useStore.getState().syncServerThreadDetail(delayed, localEnvironmentId);
        expect(threadsOf(useStore.getState())[0]?.worktreePath).toBe("/tmp/new-checkout");
      } finally {
        useStore.setState(previous, true);
        configureThreadsRuntime(configuration);
      }
    });

    it("maps prTerminalAt from a streamed worktree upsert and keeps an absent key absent", () => {
      const withTime = upsert(
        makeEmptyState(),
        worktreeShell({ prTerminalAt: "2026-02-13T00:30:00.000Z" }),
        1,
      );
      expect(localEnvironmentStateOf(withTime).worktreeById?.[worktreeId]?.prTerminalAt).toBe(
        "2026-02-13T00:30:00.000Z",
      );

      const withNull = upsert(makeEmptyState(), worktreeShell({ prTerminalAt: null }), 1);
      const nullWorktree = localEnvironmentStateOf(withNull).worktreeById?.[worktreeId];
      expect(nullWorktree !== undefined && "prTerminalAt" in nullWorktree).toBe(true);
      expect(nullWorktree?.prTerminalAt).toBeNull();

      const legacy = upsert(makeEmptyState(), worktreeShell(), 1);
      const legacyWorktree = localEnvironmentStateOf(legacy).worktreeById?.[worktreeId];
      expect(legacyWorktree).toBeDefined();
      expect(legacyWorktree !== undefined && "prTerminalAt" in legacyWorktree).toBe(false);
    });

    it("replaces the worktree when only prTerminalAt changes", () => {
      const first = upsert(
        makeEmptyState(),
        worktreeShell({ prTerminalAt: "2026-02-13T00:30:00.000Z" }),
        1,
      );
      const same = upsert(first, worktreeShell({ prTerminalAt: "2026-02-13T00:30:00.000Z" }), 2);
      expect(localEnvironmentStateOf(same).worktreeById?.[worktreeId]).toBe(
        localEnvironmentStateOf(first).worktreeById?.[worktreeId],
      );

      const corrected = upsert(
        first,
        worktreeShell({ prTerminalAt: "2026-02-13T00:20:00.000Z" }),
        2,
      );
      const correctedWorktree = localEnvironmentStateOf(corrected).worktreeById?.[worktreeId];
      expect(correctedWorktree).not.toBe(localEnvironmentStateOf(first).worktreeById?.[worktreeId]);
      expect(correctedWorktree?.prTerminalAt).toBe("2026-02-13T00:20:00.000Z");
    });

    it("carries prTerminalAt through the source-control domain event", () => {
      const seeded = upsert(
        makeEmptyState(),
        worktreeShell({ prState: "open", prTerminalAt: null }),
        1,
      );
      const sourceControlEvent = (prTerminalAt?: string | null) =>
        makeEvent(
          "worktree.sourceControlStateUpdated",
          {
            worktreeId,
            prState: "merged",
            prIsDraft: false,
            issueState: null,
            updatedAt: "2026-02-13T02:00:00.000Z",
            ...(prTerminalAt !== undefined ? { prTerminalAt } : {}),
          },
          { aggregateKind: "worktree", aggregateId: worktreeId },
        );

      const merged = applyOrchestrationEvent(
        seeded,
        sourceControlEvent("2026-02-13T01:30:00.000Z"),
        localEnvironmentId,
      );
      expect(localEnvironmentStateOf(merged).worktreeById?.[worktreeId]).toMatchObject({
        prState: "merged",
        prTerminalAt: "2026-02-13T01:30:00.000Z",
      });

      const legacy = applyOrchestrationEvent(merged, sourceControlEvent(), localEnvironmentId);
      expect(localEnvironmentStateOf(legacy).worktreeById?.[worktreeId]?.prTerminalAt).toBe(
        "2026-02-13T01:30:00.000Z",
      );
    });
  });
});

describe("thread selection memoization", () => {
  it("merges history pages idempotently in stable message order", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-2"),
          role: "assistant",
          text: "newest",
          createdAt: "2026-02-13T00:02:00.000Z",
          streaming: false,
        },
      ],
    });
    const page = {
      collection: "messages" as const,
      snapshotSequence: 2,
      items: [
        {
          id: MessageId.make("message-1"),
          role: "user" as const,
          text: "older",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-13T00:01:00.000Z",
          updatedAt: "2026-02-13T00:01:00.000Z",
        },
      ],
      page: {
        oldestCursor: OrchestrationThreadHistoryCursor.make("v1.oldest"),
        newestCursor: OrchestrationThreadHistoryCursor.make("v1.newest"),
        hasMoreBefore: true,
      },
    };

    const once = syncServerThreadHistoryPage(
      makeState(thread),
      page,
      thread.id,
      localEnvironmentId,
    );
    const twice = syncServerThreadHistoryPage(once, page, thread.id, localEnvironmentId);

    expect(
      selectThreadByRef(twice, scopeThreadRef(localEnvironmentId, thread.id))?.messages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: MessageId.make("message-1") }),
        expect.objectContaining({ id: MessageId.make("message-2") }),
      ]),
    );
    expect(
      selectThreadByRef(twice, scopeThreadRef(localEnvironmentId, thread.id))?.messages.map(
        (message) => message.id,
      ),
    ).toEqual([MessageId.make("message-1"), MessageId.make("message-2")]);
    expect(
      twice.environmentStateById[localEnvironmentId]?.threadHistoryByThreadId?.[thread.id]?.messages
        .hasMoreBefore,
    ).toBe(true);
  });

  it("keeps the stored message slice when a history page repeats", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-2"),
          role: "assistant",
          text: "newest",
          createdAt: "2026-02-13T00:02:00.000Z",
          streaming: false,
        },
      ],
    });
    const page = {
      collection: "messages" as const,
      snapshotSequence: 2,
      items: [
        {
          id: MessageId.make("message-1"),
          role: "user" as const,
          text: "older",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-13T00:01:00.000Z",
          updatedAt: "2026-02-13T00:01:00.000Z",
        },
      ],
      page: {
        oldestCursor: OrchestrationThreadHistoryCursor.make("v1.oldest"),
        newestCursor: OrchestrationThreadHistoryCursor.make("v1.newest"),
        hasMoreBefore: true,
      },
    };

    const once = syncServerThreadHistoryPage(
      makeState(thread),
      page,
      thread.id,
      localEnvironmentId,
    );
    const twice = syncServerThreadHistoryPage(once, page, thread.id, localEnvironmentId);
    const before = localEnvironmentStateOf(once);
    const after = localEnvironmentStateOf(twice);

    expect(after.messageIdsByThreadId).toBe(before.messageIdsByThreadId);
    expect(after.messageByThreadId).toBe(before.messageByThreadId);
    expect(selectThreadByRef(twice, scopeThreadRef(localEnvironmentId, thread.id))?.messages).toBe(
      selectThreadByRef(once, scopeThreadRef(localEnvironmentId, thread.id))?.messages,
    );
  });

  it("returns stable thread references for repeated reads of the same state", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "hello",
          createdAt: "2026-02-13T00:01:00.000Z",
          streaming: false,
        },
      ],
      activities: [
        {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "step",
          summary: "working",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-13T00:01:30.000Z",
        },
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: null,
          planMarkdown: "plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-13T00:02:00.000Z",
          updatedAt: "2026-02-13T00:02:00.000Z",
        },
      ],
      turnDiffSummaries: [
        {
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-02-13T00:03:00.000Z",
          files: [],
        },
      ],
    });
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);

    const first = selectThreadByRef(state, ref);
    const second = selectThreadByRef(state, ref);

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(second?.messages).toBe(first?.messages);
    expect(second?.activities).toBe(first?.activities);
    expect(second?.proposedPlans).toBe(first?.proposedPlans);
    expect(second?.turnDiffSummaries).toBe(first?.turnDiffSummaries);
  });

  it("reuses the derived thread when the app state wrapper changes but thread data does not", () => {
    const thread = makeThread({
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "done",
          createdAt: "2026-02-13T00:01:00.000Z",
          streaming: false,
        },
      ],
    });
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const wrappedState: AppState = {
      ...state,
      environmentStateById: { ...state.environmentStateById },
    };

    const first = selectThreadByRef(state, ref);
    const second = selectThreadByRef(wrappedState, ref);

    expect(second).toBe(first);
  });

  it("updates the derived thread when the underlying thread data changes", () => {
    const thread = makeThread();
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const firstState = makeState(thread);
    const secondState = makeState({
      ...thread,
      messages: [
        {
          id: MessageId.make("message-2"),
          role: "user",
          text: "new",
          createdAt: "2026-02-13T00:04:00.000Z",
          streaming: false,
        },
      ],
    });

    const first = selectThreadByRef(firstState, ref);
    const second = selectThreadByRef(secondState, ref);

    expect(second).not.toBe(first);
    expect(second?.messages).toHaveLength(1);
    expect(second?.messages[0]?.text).toBe("new");
  });

  it("checks thread existence without materializing the full thread", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);

    expect(selectThreadExistsByRef(state, ref)).toBe(true);
    expect(
      selectThreadExistsByRef(
        state,
        scopeThreadRef(thread.environmentId, ThreadId.make("missing")),
      ),
    ).toBe(false);
    expect(selectThreadExistsByRef(state, null)).toBe(false);
  });

  it("calls a thread missing only once its environment's shell snapshot arrived", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const missingRef = scopeThreadRef(thread.environmentId, ThreadId.make("missing"));
    expect(
      selectThreadAvailabilityByRef(state, scopeThreadRef(thread.environmentId, thread.id)),
    ).toBe("available");
    expect(selectThreadAvailabilityByRef(state, missingRef)).toBe("missing");
    // Before the snapshot (cold start, deep link, reconnect) nothing is claimed either way.
    const loading = withActiveEnvironmentState(localEnvironmentStateOf(state), {
      bootstrapComplete: false,
    });
    expect(selectThreadAvailabilityByRef(loading, missingRef)).toBe("unknown");
    expect(selectThreadAvailabilityByRef(state, null)).toBe("unknown");
  });
});

describe("setThreadBranch", () => {
  it("updates only the scoped thread environment", () => {
    const sharedThreadId = ThreadId.make("thread-shared");
    const localThread = makeThread({
      id: sharedThreadId,
      environmentId: localEnvironmentId,
      branch: "local-branch",
    });
    const remoteThread = makeThread({
      id: sharedThreadId,
      environmentId: remoteEnvironmentId,
      branch: "remote-branch",
    });
    const state: AppState = {
      activeEnvironmentId: localEnvironmentId,
      environmentStateById: {
        [localEnvironmentId]: environmentStateOf(makeState(localThread), localEnvironmentId),
        [remoteEnvironmentId]: environmentStateOf(makeState(remoteThread), remoteEnvironmentId),
      },
    };

    const next = setThreadBranch(
      state,
      scopeThreadRef(remoteEnvironmentId, sharedThreadId),
      "remote-next",
      "/tmp/remote-worktree",
    );

    expect(
      environmentStateOf(next, localEnvironmentId).threadShellById[sharedThreadId]?.branch,
    ).toBe("local-branch");
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadShellById[sharedThreadId]?.branch,
    ).toBe("remote-next");
    expect(
      environmentStateOf(next, remoteEnvironmentId).threadShellById[sharedThreadId]?.worktreePath,
    ).toBe("/tmp/remote-worktree");
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state = withActiveEnvironmentState(localEnvironmentStateOf(makeState(makeThread())), {
      bootstrapComplete: false,
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.make("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(localEnvironmentStateOf(next).bootstrapComplete).toBe(false);
  });

  it("applies goal updates and clears to the thread shell", () => {
    const state = makeState(makeThread());
    const goal = {
      objective: "Finish the goal UI",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 40,
      timeUsedSeconds: 5,
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:05.000Z",
    };
    const updated = applyOrchestrationEvent(
      state,
      makeEvent("thread.goal-updated", {
        threadId: ThreadId.make("thread-1"),
        goal,
        origin: "provider",
      }),
      localEnvironmentId,
    );
    expect(threadsOf(updated)[0]?.goal).toEqual(goal);

    const cleared = applyOrchestrationEvent(
      updated,
      makeEvent("thread.goal-cleared", {
        threadId: ThreadId.make("thread-1"),
        origin: "client",
        updatedAt: "2026-02-27T00:00:06.000Z",
      }),
      localEnvironmentId,
    );
    expect(threadsOf(cleared)[0]?.goal).toBeNull();
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.make("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.make("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.make("project-1");
    const recreatedProjectId = ProjectId.make("project-2");
    const state: AppState = makeEmptyState({
      projectIds: [originalProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          environmentId: localEnvironmentId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        projectMetadataDir: ".ryco",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(projectsOf(next)).toHaveLength(1);
    expect(projectsOf(next)[0]?.id).toBe(recreatedProjectId);
    expect(projectsOf(next)[0]?.cwd).toBe("/tmp/project");
    expect(projectsOf(next)[0]?.name).toBe("Project Recreated");
    expect(localEnvironmentStateOf(next).projectIds).toEqual([recreatedProjectId]);
    expect(localEnvironmentStateOf(next).projectById[originalProjectId]).toBeUndefined();
    expect(localEnvironmentStateOf(next).projectById[recreatedProjectId]?.id).toBe(
      recreatedProjectId,
    );
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.make("project-1");
    const recreatedProjectId = ProjectId.make("project-2");
    const threadId = ThreadId.make("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state = withActiveEnvironmentState(localEnvironmentStateOf(makeState(thread)), {
      projectIds: [originalProjectId, recreatedProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          environmentId: localEnvironmentId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
        [recreatedProjectId]: {
          id: recreatedProjectId,
          environmentId: localEnvironmentId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)).toHaveLength(1);
    expect(threadsOf(next)[0]?.projectId).toBe(recreatedProjectId);
    expect(localEnvironmentStateOf(next).threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(localEnvironmentStateOf(next).threadIdsByProjectId[recreatedProjectId]).toEqual([
      threadId,
    ]);
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.make("thread-1"),
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.make("thread-2") });
    const baseState = makeState(thread1);
    const baseEnvironmentState = localEnvironmentStateOf(baseState);
    const state = withActiveEnvironmentState(baseEnvironmentState, {
      threadIds: [thread1.id, thread2.id],
      threadShellById: {
        ...baseEnvironmentState.threadShellById,
        [thread2.id]: {
          id: thread2.id,
          environmentId: thread2.environmentId,
          codexThreadId: thread2.codexThreadId,
          projectId: thread2.projectId,
          title: thread2.title,
          modelSelection: thread2.modelSelection,
          runtimeMode: thread2.runtimeMode,
          interactionMode: thread2.interactionMode,
          error: thread2.error,
          createdAt: thread2.createdAt,
          archivedAt: thread2.archivedAt,
          settledOverride: thread2.settledOverride,
          settledAt: thread2.settledAt,
          updatedAt: thread2.updatedAt,
          branch: thread2.branch,
          worktreePath: thread2.worktreePath,
        },
      },
      threadSessionById: {
        ...baseEnvironmentState.threadSessionById,
        [thread2.id]: thread2.session,
      },
      threadTurnStateById: {
        ...baseEnvironmentState.threadTurnStateById,
        [thread2.id]: {
          latestTurn: thread2.latestTurn,
        },
      },
      messageIdsByThreadId: {
        ...baseEnvironmentState.messageIdsByThreadId,
        [thread2.id]: [],
      },
      messageByThreadId: {
        ...baseEnvironmentState.messageByThreadId,
        [thread2.id]: {},
      },
      activityIdsByThreadId: {
        ...baseEnvironmentState.activityIdsByThreadId,
        [thread2.id]: [],
      },
      activityByThreadId: {
        ...baseEnvironmentState.activityByThreadId,
        [thread2.id]: {},
      },
      proposedPlanIdsByThreadId: {
        ...baseEnvironmentState.proposedPlanIdsByThreadId,
        [thread2.id]: [],
      },
      proposedPlanByThreadId: {
        ...baseEnvironmentState.proposedPlanByThreadId,
        [thread2.id]: {},
      },
      turnDiffIdsByThreadId: {
        ...baseEnvironmentState.turnDiffIdsByThreadId,
        [thread2.id]: [],
      },
      turnDiffSummaryByThreadId: {
        ...baseEnvironmentState.turnDiffSummaryByThreadId,
        [thread2.id]: {},
      },
      sidebarThreadSummaryById: {
        ...baseEnvironmentState.sidebarThreadSummaryById,
      },
      threadIdsByProjectId: {
        [thread1.projectId]: [thread1.id, thread2.id],
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.make("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.make("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages[0]?.text).toBe("hello world");
    expect(threadsOf(next)[0]?.latestTurn?.state).toBe("running");
    const nextEnvironmentState = next.environmentStateById[localEnvironmentId];
    const previousEnvironmentState = state.environmentStateById[localEnvironmentId];
    expect(nextEnvironmentState?.messageIdsByThreadId[thread1.id]).toBe(
      previousEnvironmentState?.messageIdsByThreadId[thread1.id],
    );
    expect(nextEnvironmentState?.threadShellById[thread2.id]).toBe(
      previousEnvironmentState?.threadShellById[thread2.id],
    );
    expect(nextEnvironmentState?.threadSessionById[thread2.id]).toBe(
      previousEnvironmentState?.threadSessionById[thread2.id],
    );
    expect(nextEnvironmentState?.messageIdsByThreadId[thread2.id]).toBe(
      previousEnvironmentState?.messageIdsByThreadId[thread2.id],
    );
    expect(nextEnvironmentState?.messageByThreadId[thread2.id]).toBe(
      previousEnvironmentState?.messageByThreadId[thread2.id],
    );
  });

  it("updates activity records without rebuilding the id list when ordering is unchanged", () => {
    const thread = makeThread({
      activities: [
        {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "step",
          summary: "old summary",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
        },
      ],
    });
    const state = makeState(thread);
    const previousEnvironmentState = localEnvironmentStateOf(state);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "step",
          summary: "new summary",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
        },
      }),
      localEnvironmentId,
    );
    const nextEnvironmentState = localEnvironmentStateOf(next);

    expect(threadsOf(next)[0]?.activities[0]?.summary).toBe("new summary");
    expect(nextEnvironmentState.activityIdsByThreadId[thread.id]).toBe(
      previousEnvironmentState.activityIdsByThreadId[thread.id],
    );
  });

  it("inserts out-of-order activity appends without changing activity ordering semantics", () => {
    const thread = makeThread({
      activities: [
        {
          id: EventId.make("activity-2"),
          tone: "info",
          kind: "step",
          summary: "two",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-27T00:00:02.000Z",
        },
      ],
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.make("activity-1"),
          tone: "info",
          kind: "step",
          summary: "one",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-02-27T00:00:01.000Z",
        },
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
      EventId.make("activity-2"),
    ]);
  });

  it("stores reserved object-property names as ordinary message ids", () => {
    const thread = makeThread();
    const events = ["__proto__", "constructor"].map((id, sequence) =>
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.make(id),
          role: "assistant",
          text: id,
          turnId: null,
          streaming: true,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence },
      ),
    );
    const result = applyOrchestrationEvents(makeState(thread), events, localEnvironmentId);
    expect(threadsOf(result)[0]?.messages.map((message) => message.text)).toEqual([
      "__proto__",
      "constructor",
    ]);
  });

  it("retains distinct new messages and applies the history cap within one batch", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const events = Array.from({ length: 2005 }, (_, index) =>
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.make(`message-${index}`),
          role: "assistant",
          text: `text-${index}`,
          turnId: null,
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: index + 1 },
      ),
    );
    const actual = applyOrchestrationEvents(state, events, localEnvironmentId);
    const expected = events.reduce(
      (current, event) => applyOrchestrationEvent(current, event, localEnvironmentId),
      state,
    );
    expect(threadsOf(actual)).toEqual(threadsOf(expected));
    expect(threadsOf(actual)[0]?.messages).toHaveLength(2000);
    expect(threadsOf(actual)[0]?.messages[0]?.text).toBe("text-5");
  });

  it("batches message updates without mutating published maps across event boundaries", () => {
    const thread = makeThread();
    const state = makeState(thread);
    const previous = structuredClone(state);
    Object.freeze(localEnvironmentStateOf(state).messageByThreadId[thread.id]);
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.make("stream"),
          role: "assistant",
          text: i === 99 ? "" : "x",
          turnId: TurnId.make("turn"),
          streaming: i !== 99,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: i + 1 },
      ),
    );
    const boundary = makeEvent("thread.meta-updated", {
      threadId: thread.id,
      title: "new",
      updatedAt: "2026-02-27T00:00:03.000Z",
    });
    const mixed = [...events.slice(0, 50), boundary, ...events.slice(50)];
    const expected = mixed.reduce(
      (current, event) => applyOrchestrationEvent(current, event, localEnvironmentId),
      state,
    );
    const actual = applyOrchestrationEvents(state, mixed, localEnvironmentId);
    expect(threadsOf(actual)).toEqual(threadsOf(expected));
    expect(state).toEqual(previous);
    expect(threadsOf(actual)[0]?.messages[0]?.text).toBe("x".repeat(99));
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(
      state,
      [
        makeEvent(
          "thread.session-set",
          {
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.make("turn-1"),
              lastError: null,
              updatedAt: "2026-02-27T00:00:02.000Z",
            },
          },
          { sequence: 2 },
        ),
        makeEvent(
          "thread.message-sent",
          {
            threadId: thread.id,
            messageId: MessageId.make("assistant-1"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-02-27T00:00:03.000Z",
            updatedAt: "2026-02-27T00:00:03.000Z",
          },
          { sequence: 3 },
        ),
      ],
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.session?.status).toBe("running");
    expect(threadsOf(next)[0]?.latestTurn?.state).toBe("completed");
    expect(threadsOf(next)[0]?.messages).toHaveLength(1);
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.make("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries).toHaveLength(1);
    expect(threadsOf(next)[0]?.latestTurn).toEqual(threadsOf(state)[0]?.latestTurn);
  });

  describe("turn finalization", () => {
    const runningTurn = {
      turnId: TurnId.make("turn-1"),
      state: "running" as const,
      requestedAt: "2026-02-27T00:00:01.000Z",
      startedAt: "2026-02-27T00:00:02.000Z",
      completedAt: null,
      assistantMessageId: null,
    };
    const runningSession = {
      provider: ProviderDriverKind.make("codex"),
      status: "running" as const,
      orchestrationStatus: "running" as const,
      activeTurnId: TurnId.make("turn-1"),
      createdAt: "2026-02-27T00:00:01.000Z",
      updatedAt: "2026-02-27T00:00:02.000Z",
    };
    const releasingSessionSet = (releasedTurn: {
      turnId: TurnId;
      state: "completed" | "error" | "interrupted";
      completedAt: string;
      reason: string;
    }) =>
      makeEvent("thread.session-set", {
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          activeTurnId: null,
          lastError: null,
          updatedAt: releasedTurn.completedAt,
        },
        releasedTurn,
      });

    it("settles the released latest turn in the same frame as the session", () => {
      const state = makeState(makeThread({ latestTurn: runningTurn, session: runningSession }));
      const next = applyOrchestrationEvent(
        state,
        releasingSessionSet({
          turnId: TurnId.make("turn-1"),
          state: "completed",
          completedAt: "2026-02-27T00:00:09.000Z",
          reason: "provider-turn-completed",
        }),
        localEnvironmentId,
      );
      const thread = threadsOf(next)[0]!;
      expect(thread.latestTurn).toMatchObject({
        turnId: "turn-1",
        state: "completed",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:09.000Z",
      });
      expect(
        deriveThreadActivityStatus({
          session: thread.session,
          latestTurn: thread.latestTurn,
          interactionMode: thread.interactionMode,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          backgroundLiveness: null,
        }),
      ).toBe("idle");
    });

    it("keeps an interrupted turn sticky across a completed release", () => {
      const interrupted = {
        ...runningTurn,
        state: "interrupted" as const,
        completedAt: "2026-02-27T00:00:05.000Z",
      };
      const state = makeState(makeThread({ latestTurn: interrupted, session: runningSession }));
      const next = applyOrchestrationEvent(
        state,
        releasingSessionSet({
          turnId: TurnId.make("turn-1"),
          state: "completed",
          completedAt: "2026-02-27T00:00:09.000Z",
          reason: "provider-turn-completed",
        }),
        localEnvironmentId,
      );
      expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
        state: "interrupted",
        completedAt: "2026-02-27T00:00:05.000Z",
      });
    });

    it("ignores a release that names another turn", () => {
      const state = makeState(makeThread({ latestTurn: runningTurn, session: runningSession }));
      const next = applyOrchestrationEvent(
        state,
        releasingSessionSet({
          turnId: TurnId.make("turn-other"),
          state: "completed",
          completedAt: "2026-02-27T00:00:09.000Z",
          reason: "provider-turn-completed",
        }),
        localEnvironmentId,
      );
      expect(threadsOf(next)[0]?.latestTurn).toEqual(threadsOf(state)[0]?.latestTurn);
    });

    it("keeps the turn state when a diff for the same turn lands", () => {
      const diff = (status: "ready" | "missing", completedAt: string, sequence: number) =>
        makeEvent(
          "thread.turn-diff-completed",
          {
            threadId: ThreadId.make("thread-1"),
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            status,
            files: [],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt,
          },
          { sequence },
        );
      // Mid-turn placeholder: the running turn stays running.
      const running = applyOrchestrationEvent(
        makeState(makeThread({ latestTurn: runningTurn, session: runningSession })),
        diff("missing", "2026-02-27T00:00:04.000Z", 1),
        localEnvironmentId,
      );
      expect(threadsOf(running)[0]?.latestTurn).toMatchObject({
        state: "running",
        completedAt: null,
      });

      // Late capture after an error release keeps the error and its completedAt.
      const released = applyOrchestrationEvent(
        running,
        releasingSessionSet({
          turnId: TurnId.make("turn-1"),
          state: "error",
          completedAt: "2026-02-27T00:00:09.000Z",
          reason: "provider-turn-completed",
        }),
        localEnvironmentId,
      );
      const late = applyOrchestrationEvent(
        released,
        diff("ready", "2026-02-27T00:00:20.000Z", 3),
        localEnvironmentId,
      );
      expect(threadsOf(late)[0]?.latestTurn).toMatchObject({
        state: "error",
        completedAt: "2026-02-27T00:00:09.000Z",
        assistantMessageId: "assistant-1",
      });
      expect(threadsOf(late)[0]?.turnDiffSummaries[0]?.status).toBe("ready");
    });
  });

  it("filters placeholder modified zero-change files from completed turn diffs", () => {
    const state = makeState(makeThread());

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("checkpoint-1"),
        status: "ready",
        files: [
          { path: "src/noop.ts", kind: "modified", additions: 0, deletions: 0 },
          {
            path: "script.sh",
            kind: "mode-changed",
            additions: 0,
            deletions: 0,
          },
          { path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 },
        ],
        assistantMessageId: MessageId.make("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries[0]?.files).toEqual([
      { path: "script.sh", kind: "mode-changed", additions: 0, deletions: 0 },
      { path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 },
    ]);
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.make("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.make("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            assistantMessageId: MessageId.make("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.make("assistant-real"),
    );
    expect(threadsOf(next)[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.make("assistant-real"),
    );
  });

  it("retains message events that arrive before thread creation and replays them on create", () => {
    const state = makeEmptyState();
    const threadId = ThreadId.make("thread-late-create");
    const messageId = MessageId.make("message-early");
    const withEarlyMessage = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "user",
        text: "hello before create",
        turnId: null,
        streaming: false,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    const next = applyOrchestrationEvent(
      withEarlyMessage,
      makeEvent("thread.created", {
        threadId,
        projectId: ProjectId.make("project-1"),
        title: "late create thread",
        branch: "main",
        worktreePath: null,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages).toHaveLength(1);
    expect(threadsOf(next)[0]?.messages[0]?.id).toBe(messageId);
    expect(threadsOf(next)[0]?.messages[0]?.text).toBe("hello before create");
  });

  it("appends pending streamed message deltas before thread creation", () => {
    const state = makeEmptyState();
    const threadId = ThreadId.make("thread-late-stream");
    const messageId = MessageId.make("message-streaming-early");
    const turnId = TurnId.make("turn-streaming-early");

    const withFirstDelta = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "hello",
          turnId,
          streaming: true,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
        { sequence: 1 },
      ),
      localEnvironmentId,
    );
    const withSecondDelta = applyOrchestrationEvent(
      withFirstDelta,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: " world",
          turnId,
          streaming: true,
          createdAt: "2026-02-27T00:00:02.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
        { sequence: 2 },
      ),
      localEnvironmentId,
    );
    const withCompletion = applyOrchestrationEvent(
      withSecondDelta,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "",
          turnId,
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
      localEnvironmentId,
    );

    const next = applyOrchestrationEvent(
      withCompletion,
      makeEvent(
        "thread.created",
        {
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "late streaming thread",
          branch: "main",
          worktreePath: null,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-02-27T00:00:04.000Z",
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
        { sequence: 4 },
      ),
      localEnvironmentId,
    );

    const message = threadsOf(next)[0]?.messages[0];
    expect(message?.id).toBe(messageId);
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("consumes matching pending messages once the thread shell exists", () => {
    const threadId = ThreadId.make("thread-shell-before-detail");
    const messageId = MessageId.make("message-pending-before-shell");
    const turnId = TurnId.make("turn-pending-before-shell");
    const base = makeState(makeThread({ id: threadId, messages: [] }));
    const environmentState = localEnvironmentStateOf(base);
    const state: AppState = {
      ...base,
      environmentStateById: {
        ...base.environmentStateById,
        [localEnvironmentId]: {
          ...environmentState,
          pendingMessagesByThreadId: {
            [threadId]: [
              {
                id: messageId,
                role: "assistant",
                text: "hello",
                turnId,
                createdAt: "2026-02-27T00:00:01.000Z",
                streaming: true,
              },
            ],
          },
        },
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: " world",
        turnId,
        streaming: true,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      localEnvironmentId,
    );

    const nextEnvironmentState = localEnvironmentStateOf(next);
    const message = threadsOf(next)[0]?.messages[0];
    expect(nextEnvironmentState.pendingMessagesByThreadId[threadId]).toBeUndefined();
    expect(nextEnvironmentState.messageIdsByThreadId[threadId]).toEqual([messageId]);
    expect(message?.id).toBe(messageId);
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(true);
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.make("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.make("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.make("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.make("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.make("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.make("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(threadsOf(next)[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(threadsOf(next)[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.make("activity-1"),
    ]);
    expect(threadsOf(next)[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.make("turn-1"),
    ]);
  });

  describe("reverting a fork", () => {
    // A fork's inherited history carries its source's turn ids, which never have checkpoints in
    // the fork, and its provenance activity has none. No revert of the fork reaches before them,
    // as on the server (`isForkBaseItemId`).
    const forkId = ThreadId.make("fork-1");
    const inherited = (id: string) => `${forkId}:inherited:${id}`;
    const sourceTurn = TurnId.make("source-turn-1");
    const ownTurn1 = TurnId.make("own-turn-1");
    const ownTurn2 = TurnId.make("own-turn-2");
    const at = (second: number) => `2026-02-27T00:00:${String(second).padStart(2, "0")}.000Z`;
    const message = (
      id: string,
      role: "user" | "assistant",
      turnId: TurnId | null,
      second: number,
    ): Thread["messages"][number] => ({
      id: MessageId.make(id),
      role,
      text: id,
      turnId,
      createdAt: at(second),
      completedAt: at(second),
      streaming: false,
    });
    const plan = (id: string, turnId: TurnId, second: number): Thread["proposedPlans"][number] => ({
      id,
      turnId,
      planMarkdown: id,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: at(second),
      updatedAt: at(second),
    });
    const activity = (
      id: string,
      kind: string,
      turnId: TurnId | null,
      second: number,
    ): Thread["activities"][number] => ({
      id: EventId.make(id),
      tone: "tool",
      kind,
      summary: id,
      payload: {},
      turnId,
      createdAt: at(second),
    });

    function forkState() {
      return makeState(
        makeThread({
          id: forkId,
          messages: [
            // An inherited prompt whose turn the source never recorded.
            message(inherited("p0"), "user", null, 0),
            message(inherited("p1"), "user", sourceTurn, 1),
            message(inherited("r1"), "assistant", sourceTurn, 2),
            // An own prompt still without its turn id: only the count fallback keeps it, and
            // inherited prompts must never fill that fallback in its place.
            message("own-p1", "user", null, 20),
            message("own-r1", "assistant", ownTurn1, 21),
            message("own-p2", "user", ownTurn2, 30),
            message("own-r2", "assistant", ownTurn2, 31),
          ],
          proposedPlans: [
            plan(inherited("plan-1"), sourceTurn, 1),
            plan("own-plan-1", ownTurn1, 21),
            plan("own-plan-2", ownTurn2, 31),
          ],
          activities: [
            activity(inherited("tool-1"), "tool.completed", sourceTurn, 1),
            activity(`${forkId}:forked`, "thread.forked", null, 10),
            activity("own-tool-1", "tool.completed", ownTurn1, 21),
            activity("own-tool-2", "tool.completed", ownTurn2, 31),
          ],
          turnDiffSummaries: [
            {
              turnId: ownTurn1,
              completedAt: at(22),
              status: "ready",
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("fork-ref-1"),
              files: [],
            },
            {
              turnId: ownTurn2,
              completedAt: at(32),
              status: "ready",
              checkpointTurnCount: 2,
              checkpointRef: CheckpointRef.make("fork-ref-2"),
              files: [],
            },
          ],
        }),
      );
    }

    function revert(turnCount: number) {
      const next = applyOrchestrationEvent(
        forkState(),
        makeEvent("thread.reverted", { threadId: forkId, turnCount }),
        localEnvironmentId,
      );
      const thread = threadsOf(next)[0];
      return {
        messages: thread?.messages.map((entry) => entry.id),
        plans: thread?.proposedPlans.map((entry) => entry.id),
        activities: thread?.activities.map((entry) => entry.id),
      };
    }

    it("keeps the inherited history and the provenance when reverting to the fork's start", () => {
      expect(revert(0)).toEqual({
        messages: [inherited("p0"), inherited("p1"), inherited("r1")],
        plans: [inherited("plan-1")],
        activities: [inherited("tool-1"), `${forkId}:forked`],
      });
    });

    it("keeps the inherited history plus the fork's own turns up to the checkpoint", () => {
      expect(revert(1)).toEqual({
        messages: [inherited("p0"), inherited("p1"), inherited("r1"), "own-p1", "own-r1"],
        plans: [inherited("plan-1"), "own-plan-1"],
        activities: [inherited("tool-1"), `${forkId}:forked`, "own-tool-1"],
      });
    });
  });

  // These scenarios mirror the server projector's revert tests (same fixtures, same expected
  // ids): the optimistic client projection of a revert must equal the server's result.
  describe("reverting with the authoritative result", () => {
    const t = (minute: number) => `2026-02-23T09:${String(minute).padStart(2, "0")}:00.000Z`;
    const latestTurnAt = (turn: number, minute: number, assistantMessageId: string | null) => ({
      turnId: TurnId.make(`turn-${turn}`),
      state: "completed" as const,
      requestedAt: t(minute),
      startedAt: t(minute),
      completedAt: t(minute),
      assistantMessageId: assistantMessageId === null ? null : MessageId.make(assistantMessageId),
    });
    const turnMessage = (
      id: string,
      role: "user" | "assistant",
      turnId: string | null,
      minute: number,
    ): Thread["messages"][number] => ({
      id: MessageId.make(id),
      role,
      text: id,
      turnId: turnId === null ? null : TurnId.make(turnId),
      createdAt: t(minute),
      completedAt: t(minute),
      streaming: false,
    });
    const turnPlan = (
      id: string,
      turnId: string,
      minute: number,
    ): Thread["proposedPlans"][number] => ({
      id,
      turnId: TurnId.make(turnId),
      planMarkdown: id,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: t(minute),
      updatedAt: t(minute),
    });
    const turnActivity = (
      id: string,
      kind: string,
      turnId: string | null,
      minute: number,
    ): Thread["activities"][number] => ({
      id: EventId.make(id),
      tone: "tool",
      kind,
      summary: id,
      payload: {},
      turnId: turnId === null ? null : TurnId.make(turnId),
      createdAt: t(minute),
    });
    const checkpoint = (
      threadRef: string,
      count: number,
      completedMinute: number,
    ): Thread["turnDiffSummaries"][number] => ({
      turnId: TurnId.make(`turn-${count}`),
      completedAt: t(completedMinute),
      status: "ready",
      checkpointTurnCount: count,
      checkpointRef: CheckpointRef.make(`refs/ryco/checkpoints/${threadRef}/turn/${count}`),
      assistantMessageId: MessageId.make(`assistant-${count}`),
      files: [],
    });

    const turnIds = (...turns: number[]) => turns.map((turn) => TurnId.make(`turn-${turn}`));

    function revertThread(
      thread: Thread,
      payload: Omit<
        Extract<OrchestrationEvent, { type: "thread.reverted" }>["payload"],
        "threadId"
      >,
    ): Thread {
      const next = applyOrchestrationEvent(
        makeState(thread),
        makeEvent("thread.reverted", { threadId: thread.id, ...payload }),
        localEnvironmentId,
      );
      return threadsOf(next)[0]!;
    }

    // A thread rebuilt without checkpoints: turn-less prompts and items of later turns.
    function hydratedThread(): Thread {
      return makeThread({
        id: ThreadId.make("thread-hydrated"),
        latestTurn: latestTurnAt(9, 9, null),
        messages: [
          turnMessage("user-anchor-1", "user", null, 1),
          turnMessage("user-anchor-9", "user", null, 9),
        ],
        proposedPlans: [turnPlan("plan-3", "turn-3", 3), turnPlan("plan-9", "turn-9", 9)],
        activities: [turnActivity("activity-9", "tool.completed", "turn-9", 9)],
      });
    }

    it("uses the authoritative latest turn and boundary on a thread without checkpoints", () => {
      const reverted = revertThread(hydratedThread(), {
        turnCount: 5,
        droppedTurnIds: turnIds(6, 7, 8, 9),
        latestTurn: latestTurnAt(5, 5, null),
      });
      expect(reverted.latestTurn?.turnId).toBe("turn-5");
      expect(reverted.messages.map((entry) => entry.id)).toEqual(["user-anchor-1"]);
      expect(reverted.proposedPlans.map((entry) => entry.id)).toEqual(["plan-3"]);
      expect(reverted.activities).toEqual([]);
    });

    it("keeps the count-based projection for a revert without the authoritative fields", () => {
      const reverted = revertThread(hydratedThread(), { turnCount: 5 });
      expect(reverted.latestTurn).toBeNull();
      expect(reverted.messages.map((entry) => entry.id)).toEqual([
        "user-anchor-1",
        "user-anchor-9",
      ]);
      expect(reverted.proposedPlans).toEqual([]);
    });

    it("projects a full thread the same with and without the authoritative fields", () => {
      const live = makeThread({
        id: ThreadId.make("thread-live"),
        latestTurn: latestTurnAt(2, 5, "assistant-2"),
        turnDiffSummaries: [checkpoint("thread-live", 1, 3), checkpoint("thread-live", 2, 5)],
        messages: [1, 2].flatMap((count) => [
          turnMessage(`user-${count}`, "user", `turn-${count}`, count * 2),
          turnMessage(`assistant-${count}`, "assistant", `turn-${count}`, count * 2 + 1),
        ]),
      });
      const legacy = revertThread(live, { turnCount: 1 });
      const authoritative = revertThread(live, {
        turnCount: 1,
        droppedTurnIds: turnIds(2),
        latestTurn: latestTurnAt(1, 3, "assistant-1"),
      });
      expect(authoritative.messages).toEqual(legacy.messages);
      expect(authoritative.latestTurn).toEqual(legacy.latestTurn);
      expect(authoritative.turnDiffSummaries).toEqual(legacy.turnDiffSummaries);
      expect(legacy.messages.map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
    });

    it("always keeps a fork's inherited history, apart from the count fallback", () => {
      const forkId = ThreadId.make("fork-1");
      const inherited = (id: string) => `${forkId}:inherited:${id}`;
      const fork = makeThread({
        id: forkId,
        latestTurn: latestTurnAt(2, 22, "assistant-2"),
        turnDiffSummaries: [checkpoint("fork-1", 1, 12), checkpoint("fork-1", 2, 22)],
        // Live user prompts carry no turn id, inherited ones may not either: an inherited
        // prompt must not take the fallback slot of the fork's own first prompt.
        messages: [
          turnMessage(inherited("user-0"), "user", null, 1),
          turnMessage(inherited("assistant-0"), "assistant", "turn-source", 2),
          turnMessage("user-1", "user", null, 10),
          turnMessage("assistant-1", "assistant", "turn-1", 12),
          turnMessage("user-2", "user", null, 20),
          turnMessage("assistant-2", "assistant", "turn-2", 22),
        ],
        proposedPlans: [
          turnPlan(inherited("plan-0"), "turn-source", 3),
          turnPlan("plan-2", "turn-2", 21),
        ],
        activities: [
          turnActivity(inherited("tool-0"), "tool.completed", "turn-source", 2),
          turnActivity(`${forkId}:forked`, "thread.forked", null, 5),
          turnActivity("tool-2", "tool.completed", "turn-2", 21),
        ],
      });
      const inheritedMessageIds = [inherited("user-0"), inherited("assistant-0")];

      for (const payload of [
        { turnCount: 0 },
        { turnCount: 0, droppedTurnIds: turnIds(1, 2), latestTurn: null },
      ]) {
        const toZero = revertThread(fork, payload);
        expect(toZero.messages.map((entry) => entry.id)).toEqual(inheritedMessageIds);
        expect(toZero.proposedPlans.map((entry) => entry.id)).toEqual([inherited("plan-0")]);
        expect(toZero.activities.map((entry) => entry.id)).toEqual([
          inherited("tool-0"),
          `${forkId}:forked`,
        ]);
        expect(toZero.latestTurn).toBeNull();
      }

      const toOne = revertThread(fork, { turnCount: 1 });
      expect(toOne.messages.map((entry) => entry.id)).toEqual([
        ...inheritedMessageIds,
        "user-1",
        "assistant-1",
      ]);
    });
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.make("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.make("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.make("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.make("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.make("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
      localEnvironmentId,
    );

    expect(threadsOf(reverted)[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
      localEnvironmentId,
    );

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.make("turn-3"),
      state: "running",
    });
    expect(threadsOf(next)[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });
});

describe("thread settlement state", () => {
  function makeShellSnapshot(
    settledOverride: "settled" | "active" | null,
    settledAt: string | null,
  ) {
    const updatedAt = settledAt ?? "2026-07-31T02:00:00.000Z";
    return {
      snapshotSequence: settledOverride === "settled" ? 1 : 2,
      projects: [
        {
          id: ProjectId.make("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-settlement"),
          projectId: ProjectId.make("project-1"),
          title: "Settlement",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          worktreeId: null,
          manualStatusBucket: null,
          manualPosition: 0,
          latestTurn: null,
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt,
          archivedAt: null,
          settledOverride,
          settledAt,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ],
      updatedAt,
    };
  }

  it("treats reserved object-property names as snapshot keys", () => {
    const snapshot = makeShellSnapshot(null, null);
    const threads = ["__proto__", "constructor"].map((id) =>
      Object.assign({}, snapshot.threads[0]!, {
        id: ThreadId.make(id),
        projectId: ProjectId.make(id),
      }),
    );
    const result = syncServerShellSnapshot(
      makeEmptyState(),
      { ...snapshot, threads },
      localEnvironmentId,
    );
    const environment = localEnvironmentStateOf(result);
    expect(Object.keys(environment.threadShellById)).toEqual(["__proto__", "constructor"]);
    for (const thread of threads)
      expect(environment.threadIdsByProjectId[thread.projectId]).toEqual([thread.id]);
  });

  it("builds bulk indexes once and keeps the last duplicate shell in its final project", () => {
    const snapshot = makeShellSnapshot(null, null);
    const template = snapshot.threads[0]!;
    const threads = Array.from({ length: 2000 }, (_, index) => ({
      ...template,
      id: ThreadId.make(`bulk-${index}`),
    }));
    const moved = { ...threads[0]!, projectId: ProjectId.make("project-2"), title: "moved" };
    const result = syncServerShellSnapshot(
      makeEmptyState(),
      { ...snapshot, threads: [...threads, moved] },
      localEnvironmentId,
    );
    const environment = localEnvironmentStateOf(result);
    expect(environment.threadIds).toHaveLength(2000);
    expect(environment.threadIdsByProjectId[template.projectId]).toHaveLength(1999);
    expect(environment.threadIdsByProjectId[moved.projectId]).toEqual([moved.id]);
    expect(environment.threadShellById[moved.id]?.title).toBe("moved");
  });

  it("refreshes completion recency independently of general thread updates", () => {
    let state = makeEmptyState();
    for (const latestCompletedTurnAt of [
      null,
      "2026-07-31T01:00:00.000Z",
      "2026-07-31T01:30:00.000Z",
      null,
    ]) {
      const snapshot = makeShellSnapshot(null, null);
      state = syncServerShellSnapshot(
        state,
        {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            Object.assign(thread, { latestCompletedTurnAt }),
          ),
        },
        localEnvironmentId,
      );
      expect(
        fullThreadEntry(
          localEnvironmentStateOf(state).sidebarThreadSummaryById[
            ThreadId.make("thread-settlement")
          ],
        )?.latestCompletedTurnAt,
      ).toBe(latestCompletedTurnAt);
    }
  });

  it("replaces settlement fields with each shell generation", () => {
    const settledAt = "2026-07-31T01:00:00.000Z";
    const settled = syncServerShellSnapshot(
      makeEmptyState(),
      makeShellSnapshot("settled", settledAt),
      localEnvironmentId,
    );
    expect(
      localEnvironmentStateOf(settled).sidebarThreadSummaryById[ThreadId.make("thread-settlement")],
    ).toMatchObject({
      settledOverride: "settled",
      settledAt,
    });

    const replaced = syncServerShellSnapshot(
      settled,
      makeShellSnapshot(null, null),
      localEnvironmentId,
    );
    expect(
      localEnvironmentStateOf(replaced).sidebarThreadSummaryById[
        ThreadId.make("thread-settlement")
      ],
    ).toMatchObject({
      settledOverride: null,
      settledAt: null,
    });
  });

  it("maps settlement fields from thread detail snapshots", () => {
    const settledAt = "2026-07-31T01:00:00.000Z";
    const state = syncServerThreadDetail(
      makeEmptyState(),
      {
        id: ThreadId.make("thread-detail-settlement"),
        projectId: ProjectId.make("project-1"),
        title: "Detail settlement",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        worktreeId: null,
        manualStatusBucket: null,
        manualPosition: 0,
        latestTurn: null,
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: settledAt,
        archivedAt: null,
        settledOverride: "settled",
        settledAt,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
      localEnvironmentId,
    );

    expect(threadsOf(state)[0]).toMatchObject({ settledOverride: "settled", settledAt });
  });

  it("keeps snooze events in shell and sidebar state and clears them on unsnooze", () => {
    const threadId = ThreadId.make("thread-settlement");
    const initial = syncServerShellSnapshot(
      makeEmptyState(),
      makeShellSnapshot(null, null),
      localEnvironmentId,
    );
    const snoozedAt = "2026-07-31T03:00:00.000Z";
    const snoozedUntil = "2026-07-31T04:00:00.000Z";
    const snoozed = applyOrchestrationEvent(
      initial,
      makeEvent("thread.snoozed", { threadId, snoozedAt, snoozedUntil, updatedAt: snoozedAt }),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(snoozed).threadShellById[threadId]).toMatchObject({
      snoozedAt,
      snoozedUntil,
      settledOverride: "active",
    });
    expect(localEnvironmentStateOf(snoozed).sidebarThreadSummaryById[threadId]).toMatchObject({
      snoozedAt,
      snoozedUntil,
    });
    const awake = applyOrchestrationEvent(
      snoozed,
      makeEvent("thread.unsnoozed", { threadId, updatedAt: snoozedUntil }),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(awake).threadShellById[threadId]).toMatchObject({
      snoozedAt: null,
      snoozedUntil: null,
    });
    expect(localEnvironmentStateOf(awake).sidebarThreadSummaryById[threadId]).toMatchObject({
      snoozedAt: null,
      snoozedUntil: null,
    });
  });

  it.each(["thread.unsettled", "thread.unsnoozed"] as const)(
    "projects %s Undo restoration into shell, sidebar and detail state",
    (type) => {
      const threadId = ThreadId.make("thread-settlement");
      const initial = syncServerShellSnapshot(
        makeEmptyState(),
        makeShellSnapshot(null, null),
        localEnvironmentId,
      );
      const restoredSidebarState = {
        settledOverride: null,
        settledAt: null,
        snoozedAt: "2026-07-31T01:00:00.000Z",
        snoozedUntil: "2026-08-01T01:00:00.000Z",
      };
      const updatedAt = "2026-07-31T00:00:00.000Z";
      const restored = applyOrchestrationEvent(
        initial,
        makeEvent(type, {
          threadId,
          updatedAt,
          ...(type === "thread.unsettled" ? { reason: "user" as const } : {}),
          restoredSidebarState,
        }),
        localEnvironmentId,
      );
      expect(localEnvironmentStateOf(restored).threadShellById[threadId]).toMatchObject({
        ...restoredSidebarState,
        updatedAt,
      });
      expect(localEnvironmentStateOf(restored).sidebarThreadSummaryById[threadId]).toMatchObject({
        ...restoredSidebarState,
        updatedAt,
      });
      expect(threadsOf(restored)[0]).toMatchObject({ ...restoredSidebarState, updatedAt });
    },
  );

  it("applies raw settle and activity-unsettle events to shell and sidebar state", () => {
    const threadId = ThreadId.make("thread-settlement");
    const initial = syncServerShellSnapshot(
      makeEmptyState(),
      makeShellSnapshot(null, null),
      localEnvironmentId,
    );
    const settledAt = "2026-07-31T03:00:00.000Z";
    const settled = applyOrchestrationEvent(
      initial,
      makeEvent("thread.settled", {
        threadId,
        settledAt,
        updatedAt: settledAt,
      }),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(settled).threadShellById[threadId]).toMatchObject({
      settledOverride: "settled",
      settledAt,
    });
    expect(localEnvironmentStateOf(settled).sidebarThreadSummaryById[threadId]).toMatchObject({
      settledOverride: "settled",
      settledAt,
    });

    const activeAt = "2026-07-31T04:00:00.000Z";
    const active = applyOrchestrationEvent(
      settled,
      makeEvent("thread.unsettled", {
        threadId,
        reason: "activity",
        updatedAt: activeAt,
      }),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(active).sidebarThreadSummaryById[threadId]).toMatchObject({
      settledOverride: null,
      settledAt: null,
      updatedAt: activeAt,
    });
  });
});

describe("shell push coalescing", () => {
  function makeThreadShellUpsertEvent(params: {
    threadId: ThreadId;
    sequence: number;
    title: string;
    updatedAt: string;
    turnState: "running" | "completed";
  }): Extract<OrchestrationShellStreamEvent, { kind: "thread-upserted" }> {
    const turnId = TurnId.make(`turn-${params.threadId}`);
    return {
      kind: "thread-upserted",
      sequence: params.sequence,
      thread: {
        id: params.threadId,
        projectId: ProjectId.make("project-1"),
        title: params.title,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId,
          state: params.turnState,
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: params.turnState === "completed" ? params.updatedAt : null,
          assistantMessageId: null,
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: params.updatedAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: {
          threadId: params.threadId,
          status: params.turnState === "running" ? "running" : "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: params.turnState === "running" ? turnId : null,
          lastError: null,
          updatedAt: params.updatedAt,
        },
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    };
  }

  // A burst of shell upserts across two threads that flips turn/session state
  // between running and completed on each event.
  function recordedShellEventSequence(): Array<
    Extract<OrchestrationShellStreamEvent, { kind: "thread-upserted" }>
  > {
    const threadA = ThreadId.make("thread-a");
    const threadB = ThreadId.make("thread-b");
    return Array.from({ length: 40 }, (_unused, index) => {
      const threadId = index % 2 === 0 ? threadA : threadB;
      const turnState = index % 4 < 2 ? "running" : "completed";
      return makeThreadShellUpsertEvent({
        threadId,
        sequence: index + 1,
        title: `Thread ${threadId} @ ${index}`,
        updatedAt: `2026-02-27T00:00:${String(index).padStart(2, "0")}.000Z`,
        turnState,
      });
    });
  }

  function foldShellEvents(
    base: AppState,
    events: ReadonlyArray<Extract<OrchestrationShellStreamEvent, { kind: "thread-upserted" }>>,
  ): AppState {
    return events.reduce((state, event) => applyShellEvent(state, event, localEnvironmentId), base);
  }

  it("produces the same final turn state when coalescing a burst into one frame", () => {
    const base = makeEmptyState();
    const events = recordedShellEventSequence();

    // Reference behavior: apply every event immediately (pre-change behavior).
    const reference = foldShellEvents(base, events);

    let committed: AppState = base;
    let commits = 0;
    const scheduled: Array<() => void> = [];
    const fallbacks: Array<() => void> = [];
    const coalescer = createShellEventCoalescer({
      getState: () => committed,
      commitState: (next) => {
        commits += 1;
        committed = next;
      },
      schedule: (callback) => {
        scheduled.push(callback);
      },
      scheduleFallback: (callback) => {
        fallbacks.push(callback);
      },
    });

    for (const event of events) {
      coalescer.enqueue(event, localEnvironmentId);
    }

    // Every event waits for one frame, however slowly they arrived.
    expect(scheduled).toHaveLength(1);
    expect(commits).toBe(0);
    expect(coalescer.hasPending()).toBe(true);

    for (const flushFrame of scheduled) {
      flushFrame();
    }
    // The fallback for a frame that already ran does nothing.
    for (const fallback of fallbacks) {
      fallback();
    }

    expect(commits).toBe(1);
    expect(coalescer.hasPending()).toBe(false);
    expect(committed).toEqual(reference);

    const threadA = ThreadId.make("thread-a");
    const threadB = ThreadId.make("thread-b");
    const committedEnv = selectEnvironmentState(committed, localEnvironmentId);
    const referenceEnv = selectEnvironmentState(reference, localEnvironmentId);
    expect(committedEnv.threadTurnStateById[threadA]).toEqual(
      referenceEnv.threadTurnStateById[threadA],
    );
    expect(committedEnv.threadTurnStateById[threadB]).toEqual(
      referenceEnv.threadTurnStateById[threadB],
    );
    expect(committedEnv.threadSessionById[threadA]).toEqual(
      referenceEnv.threadSessionById[threadA],
    );
    expect(committedEnv.sidebarThreadSummaryById[threadB]).toEqual(
      referenceEnv.sidebarThreadSummaryById[threadB],
    );
  });

  it("applies a thread-priorities item as a replacement, keeping unchanged rows", () => {
    const threadA = ThreadId.make("thread-a");
    const threadB = ThreadId.make("thread-b");
    const ranking = (tier: "now" | "later", batchId: string) => ({
      tier,
      confidence: "high" as const,
      reason: "Needs a reply",
      inputFingerprint: "fp" as never,
      batchId: batchId as never,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      rankedAt: "2026-10-12T00:00:00.000Z",
      usableUntil: "2026-10-12T01:00:00.000Z",
    });
    const base = foldShellEvents(makeEmptyState(), [
      makeThreadShellUpsertEvent({
        threadId: threadA,
        sequence: 1,
        title: "A",
        updatedAt: "2026-10-12T00:00:00.000Z",
        turnState: "completed",
      }),
      makeThreadShellUpsertEvent({
        threadId: threadB,
        sequence: 2,
        title: "B",
        updatedAt: "2026-10-12T00:00:00.000Z",
        turnState: "completed",
      }),
    ]);
    const ranked = applyThreadPriorities(
      base,
      {
        kind: "thread-priorities",
        priorities: [
          { threadId: threadA, priority: ranking("now", "batch-1") },
          { threadId: threadB, priority: ranking("later", "batch-1") },
        ],
      },
      localEnvironmentId,
    );
    const rankedEnv = selectEnvironmentState(ranked, localEnvironmentId);
    expect(fullThreadEntry(rankedEnv.sidebarThreadSummaryById[threadA])?.priority?.tier).toBe(
      "now",
    );
    expect(fullThreadEntry(rankedEnv.sidebarThreadSummaryById[threadB])?.priority?.tier).toBe(
      "later",
    );

    // A later ranking that leaves thread A out clears its priority; thread B's
    // unchanged row keeps its identity.
    const reranked = applyThreadPriorities(
      ranked,
      {
        kind: "thread-priorities",
        priorities: [{ threadId: threadB, priority: ranking("later", "batch-1") }],
      },
      localEnvironmentId,
    );
    const rerankedEnv = selectEnvironmentState(reranked, localEnvironmentId);
    expect(
      fullThreadEntry(rerankedEnv.sidebarThreadSummaryById[threadA])?.priority,
    ).toBeUndefined();
    expect(rerankedEnv.sidebarThreadSummaryById[threadB]).toBe(
      rankedEnv.sidebarThreadSummaryById[threadB],
    );

    // Nothing changed: the state itself is returned.
    expect(
      applyThreadPriorities(
        reranked,
        {
          kind: "thread-priorities",
          priorities: [{ threadId: threadB, priority: ranking("later", "batch-1") }],
        },
        localEnvironmentId,
      ),
    ).toBe(reranked);
  });

  it("commits a batch of shell updates at once, preparing each against the state before it", () => {
    const events = recordedShellEventSequence().slice(0, 3);
    useStore.setState(makeEmptyState());
    let commits = 0;
    const unsubscribe = useStore.subscribe(() => {
      commits += 1;
    });
    const seenThreadCounts = useStore
      .getState()
      .applyShellEvents(
        events,
        localEnvironmentId,
        (state) => selectEnvironmentState(state, localEnvironmentId).threadIds.length,
      );
    unsubscribe();

    expect(commits).toBe(1);
    // thread-a, then thread-b are new; the third event updates thread-a.
    expect(seenThreadCounts).toEqual([0, 1, 2]);
    expect(selectEnvironmentState(useStore.getState(), localEnvironmentId).threadIds).toHaveLength(
      2,
    );
    useStore.setState(makeEmptyState());
  });

  it("commits buffered events on the fallback when no frame runs", () => {
    const base = makeEmptyState();
    const events = recordedShellEventSequence();
    let committed: AppState = base;
    const fallbacks: Array<() => void> = [];
    const coalescer = createShellEventCoalescer({
      getState: () => committed,
      commitState: (next) => {
        committed = next;
      },
      // A hidden document never runs the frame.
      schedule: () => undefined,
      scheduleFallback: (callback) => {
        fallbacks.push(callback);
      },
    });

    for (const event of events) {
      coalescer.enqueue(event, localEnvironmentId);
    }
    expect(fallbacks).toHaveLength(1);
    fallbacks[0]!();

    expect(coalescer.hasPending()).toBe(false);
    expect(committed).toEqual(foldShellEvents(base, events));
  });
});

describe("message attachment mapping", () => {
  it("carries advisory attachment dimensions through message mapping", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread.id,
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "with attachments",
        attachments: [
          {
            type: "image",
            id: "attachment-image-1",
            name: "chart.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            width: 640,
            height: 480,
          },
          {
            type: "image",
            id: "attachment-image-2",
            name: "unknown-size.png",
            mimeType: "image/png",
            sizeBytes: 512,
          },
          {
            type: "file",
            id: "attachment-file-1",
            name: "clip.mp4",
            mimeType: "video/mp4",
            sizeBytes: 2048,
            width: 1920,
            height: 1080,
          },
          {
            type: "vendorX/telemetry",
            name: "opaque-blob",
            sizeBytes: 16,
          },
        ],
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      localEnvironmentId,
    );

    const attachments = threadsOf(next)[0]?.messages[0]?.attachments;
    expect(attachments?.[0]).toEqual({
      type: "image",
      id: "attachment-image-1",
      name: "chart.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      width: 640,
      height: 480,
      previewUrl: "attachment-image-1",
    });
    expect(attachments?.[1]).toEqual({
      type: "image",
      id: "attachment-image-2",
      name: "unknown-size.png",
      mimeType: "image/png",
      sizeBytes: 512,
      previewUrl: "attachment-image-2",
    });
    expect(attachments?.[2]).toEqual({
      type: "file",
      id: "attachment-file-1",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 2048,
      width: 1920,
      height: 1080,
      previewUrl: "attachment-file-1",
    });
    expect(attachments?.[3]).toEqual({
      type: "vendorX/telemetry",
      name: "opaque-blob",
      sizeBytes: 16,
    });
  });
});

describe("usage limits on shell upserts", () => {
  it("updates the shell and summary when only the usage limit changes", () => {
    const threadId = ThreadId.make("thread-usage-limit");
    const upsert = (
      sequence: number,
      usageLimit: OrchestrationThreadShell["usageLimit"],
    ): Extract<OrchestrationShellStreamEvent, { kind: "thread-upserted" }> => ({
      kind: "thread-upserted",
      sequence,
      thread: {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Limited",
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-10-04T10:00:00.000Z",
        updatedAt: "2026-10-04T10:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        ...(usageLimit !== undefined ? { usageLimit } : {}),
      },
    });
    const first = applyShellEvent(makeEmptyState(), upsert(1, null), localEnvironmentId);
    const limit = {
      limitId: "usage-limit:thread-usage-limit:turn-1",
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      turnId: TurnId.make("turn-1"),
      message: "Claude usage limit reached.",
      limitedAt: "2026-10-04T10:00:00.000Z",
      resetAt: null,
      autoResume: null,
      updatedAt: "2026-10-04T10:00:00.000Z",
    };
    const limited = applyShellEvent(first, upsert(2, limit), localEnvironmentId);
    const environment = limited.environmentStateById[localEnvironmentId]!;
    expect(fullThreadEntry(environment.threadShellById[threadId])?.usageLimit).toEqual(limit);
    expect(fullThreadEntry(environment.sidebarThreadSummaryById[threadId])?.usageLimit).toEqual(
      limit,
    );

    const configured = applyShellEvent(
      limited,
      upsert(3, { ...limit, autoResume: true }),
      localEnvironmentId,
    );
    expect(
      fullThreadEntry(
        configured.environmentStateById[localEnvironmentId]!.sidebarThreadSummaryById[threadId],
      )?.usageLimit?.autoResume,
    ).toBe(true);
  });
});

describe("thread lineage", () => {
  const projectId = ProjectId.make("project-lineage");
  const parentId = ThreadId.make("thread-lineage-parent");
  const childId = ThreadId.make("thread-lineage-child");
  const lineage: ThreadLineage = {
    parentThreadId: parentId,
    rootThreadId: parentId,
    relationship: "delegated",
  };

  function shellThread(
    id: ThreadId,
    overrides: Partial<OrchestrationThreadShell> = {},
  ): OrchestrationThreadShell {
    return {
      id,
      projectId,
      title: `Thread ${id}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      goal: null,
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

  const upsert = (
    sequence: number,
    thread: OrchestrationThreadShell,
  ): OrchestrationShellStreamEvent => ({ kind: "thread-upserted", sequence, thread });

  it("maps shell lineage into the shell and sidebar summary", () => {
    let state = applyShellEvent(
      makeEmptyState(),
      upsert(1, shellThread(parentId)),
      localEnvironmentId,
    );
    state = applyShellEvent(
      state,
      upsert(2, shellThread(childId, { lineage })),
      localEnvironmentId,
    );
    const environment = localEnvironmentStateOf(state);
    expect(environment.threadShellById[childId]?.lineage).toEqual(lineage);
    expect(environment.sidebarThreadSummaryById[childId]?.lineage).toEqual(lineage);
    expect(environment.threadShellById[parentId]?.lineage).toBeNull();
    expect(environment.sidebarThreadSummaryById[parentId]?.lineage).toBeNull();
  });

  it("replaces a cached pre-lineage shell and summary when only lineage differs", () => {
    const base = applyShellEvent(
      makeEmptyState(),
      upsert(1, shellThread(childId)),
      localEnvironmentId,
    );
    const baseEnvironment = localEnvironmentStateOf(base);
    const { lineage: _summaryLineage, ...preLineageSummary } =
      baseEnvironment.sidebarThreadSummaryById[childId]!;
    const { lineage: _shellLineage, ...preLineageShell } =
      baseEnvironment.threadShellById[childId]!;
    const cached = withActiveEnvironmentState({
      ...baseEnvironment,
      sidebarThreadSummaryById: {
        ...baseEnvironment.sidebarThreadSummaryById,
        [childId]: preLineageSummary,
      },
      threadShellById: { ...baseEnvironment.threadShellById, [childId]: preLineageShell },
    });

    // Absent and null lineage are the same fact: the cached summary is kept.
    const unchanged = localEnvironmentStateOf(
      applyShellEvent(cached, upsert(2, shellThread(childId)), localEnvironmentId),
    );
    expect(unchanged.sidebarThreadSummaryById[childId]).toBe(preLineageSummary);

    const replaced = localEnvironmentStateOf(
      applyShellEvent(cached, upsert(3, shellThread(childId, { lineage })), localEnvironmentId),
    );
    expect(replaced.sidebarThreadSummaryById[childId]?.lineage).toEqual(lineage);
    expect(replaced.threadShellById[childId]?.lineage).toEqual(lineage);
  });

  it("keeps lineage when a thread detail rewrites the shell", () => {
    const state = syncServerThreadDetail(
      makeEmptyState(),
      {
        ...shellThread(childId, { lineage }),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(state).threadShellById[childId]?.lineage).toEqual(lineage);
    expect(selectThreadByRef(state, scopeThreadRef(localEnvironmentId, childId))?.lineage).toEqual(
      lineage,
    );
  });

  it("keeps lineage through cache hydration and demotion", () => {
    const live = applyShellEvent(
      makeEmptyState(),
      upsert(1, shellThread(childId, { lineage })),
      localEnvironmentId,
    );
    const environment = localEnvironmentStateOf(live);
    const hydrated = hydrateEnvironmentStateFromCache(
      { activeEnvironmentId: null, environmentStateById: {} },
      {
        capturedAt: 1,
        projects: [],
        worktrees: [],
        threads: [
          {
            shell: environment.threadShellById[childId]!,
            summary: environment.sidebarThreadSummaryById[childId]!,
          },
        ],
      },
      localEnvironmentId,
    );
    expect(
      environmentStateOf(hydrated, localEnvironmentId).sidebarThreadSummaryById[childId]?.lineage,
    ).toEqual(lineage);
    expect(
      environmentStateOf(hydrated, localEnvironmentId).threadShellById[childId]?.lineage,
    ).toEqual(lineage);

    const demoted = demoteEnvironmentStateToCachedSnapshot(live, localEnvironmentId, 2);
    expect(
      environmentStateOf(demoted, localEnvironmentId).sidebarThreadSummaryById[childId]?.lineage,
    ).toEqual(lineage);
  });

  it("selects direct delegated children for a thread ref", () => {
    const laterChildId = ThreadId.make("thread-lineage-later-child");
    const grandchildId = ThreadId.make("thread-lineage-grandchild");
    const threads = [
      shellThread(parentId),
      shellThread(laterChildId, { lineage, createdAt: "2026-10-01T00:00:05.000Z" }),
      shellThread(childId, { lineage, createdAt: "2026-10-01T00:00:01.000Z" }),
      shellThread(grandchildId, {
        lineage: { parentThreadId: childId, rootThreadId: parentId, relationship: "delegated" },
      }),
    ];
    let state = makeEmptyState();
    threads.forEach((thread, index) => {
      state = applyShellEvent(state, upsert(index + 1, thread), localEnvironmentId);
    });

    const children = selectDelegatedChildThreadsForThreadRef(
      state,
      scopeThreadRef(localEnvironmentId, parentId),
    );
    expect(children.map((child) => child.id)).toEqual([childId, laterChildId]);
    expect(
      selectDelegatedChildThreadsForThreadRef(
        state,
        scopeThreadRef(localEnvironmentId, childId),
      ).map((child) => child.id),
    ).toEqual([grandchildId]);
    expect(selectDelegatedChildThreadsForThreadRef(state, null)).toEqual([]);

    // Without a parent shell, every summary in the environment is a candidate.
    const withoutParent = applyShellEvent(
      state,
      { kind: "thread-removed", sequence: 10, threadId: parentId },
      localEnvironmentId,
    );
    expect(
      selectDelegatedChildThreadsForThreadRef(
        withoutParent,
        scopeThreadRef(localEnvironmentId, parentId),
      ).map((child) => child.id),
    ).toEqual([childId, laterChildId]);
  });
});

describe("evicting thread bodies", () => {
  const first = ThreadId.make("thread-first");
  const second = ThreadId.make("thread-second");
  const firstRef = scopeThreadRef(localEnvironmentId, first);
  const secondRef = scopeThreadRef(localEnvironmentId, second);
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();

  function shellThread(id: ThreadId, overrides: Record<string, unknown> = {}) {
    return {
      id,
      projectId: ProjectId.make("project-1"),
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
      createdAt: at(0),
      updatedAt: at(0),
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

  function makeWindow(id: ThreadId): OrchestrationThreadWindowSnapshot {
    const historyPage = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };
    const {
      latestUserMessageAt: _latest,
      hasPendingApprovals: _a,
      hasPendingUserInput: _u,
      hasActionableProposedPlan: _p,
      ...thread
    } = shellThread(id);
    return {
      snapshotSequence: 10,
      thread: {
        ...thread,
        deletedAt: null,
        messages: [1, 2].map((index) => ({
          id: MessageId.make(`${id}-message-${index}`),
          role: index === 1 ? "user" : "assistant",
          text: `Message ${index}`,
          turnId: null,
          streaming: false,
          createdAt: at(index),
          updatedAt: at(index),
        })),
        proposedPlans: [
          {
            id: `${id}-plan`,
            turnId: null,
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: at(1),
            updatedAt: at(1),
          },
        ],
        activities: [
          {
            id: EventId.make(`${id}-activity`),
            tone: "tool",
            kind: "tool.completed",
            summary: "Tool",
            payload: { detail: "output" },
            turnId: null,
            sequence: 1,
            createdAt: at(1),
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make(`${id}-turn`),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make(`${id}-ref`),
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

  function archivedStub(id: ThreadId) {
    return {
      id,
      projectId: ProjectId.make("project-1"),
      title: `Thread ${id}`,
      branch: null,
      worktreePath: null,
      worktreeId: null,
      createdAt: at(0),
      updatedAt: at(7),
      archivedAt: at(7),
      latestUserMessageAt: null,
      lineage: null,
    };
  }

  function shellSnapshot(
    snapshotSequence: number,
    threads: ReadonlyArray<ReturnType<typeof shellThread>>,
    archivedThreadStubs?: ReadonlyArray<ReturnType<typeof archivedStub>>,
  ): OrchestrationStubbedShellSnapshot {
    return {
      snapshotSequence,
      projects: [
        {
          id: ProjectId.make("project-1"),
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at(0),
          updatedAt: at(0),
        },
      ],
      threads,
      ...(archivedThreadStubs === undefined ? {} : { archivedThreadStubs }),
      updatedAt: at(0),
    } as unknown as OrchestrationStubbedShellSnapshot;
  }

  /** Both threads listed by the shell, opened, and with a history page still loading. */
  function loadedState(): AppState {
    let state = syncServerShellSnapshot(
      makeEmptyState(),
      shellSnapshot(1, [shellThread(first), shellThread(second)]),
      localEnvironmentId,
    );
    for (const id of [first, second]) {
      state = syncServerThreadWindow(state, makeWindow(id), localEnvironmentId);
      state = setServerThreadHistoryLoadState(state, {
        environmentId: localEnvironmentId,
        threadId: id,
        collection: "messages",
        loadState: { status: "loading", cursor: null, error: null },
      });
    }
    return state;
  }

  /** Whether a composed thread is memoized under the shell. */
  const composedUnder = (shell: ThreadShellOrStub | undefined) =>
    shell !== undefined && threadCache.has(shell as ThreadShell);

  const bodyRecords = [
    "messageIdsByThreadId",
    "messageByThreadId",
    "activityIdsByThreadId",
    "activityByThreadId",
    "proposedPlanIdsByThreadId",
    "proposedPlanByThreadId",
    "turnDiffIdsByThreadId",
    "turnDiffSummaryByThreadId",
    "threadHistoryByThreadId",
    "threadHistoryLoadByThreadId",
  ] as const;

  it("drops a thread's body and keeps its shell, session, turn state and summary", () => {
    const before = localEnvironmentStateOf(loadedState());
    for (const key of bodyRecords) expect(before[key]).toHaveProperty(first);

    const after = localEnvironmentStateOf(evictThreadBodies(loadedState(), [firstRef]));

    for (const key of bodyRecords) expect(after[key]).not.toHaveProperty(first);
    expect(after.threadShellById[first]).toBeDefined();
    expect(after.threadSessionById).toHaveProperty(first);
    expect(after.threadTurnStateById).toHaveProperty(first);
    expect(after.sidebarThreadSummaryById[first]?.title).toBe(`Thread ${first}`);
    expect(after.threadIds).toEqual(before.threadIds);
    expect(after.bootstrapComplete).toBe(true);
  });

  it("keeps the rows of every other thread by identity", () => {
    const loaded = loadedState();
    const before = localEnvironmentStateOf(loaded);
    const after = localEnvironmentStateOf(evictThreadBodies(loaded, [firstRef]));

    for (const key of bodyRecords) {
      expect(after[key]![second]).toBe(before[key]![second]);
    }
    expect(after.threadShellById).toBe(before.threadShellById);
    expect(after.threadSessionById).toBe(before.threadSessionById);
    expect(after.threadTurnStateById).toBe(before.threadTurnStateById);
    expect(after.sidebarThreadSummaryById).toBe(before.sidebarThreadSummaryById);
    expect(after.threadIdsByProjectId).toBe(before.threadIdsByProjectId);
    expect(after.projectById).toBe(before.projectById);
  });

  it("does not publish a new state when no listed thread holds a body", () => {
    const loaded = loadedState();
    const evicted = evictThreadBodies(loaded, [firstRef]);
    expect(evictThreadBodies(evicted, [firstRef])).toBe(evicted);
    expect(evictThreadBodies(loaded, [])).toBe(loaded);
    expect(evictThreadBodies(loaded, [scopeThreadRef(remoteEnvironmentId, first)])).toBe(loaded);
  });

  it("drops several threads at once and the pending messages of a thread without a shell", () => {
    const pendingId = ThreadId.make("thread-pending");
    const pending = applyOrchestrationEvent(
      loadedState(),
      makeEvent("thread.message-sent", {
        threadId: pendingId,
        messageId: MessageId.make("pending-message"),
        role: "assistant",
        text: "early",
        turnId: null,
        streaming: true,
        createdAt: at(3),
        updatedAt: at(3),
      }),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(pending).pendingMessagesByThreadId[pendingId]).toHaveLength(1);

    const after = localEnvironmentStateOf(
      evictThreadBodies(pending, [
        firstRef,
        secondRef,
        scopeThreadRef(localEnvironmentId, pendingId),
      ]),
    );

    expect(after.messageByThreadId).toEqual({});
    expect(after.activityByThreadId).toEqual({});
    expect(after.pendingMessagesByThreadId).toEqual({});
  });

  it("ends a cached body's provenance with the body", () => {
    const loaded = loadedState();
    const environment = localEnvironmentStateOf(loaded);
    const hydrated = hydrateEnvironmentStateFromCache(
      { activeEnvironmentId: null, environmentStateById: {} },
      {
        capturedAt: 1,
        projects: [],
        worktrees: [],
        threads: [
          {
            shell: environment.threadShellById[first]!,
            summary: environment.sidebarThreadSummaryById[first]!,
            content: {
              messages: [
                {
                  id: MessageId.make("cached-message"),
                  role: "user",
                  text: "cached",
                  createdAt: at(1),
                  streaming: false,
                },
              ],
            },
          },
        ],
      },
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(hydrated).cachedMessageThreadIds).toHaveProperty(first);

    const after = localEnvironmentStateOf(evictThreadBodies(hydrated, [firstRef]));

    expect(after.cachedMessageThreadIds).toEqual({});
    expect(after.messageByThreadId).toEqual({});
    expect(after.threadShellById[first]).toBeDefined();
  });

  it("forgets the thread composed from a dropped body", () => {
    const loaded = loadedState();
    const environment = localEnvironmentStateOf(loaded);
    const composed = getThreadFromEnvironmentState(environment, first);
    const untouched = getThreadFromEnvironmentState(environment, second);
    expect(composed?.messages).toHaveLength(2);
    expect(getThreadFromEnvironmentState(environment, first)).toBe(composed);

    const after = localEnvironmentStateOf(evictThreadBodies(loaded, [firstRef]));

    // Composing from the state before the eviction builds the thread anew: the
    // memo under its shell, and the body it held, are gone.
    const recomposed = getThreadFromEnvironmentState(environment, first);
    expect(recomposed).not.toBe(composed);
    expect(recomposed).toEqual(composed);
    expect(getThreadFromEnvironmentState(environment, second)).toBe(untouched);
    expect(after.threadShellById[first]).toBe(environment.threadShellById[first]);
    expect(after.threadSessionById[first]).toBe(environment.threadSessionById[first]);
    expect(after.threadTurnStateById[first]).toBe(environment.threadTurnStateById[first]);
    expect(after.sidebarThreadSummaryById[first]).toBe(environment.sidebarThreadSummaryById[first]);
  });

  it("forgets the rows collected from a dropped body", () => {
    const loaded = loadedState();
    const environment = localEnvironmentStateOf(loaded);
    getThreadFromEnvironmentState(environment, first);
    getThreadFromEnvironmentState(environment, second);
    const idListsOf = (threadId: ThreadId): ReadonlyArray<readonly string[] | undefined> => [
      environment.messageIdsByThreadId[threadId],
      environment.activityIdsByThreadId[threadId],
      environment.proposedPlanIdsByThreadId[threadId],
      environment.turnDiffIdsByThreadId[threadId],
    ];
    for (const ids of [...idListsOf(first), ...idListsOf(second)]) {
      expect(ids?.length).toBeGreaterThan(0);
      expect(collectedByIdsCache.has(ids!)).toBe(true);
    }

    evictThreadBodies(loaded, [firstRef]);

    // The state before the eviction still holds both keys of every dropped list.
    for (const ids of idListsOf(first)) expect(collectedByIdsCache.has(ids!)).toBe(false);
    for (const ids of idListsOf(second)) expect(collectedByIdsCache.has(ids!)).toBe(true);
  });

  it("forgets the thread composed under a shell an update replaced", () => {
    const loaded = loadedState();
    const environment = localEnvironmentStateOf(loaded);
    const previousShell = environment.threadShellById[first];
    expect(getThreadFromEnvironmentState(environment, first)?.messages).toHaveLength(2);
    expect(composedUnder(previousShell)).toBe(true);

    const updated = applyOrchestrationEvent(
      loaded,
      makeEvent(
        "thread.meta-updated",
        { threadId: first, title: "Renamed", updatedAt: at(5) },
        { sequence: 11 },
      ),
      localEnvironmentId,
    );
    const nextShell = localEnvironmentStateOf(updated).threadShellById[first];
    expect(nextShell).not.toBe(previousShell);
    expect(nextShell?.title).toBe("Renamed");
    expect(composedUnder(previousShell)).toBe(false);

    getThreadFromEnvironmentState(localEnvironmentStateOf(updated), first);
    expect(composedUnder(nextShell)).toBe(true);
    evictThreadBodies(updated, [firstRef]);

    // No shell of the thread the test kept reaches a composed body any more.
    expect(composedUnder(previousShell)).toBe(false);
    expect(composedUnder(nextShell)).toBe(false);
  });

  it("forgets the thread composed under a shell the shell stream or a snapshot replaced or dropped", () => {
    const composeBoth = () => {
      const loaded = loadedState();
      const environment = localEnvironmentStateOf(loaded);
      getThreadFromEnvironmentState(environment, first);
      getThreadFromEnvironmentState(environment, second);
      const firstShell = environment.threadShellById[first];
      const secondShell = environment.threadShellById[second];
      expect(composedUnder(firstShell)).toBe(true);
      expect(composedUnder(secondShell)).toBe(true);
      return { loaded, firstShell, secondShell };
    };

    const upserted = composeBoth();
    const afterUpsert = applyShellEvent(
      upserted.loaded,
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: shellThread(first, { title: "Upserted", updatedAt: at(6) }),
      } as never,
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(afterUpsert).threadShellById[first]?.title).toBe("Upserted");
    expect(composedUnder(upserted.firstShell)).toBe(false);
    expect(composedUnder(upserted.secondShell)).toBe(true);

    const resynced = composeBoth();
    const afterSnapshot = syncServerShellSnapshot(
      resynced.loaded,
      shellSnapshot(2, [shellThread(first, { title: "Renamed", updatedAt: at(6) })]),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(afterSnapshot).threadIds).toEqual([first]);
    expect(composedUnder(resynced.firstShell)).toBe(false);
    expect(composedUnder(resynced.secondShell)).toBe(false);

    const removed = composeBoth();
    const afterRemoval = applyShellEvent(
      removed.loaded,
      { kind: "thread-removed", sequence: 2, threadId: first },
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(afterRemoval).threadShellById[first]).toBeUndefined();
    expect(composedUnder(removed.firstShell)).toBe(false);
    expect(composedUnder(removed.secondShell)).toBe(true);
  });

  it("forgets the thread composed under a shell a settlement or archive replaced", () => {
    const loaded = loadedState();
    const environment = localEnvironmentStateOf(loaded);
    getThreadFromEnvironmentState(environment, first);
    const previousShell = environment.threadShellById[first];
    expect(composedUnder(previousShell)).toBe(true);

    const settled = applyOrchestrationEvent(
      loaded,
      makeEvent(
        "thread.settled",
        { threadId: first, settledAt: at(7), updatedAt: at(7) },
        { sequence: 11 },
      ),
      localEnvironmentId,
    );
    expect(localEnvironmentStateOf(settled).threadShellById[first]).toMatchObject({
      settledAt: at(7),
    });
    expect(composedUnder(previousShell)).toBe(false);

    const reloaded = loadedState();
    const reloadedEnvironment = localEnvironmentStateOf(reloaded);
    getThreadFromEnvironmentState(reloadedEnvironment, first);
    const fullShell = reloadedEnvironment.threadShellById[first];
    expect(composedUnder(fullShell)).toBe(true);

    const archived = syncServerShellSnapshot(
      reloaded,
      shellSnapshot(2, [shellThread(second)], [archivedStub(first)]),
      localEnvironmentId,
    );
    expect(isArchivedThreadStub(localEnvironmentStateOf(archived).threadShellById[first])).toBe(
      true,
    );
    expect(composedUnder(fullShell)).toBe(false);
  });

  it("keeps the composed thread of a shell that stays", () => {
    const loaded = loadedState();
    const environment = localEnvironmentStateOf(loaded);
    const shell = environment.threadShellById[first];
    const composed = getThreadFromEnvironmentState(environment, first);
    expect(composedUnder(shell)).toBe(true);
    const expectKept = (state: AppState) => {
      expect(localEnvironmentStateOf(state).threadShellById[first]).toBe(shell);
      expect(composedUnder(shell)).toBe(true);
      expect(getThreadFromEnvironmentState(localEnvironmentStateOf(state), first)).toBe(composed);
    };

    expectKept(
      syncServerShellSnapshot(
        loaded,
        shellSnapshot(2, [shellThread(first), shellThread(second)]),
        localEnvironmentId,
      ),
    );

    // An event that leaves the shell as it is, alone and inside a batch.
    const unchanged = (sequence: number) =>
      makeEvent(
        "thread.meta-updated",
        { threadId: first, title: `Thread ${first}`, updatedAt: at(0) },
        { sequence },
      );
    expectKept(applyOrchestrationEvent(loaded, unchanged(12), localEnvironmentId));
    expectKept(
      applyOrchestrationEvents(loaded, [unchanged(12), unchanged(13)], localEnvironmentId),
    );
  });

  it("loads the thread again as if it had never been opened", () => {
    const loaded = loadedState();
    expect(selectThreadDetailLoaded(loaded, firstRef)).toBe(true);

    const evicted = evictThreadBodies(loaded, [firstRef]);
    expect(selectThreadDetailLoaded(evicted, firstRef)).toBe(false);
    expect(selectThreadByRef(evicted, firstRef)?.messages).toEqual([]);

    const reopened = syncServerThreadWindow(evicted, makeWindow(first), localEnvironmentId);
    expect(selectThreadDetailLoaded(reopened, firstRef)).toBe(true);
    expect(selectThreadByRef(reopened, firstRef)?.messages.map((message) => message.text)).toEqual([
      "Message 1",
      "Message 2",
    ]);
    expect(selectThreadByRef(reopened, firstRef)?.activities).toHaveLength(1);
  });

  it("is available as a store action", () => {
    const previous = useStore.getState();
    try {
      useStore.setState(loadedState());
      useStore.getState().evictThreadBodies([firstRef]);

      const environment = selectEnvironmentState(useStore.getState(), localEnvironmentId);
      expect(environment.messageByThreadId).not.toHaveProperty(first);
      expect(environment.messageByThreadId).toHaveProperty(second);
    } finally {
      useStore.setState(previous, true);
    }
  });
});

describe("thread errors", () => {
  const releasedSession = {
    threadId: ThreadId.make("thread-1"),
    status: "error" as const,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: ORPHANED_PROVIDER_SESSION_ERROR,
    updatedAt: "2026-02-27T00:00:02.000Z",
  };

  it("shows no thread error for a session a server restart released", () => {
    const released = applyOrchestrationEvent(
      makeState(makeThread()),
      makeEvent("thread.session-set", {
        threadId: releasedSession.threadId,
        session: releasedSession,
      }),
      localEnvironmentId,
    );
    expect(threadsOf(released)[0]?.session?.lastError).toBe(ORPHANED_PROVIDER_SESSION_ERROR);
    expect(threadsOf(released)[0]?.error).toBeNull();

    const failed = applyOrchestrationEvent(
      released,
      makeEvent(
        "thread.session-set",
        {
          threadId: releasedSession.threadId,
          session: { ...releasedSession, lastError: "Provider exited (code 1)" },
        },
        { sequence: 2 },
      ),
      localEnvironmentId,
    );
    expect(threadsOf(failed)[0]?.error).toBe("Provider exited (code 1)");
  });

  it("maps a released session from shell and detail snapshots without an error", () => {
    const shell: OrchestrationThreadShell = {
      id: releasedSession.threadId,
      projectId: ProjectId.make("project-1"),
      title: "Released",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      worktreeId: null,
      manualStatusBucket: null,
      manualPosition: 0,
      latestTurn: null,
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:02.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: releasedSession,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    };
    const fromShell = syncServerShellSnapshot(
      makeEmptyState(),
      { snapshotSequence: 1, projects: [], threads: [shell], updatedAt: shell.updatedAt },
      localEnvironmentId,
    );
    expect(
      fullThreadEntry(localEnvironmentStateOf(fromShell).threadShellById[shell.id])?.error,
    ).toBeNull();

    const fromDetail = syncServerThreadDetail(
      makeEmptyState(),
      {
        ...shell,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
      localEnvironmentId,
    );
    expect(threadsOf(fromDetail)[0]?.error).toBeNull();
    expect(
      threadsOf(
        syncServerThreadDetail(
          makeEmptyState(),
          {
            ...shell,
            session: { ...releasedSession, lastError: "Provider exited (code 1)" },
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          localEnvironmentId,
        ),
      )[0]?.error,
    ).toBe("Provider exited (code 1)");
  });
});
