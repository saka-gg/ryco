import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSessionStatus,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import { listRunningThreadKeys } from "./runningThreads.ts";
import type { AppState, EnvironmentState } from "./store.ts";

const environmentId = EnvironmentId.make("environment-running");
const otherEnvironmentId = EnvironmentId.make("environment-other");
const projectId = ProjectId.make("project-1");
const scopedKeyOf = (environment: EnvironmentId, id: ThreadId) =>
  scopedThreadKey(scopeThreadRef(environment, id));
const turn = (state: "running" | "completed") => ({ turnId: "turn-1", state });

function emptyEnvironment(): EnvironmentState {
  return {
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
}

describe("listRunningThreadKeys", () => {
  const shellOf = (id: string) => ({ id: ThreadId.make(id), projectId, archivedAt: null }) as never;
  const sessionAt = (status: OrchestrationSessionStatus, updatedAt: string) =>
    ({ orchestrationStatus: status, updatedAt }) as never;
  const state: AppState = {
    activeEnvironmentId: environmentId,
    environmentStateById: {
      [environmentId]: {
        ...emptyEnvironment(),
        threadShellById: {
          [ThreadId.make("running")]: shellOf("running"),
          [ThreadId.make("starting")]: shellOf("starting"),
          [ThreadId.make("turn-running")]: shellOf("turn-running"),
          [ThreadId.make("ready")]: shellOf("ready"),
          [ThreadId.make("archived")]: {
            shellDetail: "archived-stub",
            id: ThreadId.make("archived"),
            projectId,
          } as never,
        },
        threadSessionById: {
          [ThreadId.make("running")]: sessionAt("running", "2026-10-30T10:00:03.000Z"),
          [ThreadId.make("starting")]: sessionAt("starting", "2026-10-30T10:00:01.000Z"),
          [ThreadId.make("turn-running")]: sessionAt("ready", "2026-10-30T10:00:02.000Z"),
          [ThreadId.make("ready")]: sessionAt("ready", "2026-10-30T10:00:09.000Z"),
          [ThreadId.make("archived")]: sessionAt("running", "2026-10-30T10:00:09.000Z"),
        },
        threadTurnStateById: {
          [ThreadId.make("turn-running")]: { latestTurn: turn("running") } as never,
          [ThreadId.make("ready")]: { latestTurn: turn("completed") } as never,
        },
      },
      [otherEnvironmentId]: {
        ...emptyEnvironment(),
        threadShellById: { [ThreadId.make("remote")]: shellOf("remote") },
        threadSessionById: {
          [ThreadId.make("remote")]: sessionAt("running", "2026-10-30T10:00:04.000Z"),
        },
      },
    },
  };
  const key = scopedKeyOf;

  it("lists threads with a turn in progress in every environment, newest first", () => {
    expect(listRunningThreadKeys(state, 10)).toEqual([
      key(otherEnvironmentId, ThreadId.make("remote")),
      key(environmentId, ThreadId.make("running")),
      key(environmentId, ThreadId.make("turn-running")),
      key(environmentId, ThreadId.make("starting")),
    ]);
  });

  it("keeps the most recently updated ones within the limit", () => {
    expect(listRunningThreadKeys(state, 2)).toEqual([
      key(otherEnvironmentId, ThreadId.make("remote")),
      key(environmentId, ThreadId.make("running")),
    ]);
    expect(listRunningThreadKeys(state, 0)).toEqual([]);
  });
});
