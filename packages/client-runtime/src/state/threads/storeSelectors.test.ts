import {
  type OrchestrationThread,
  type OrchestrationThreadHistoryState,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createEnvironmentFallbackThreadRefSelector,
  selectEnvironmentShellLive,
  selectThreadDetailLoaded,
} from "./storeSelectors.ts";
import {
  syncServerThreadDetail,
  syncServerThreadWindow,
  type AppState,
  type EnvironmentState,
} from "./store.ts";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type SidebarThreadSummary,
  type ThreadShell,
} from "./types.ts";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const makeEnvironmentState = (overrides: Partial<EnvironmentState> = {}): EnvironmentState => ({
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
  sidebarThreadSummaryById: {},
  bootstrapComplete: true,
  ...overrides,
});

const makeState = (environmentState: EnvironmentState): AppState => ({
  activeEnvironmentId: environmentId,
  environmentStateById: {
    [environmentId]: environmentState,
  },
});

const makeSummary = (
  id: ThreadId,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary => ({
  id,
  environmentId,
  projectId,
  title: id,
  interactionMode: DEFAULT_INTERACTION_MODE,
  tokenMode: DEFAULT_AGENT_TOKEN_MODE,
  session: null,
  createdAt: "2026-06-12T10:00:00.000Z",
  archivedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const makeShell = (id: ThreadId, overrides: Partial<ThreadShell> = {}): ThreadShell => ({
  id,
  environmentId,
  codexThreadId: null,
  projectId,
  title: id,
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_INTERACTION_MODE,
  tokenMode: DEFAULT_AGENT_TOKEN_MODE,
  error: null,
  createdAt: "2026-06-12T10:00:00.000Z",
  archivedAt: null,
  branch: null,
  worktreePath: null,
  ...overrides,
});

describe("createEnvironmentFallbackThreadRefSelector", () => {
  it("returns a stable ref when the selected fallback thread does not change", () => {
    const state = makeState(
      makeEnvironmentState({
        threadIds: [threadA, threadB],
        sidebarThreadSummaryById: {
          [threadA]: makeSummary(threadA),
          [threadB]: makeSummary(threadB, {
            latestUserMessageAt: "2026-06-12T11:00:00.000Z",
          }),
        },
      }),
    );
    const selector = createEnvironmentFallbackThreadRefSelector(environmentId, "updated_at");

    const first = selector(state);
    const second = selector(state);

    expect(first).toEqual({ environmentId, threadId: threadB } satisfies ScopedThreadRef);
    expect(second).toBe(first);
  });

  it("sorts fallback candidates by sidebar summary data", () => {
    const state = makeState(
      makeEnvironmentState({
        threadIds: [threadA, threadB],
        sidebarThreadSummaryById: {
          [threadA]: makeSummary(threadA, {
            latestUserMessageAt: "2026-06-12T11:00:00.000Z",
          }),
          [threadB]: makeSummary(threadB, {
            latestUserMessageAt: "2026-06-12T10:30:00.000Z",
          }),
        },
      }),
    );
    const selector = createEnvironmentFallbackThreadRefSelector(environmentId, "updated_at");

    expect(selector(state)).toEqual({ environmentId, threadId: threadA });
  });

  it("falls back to thread shell data when the sidebar summary has not arrived yet", () => {
    const state = makeState(
      makeEnvironmentState({
        threadIds: [threadA],
        threadShellById: {
          [threadA]: makeShell(threadA),
        },
      }),
    );
    const selector = createEnvironmentFallbackThreadRefSelector(environmentId, "updated_at");

    expect(selector(state)).toEqual({ environmentId, threadId: threadA });
  });
});

describe("selectThreadDetailLoaded", () => {
  const ref = { environmentId, threadId: threadA } satisfies ScopedThreadRef;
  const detail: OrchestrationThread = {
    id: threadA,
    projectId,
    title: "Detail",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-12T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as OrchestrationThread;
  const page = { cursor: null, hasMore: false } as never;
  const history = {
    messages: page,
    proposedPlans: page,
    activities: page,
    checkpoints: page,
  } as OrchestrationThreadHistoryState;

  it("is false for a shell-only thread", () => {
    const state = makeState(
      makeEnvironmentState({
        threadIds: [threadA],
        threadShellById: { [threadA]: makeShell(threadA) },
        sidebarThreadSummaryById: { [threadA]: makeSummary(threadA) },
      }),
    );
    expect(selectThreadDetailLoaded(state, ref)).toBe(false);
  });

  it("is true after a full-detail snapshot", () => {
    const state = syncServerThreadDetail(makeState(makeEnvironmentState()), detail, environmentId);
    expect(selectThreadDetailLoaded(state, ref)).toBe(true);
  });

  it("is true after a thread-detail window", () => {
    const state = syncServerThreadWindow(
      makeState(makeEnvironmentState()),
      { snapshotSequence: 1, thread: detail, history },
      environmentId,
    );
    expect(selectThreadDetailLoaded(state, ref)).toBe(true);
  });
});

describe("selectEnvironmentShellLive", () => {
  it("is true only for a bootstrapped environment that is not cache provenance", () => {
    expect(selectEnvironmentShellLive(makeState(makeEnvironmentState()), environmentId)).toBe(true);
    expect(
      selectEnvironmentShellLive(
        makeState(makeEnvironmentState({ bootstrapComplete: false })),
        environmentId,
      ),
    ).toBe(false);
    expect(
      selectEnvironmentShellLive(
        makeState(makeEnvironmentState({ hydratedFromCacheAt: 1 })),
        environmentId,
      ),
    ).toBe(false);
    expect(
      selectEnvironmentShellLive(makeState(makeEnvironmentState()), EnvironmentId.make("other")),
    ).toBe(false);
  });
});
