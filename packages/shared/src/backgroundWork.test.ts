import { EventId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveBackgroundWork, BACKGROUND_WORK_LIMIT } from "./backgroundWork.ts";
import { capThreadActivitiesPreservingMilestones } from "./threadActivity.ts";

function activity(n: number, kind: string, payload: Record<string, unknown> = {}) {
  return {
    id: EventId.make(`event-${n}`),
    kind,
    payload,
    createdAt: new Date(n * 1000).toISOString(),
  };
}
const start = (n: number, taskId = "task", overrides = {}) =>
  activity(n, "task.started", {
    taskId,
    taskType: "local_bash",
    agentKind: "background",
    isBackgrounded: true,
    runtimeSessionId: "epoch",
    title: "Run checks",
    canStop: true,
    ...overrides,
  });
const patch = (n: number, payload: Record<string, unknown>) =>
  activity(n, "task.updated", {
    taskId: "task",
    runtimeSessionId: "epoch",
    ...payload,
  });

describe("background work", () => {
  it("keeps detached work across turns without including agents, owned shells or foreground commands", () => {
    const work = deriveBackgroundWork([
      start(1),
      start(2, "foreground", { isBackgrounded: undefined }),
      start(3, "agent", { agentKind: "agent" }),
      start(4, "owned", { agentId: "agent" }),
      start(5, "plan", { taskType: "plan" }),
      activity(6, "turn.completed"),
      activity(7, "turn.started"),
    ]);
    expect(work.tasks.map((task) => task.id)).toEqual(["task"]);
    expect(work.tasks[0]?.canStop).toBe(true);
  });

  it("freezes elapsed time while idle, resumes, and ignores stale attempts", () => {
    const paused = [
      start(1),
      patch(11, { status: "idle" }),
      patch(30, { description: "Still paused" }),
    ];
    expect(deriveBackgroundWork(paused).tasks[0]).toMatchObject({
      status: "idle",
      elapsedMs: 10_000,
      activeSince: null,
    });
    expect(
      deriveBackgroundWork([...paused, patch(40, { status: "running" })]).tasks[0],
    ).toMatchObject({ elapsedMs: 10_000, activeSince: new Date(40_000).toISOString() });
    expect(
      deriveBackgroundWork([
        start(1, "task", { attempt: 2 }),
        patch(2, { attempt: 1, status: "idle" }),
      ]).tasks[0]?.status,
    ).toBe("running");
  });

  it("settles terminal tasks, refuses delayed starts, and allows an explicit newer attempt", () => {
    const settled = [start(1), patch(2, { status: "cancelled" }), start(3)];
    expect(deriveBackgroundWork(settled).tasks).toEqual([]);
    expect(deriveBackgroundWork([...settled, start(4, "task", { attempt: 1 })]).tasks).toHaveLength(
      1,
    );
    expect(deriveBackgroundWork([start(1), patch(2, { isBackgrounded: false })]).tasks).toEqual([]);
  });

  it("settles at confirmed session boundaries and rejects the previous epoch", () => {
    expect(
      deriveBackgroundWork([
        start(1),
        activity(2, "background-work.session-boundary", {
          runtimeSessionId: "epoch",
          state: "stopped",
        }),
        start(3),
      ]).tasks,
    ).toEqual([]);
    const restarted = [
      start(1),
      activity(2, "background-work.session-boundary", {
        runtimeSessionId: "new",
        state: "started",
      }),
      start(3),
    ];
    expect(deriveBackgroundWork(restarted).tasks).toEqual([]);
    expect(
      deriveBackgroundWork([...restarted, start(4, "task", { runtimeSessionId: "new" })]).tasks,
    ).toHaveLength(1);
  });

  it("retains compact background evidence beyond the normal tail and settles after trimming", () => {
    let rows = [
      start(1),
      ...Array.from({ length: 1000 }, (_, i) => activity(i + 2, "tool.completed")),
    ];
    rows = capThreadActivitiesPreservingMilestones(rows, 5);
    expect(rows).toHaveLength(6);
    expect(deriveBackgroundWork(rows).tasks[0]?.id).toBe("task");
    rows = capThreadActivitiesPreservingMilestones(
      [...rows, patch(1003, { status: "completed" })],
      5,
    );
    expect(deriveBackgroundWork(rows).tasks).toEqual([]);
    rows = capThreadActivitiesPreservingMilestones(
      [...rows, ...Array.from({ length: 20 }, (_, i) => activity(1004 + i, "tool.completed"))],
      5,
    );
    expect(deriveBackgroundWork([...rows, start(1050)]).tasks).toEqual([]);
  });

  it("bounds unfinished details and reports missing detail without claiming omitted work is live", () => {
    const rows = Array.from({ length: BACKGROUND_WORK_LIMIT + 1 }, (_, i) =>
      start(i, `task-${i}`, { title: "x".repeat(5000) }),
    );
    const retained = capThreadActivitiesPreservingMilestones(
      [...rows, activity(200, "tool.completed")],
      1,
    );
    const work = deriveBackgroundWork(retained);
    expect(work.tasks).toHaveLength(100);
    expect(work.detailsOmitted).toBe(true);
    expect(work.tasks.every((task) => task.title.length <= 180)).toBe(true);
    expect(JSON.stringify(retained).length).toBeLessThan(70_000);
    expect(
      deriveBackgroundWork([
        ...retained,
        activity(201, "background-work.session-boundary", { state: "stopped" }),
      ]),
    ).toEqual({ tasks: [], detailsOmitted: false });
  });
  it("preserves the newer checkpoint when older history pages are merged", () => {
    const settled = capThreadActivitiesPreservingMilestones(
      [start(1000), patch(1001, { status: "completed" }), activity(1002, "tool.completed")],
      1,
    );
    const older = Array.from({ length: 20 }, (_, i) => start(i + 1, `old-${i}`));
    const merged = capThreadActivitiesPreservingMilestones([...older, ...settled], 5);
    expect(merged.filter((row) => row.kind === "background-work.checkpoint")).toHaveLength(1);
    expect(deriveBackgroundWork(merged).tasks).toEqual([]);
  });
});
