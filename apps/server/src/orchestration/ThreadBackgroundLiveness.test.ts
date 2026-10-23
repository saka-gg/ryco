import { describe, expect, it } from "vite-plus/test";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";

describe("ThreadBackgroundLiveness", () => {
  it("does not let status-free progress restart an idle task", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: "idle",
      kind: "updated",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();
  });

  it("lists only threads that still have live work", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const start = (threadId: string, taskId: string, taskType: string) =>
      liveness.recordTaskLiveness({
        threadId,
        taskId,
        taskType,
        status: undefined,
        kind: "started",
      });
    start("t-monitor", "m1", "monitor");
    start("t-agent", "a1", "subagent");
    start("t-done", "s1", "local_bash");
    liveness.recordTaskLiveness({
      threadId: "t-done",
      taskId: "s1",
      taskType: "local_bash",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.listLiveThreadIds().toSorted()).toEqual(["t-agent", "t-monitor"]);
    liveness.clearThreadLiveness("t-agent");
    expect(liveness.listLiveThreadIds()).toEqual(["t-monitor"]);
  });

  it("lists the live tasks of a thread, agents and watch loops alike", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const record = (taskId: string, taskType: string, kind: "started" | "completed") =>
      liveness.recordTaskLiveness({ threadId: "t", taskId, taskType, status: undefined, kind });
    record("agent", "subagent", "started");
    record("watch", "monitor", "started");
    record("shell", "local_bash", "started");
    record("shell", "local_bash", "completed");
    expect(liveness.listLiveTaskIds("t").toSorted()).toEqual(["agent", "watch"]);
    expect(liveness.listLiveTaskIds("other")).toEqual([]);
    liveness.clearThreadLiveness("t");
    expect(liveness.listLiveTaskIds("t")).toEqual([]);
  });

  it("scopes a thread's live tasks to the runtime that reported them", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const start = (taskId: string, runtimeSessionId: string | null) =>
      liveness.recordTaskLiveness({
        threadId: "t",
        taskId,
        taskType: "local_agent",
        status: "running",
        kind: "started",
        runtimeSessionId,
      });
    start("old-agent", "runtime-a");
    expect(liveness.listLiveTaskIds("t", "runtime-a")).toEqual(["old-agent"]);
    // The thread runs another runtime now: the old one's tasks died with it.
    expect(liveness.listLiveTaskIds("t", "runtime-b")).toEqual([]);
    expect(liveness.listLiveTaskIds("t", null)).toEqual([]);
    expect(liveness.listLiveTaskIds("t")).toEqual(["old-agent"]);

    // The replacement's first report drops what the replaced runtime left behind.
    start("new-agent", "runtime-b");
    expect(liveness.listLiveTaskIds("t")).toEqual(["new-agent"]);
    expect(liveness.listLiveTaskIds("t", "runtime-b")).toEqual(["new-agent"]);

    liveness.clearThreadLiveness("t");
    start("fresh", null);
    expect(liveness.listLiveTaskIds("t", null)).toEqual(["fresh"]);
    expect(liveness.listLiveTaskIds("t", "runtime-b")).toEqual([]);
  });

  it("keeps working until both agents and background tasks finish", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-1";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("terminal rows without a taskType still clear monitor entries", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-2";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    // Terminal tick arrives with no taskType (common on task.completed).
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: undefined,
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("nested agents (agentId + agent taskType) still count toward liveness", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-nested";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "n1",
      taskType: "local_agent",
      status: undefined,
      kind: "started",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "n1",
      taskType: "local_agent",
      status: "completed",
      kind: "completed",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("blank or whitespace agentId counts as absent, matching classifyTaskAgentKind", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-blank-agent";
    // A local_bash with a blank agentId is stamped "background" by the
    // classifier; the liveness registry must keep it as a monitor rather
    // than dropping it as agent-owned.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "b1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
      agentId: "",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "b2",
      taskType: undefined,
      status: "running",
      kind: "progress",
      agentId: "   ",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
  });

  it("untyped rows count as agents; idle is not live; agent-owned tasks are ignored", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-3";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "idle",
      kind: "updated",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
    liveness.recordTaskLiveness({
      threadId,
      taskId: "sh:1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("reclassification moves a task between buckets instead of duplicating it", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-reclass";
    // First seen without a taskType: counts as an agent.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: undefined,
      status: "running",
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    // Later transition reveals it is a shell: it still counts as work,
    // but must not leave a duplicate agent entry behind.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    // Turning out to be inert or agent-owned drops the prior entry too.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("plan tasks are inert; clear removes everything; instances are isolated", () => {
    const a = ThreadBackgroundLiveness.make();
    const b = ThreadBackgroundLiveness.make();
    a.recordTaskLiveness({
      threadId: "t",
      taskId: "p1",
      taskType: "plan",
      status: undefined,
      kind: "started",
    });
    expect(a.getThreadBackgroundLiveness("t")).toBeNull();
    a.recordTaskLiveness({
      threadId: "t",
      taskId: "a1",
      taskType: "local_workflow",
      status: undefined,
      kind: "started",
    });
    expect(a.getThreadBackgroundLiveness("t")).toBe("working");
    expect(b.getThreadBackgroundLiveness("t")).toBeNull();
    a.clearThreadLiveness("t");
    expect(a.getThreadBackgroundLiveness("t")).toBeNull();
  });
});

it("retains monitor classification on sparse updates and ignores late terminal-task updates", () => {
  const liveness = ThreadBackgroundLiveness.make();
  const base = { threadId: "history", taskId: "monitor", taskType: undefined, status: undefined };
  liveness.recordTaskLiveness({ ...base, taskType: "local_bash", kind: "started", attempt: 1 });
  liveness.recordTaskLiveness({ ...base, kind: "updated", status: "running" });
  expect(liveness.getThreadBackgroundLiveness("history")).toBe("working");
  liveness.recordTaskLiveness({ ...base, kind: "completed" });
  liveness.recordTaskLiveness({ ...base, kind: "updated", status: "running" });
  expect(liveness.getThreadBackgroundLiveness("history")).toBeNull();
  liveness.recordTaskLiveness({ ...base, kind: "started", attempt: 2 });
  expect(liveness.getThreadBackgroundLiveness("history")).toBe("working");
});

it("settles workflow-owned members with the coordinator, including delayed member updates", () => {
  const liveness = ThreadBackgroundLiveness.make();
  const base = { threadId: "workflow", taskType: undefined, status: undefined };
  liveness.recordTaskLiveness({
    ...base,
    taskId: "coordinator",
    taskType: "local_workflow",
    kind: "started",
  });
  liveness.recordTaskLiveness({
    ...base,
    taskId: "member",
    parentAgentId: "coordinator",
    kind: "progress",
    status: "running",
  });
  liveness.recordTaskLiveness({ ...base, taskId: "coordinator", kind: "completed" });
  expect(liveness.getThreadBackgroundLiveness("workflow")).toBeNull();
  liveness.recordTaskLiveness({
    ...base,
    taskId: "late-member",
    parentAgentId: "coordinator",
    kind: "progress",
    status: "running",
  });
  expect(liveness.getThreadBackgroundLiveness("workflow")).toBeNull();
});

it.each(["local_bash", "shell", "monitor", "monitor_mcp"])(
  "keeps %s working through sparse updates until it stops",
  (taskType) => {
    const liveness = ThreadBackgroundLiveness.make();
    const task = { threadId: "background", taskId: "task", taskType, status: "running" };
    liveness.recordTaskLiveness({ ...task, kind: "started" });
    expect(liveness.getThreadBackgroundLiveness(task.threadId)).toBe("working");
    liveness.recordTaskLiveness({
      ...task,
      taskType: undefined,
      status: undefined,
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(task.threadId)).toBe("working");
    liveness.recordTaskLiveness({ ...task, status: "stopped", kind: "updated" });
    expect(liveness.getThreadBackgroundLiveness(task.threadId)).toBeNull();
    liveness.recordTaskLiveness({ ...task, kind: "progress" });
    expect(liveness.getThreadBackgroundLiveness(task.threadId)).toBeNull();
  },
);
