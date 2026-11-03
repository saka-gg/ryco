import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSessionStatus,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import { keepRunningThreadKeys, listRunningThreadKeys } from "./runningThreads.ts";
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

describe("keepRunningThreadKeys", () => {
  it("keeps a running thread until it stops and fills freed places newest first", () => {
    const first = keepRunningThreadKeys([], ["c", "b", "a"], 2);
    expect(first).toEqual(["c", "b"]);
    // "a" became the most recently updated: the kept ones still run, so nothing changes.
    expect(keepRunningThreadKeys(first, ["a", "c", "b"], 2)).toBe(first);
    // "c" stopped: its place goes to the newest other one.
    expect(keepRunningThreadKeys(first, ["a", "b", "d"], 2)).toEqual(["b", "a"]);
    expect(keepRunningThreadKeys(["b", "a"], [], 2)).toEqual([]);
  });
});

describe("listRunningThreadKeys caching", () => {
  it("answers from the cache while an environment's maps keep their identity", () => {
    const shells = {
      [ThreadId.make("t-1")]: { id: ThreadId.make("t-1"), projectId, archivedAt: null },
    } as never as EnvironmentState["threadShellById"];
    const environment: EnvironmentState = {
      ...emptyEnvironment(),
      threadShellById: shells,
      threadSessionById: {
        [ThreadId.make("t-1")]: {
          orchestrationStatus: "running",
          updatedAt: "2026-10-30T00:00:00Z",
        },
      } as never,
    };
    const state: AppState = {
      activeEnvironmentId: environmentId,
      environmentStateById: { [environmentId]: environment },
    };
    expect(listRunningThreadKeys(state, 10)).toEqual([
      scopedKeyOf(environmentId, ThreadId.make("t-1")),
    ]);
    // The same map objects: the scan is skipped (a mutation in place would go unseen).
    (shells as Record<string, unknown>)[ThreadId.make("t-2")] = {
      id: ThreadId.make("t-2"),
      projectId,
      archivedAt: null,
    };
    expect(listRunningThreadKeys(state, 10)).toHaveLength(1);
    // A new sessions map (what the store does on a change) is scanned again.
    const next: AppState = {
      ...state,
      environmentStateById: {
        [environmentId]: {
          ...environment,
          threadSessionById: {
            ...environment.threadSessionById,
            [ThreadId.make("t-2")]: {
              orchestrationStatus: "starting",
              updatedAt: "2026-10-30T00:00:01Z",
            },
          } as never,
        },
      },
    };
    expect(listRunningThreadKeys(next, 10)).toEqual([
      scopedKeyOf(environmentId, ThreadId.make("t-2")),
      scopedKeyOf(environmentId, ThreadId.make("t-1")),
    ]);
  });
});
