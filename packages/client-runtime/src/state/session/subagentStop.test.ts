import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@ryco/contracts";

import { deriveThreadAgentPanelModel, foldSubagentActivities } from "./subagentRuntime.ts";
import { subagentStopIdentity } from "./subagentStop.ts";
import { deriveThreadSubagents } from "./threadWorkspaceViewModel.ts";

let sequence = 0;
/** A post-ingestion agent row: ingestion stamps agentKind on every task.* payload. */
function agentRow(kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: kind.startsWith("task.") ? { agentKind: "agent", ...payload } : payload,
    turnId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, 0, sequence)).toISOString(),
  } as unknown as OrchestrationThreadActivity;
}

/** A Claude subagent that runtime rt-1 reported running and stoppable. */
function started(taskId: string, overrides: Record<string, unknown> = {}) {
  return agentRow("task.started", {
    taskId,
    taskType: "local_agent",
    runtimeSessionId: "rt-1",
    canStop: true,
    ...overrides,
  });
}

function identityAfter(
  rows: ReadonlyArray<OrchestrationThreadActivity>,
  currentRuntimeSessionId: string | null = "rt-1",
  sessionLive = true,
) {
  const [agent] = foldSubagentActivities(rows, { sessionLive });
  return agent ? subagentStopIdentity(agent, currentRuntimeSessionId) : undefined;
}

describe("subagentStopIdentity", () => {
  it("stops a live subagent of the current runtime as attempt 0", () => {
    expect(identityAfter([started("agent-1")])).toEqual({
      taskId: "agent-1",
      runtimeSessionId: "rt-1",
      attempt: 0,
    });
    expect(identityAfter([started("agent-2", { attempt: 3 })])?.attempt).toBe(3);
    expect(
      identityAfter([
        started("agent-3"),
        agentRow("task.updated", { taskId: "agent-3", status: "waiting" }),
      ]),
    ).toMatchObject({ taskId: "agent-3" });
  });

  it("refuses settled and idle agents", () => {
    expect(
      identityAfter([
        started("done"),
        agentRow("task.completed", { taskId: "done", status: "completed" }),
      ]),
    ).toBeNull();
    expect(
      identityAfter([
        started("failed"),
        agentRow("task.completed", { taskId: "failed", status: "failed" }),
      ]),
    ).toBeNull();
    expect(
      identityAfter([
        started("stopped"),
        agentRow("task.completed", { taskId: "stopped", status: "stopped" }),
      ]),
    ).toBeNull();
    expect(
      identityAfter([
        started("idle"),
        agentRow("task.updated", { taskId: "idle", status: "idle" }),
      ]),
    ).toBeNull();
  });

  it("refuses agents the provider can't stop", () => {
    expect(identityAfter([started("agent-1", { canStop: false })])).toBeNull();
    expect(identityAfter([started("agent-2", { canStop: undefined })])).toBeNull();
  });

  it("refuses agents of another runtime or with no known runtime", () => {
    expect(identityAfter([started("agent-1")], "rt-2")).toBeNull();
    expect(identityAfter([started("agent-1")], null)).toBeNull();
    expect(identityAfter([started("agent-2", { runtimeSessionId: undefined })], null)).toBeNull();
  });

  it("refuses an agent orphaned by its session's death", () => {
    expect(identityAfter([started("agent-1")], "rt-1", false)).toBeNull();
  });

  it("never stops a workflow coordinator or one of its members", () => {
    expect(identityAfter([started("wf-1", { taskType: "local_workflow" })])).toBeNull();
    expect(
      identityAfter([
        agentRow("task.progress", {
          taskId: "wf-1:wf:0",
          status: "running",
          parentAgentId: "wf-1",
          attempt: 2,
          runtimeSessionId: "rt-1",
          canStop: true,
        }),
      ]),
    ).toBeNull();
  });

  it("refuses Codex collaboration agents from the transcript fallback", () => {
    const rows = [
      agentRow("tool.started", {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        providerItemId: "collab-reviewer",
        detail: "Review the Agents workspace",
      }),
    ];
    const model = deriveThreadAgentPanelModel({
      activities: rows,
      transcriptSubagents: deriveThreadSubagents(rows),
      sessionLive: true,
    });
    const [agent] = model.directAgents;
    expect(agent?.status).toBe("running");
    expect(subagentStopIdentity(agent!, "rt-1")).toBeNull();
  });
});
