import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  deriveAgentPanelModel,
  emptyAgentPanelModel,
  type RuntimeSubagent,
} from "@ryco/client-runtime/state/session";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";

import {
  buildThreadAgentsEntry,
  buildThreadAgentsSheetModel,
  threadAgentElapsedText,
  threadAgentsSheetSummary,
  type ThreadAgentsSheetInput,
  type ThreadAgentsSheetModel,
} from "./threadAgentsSheetModel";

const NODE = "node-a" as EnvironmentId;
const T0 = "2026-08-10T10:00:00.000Z";
const NOW = Date.parse("2026-08-10T10:01:05.000Z");

function agent(id: string, overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title: `Task for ${id}`,
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    runtimeSessionId: null,
    canStop: false,
    canMessage: false,
    recentActivity: [],
    firstSeenAt: T0,
    spawnTurnId: null,
    startedAt: T0,
    completedAt: null,
    updatedAt: T0,
    ...overrides,
  };
}

function child(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    environmentId: NODE,
    id: id as never,
    projectId: "project-a" as never,
    title: `Child ${id}`,
    interactionMode: "default",
    session: null,
    createdAt: T0,
    archivedAt: null,
    updatedAt: T0,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function turn(state: "running" | "completed", startedAt: string, completedAt: string | null) {
  return {
    turnId: "turn-1",
    state,
    requestedAt: startedAt,
    startedAt,
    completedAt,
    assistantMessageId: null,
  } as never;
}

function build(overrides: Partial<ThreadAgentsSheetInput> = {}): ThreadAgentsSheetModel {
  return buildThreadAgentsSheetModel({
    panel: emptyAgentPanelModel(),
    delegatedChildren: [],
    environment: { environmentId: NODE, label: "Studio", connectionState: "connected" },
    runtimeSessionId: "rt-1",
    stopReady: true,
    offline: false,
    completionReturns: new Map(),
    ...overrides,
  });
}

function limitedChild(id: string): SidebarThreadSummary {
  return child(id, {
    modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
    usageLimit: {
      limitId: `usage-limit:${id}:turn-1`,
      provider: "codex",
      providerInstanceId: "codex",
      turnId: "turn-1",
      message: "Usage limit reached",
      limitedAt: T0,
      resetAt: "2026-08-10T10:05:00.000Z",
      autoResume: null,
      updatedAt: T0,
    } as never,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("thread agents sheet", () => {
  it("lists nothing, and offers no way in, while the chat set no agents working", () => {
    const model = build();
    expect(model).toEqual({
      sections: [],
      total: 0,
      live: 0,
      offline: false,
    });
    expect(buildThreadAgentsEntry(model)).toBeNull();
  });

  it("lists subagents with live elapsed time, status and what each is doing", () => {
    const model = build({
      panel: deriveAgentPanelModel({
        agents: [
          agent("a", { role: "Explore", title: "Map the relay client", progress: "Reading ws.ts" }),
          agent("b", {
            status: "completed",
            result: "All 12 tests pass.",
            completedAt: "2026-08-10T10:00:40.000Z",
          }),
          agent("c", {
            status: "failed",
            error: "Out of budget",
            firstSeenAt: "2026-08-10T10:00:01.000Z",
          }),
        ],
      }),
    });
    expect(model.sections.map((section) => [section.title, section.status])).toEqual([
      ["Subagents", "1 working"],
    ]);
    const [running, done, failed] = model.sections[0]!.rows;
    expect(running).toMatchObject({
      statusLabel: "Running",
      tone: "working",
      activity: "Reading ws.ts",
      // Its start, which the row's label measures to the clock as it ticks.
      elapsed: { kind: "live", since: T0 },
      childThreadId: null,
    });
    expect(threadAgentElapsedText(running!.elapsed, NOW)).toBe("1m 05s");
    expect(done).toMatchObject({
      statusLabel: "Completed",
      tone: "done",
      activity: "All 12 tests pass.",
      elapsed: { kind: "frozen", text: "40s" },
    });
    expect(done?.details?.outcome).toEqual({ text: "All 12 tests pass.", failed: false });
    expect(failed).toMatchObject({
      statusLabel: "Failed",
      tone: "failed",
      activity: "Out of budget",
    });
    expect(failed?.details?.outcome).toEqual({ text: "Out of budget", failed: true });
    expect(model).toMatchObject({ total: 3, live: 1 });
  });

  it("unfolds a subagent's task, facts and recent activity", () => {
    const model = build({
      panel: deriveAgentPanelModel({
        agents: [
          agent("a", {
            role: "Explore",
            title: "Map how the relay client reconnects after a drop",
            model: "claude-opus-4-20250514",
            effort: "high",
            usage: { totalTokens: 12_400, toolUses: 1 },
            recentActivity: [
              { at: T0, summary: "Read ws.ts" },
              { at: T0, summary: "Grep reconnect" },
            ],
          }),
        ],
      }),
    });
    const row = model.sections[0]!.rows[0]!;
    expect(row).toMatchObject({
      label: "Map how the relay client reconnects after a drop",
      role: "Explore",
    });
    expect(row.details).toEqual({
      // The row already leads with the whole task.
      title: null,
      facts: ["opus-4 · high", "12.4k tokens", "1 tool call"],
      recentActivity: [
        { at: T0, summary: "Read ws.ts" },
        { at: T0, summary: "Grep reconnect" },
      ],
      outcome: null,
    });
  });

  it("groups a workflow's members under the run, with the run's progress words", () => {
    const model = build({
      panel: deriveAgentPanelModel({
        agents: [
          agent("wf", {
            kind: "workflow",
            workflowName: "Port batch",
            phases: [{ index: 0, title: "Work" }],
          }),
          agent("m1", {
            kind: "workflow_agent",
            parentAgentId: "wf",
            phaseIndex: 0,
            agentIndex: 0,
          }),
          agent("m2", {
            kind: "workflow_agent",
            parentAgentId: "wf",
            phaseIndex: 0,
            agentIndex: 1,
            status: "completed",
          }),
        ],
      }),
    });
    expect(model.sections.map((section) => [section.key, section.title, section.status])).toEqual([
      ["workflow:wf", "Port batch", "Work · 1 working"],
    ]);
    expect(model.sections[0]!.rows.map((row) => row.key)).toEqual(["agent:m1", "agent:m2"]);
    // The coordinator is the members' container, never counted as one more agent.
    expect(model).toMatchObject({ total: 2, live: 1 });
  });

  it("lists delegated tasks that open their own thread, clocked while they work", () => {
    const model = build({
      delegatedChildren: [
        child("working", { latestTurn: turn("running", "2026-08-10T10:00:30.000Z", null) }),
        child("done", {
          latestTurn: turn("completed", "2026-08-10T09:50:00.000Z", "2026-08-10T09:52:05.000Z"),
          latestCompletedTurnAt: "2026-08-10T09:52:05.000Z",
        }),
        child("asking", { hasPendingUserInput: true }),
      ],
    });
    expect(model.sections.map((section) => [section.title, section.status])).toEqual([
      ["Delegated tasks", "1 working"],
    ]);
    const [working, done, asking] = model.sections[0]!.rows;
    expect(working).toMatchObject({
      label: "Child working",
      statusLabel: "Working",
      tone: "working",
      elapsed: { kind: "live", since: "2026-08-10T10:00:30.000Z" },
      childThreadId: "working",
      details: null,
      stop: null,
    });
    expect(threadAgentElapsedText(working!.elapsed, NOW)).toBe("35s");
    expect(done).toMatchObject({
      statusLabel: "Done",
      tone: "done",
      elapsed: { kind: "frozen", text: "2m 05s" },
    });
    expect(asking).toMatchObject({ statusLabel: "Needs input", tone: "attention", elapsed: null });
    expect(model).toMatchObject({ total: 3, live: 2 });
  });

  it("offers Stop only for a live subagent of the current runtime while the node takes changes", () => {
    const stoppable = agent("a", { canStop: true, runtimeSessionId: "rt-1", attempt: 2 });
    const panel = deriveAgentPanelModel({
      agents: [
        stoppable,
        agent("old-runtime", { canStop: true, runtimeSessionId: "rt-0" }),
        agent("done", { canStop: true, runtimeSessionId: "rt-1", status: "completed" }),
      ],
    });
    expect(build({ panel }).sections[0]!.rows.map((row) => row.stop)).toEqual([
      { taskId: "a", runtimeSessionId: "rt-1", attempt: 2 },
      null,
      null,
    ]);
    expect(
      build({ panel, stopReady: false }).sections[0]!.rows.every((row) => row.stop === null),
    ).toBe(true);
  });

  it("names the way in by what is active now, else by how many there were", () => {
    const live = build({
      panel: deriveAgentPanelModel({ agents: [agent("a"), agent("b", { status: "completed" })] }),
    });
    expect(buildThreadAgentsEntry(live)).toEqual({
      label: "1 agent active",
      live: true,
      accessibilityLabel: "1 agent active, 2 in all. Show agents.",
    });
    const settled = build({
      panel: deriveAgentPanelModel({
        agents: [agent("a", { status: "completed" }), agent("b", { status: "completed" })],
      }),
    });
    expect(buildThreadAgentsEntry(settled)).toEqual({
      label: "2 agents",
      live: false,
      accessibilityLabel: "2 agents. Show agents.",
    });
  });

  it("reads a delegated task by the dock's rules: finished, and a failed return", () => {
    const completionReturn = (
      childId: string,
      status: AgentControlCompletionReturn["status"],
    ): AgentControlCompletionReturn =>
      ({
        revision: 1,
        childThreadId: childId,
        initialMessageId: `initial-${childId}`,
        parentThreadId: "parent",
        parentTurnId: "origin",
        childTurnId: null,
        status,
        detail: `${status} detail`,
        updatedAt: T0,
      }) as never;
    const model = build({
      delegatedChildren: [
        // Finished a turn before; its newest turn has no completion yet (web's latestCompletedTurnAt).
        child("earlier", { latestCompletedTurnAt: "2026-08-10T09:52:05.000Z" }),
        child("blocked", {
          latestTurn: turn("completed", "2026-08-10T09:50:00.000Z", "2026-08-10T09:52:05.000Z"),
        }),
        child("returned", {
          latestTurn: turn("completed", "2026-08-10T09:50:00.000Z", "2026-08-10T09:51:00.000Z"),
        }),
      ],
      completionReturns: new Map<ThreadId, AgentControlCompletionReturn>([
        ["blocked" as ThreadId, completionReturn("blocked", "blocked")],
        ["returned" as ThreadId, completionReturn("returned", "delivered")],
      ]),
    });
    const [earlier, blocked, returned] = model.sections[0]!.rows;
    expect(earlier).toMatchObject({ statusLabel: "Done", tone: "done", activity: null });
    expect(blocked).toMatchObject({
      statusLabel: "Done",
      tone: "done",
      activity: "Return blocked",
      activityFailed: true,
    });
    expect(returned).toMatchObject({ activity: "Returned", activityFailed: false });
    // A blocked return counts as failed, as the dock counts it.
    expect(model.sections[0]!.status).toBe("1 failed");
  });

  it("shows an offline chat's agents as last known: nothing live, no clock, no Stop", () => {
    const panel = deriveAgentPanelModel({
      agents: [
        agent("a", { canStop: true, runtimeSessionId: "rt-1", progress: "Reading ws.ts" }),
        agent("b", { status: "completed", completedAt: "2026-08-10T10:00:40.000Z" }),
      ],
    });
    const model = build({
      panel,
      offline: true,
      delegatedChildren: [
        child("working", { latestTurn: turn("running", "2026-08-10T10:00:30.000Z", null) }),
        child("done", {
          latestTurn: turn("completed", "2026-08-10T09:50:00.000Z", "2026-08-10T09:52:05.000Z"),
        }),
      ],
    });
    const [running, settled] = model.sections[0]!.rows;
    expect(running).toMatchObject({
      statusLabel: "Offline",
      tone: "muted",
      elapsed: null,
      stop: null,
      activity: "Reading ws.ts",
    });
    // What settled stays a fact.
    expect(settled).toMatchObject({
      statusLabel: "Completed",
      tone: "done",
      elapsed: { kind: "frozen", text: "40s" },
    });
    const [working, done] = model.sections[1]!.rows;
    expect(working).toMatchObject({ statusLabel: "Offline", tone: "muted", elapsed: null });
    expect(done).toMatchObject({ statusLabel: "Done", tone: "done" });
    expect(model.sections.map((section) => section.status)).toEqual([null, null]);
    expect(model).toMatchObject({ live: 0, total: 4, offline: true });
    expect(buildThreadAgentsEntry(model)).toEqual({
      label: "4 agents",
      live: false,
      accessibilityLabel: "4 agents, offline. Show agents.",
    });
    expect(threadAgentsSheetSummary(model)).toBe("Offline · 4 in all");
  });

  it("counts a delegated task held by a usage limit, as the dock does, as not active", () => {
    const model = build({ delegatedChildren: [limitedChild("limited")] });
    expect(model.sections[0]!.rows[0]).toMatchObject({ statusLabel: "Limited", tone: "attention" });
    expect(model.live).toBe(0);
    expect(buildThreadAgentsEntry(model)).toMatchObject({ label: "1 agent", live: false });
  });

  it("never reads the time: only a working row's label measures its start to the clock", () => {
    const input = {
      panel: deriveAgentPanelModel({
        agents: [
          agent("a"),
          agent("b", { status: "completed", completedAt: "2026-08-10T10:00:40.000Z" }),
        ],
      }),
      delegatedChildren: [
        child("working", { latestTurn: turn("running", "2026-08-10T10:00:30.000Z", null) }),
        limitedChild("limited"),
      ],
    };
    vi.useFakeTimers({ now: NOW });
    const opened = build(input);
    // Ten minutes on, past the limit's reset too: a clock tick has nothing to rebuild.
    vi.setSystemTime(NOW + 10 * 60_000);
    expect(build(input)).toEqual(opened);

    const [running, settled] = opened.sections[0]!.rows;
    const [working, limited] = opened.sections[1]!.rows;
    expect(threadAgentElapsedText(running!.elapsed, NOW)).toBe("1m 05s");
    expect(threadAgentElapsedText(running!.elapsed, NOW + 1000)).toBe("1m 06s");
    expect(threadAgentElapsedText(working!.elapsed, NOW + 1000)).toBe("36s");
    // Settled time is a fact, whatever the clock says; a held task shows none.
    expect(threadAgentElapsedText(settled!.elapsed, NOW + 60_000)).toBe("40s");
    expect(limited).toMatchObject({ statusLabel: "Limited", elapsed: null });
  });
});
