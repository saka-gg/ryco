import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  CheckpointRef,
  DEFAULT_MODEL,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  OrchestrationThreadHistoryCursor,
  ThreadId,
  TurnId,
  WorktreeId,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  applyShellEvent,
  createShellEventCoalescer,
  removeEnvironmentState,
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectThreadByRef,
  selectThreadExistsByRef,
  setSidebarWorktreeTitle,
  setThreadBranch,
  syncServerThreadHistoryPage,
  selectThreadsAcrossEnvironments,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  SHELL_COALESCE_THRESHOLD_EVENTS_PER_MS,
  type AppState,
  type EnvironmentState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function withActiveEnvironmentState(
  environmentState: EnvironmentState,
  overrides: Partial<AppState & EnvironmentState> = {},
): AppState {
  const {
    activeEnvironmentId: overrideActiveEnvironmentId,
    environmentStateById: overrideEnvironmentStateById,
    ...environmentOverrides
  } = overrides;
  const activeEnvironmentId = overrideActiveEnvironmentId ?? localEnvironmentId;
  const mergedEnvironmentState = {
    ...environmentState,
    ...environmentOverrides,
  };
  const environmentStateById =
    overrideEnvironmentStateById ??
    (activeEnvironmentId
      ? {
          [activeEnvironmentId]: mergedEnvironmentState,
        }
      : {});

  return {
    activeEnvironmentId,
    environmentStateById,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  const projectId = ProjectId.make("project-1");
  const project = {
    id: projectId,
    environmentId: thread.environmentId,
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    scripts: [],
  };
  const threadIdsByProjectId: EnvironmentState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  const environmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: project,
    },
    threadIds: [thread.id],
    threadIdsByProjectId,
    threadShellById: {
      [thread.id]: {
        id: thread.id,
        environmentId: thread.environmentId,
        codexThreadId: thread.codexThreadId,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        error: thread.error,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        settledOverride: thread.settledOverride,
        settledAt: thread.settledAt,
        updatedAt: thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      },
    },
    threadSessionById: {
      [thread.id]: thread.session,
    },
    threadTurnStateById: {
      [thread.id]: {
        latestTurn: thread.latestTurn,
        ...(thread.pendingSourceProposedPlan
          ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
          : {}),
      },
    },
    messageIdsByThreadId: {
      [thread.id]: thread.messages.map((message) => message.id),
    },
    messageByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.messages.map((message) => [message.id, message] as const),
      ) as EnvironmentState["messageByThreadId"][ThreadId],
    },
    pendingMessagesByThreadId: {},
    activityIdsByThreadId: {
      [thread.id]: thread.activities.map((activity) => activity.id),
    },
    activityByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.activities.map((activity) => [activity.id, activity] as const),
      ) as EnvironmentState["activityByThreadId"][ThreadId],
    },
    proposedPlanIdsByThreadId: {
      [thread.id]: thread.proposedPlans.map((plan) => plan.id),
    },
    proposedPlanByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.proposedPlans.map((plan) => [plan.id, plan] as const),
      ) as EnvironmentState["proposedPlanByThreadId"][ThreadId],
    },
    turnDiffIdsByThreadId: {
      [thread.id]: thread.turnDiffSummaries.map((summary) => summary.turnId),
    },
    turnDiffSummaryByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
      ) as EnvironmentState["turnDiffSummaryByThreadId"][ThreadId],
    },
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState, {
    activeEnvironmentId: thread.environmentId,
  });
}

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
        localEnvironmentStateOf(state).sidebarThreadSummaryById["thread-settlement"]
          ?.latestCompletedTurnAt,
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
      localEnvironmentStateOf(settled).sidebarThreadSummaryById["thread-settlement"],
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
      localEnvironmentStateOf(replaced).sidebarThreadSummaryById["thread-settlement"],
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

  it("produces the same final turn state when coalescing a high-frequency burst", () => {
    const base = makeEmptyState();
    const events = recordedShellEventSequence();

    // Reference behavior: apply every event immediately (pre-change behavior).
    const reference = foldShellEvents(base, events);

    let committed: AppState = base;
    const scheduled: Array<() => void> = [];
    const coalescer = createShellEventCoalescer({
      getState: () => committed,
      commitState: (next) => {
        committed = next;
      },
      // Constant clock => zero span => infinite events/ms => always over threshold.
      now: () => 0,
      schedule: (callback) => {
        scheduled.push(callback);
      },
    });

    for (const event of events) {
      coalescer.enqueue(event, localEnvironmentId);
    }

    // The burst must have been coalesced into a single deferred frame flush.
    expect(scheduled).toHaveLength(1);
    expect(coalescer.hasPending()).toBe(true);

    for (const flushFrame of scheduled) {
      flushFrame();
    }

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

  it("applies shell events immediately when the rate stays under the threshold", () => {
    const base = makeEmptyState();
    const events = recordedShellEventSequence();
    const reference = foldShellEvents(base, events);

    let committed: AppState = base;
    const scheduled: Array<() => void> = [];
    let clock = 0;
    const coalescer = createShellEventCoalescer({
      getState: () => committed,
      commitState: (next) => {
        committed = next;
      },
      // Space events far enough apart to stay well under the threshold.
      now: () => {
        clock += 1000 / SHELL_COALESCE_THRESHOLD_EVENTS_PER_MS + 5;
        return clock;
      },
      schedule: (callback) => {
        scheduled.push(callback);
      },
    });

    for (const event of events) {
      coalescer.enqueue(event, localEnvironmentId);
    }

    // No frame was scheduled; every event committed synchronously.
    expect(scheduled).toHaveLength(0);
    expect(coalescer.hasPending()).toBe(false);
    expect(committed).toEqual(reference);
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
