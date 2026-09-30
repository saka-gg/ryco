import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createEnvironmentFallbackThreadRefSelector } from "./storeSelectors.ts";
import type { AppState, EnvironmentState } from "./store.ts";
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
