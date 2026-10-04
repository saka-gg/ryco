import {
  CheckpointRef,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorktreeId,
  type OrchestrationLatestTurnState,
  type OrchestrationSessionStatus,
  type OrchestrationThreadActivity,
  type ScopedThreadRef,
  type ThreadUsageLimit,
} from "@ryco/contracts";

import type { AppState, EnvironmentState } from "../src/state/threads/store.ts";
import type {
  SidebarThreadSummary,
  SidebarWorktreeSummary,
  ThreadSession,
  ThreadShell,
} from "../src/state/threads/types.ts";

/** Shared AppState builders for the message-queue policy tests. */

export const QUEUE_ENV = EnvironmentId.make("env-queue");
const PROJECT = ProjectId.make("project-queue");
const AT = "2026-10-01T10:00:00.000Z";

export function queueRef(threadId: string): ScopedThreadRef {
  return { environmentId: QUEUE_ENV, threadId: ThreadId.make(threadId) };
}

export function queueKey(threadId: string): string {
  return `${QUEUE_ENV}:${threadId}`;
}

export interface SessionFixture {
  readonly status: OrchestrationSessionStatus;
  readonly activeTurnId?: string | null;
  readonly lastError?: string | null;
  readonly providerInstanceId?: string;
  readonly updatedAt?: string;
}

export interface ActivityFixture {
  readonly id: string;
  readonly kind: string;
  readonly payload?: unknown;
  readonly turnId?: string | null;
}

export interface ThreadFixture {
  readonly id: string;
  readonly session?: SessionFixture | null;
  readonly latestTurn?: {
    readonly turnId: string;
    readonly state: OrchestrationLatestTurnState;
  } | null;
  /** The latest turn's checkpoint summary. */
  readonly latestCheckpoint?: {
    readonly status: "ready" | "missing" | "error";
    readonly checkpointRef: string;
  };
  /** undefined = no detail applied. */
  readonly messageIds?: readonly string[];
  readonly activities?: readonly ActivityFixture[];
  readonly archivedAt?: string | null;
  readonly worktreeArchivedAt?: string | null;
  readonly summary?: Partial<SidebarThreadSummary>;
  readonly history?: boolean;
  readonly usageLimit?: ThreadUsageLimit | null;
  /** The thread's model target instance; defaults to "codex". */
  readonly modelInstanceId?: string;
}

function toSession(fixture: SessionFixture): ThreadSession {
  const legacyStatus: ThreadSession["status"] =
    fixture.status === "running"
      ? "running"
      : fixture.status === "starting"
        ? "connecting"
        : fixture.status === "error"
          ? "error"
          : fixture.status === "idle" || fixture.status === "stopped"
            ? "closed"
            : "ready";
  return {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make(fixture.providerInstanceId ?? "codex"),
    status: legacyStatus,
    orchestrationStatus: fixture.status,
    ...(fixture.activeTurnId ? { activeTurnId: TurnId.make(fixture.activeTurnId) } : {}),
    createdAt: fixture.updatedAt ?? AT,
    updatedAt: fixture.updatedAt ?? AT,
    ...(fixture.lastError ? { lastError: fixture.lastError } : {}),
  };
}

function toActivity(fixture: ActivityFixture, index: number): OrchestrationThreadActivity {
  return {
    id: EventId.make(fixture.id),
    tone: fixture.kind.endsWith("failed") ? "error" : "info",
    kind: fixture.kind,
    summary: fixture.kind,
    payload: fixture.payload ?? {},
    turnId: fixture.turnId ? TurnId.make(fixture.turnId) : null,
    sequence: index + 1,
    createdAt: AT,
  };
}

export function emptyEnvironmentState(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    worktreeIds: [],
    worktreeIdsByProjectId: {},
    worktreeById: {},
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
    threadHistoryByThreadId: {},
    threadHistoryLoadByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
    hydratedFromCacheAt: undefined,
    ...overrides,
  };
}

/** Writes (or replaces) one thread's records with fresh identities. */
export function withThread(state: AppState, fixture: ThreadFixture): AppState {
  const environment = state.environmentStateById[QUEUE_ENV] ?? emptyEnvironmentState();
  const threadId = ThreadId.make(fixture.id);
  const worktreeId =
    fixture.worktreeArchivedAt !== undefined ? WorktreeId.make(`wt-${fixture.id}`) : null;
  const shell: ThreadShell = {
    id: threadId,
    environmentId: QUEUE_ENV,
    codexThreadId: null,
    projectId: PROJECT,
    title: fixture.id,
    modelSelection: {
      instanceId: ProviderInstanceId.make(fixture.modelInstanceId ?? "codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    error: null,
    createdAt: AT,
    archivedAt: fixture.archivedAt ?? null,
    branch: null,
    worktreePath: null,
    worktreeId,
    ...(fixture.usageLimit !== undefined ? { usageLimit: fixture.usageLimit } : {}),
  };
  const latestTurn = fixture.latestTurn
    ? {
        turnId: TurnId.make(fixture.latestTurn.turnId),
        state: fixture.latestTurn.state,
        requestedAt: AT,
        startedAt: AT,
        completedAt: fixture.latestTurn.state === "running" ? null : AT,
        assistantMessageId: null,
      }
    : null;
  const summary: SidebarThreadSummary = {
    id: threadId,
    environmentId: QUEUE_ENV,
    projectId: PROJECT,
    title: fixture.id,
    interactionMode: "default",
    session: null,
    createdAt: AT,
    archivedAt: fixture.archivedAt ?? null,
    latestTurn,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...fixture.summary,
  };
  const activities = (fixture.activities ?? []).map(toActivity);
  const detail = fixture.messageIds !== undefined;
  const messageIdsByThreadId = { ...environment.messageIdsByThreadId };
  const activityIdsByThreadId = { ...environment.activityIdsByThreadId };
  const activityByThreadId = { ...environment.activityByThreadId };
  if (detail) {
    messageIdsByThreadId[threadId] = fixture.messageIds!.map((id) => MessageId.make(id));
    activityIdsByThreadId[threadId] = activities.map((activity) => activity.id);
    activityByThreadId[threadId] = Object.fromEntries(
      activities.map((activity) => [activity.id, activity]),
    );
  } else {
    delete messageIdsByThreadId[threadId];
    delete activityIdsByThreadId[threadId];
    delete activityByThreadId[threadId];
  }
  // Left untouched unless given, so a test can mix fixtures with applied
  // `thread.turn-diff-completed` events.
  const turnDiffSummaryByThreadId = { ...environment.turnDiffSummaryByThreadId };
  if (latestTurn && fixture.latestCheckpoint) {
    turnDiffSummaryByThreadId[threadId] = {
      [latestTurn.turnId]: {
        turnId: latestTurn.turnId,
        completedAt: AT,
        status: fixture.latestCheckpoint.status,
        files: [],
        checkpointRef: CheckpointRef.make(fixture.latestCheckpoint.checkpointRef),
        checkpointTurnCount: 1,
      },
    };
  }
  const threadHistoryByThreadId = { ...environment.threadHistoryByThreadId };
  if (fixture.history) {
    threadHistoryByThreadId[threadId] = {} as never;
  } else {
    delete threadHistoryByThreadId[threadId];
  }
  const worktreeById = { ...environment.worktreeById };
  if (worktreeId) {
    worktreeById[worktreeId] = {
      id: worktreeId,
      archivedAt: fixture.worktreeArchivedAt ?? null,
    } as SidebarWorktreeSummary;
  }
  return {
    ...state,
    environmentStateById: {
      ...state.environmentStateById,
      [QUEUE_ENV]: {
        ...environment,
        threadIds: environment.threadIds.includes(threadId)
          ? environment.threadIds
          : [...environment.threadIds, threadId],
        threadShellById: { ...environment.threadShellById, [threadId]: shell },
        threadSessionById: {
          ...environment.threadSessionById,
          [threadId]: fixture.session ? toSession(fixture.session) : null,
        },
        threadTurnStateById: { ...environment.threadTurnStateById, [threadId]: { latestTurn } },
        sidebarThreadSummaryById: { ...environment.sidebarThreadSummaryById, [threadId]: summary },
        messageIdsByThreadId,
        activityIdsByThreadId,
        activityByThreadId,
        turnDiffSummaryByThreadId,
        threadHistoryByThreadId,
        worktreeById,
      },
    },
  };
}

export function makeQueueAppState(
  threads: readonly ThreadFixture[],
  environment: Partial<EnvironmentState> = {},
): AppState {
  let state: AppState = {
    activeEnvironmentId: QUEUE_ENV,
    environmentStateById: { [QUEUE_ENV]: emptyEnvironmentState(environment) },
  };
  for (const thread of threads) state = withThread(state, thread);
  return state;
}

export function turnStartFailed(id: string, messageId: string, detail?: string): ActivityFixture {
  return {
    id,
    kind: "provider.turn.start.failed",
    payload: { messageId, ...(detail ? { detail } : {}) },
  };
}

/** A steer rejection row; `id` is the activity id, `turn-steer-rejected:<commandId>` in production. */
export function steerFailed(
  id: string,
  messageId: string,
  reason?: "deferred" | "failed",
): ActivityFixture {
  return {
    id,
    kind: "provider.turn.steer.failed",
    payload: { messageId, error: "Steer rejected.", ...(reason ? { reason } : {}) },
  };
}
