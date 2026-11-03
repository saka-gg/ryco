/**
 * Thread-store fixtures shared by the store's tests: an app state holding one thread.
 *
 * @module store.testSupport
 */
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts/base-schemas";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";

import type { AppState, EnvironmentState } from "./store.ts";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types.ts";

export const localEnvironmentId = EnvironmentId.make("environment-local");

export function withActiveEnvironmentState(
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

export function makeThread(overrides: Partial<Thread> = {}): Thread {
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

export function makeState(thread: Thread): AppState {
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
