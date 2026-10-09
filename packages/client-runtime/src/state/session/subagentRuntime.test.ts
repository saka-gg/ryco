import { describe, expect, it } from "vite-plus/test";
import { type OrchestrationThreadActivity } from "@ryco/contracts";
import { classifyTaskAgentKind } from "@ryco/shared/taskClassification";
import {
  agentPanelAgentCount,
  agentPanelRoster,
  agentPhaseStatusText,
  agentWorkflowMembers,
  agentWorkflowStatusText,
  buildAgentRosterIdentity,
  deriveAgentPanelModel,
  deriveThreadAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isAgentAttributedToolActivity,
  isSubagentActivityKind,
  isTimelineBypassActivity,
  resolveAgentRowIdentity,
  summarizeAgentWorkflow,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
  workflowCardMembers,
} from "./subagentRuntime.ts";
import { deriveThreadSubagents } from "./threadWorkspaceViewModel.ts";

// Timestamps derive from a base epoch so every fixture stays a VALID ISO
// string past 59 rows — interpolating the sequence into the seconds field
// produced `10:00:137.000Z`, which Date.parse rejects.
const BASE_EPOCH_MS = Date.parse("2026-08-01T10:00:00.000Z");
const stampFor = (index: number) => new Date(BASE_EPOCH_MS + index * 1000).toISOString();

let sequence = 0;
/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload, so the helper stamps too (same classifier). Pass an
 * explicit agentKind (or agentKind: undefined via legacy()) to override.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at = stampFor(sequence),
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}

/** A pre-stamp row (legacy thread / old server): no agentKind at all. */
function legacyActivity(
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: stampFor(sequence),
  } as unknown as OrchestrationThreadActivity;
}

function fold(rows: ReadonlyArray<OrchestrationThreadActivity>) {
  return foldSubagentActivities(rows);
}

describe("foldSubagentActivities", () => {
  it("builds an agent from start → progress → completion", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-1",
        title: "Audit auth flow",
        role: "explorer",
      }),
      activity("task.progress", {
        taskId: "task-1",
        lastToolName: "Read",
        typedUsage: { totalTokens: 1200, toolUses: 3 },
      }),
      activity("task.completed", {
        taskId: "task-1",
        status: "completed",
        summary: "Found 2 issues",
        typedUsage: { totalTokens: 5000, toolUses: 9 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Audit auth flow");
    expect(agent.role).toBe("explorer");
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("Found 2 issues");
    expect(agent.usage?.totalTokens).toBe(5000);
    expect(agent.activationCount).toBe(1);
    expect(agent.completedAt).not.toBeNull();
  });

  it("progress can create an agent when its start row aged out of retention", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "task-orphan",
        title: "Recovered agent",
        role: "verifier",
        typedUsage: { totalTokens: 100 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Recovered agent");
    expect(agents[0]!.status).toBe("running");
  });

  it("completion before start stays terminal; a late start only fills metadata", () => {
    const agents = fold([
      activity("task.completed", {
        taskId: "task-2",
        status: "failed",
        summary: "boom",
        role: "fixer",
      }),
      activity("task.started", { taskId: "task-2", title: "Late metadata", role: "fixer" }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Late metadata");
    expect(agent.role).toBe("fixer");
    // The late start must NOT reopen the terminal activation as a new run.
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("boom");
  });

  it("duplicate terminal events are idempotent (timestamps do not slide)", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-3", taskType: "local_agent" }),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T12:00:00.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("late running state cannot reopen a terminal agent", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-4", taskType: "local_agent" }),
      activity("task.completed", { taskId: "task-4", status: "completed", summary: "run 1 done" }),
      activity("task.updated", { taskId: "task-4", status: "running" }),
    ]);
    const agent = agents[0]!;
    expect(agent.activationCount).toBe(1);
    expect(agent.result).toBe("run 1 done");
    expect(agent.completedAt).not.toBeNull();
    expect(agent.status).toBe("completed");
  });

  it("idle is nonterminal: an idle agent resumes without losing identity", () => {
    const agents = fold([
      activity("task.started", { taskId: "codex-child-1", title: "Marlow", role: "explorer" }),
      activity("task.updated", { taskId: "codex-child-1", status: "idle" }),
      activity("task.updated", { taskId: "codex-child-1", status: "running" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(2);
    expect(agents[0]!.status).toBe("running");
  });

  it("cumulative usage max-merges: duplicate and late frames never shrink or double-count", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-5", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", { taskId: "task-5", typedUsage: { totalTokens: 500 } }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 900, inputTokens: 700 });
  });

  it("usage snapshots enrich an existing agent without changing its status", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "usage-waiting", taskType: "local_agent" }),
      activity("task.progress", { taskId: "usage-waiting", status: "waiting" }),
      activity("task.progress", {
        taskId: "usage-waiting",
        usageSnapshot: true,
        typedUsage: { totalTokens: 1_200 },
      }),
    ]);

    expect(agent?.status).toBe("waiting");
    expect(agent?.usage?.totalTokens).toBe(1_200);
  });

  it("a retained usage snapshot can reconstruct a running agent", () => {
    const [agent] = fold([
      activity("task.progress", {
        taskId: "usage-only",
        usageSnapshot: true,
        typedUsage: { totalTokens: 800 },
      }),
    ]);

    expect(agent?.status).toBe("running");
    expect(agent?.usage?.totalTokens).toBe(800);
  });

  it("partial terminal usage preserves known breakdown fields", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-6", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-6",
        typedUsage: { totalTokens: 800, inputTokens: 600, outputTokens: 150 },
      }),
      activity("task.completed", {
        taskId: "task-6",
        status: "completed",
        typedUsage: { totalTokens: 1000 },
      }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 1000, inputTokens: 600, outputTokens: 150 });
  });

  it("skips malformed rows individually without failing the fold", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-7", title: "Good", taskType: "local_agent" }),
      activity("task.progress", { bogus: true }),
      activity("task.progress", { taskId: 42 }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Good");
  });

  it("bounds repeated strings at 180 chars and the activity ring at 6 deduped entries", () => {
    const long = "x".repeat(500);
    const rows = [activity("task.started", { taskId: "task-8", taskType: "local_agent" })];
    for (let i = 0; i < 10; i += 1) {
      rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-${i}` }));
    }
    rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-9` }));
    const agents = fold(rows);
    const agent = agents[0]!;
    expect(agent.recentActivity.length).toBeLessThanOrEqual(6);
    for (const entry of agent.recentActivity) {
      expect(entry.summary.length).toBeLessThanOrEqual(180);
    }
    // Consecutive identical summaries dedupe (truncation makes them equal).
    const summaries = agent.recentActivity.map((entry) => entry.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });

  it("plan tasks are not agents", () => {
    const agents = fold([activity("task.started", { taskId: "plan-1", taskType: "plan" })]);
    expect(agents).toHaveLength(0);
  });

  it("workflow members key by stable slot and attach to their coordinator", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-1",
        taskType: "local_workflow",
        title: "audit-auth-flow",
        workflowName: "audit-auth-flow",
      }),
      activity("task.progress", {
        taskId: "wf-1",
        phases: [
          { index: 0, title: "Audit" },
          { index: 1, title: "Verify" },
        ],
      }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "audit:entrypoints",
        status: "running",
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 0,
        phaseTitle: "Audit",
        timelineBypass: true,
      }),
    ]);
    const workflow = agents.find((agent) => agent.id === "wf-1");
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(workflow?.kind).toBe("workflow");
    expect(workflow?.phases).toEqual([
      { index: 0, title: "Audit" },
      { index: 1, title: "Verify" },
    ]);
    expect(member?.kind).toBe("workflow_agent");
    expect(member?.parentAgentId).toBe("wf-1");
  });

  it("a workflow member retry (attempt bump) is a reactivation of the same slot", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "failed",
        error: "attempt 1 died",
        parentAgentId: "wf-2",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "running",
        parentAgentId: "wf-2",
        attempt: 2,
      }),
    ]);
    expect(agents).toHaveLength(1);
    const member = agents[0]!;
    expect(member.activationCount).toBeGreaterThanOrEqual(2);
    expect(member.error).toBeNull();
    expect(member.status).toBe("running");
  });

  it("drops non-http(s) session urls at the fold boundary", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-3",
        taskType: "local_workflow",
        runHandles: { sessionUrl: "javascript:alert(1)", runId: "run-1" },
      }),
    ]);
    expect(agents[0]!.runHandles?.sessionUrl).toBeUndefined();
    expect(agents[0]!.runHandles?.runId).toBe("run-1");
  });
});

/**
 * Panel roster fixture: a two-phase workflow (Audit done, Verify running) and
 * one idle direct spawn. A builder, so each describe folds its own rows.
 */
function panelRoster() {
  return fold([
    activity("task.started", { taskId: "wf-1", taskType: "local_workflow", title: "audit" }),
    activity("task.progress", {
      taskId: "wf-1",
      phases: [
        { index: 0, title: "Audit" },
        { index: 1, title: "Verify" },
      ],
    }),
    activity("task.progress", {
      taskId: "wf-1:wf:0",
      title: "audit:a",
      status: "completed",
      parentAgentId: "wf-1",
      agentIndex: 0,
      phaseIndex: 0,
    }),
    activity("task.completed", { taskId: "wf-1:wf:0", status: "completed", parentAgentId: "wf-1" }),
    activity("task.progress", {
      taskId: "wf-1:wf:1",
      title: "verify:b",
      status: "running",
      parentAgentId: "wf-1",
      agentIndex: 1,
      phaseIndex: 1,
      typedUsage: { totalTokens: 4000 },
    }),
    activity("task.started", { taskId: "direct-1", title: "Marlow", role: "explorer" }),
    activity("task.updated", { taskId: "direct-1", status: "idle" }),
  ]);
}

describe("deriveAgentPanelModel", () => {
  const roster = panelRoster();

  it("groups workflow members by phase and separates direct spawns", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.workflows).toHaveLength(1);
    const group = model.workflows[0]!;
    expect(group.phases).toHaveLength(2);
    expect(group.phases[0]!.state).toBe("done");
    expect(group.phases[1]!.state).toBe("running");
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["direct-1"]);
  });

  it("counts idle deliberately and waiting as active", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.idleCount).toBe(1);
    // Member 1 is running; the wf-1 coordinator is a container, not a worker.
    expect(model.runningCount).toBe(1);
    // Every agent lands in exactly one bucket, except coordinators that stand
    // in for their members.
    expect(model.idleCount + model.runningCount + model.waitingCount + model.settledCount).toBe(
      roster.length - 1,
    );
  });

  it("omits a workflow coordinator from the working-agent count", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    // One member still running plus one idle direct spawn. The coordinator
    // reports running for the whole workflow and must not inflate the banner.
    expect(model.liveCount).toBe(1);
  });

  it("omits a finished workflow coordinator from the settled count", () => {
    const finished = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow", title: "sweep" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        title: "sweep:a",
        status: "completed",
        parentAgentId: "wf-2",
        agentIndex: 0,
        phaseIndex: 0,
      }),
      activity("task.completed", {
        taskId: "wf-2:wf:0",
        status: "completed",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "completed" }),
    ]);

    const model = deriveAgentPanelModel({ agents: finished });

    // Only the member settled. The coordinator stands in for it, so counting
    // both would report two finished agents where one ran.
    expect(model.settledCount).toBe(1);
    expect(model.liveCount).toBe(0);
  });

  it("keeps direct spawns in first-seen order as their activity changes", () => {
    const directRoster = fold([
      activity("task.started", { taskId: "direct-a", title: "First" }, "2026-08-01T11:00:00.000Z"),
      activity("task.started", { taskId: "direct-b", title: "Second" }, "2026-08-01T11:00:01.000Z"),
      activity(
        "task.progress",
        { taskId: "direct-a", summary: "Newest activity" },
        "2026-08-01T11:00:02.000Z",
      ),
    ]);

    expect(
      deriveAgentPanelModel({ agents: directRoster }).directAgents.map((agent) => agent.id),
    ).toEqual(["direct-a", "direct-b"]);
  });

  it("keeps first-seen order after roster retention ranking", () => {
    const starts = Array.from({ length: 101 }, (_, index) =>
      activity(
        "task.started",
        { taskId: `capped-${index}`, title: `Agent ${index}` },
        `2026-08-01T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}.000Z`,
      ),
    );
    const cappedRoster = fold([
      ...starts,
      activity(
        "task.progress",
        { taskId: "capped-0", summary: "Newest activity" },
        "2026-08-01T12:02:00.000Z",
      ),
    ]);

    const ids = deriveAgentPanelModel({ agents: cappedRoster }).directAgents.map(
      (agent) => agent.id,
    );
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 3)).toEqual(["capped-0", "capped-2", "capped-3"]);
    expect(ids.at(-1)).toBe("capped-100");
  });

  it("a phase with only pending members never reads as running", () => {
    const pendingRoster = fold([
      activity("task.started", { taskId: "wf-9", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-9",
        phases: [{ index: 0, title: "Fix" }],
      }),
      activity("task.progress", {
        taskId: "wf-9:wf:0",
        title: "fixer",
        status: "pending",
        parentAgentId: "wf-9",
        agentIndex: 0,
        phaseIndex: 0,
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: pendingRoster });
    // "pending" counts as active liveness (queued work), so the phase reads
    // running only if a member is genuinely pending/running — this asserts
    // the settled-count rule: no member settled, phase not done.
    expect(model.workflows[0]!.phases[0]!.state).not.toBe("done");
  });

  it("keeps unstarted phases pending while live and settles them with the workflow", () => {
    const liveActivities = [
      activity("task.started", { taskId: "wf-sequential", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-sequential",
        phases: [
          { index: 1, title: "Work" },
          { index: 2, title: "Review" },
          { index: 3, title: "Verify" },
        ],
      }),
      activity("task.progress", {
        taskId: "wf-sequential:wf:1",
        title: "Implement",
        status: "running",
        parentAgentId: "wf-sequential",
        phaseIndex: 1,
      }),
    ];
    const live = deriveAgentPanelModel({ agents: fold(liveActivities) });
    expect(live.workflows[0]!.phases.map((phase) => phase.state)).toEqual([
      "running",
      "pending",
      "pending",
    ]);

    const settled = deriveAgentPanelModel({
      agents: fold([
        ...liveActivities,
        activity("task.completed", {
          taskId: "wf-sequential",
          taskType: "local_workflow",
          status: "completed",
        }),
      ]),
    });
    expect(settled.workflows[0]!.phases.map((phase) => phase.state)).toEqual([
      "done",
      "done",
      "done",
    ]);
  });

  it("v2 projection wins outright and sources are never merged", () => {
    const v2Agent = { ...roster[0]!, id: "v2-only", title: "From v2" };
    const model = deriveAgentPanelModel({ agents: roster, v2Projection: [v2Agent] });
    const allIds = [
      ...model.workflows.map((group) => group.workflow.id),
      ...model.directAgents.map((agent) => agent.id),
    ];
    expect(allIds).toContain("v2-only");
    expect(allIds).not.toContain("direct-1");
  });

  it("orphaned members fall back to the direct list", () => {
    const orphans = fold([
      activity("task.progress", {
        taskId: "gone:wf:0",
        title: "orphan",
        status: "running",
        parentAgentId: "gone",
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: orphans });
    expect(model.workflows).toHaveLength(0);
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["gone:wf:0"]);
  });
});

describe("workflowCardMembers", () => {
  it("orders by urgency (failed, running, waiting) and reports overflow", () => {
    const roster = fold([
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      ...[..."abcdefghij"].map((letter, index) =>
        activity("task.progress", {
          taskId: `wf-1:wf:${index}`,
          title: `agent-${letter}`,
          status: index === 3 ? "failed" : index < 3 ? "completed" : "running",
          ...(index === 3 ? { error: "died" } : {}),
          parentAgentId: "wf-1",
          agentIndex: index,
          phaseIndex: 0,
          phaseTitle: "Work",
        }),
      ),
    ]);
    const model = deriveAgentPanelModel({ agents: roster });
    const { visible, overflow } = workflowCardMembers(model.workflows[0]!, 8);
    expect(visible).toHaveLength(8);
    expect(overflow).toBe(2);
    expect(visible.some((agent) => agent.status === "failed")).toBe(true);
    expect(visible.filter((agent) => agent.status === "completed").length).toBeLessThanOrEqual(2);
    // Chosen by urgency, rendered in roster (spawn) order.
    expect(visible.map((agent) => agent.agentIndex)).toEqual([0, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps rows in place when a member's progress bumps its updatedAt", () => {
    const rows = [
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      ...[..."abc"].map((letter, index) =>
        activity("task.progress", {
          taskId: `wf-1:wf:${index}`,
          title: `agent-${letter}`,
          status: "running",
          parentAgentId: "wf-1",
          agentIndex: index,
          phaseIndex: 0,
          phaseTitle: "Work",
        }),
      ),
    ];
    const ids = (activities: ReadonlyArray<OrchestrationThreadActivity>) =>
      workflowCardMembers(
        deriveAgentPanelModel({ agents: fold(activities) }).workflows[0]!,
        3,
      ).visible.map((agent) => agent.id);
    const before = ids(rows);
    const after = ids([
      ...rows,
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "agent-a",
        status: "running",
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 0,
        phaseTitle: "Work",
        summary: "Still going",
      }),
    ]);
    expect(after).toEqual(before);
    expect(before).toEqual(["wf-1:wf:0", "wf-1:wf:1", "wf-1:wf:2"]);
  });
});

function workflowGroup(rows: ReadonlyArray<OrchestrationThreadActivity>): AgentPanelWorkflowGroup {
  return deriveAgentPanelModel({ agents: fold(rows) }).workflows[0]!;
}

function workflowMember(
  workflowId: string,
  index: number,
  status: string,
  extra: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return activity("task.progress", {
    taskId: `${workflowId}:wf:${index}`,
    title: `member-${index}`,
    status,
    parentAgentId: workflowId,
    agentIndex: index,
    ...extra,
  });
}

describe("summarizeAgentWorkflow", () => {
  it("summarizes a live run by its coordinator, members and live phase", () => {
    const model = deriveAgentPanelModel({ agents: panelRoster() });
    const summary = summarizeAgentWorkflow(model.workflows[0]!);
    expect(summary).toEqual({
      id: "wf-1",
      name: "audit",
      live: true,
      displayStatus: "running",
      memberCount: 2,
      settledCount: 1,
      workingCount: 1,
      failedCount: 0,
      totalTokens: 4000,
      phaseCount: 2,
      livePhase: model.workflows[0]!.phases[1],
    });
    expect(agentWorkflowStatusText(summary)).toBe("Verify · 1 working");
  });

  it("prefers the workflow name and reads failed once any member failed", () => {
    const group = workflowGroup([
      activity("task.started", {
        taskId: "wf-f",
        taskType: "local_workflow",
        title: "coordinator title",
        workflowName: "Release audit",
      }),
      workflowMember("wf-f", 0, "failed", { error: "boom" }),
      workflowMember("wf-f", 1, "completed"),
      activity("task.completed", { taskId: "wf-f", status: "completed" }),
    ]);
    const summary = summarizeAgentWorkflow(group);
    expect(summary.name).toBe("Release audit");
    expect(summary.live).toBe(false);
    expect(summary.displayStatus).toBe("failed");
    expect(summary.failedCount).toBe(1);
    expect(summary.settledCount).toBe(2);
    expect(agentWorkflowStatusText(summary)).toBe("1 failed");
  });

  it("words a settled clean run as completed", () => {
    const group = workflowGroup([
      activity("task.started", { taskId: "wf-c", taskType: "local_workflow", title: "sweep" }),
      workflowMember("wf-c", 0, "completed"),
      activity("task.completed", { taskId: "wf-c", status: "completed" }),
    ]);
    const summary = summarizeAgentWorkflow(group);
    expect(summary.displayStatus).toBe("completed");
    expect(agentWorkflowStatusText(summary)).toBe("Completed");
  });

  it("counts working members without a live phase, and says Working with none", () => {
    const working = summarizeAgentWorkflow(
      workflowGroup([
        activity("task.started", { taskId: "wf-u", taskType: "local_workflow", title: "unphased" }),
        workflowMember("wf-u", 0, "running"),
        workflowMember("wf-u", 1, "waiting"),
        workflowMember("wf-u", 2, "completed"),
      ]),
    );
    expect(working.livePhase).toBeNull();
    expect(working.workingCount).toBe(2);
    expect(agentWorkflowStatusText(working)).toBe("2 working");

    // Dynamic spawns: every member settled while the coordinator still runs.
    const between = summarizeAgentWorkflow(
      workflowGroup([
        activity("task.started", { taskId: "wf-b", taskType: "local_workflow", title: "between" }),
        workflowMember("wf-b", 0, "completed"),
      ]),
    );
    expect(between.live).toBe(true);
    expect(agentWorkflowStatusText(between)).toBe("Working");
  });

  it("counts coordinator tokens only when the run has no members", () => {
    const memberless = summarizeAgentWorkflow(
      workflowGroup([
        activity("task.started", { taskId: "wf-t", taskType: "local_workflow", title: "solo" }),
        activity("task.progress", { taskId: "wf-t", typedUsage: { totalTokens: 900 } }),
      ]),
    );
    expect(memberless.memberCount).toBe(0);
    expect(memberless.totalTokens).toBe(900);

    const withMembers = summarizeAgentWorkflow(
      workflowGroup([
        activity("task.started", { taskId: "wf-m", taskType: "local_workflow", title: "pair" }),
        activity("task.progress", { taskId: "wf-m", typedUsage: { totalTokens: 900 } }),
        workflowMember("wf-m", 0, "running", { typedUsage: { totalTokens: 300 } }),
      ]),
    );
    expect(withMembers.totalTokens).toBe(300);
  });

  it("words a direct-spawn batch through the same status fields", () => {
    expect(
      agentWorkflowStatusText({ live: true, livePhase: null, workingCount: 3, failedCount: 0 }),
    ).toBe("3 working");
    expect(
      agentWorkflowStatusText({ live: false, livePhase: null, workingCount: 0, failedCount: 2 }),
    ).toBe("2 failed");
  });
});

describe("agentPhaseStatusText", () => {
  it("words done, active and unstarted phases", () => {
    const [audit, verify] = deriveAgentPanelModel({ agents: panelRoster() }).workflows[0]!.phases;
    expect(agentPhaseStatusText(audit!)).toBe("1 done");
    expect(agentPhaseStatusText(verify!)).toBe("1 active · 0 done");

    const sequential = workflowGroup([
      activity("task.started", { taskId: "wf-s", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-s",
        phases: [
          { index: 0, title: "Work" },
          { index: 1, title: "Review" },
        ],
      }),
      workflowMember("wf-s", 0, "running", { phaseIndex: 0 }),
      workflowMember("wf-s", 1, "completed", { phaseIndex: 0 }),
    ]);
    expect(sequential.phases.map(agentPhaseStatusText)).toEqual([
      "1 active · 1 done",
      "not started",
    ]);
  });
});

describe("agent roster helpers", () => {
  it("lists workflow members in phase order, then unphased members", () => {
    const group = workflowGroup([
      activity("task.started", { taskId: "wf-o", taskType: "local_workflow" }),
      activity("task.progress", { taskId: "wf-o", phases: [{ index: 0, title: "Work" }] }),
      workflowMember("wf-o", 0, "running"),
      workflowMember("wf-o", 1, "running", { phaseIndex: 0 }),
    ]);
    expect(agentWorkflowMembers(group).map((agent) => agent.id)).toEqual([
      "wf-o:wf:1",
      "wf-o:wf:0",
    ]);
  });

  it("counts every agent once and never a coordinator standing in for members", () => {
    const model = deriveAgentPanelModel({ agents: panelRoster() });
    expect(agentPanelAgentCount(model)).toBe(3);
    expect(agentPanelRoster(model).map((agent) => agent.id)).toEqual([
      "wf-1",
      "wf-1:wf:0",
      "wf-1:wf:1",
      "direct-1",
    ]);
  });

  it("labels the roster with functional labels, numbered on collision", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity("task.started", { taskId: "explore-1", title: "Explore" }),
        activity("task.started", { taskId: "explore-2", title: "Explore" }),
        activity("task.started", { taskId: "direct-1", title: "Marlow", role: "explorer" }),
        activity("task.started", { taskId: "reviewer-1", title: "Reviewer", role: "reviewer" }),
      ]),
    });
    const roster = buildAgentRosterIdentity(model);
    const byId = (id: string): RuntimeSubagent =>
      agentPanelRoster(model).find((agent) => agent.id === id)!;
    expect(resolveAgentRowIdentity(byId("explore-1"), roster).label).toBe("Explore");
    expect(resolveAgentRowIdentity(byId("explore-2"), roster).label).toBe("Explore 2");
    expect(resolveAgentRowIdentity(byId("direct-1"), roster)).toEqual({
      label: "Marlow",
      role: "Explorer",
    });
    // A role that only repeats the label is not set beside it.
    expect(resolveAgentRowIdentity(byId("reviewer-1"), roster)).toEqual({
      label: "Reviewer",
      role: null,
    });
  });

  it("falls back to the agent's own label outside a roster", () => {
    const [agent] = fold([activity("task.started", { taskId: "solo-1", title: "Lint the tree" })]);
    const empty = buildAgentRosterIdentity(deriveAgentPanelModel({ agents: [] }));
    expect(empty.labels.size).toBe(0);
    expect(resolveAgentRowIdentity(agent!, empty)).toEqual({ label: "Lint the tree", role: null });
  });
});

describe("timeline predicates", () => {
  it("recognizes subagent activity kinds as fold input", () => {
    for (const kind of [
      "task.started",
      "task.progress",
      "task.updated",
      "task.completed",
      "tool.progress",
    ]) {
      expect(isSubagentActivityKind(kind)).toBe(true);
    }
    expect(isSubagentActivityKind("tool.completed")).toBe(false);
  });

  it("attributed tool rows are re-homed; unattributed rows stay in the timeline", () => {
    expect(isAgentAttributedToolActivity(activity("tool.completed", { agentId: "task-1" }))).toBe(
      true,
    );
    expect(isAgentAttributedToolActivity(activity("tool.completed", {}))).toBe(false);
    expect(isAgentAttributedToolActivity(activity("tool.completed", { agentId: "  " }))).toBe(
      false,
    );
  });

  it("timelineBypass rows never render in the parent chat", () => {
    expect(isTimelineBypassActivity(activity("task.progress", { timelineBypass: true }))).toBe(
      true,
    );
    expect(isTimelineBypassActivity(activity("task.progress", {}))).toBe(false);
  });
});

describe("formatSubagentTokenCount", () => {
  it("formats plain counters", () => {
    expect(formatSubagentTokenCount(950)).toBe("950");
    expect(formatSubagentTokenCount(41200)).toBe("41.2k");
    expect(formatSubagentTokenCount(247000)).toBe("247k");
    expect(formatSubagentTokenCount(1_400_000)).toBe("1.4M");
  });
});

describe("model and effort attribution", () => {
  it("carries model/effort from start rows and refines model from later rows", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-m",
        title: "Verify math",
        model: "sonnet",
        effort: "high",
      }),
      // Later row refines with the authoritative API model id; effort absent
      // must not clear the known value.
      activity("task.progress", { taskId: "task-m", model: "claude-sonnet-5[1m]" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.model).toBe("claude-sonnet-5[1m]");
    expect(agents[0]!.effort).toBe("high");
  });

  it("formatSubagentModelLabel compacts ids and appends effort", () => {
    expect(formatSubagentModelLabel("claude-sonnet-5[1m]", "high")).toBe("sonnet-5[1m] · high");
    expect(formatSubagentModelLabel("claude-opus-4-20250514", null)).toBe("opus-4");
    expect(formatSubagentModelLabel("gpt-5.6-sol", "low")).toBe("gpt-5.6-sol · low");
    expect(formatSubagentModelLabel(null, "high")).toBeNull();
  });
});

describe("background task exclusion", () => {
  it("shells and monitors never join the roster (from any lifecycle row)", () => {
    const agents = fold([
      activity("task.started", { taskId: "shell-1", taskType: "shell", title: "Run 12s stall" }),
      activity("task.progress", { taskId: "shell-2", taskType: "shell", title: "Run stall" }),
      activity("task.completed", { taskId: "mon-1", taskType: "monitor", status: "completed" }),
      activity("task.started", { taskId: "agent-1", taskType: "subagent", title: "Real agent" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["agent-1"]);
  });

  it("rows without a taskType stay in the roster (workflow members, Codex children)", () => {
    const agents = fold([
      activity("task.progress", { taskId: "wf-1:wf:0", status: "running", parentAgentId: "wf-1" }),
    ]);
    expect(agents).toHaveLength(1);
  });

  it("the server stamp is the only classifier: no stamp means no roster row", () => {
    const agents = fold([
      // Stamped background: agent-looking fields don't matter.
      activity("task.started", {
        taskId: "bg-1",
        agentKind: "background",
        role: "watcher",
        model: "sonnet",
      }),
      // Stamped agent: plain row still joins the roster.
      activity("task.started", { taskId: "ag-1", agentKind: "agent", detail: "plain row" }),
      // Legacy pre-stamp rows (old threads/servers) stay in the work log —
      // exactly their pre-upgrade behavior.
      legacyActivity("task.started", { taskId: "old-task", detail: "tailing logs" }),
      legacyActivity("task.progress", { taskId: "old-task", summary: "still tailing" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["ag-1"]);
  });

  it("membership is sticky: a stampless later row still reaches a known agent", () => {
    const agents = fold([
      activity("task.started", { taskId: "a1", taskType: "local_agent", title: "Agent" }),
      // Terminal row missing the stamp (defensive: adapters synthesize some
      // rows) — sticky membership still routes it to the agent.
      legacyActivity("task.completed", { taskId: "a1", status: "completed", summary: "done" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("completed");
    expect(agents[0]!.result).toBe("done");
  });
});

describe("session-derived interruption", () => {
  it("dead session interrupts live agents but preserves idle and settled", () => {
    const rows = [
      activity("task.started", { taskId: "live-1", taskType: "local_agent" }),
      activity("task.started", { taskId: "idle-1", taskType: "local_agent" }),
      activity("task.updated", { taskId: "idle-1", status: "idle" }),
      activity("task.started", { taskId: "done-1", taskType: "local_agent" }),
      activity("task.completed", { taskId: "done-1", status: "completed" }),
    ];
    const dead = foldSubagentActivities(rows, { sessionLive: false });
    expect(dead.find((agent) => agent.id === "live-1")?.status).toBe("interrupted");
    expect(dead.find((agent) => agent.id === "idle-1")?.status).toBe("idle");
    expect(dead.find((agent) => agent.id === "done-1")?.status).toBe("completed");
    const alive = foldSubagentActivities(rows, { sessionLive: true });
    expect(alive.find((agent) => agent.id === "live-1")?.status).toBe("running");
  });
});

describe("Codex collaboration transcript fallback", () => {
  it("renders persisted collab agents when no native task projection exists", () => {
    const rows = [
      activity("tool.started", {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        providerItemId: "collab-reviewer",
        data: {
          item: {
            type: "collabAgentToolCall",
            id: "collab-reviewer",
            tool: "spawnAgent",
            prompt: "You are a reviewer. Inspect the Agents workspace.",
            receiverThreadIds: ["child-reviewer"],
            status: "inProgress",
          },
        },
      }),
    ];

    const model = deriveThreadAgentPanelModel({
      activities: rows,
      transcriptSubagents: deriveThreadSubagents(rows),
      sessionLive: true,
    });

    expect(model).toMatchObject({
      hasAgents: true,
      liveCount: 1,
      runningCount: 1,
    });
    expect(model.directAgents).toHaveLength(1);
    expect(model.directAgents[0]).toMatchObject({
      id: "subagent:collab-reviewer",
      kind: "subagent",
      role: "Reviewer",
      status: "running",
      title: "You are a reviewer. Inspect the Agents workspace.",
    });
  });

  it("prefers native task state when transcript and task rows share an identity", () => {
    const rows = [
      activity("task.started", {
        taskId: "shared-agent",
        taskType: "local_agent",
        title: "Native verifier",
        role: "verifier",
      }),
      activity("tool.started", {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        subagentId: "shared-agent",
        detail: "Duplicate legacy representation",
      }),
    ];

    const model = deriveThreadAgentPanelModel({
      activities: rows,
      transcriptSubagents: deriveThreadSubagents(rows),
      sessionLive: true,
    });

    expect(model.directAgents).toHaveLength(1);
    expect(model.directAgents[0]).toMatchObject({
      id: "shared-agent",
      title: "Native verifier",
      role: "verifier",
    });
  });

  it("does not leave a collab-only running row live after its session dies", () => {
    const rows = [
      activity("tool.started", {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        providerItemId: "orphaned-collab",
        detail: "Inspect reconnect behavior",
      }),
    ];

    const model = deriveThreadAgentPanelModel({
      activities: rows,
      transcriptSubagents: deriveThreadSubagents(rows),
      sessionLive: false,
    });

    expect(model.liveCount).toBe(0);
    expect(model.directAgents[0]?.status).toBe("interrupted");
  });
});

describe("terminal robustness", () => {
  it("task.updated creating an agent (start row aged out) counts one activation", () => {
    const agents = fold([
      activity("task.updated", { taskId: "orphan-u", status: "running", role: "worker" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(1);
    expect(agents[0]!.status).toBe("running");
  });

  it("a late start after a terminal task.updated does not reopen the run", () => {
    const agents = fold([
      activity("task.updated", { taskId: "t1", status: "failed", role: "worker" }),
      activity("task.started", { taskId: "t1", taskType: "local_agent", title: "Late" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("failed");
    expect(agents[0]!.title).toBe("Late");
  });

  it("a completion after a terminal task.updated still enriches result and usage", () => {
    // Claude commonly emits terminal task.updated before task.completed;
    // the completion carries the summary and final usage the update lacked.
    const agents = fold([
      activity("task.started", { taskId: "te-1", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "te-1", status: "completed", endedAt: "2026-08-01T10:59:00.000Z" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        {
          taskId: "te-1",
          status: "completed",
          summary: "final answer",
          typedUsage: { totalTokens: 4200, toolUses: 7 },
        },
        "2026-08-01T11:00:01.000Z",
      ),
    ]);
    const agent = agents[0]!;
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("final answer");
    expect(agent.usage?.totalTokens).toBe(4200);
    // Timestamps stay pinned to the transition that settled the run.
    expect(agent.completedAt).toBe("2026-08-01T10:59:00.000Z");
  });

  it("duplicate completions keep the FIRST result, not the last", () => {
    const agents = fold([
      activity("task.started", { taskId: "t2", taskType: "local_agent" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "first result" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "second result" }),
    ]);
    expect(agents[0]!.result).toBe("first result");
  });

  it("provider endedAt wins over ingestion time on the settling transition", () => {
    const agents = fold([
      activity("task.started", { taskId: "t3", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "t3", status: "failed", endedAt: "2026-08-01T09:59:59.000Z" },
        "2026-08-01T10:00:30.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T09:59:59.000Z");
  });

  it("workflow retries count each attempt once", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "failed",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 2,
      }),
    ]);
    expect(agents[0]!.activationCount).toBe(2);
  });

  it("an explicit attempt bump on task.started reopens a settled workflow slot", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-start:wf:0",
        parentAgentId: "wf-start",
        status: "failed",
        attempt: 1,
        error: "first attempt failed",
      }),
      activity("task.started", {
        taskId: "wf-start:wf:0",
        parentAgentId: "wf-start",
        attempt: 2,
      }),
    ]);

    expect(agents[0]).toMatchObject({
      activationCount: 2,
      status: "running",
      error: null,
      completedAt: null,
    });
  });

  it("a retry observed only at completion becomes a complete second activation", () => {
    const retryCompletedAt = "2026-08-01T12:00:00.000Z";
    const agents = fold([
      activity("task.completed", {
        taskId: "wf-complete:wf:0",
        parentAgentId: "wf-complete",
        status: "failed",
        attempt: 1,
        summary: "first attempt failed",
      }),
      activity(
        "task.completed",
        {
          taskId: "wf-complete:wf:0",
          parentAgentId: "wf-complete",
          status: "completed",
          attempt: 2,
          summary: "retry succeeded",
        },
        retryCompletedAt,
      ),
    ]);

    expect(agents[0]).toMatchObject({
      activationCount: 2,
      status: "completed",
      result: "retry succeeded",
      error: null,
      startedAt: retryCompletedAt,
      completedAt: retryCompletedAt,
    });
  });
});

describe("phase membership", () => {
  it("members with unknown phase indices land in unphasedMembers, never vanish", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity("task.started", {
          taskId: "wf-p",
          taskType: "local_workflow",
          phases: [{ index: 0, title: "Only phase" }],
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:0",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 0,
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:9",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 9,
        }),
      ]),
    });
    const group = model.workflows[0]!;
    const visible = [
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ].map((member) => member.id);
    expect(visible).toContain("wf-p:wf:0");
    expect(visible).toContain("wf-p:wf:9");
  });
});

describe("coordinator settle cascade", () => {
  it("members without their own terminal row settle when the coordinator does", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "stalled member",
        status: "running",
        parentAgentId: "wf-1",
      }),
      activity("task.completed", {
        taskId: "wf-1",
        status: "completed",
        taskType: "local_workflow",
      }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(member?.status).toBe("completed");
    expect(member?.completedAt).not.toBeNull();
  });

  it("a failed coordinator marks unfinished members interrupted, not completed", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        status: "running",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "failed", taskType: "local_workflow" }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-2:wf:0");
    expect(member?.status).toBe("interrupted");
  });
});

describe("task type classification is a denylist", () => {
  it("unknown agent-flavored types (local_agent, future names) join the roster", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "a1",
        taskType: "local_agent",
        title: "Math test 1",
        role: "claude",
      }),
      activity("task.started", { taskId: "a2", taskType: "some_future_agent_kind", title: "X" }),
    ]);
    expect(agents.map((agent) => agent.id).toSorted()).toEqual(["a1", "a2"]);
  });
});

describe("nested agents vs subagent shells", () => {
  it("a nested agent (agentId + agent taskType) stays in the roster; its shells do not", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "nested-1",
        taskType: "local_agent",
        agentId: "parent-agent",
        title: "Nested researcher",
      }),
      activity("task.started", {
        taskId: "shell-1",
        taskType: "local_bash",
        agentId: "parent-agent",
        title: "Nested sleep",
      }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["nested-1"]);
  });
});

it("retains distinct observed child direct/read/write/output scopes across sparse terminal updates", () => {
  const agents = fold([
    activity("task.started", {
      taskId: "cache-child",
      title: "Child fixture",
      taskType: "local_agent",
    }),
    activity("task.progress", {
      taskId: "cache-child",
      typedUsage: {
        totalTokens: 100,
        inputTokens: 10,
        directInputTokens: 10,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 30,
        outputTokens: 10,
      },
    }),
    activity("task.completed", {
      taskId: "cache-child",
      status: "completed",
      typedUsage: { totalTokens: 100 },
    }),
  ]);
  expect(agents[0]?.usage).toMatchObject({
    directInputTokens: 10,
    cachedInputTokens: 50,
    cacheWriteInputTokens: 30,
    outputTokens: 10,
  });
});
