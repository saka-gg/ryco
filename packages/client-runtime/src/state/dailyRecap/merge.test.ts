import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DailyRecapSnapshot,
  type DailyRecapThread,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DailyRecapNodeResult, ReadyDailyRecap } from "./cache.ts";
import { mergeDailyRecaps } from "./merge.ts";

const nodeA = EnvironmentId.make("synthetic-node-a");
const nodeB = EnvironmentId.make("synthetic-node-b");
const nodeC = EnvironmentId.make("synthetic-node-c");

function thread(id: string, lastActivityAt: string): DailyRecapThread {
  return {
    threadId: ThreadId.make(id),
    threadTitle: `Chat ${id}`,
    projectId: ProjectId.make("project"),
    projectTitle: "ryco",
    lastActivityAt,
  };
}

function project(id: string, turns: number, agentMs: number, title = id) {
  return { projectId: ProjectId.make(id), projectTitle: title, turns, agentMs };
}

function ready(
  environmentId: EnvironmentId,
  requestedAtMs: number,
  overrides: Partial<DailyRecapSnapshot> = {},
): ReadyDailyRecap {
  const emptySection = { totalThreads: 0, threads: [], truncated: false };
  return {
    environmentId,
    label: `Label ${environmentId}`,
    requestedAtMs,
    status: "ready",
    snapshot: {
      date: "2026-10-23",
      timeZone: "Europe/Berlin",
      generatedAt: "2026-10-23T12:00:00.000Z",
      from: "2026-10-22T22:00:00.000Z",
      to: "2026-10-23T22:00:00.000Z",
      counts: { completedTurns: 0, failedTurns: 0, interruptedTurns: 0 },
      completed: emptySection,
      failed: emptySection,
      activity: { agentMs: 0, projects: [] },
      needsAttention: emptySection,
      ...overrides,
    },
  };
}

describe("merging daily recaps across nodes", () => {
  it("is empty when no node answered", () => {
    const results: DailyRecapNodeResult[] = [
      { environmentId: nodeA, label: "A", requestedAtMs: 1, status: "offline" },
      { environmentId: nodeB, label: "B", requestedAtMs: 1, status: "failed", message: "No." },
    ];
    expect(mergeDailyRecaps(results)).toBeNull();
    expect(mergeDailyRecaps([])).toBeNull();
  });

  it("passes a single node's recap through, tagged with its node", () => {
    const merged = mergeDailyRecaps([
      ready(nodeA, 5, {
        counts: { completedTurns: 3, failedTurns: 1, interruptedTurns: 2 },
        completed: {
          totalThreads: 1,
          threads: [thread("t1", "2026-10-23T10:00:00.000Z")],
          truncated: false,
        },
        activity: { agentMs: 90_000, projects: [project("p1", 3, 90_000)] },
      }),
    ]);
    expect(merged).toEqual({
      date: "2026-10-23",
      timeZone: "Europe/Berlin",
      counts: { completedTurns: 3, failedTurns: 1, interruptedTurns: 2 },
      completed: {
        totalThreads: 1,
        threads: [
          {
            ...thread("t1", "2026-10-23T10:00:00.000Z"),
            environmentId: nodeA,
            environmentLabel: `Label ${nodeA}`,
          },
        ],
        truncated: false,
      },
      failed: { totalThreads: 0, threads: [], truncated: false },
      activity: {
        agentMs: 90_000,
        projects: [
          { ...project("p1", 3, 90_000), environmentId: nodeA, environmentLabel: `Label ${nodeA}` },
        ],
      },
      activityMissing: [],
      updatedAtMs: 5,
    });
  });

  it("adds up the nodes that answered and skips the rest", () => {
    const merged = mergeDailyRecaps([
      ready(nodeA, 20, {
        counts: { completedTurns: 3, failedTurns: 1, interruptedTurns: 0 },
        failed: {
          totalThreads: 1,
          threads: [thread("a-failed", "2026-10-23T09:00:00.000Z")],
          truncated: false,
        },
      }),
      { environmentId: nodeC, label: "C", requestedAtMs: 1, status: "unsupported" },
      ready(nodeB, 10, {
        counts: { completedTurns: 4, failedTurns: 0, interruptedTurns: 1 },
        failed: {
          totalThreads: 3,
          threads: [thread("b-failed", "2026-10-23T11:00:00.000Z")],
          truncated: true,
        },
      }),
    ]);
    expect(merged?.counts).toEqual({ completedTurns: 7, failedTurns: 1, interruptedTurns: 1 });
    expect(merged?.failed.totalThreads).toBe(4);
    expect(merged?.failed.truncated).toBe(true);
    expect(merged?.failed.threads.map((entry) => entry.threadId)).toEqual(["b-failed", "a-failed"]);
    expect(merged?.completed.truncated).toBe(false);
    // The oldest answer that went into it, not a skipped node's.
    expect(merged?.updatedAtMs).toBe(10);
  });

  it("orders chats by their latest activity, then node, then id", () => {
    const at = "2026-10-23T10:00:00.000Z";
    const merged = mergeDailyRecaps([
      ready(nodeB, 1, {
        completed: {
          totalThreads: 2,
          threads: [thread("t2", at), thread("t1", at)],
          truncated: false,
        },
      }),
      ready(nodeA, 1, {
        completed: {
          totalThreads: 2,
          threads: [thread("t9", at), thread("newest", "2026-10-23T10:00:01.000Z")],
          truncated: false,
        },
      }),
    ]);
    expect(
      merged?.completed.threads.map((entry) => `${entry.environmentId}/${entry.threadId}`),
    ).toEqual([`${nodeA}/newest`, `${nodeA}/t9`, `${nodeB}/t1`, `${nodeB}/t2`]);
  });

  it("leaves out the agent time and projects of a node that predates them", () => {
    const { activity: _activity, ...olderSnapshot } = ready(nodeB, 1, {
      counts: { completedTurns: 5, failedTurns: 0, interruptedTurns: 0 },
    }).snapshot;
    const older: ReadyDailyRecap = { ...ready(nodeB, 1), snapshot: olderSnapshot };
    const merged = mergeDailyRecaps([
      ready(nodeA, 1, {
        counts: { completedTurns: 2, failedTurns: 0, interruptedTurns: 0 },
        activity: { agentMs: 60_000, projects: [project("p1", 2, 60_000)] },
      }),
      older,
    ]);
    expect(merged?.counts.completedTurns).toBe(7);
    expect(merged?.activity?.agentMs).toBe(60_000);
    expect(merged?.activity?.projects.map((entry) => entry.projectId)).toEqual(["p1"]);
    expect(merged?.activityMissing).toEqual([nodeB]);

    // Nobody reports activity: there is none to show, rather than zero.
    expect(mergeDailyRecaps([older])?.activity).toBeNull();
  });

  it("keeps the busiest projects across nodes, most turns then most agent time", () => {
    const merged = mergeDailyRecaps([
      ready(nodeA, 1, {
        activity: {
          agentMs: 0,
          projects: [
            project("a1", 9, 10),
            project("a2", 4, 50),
            project("a3", 4, 50, "alpha"),
            project("a4", 1, 0),
          ],
        },
      }),
      ready(nodeB, 1, {
        activity: {
          agentMs: 0,
          projects: [project("b1", 4, 90), project("b2", 4, 50, "a2"), project("b3", 2, 0)],
        },
      }),
    ]);
    expect(
      merged?.activity?.projects.map((entry) => `${entry.environmentId}/${entry.projectId}`),
    ).toEqual([
      `${nodeA}/a1`,
      `${nodeB}/b1`,
      // Same turns and agent time: by title, then node.
      `${nodeA}/a2`,
      `${nodeB}/b2`,
      `${nodeA}/a3`,
    ]);
  });
});
