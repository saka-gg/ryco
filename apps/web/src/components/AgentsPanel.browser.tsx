import "../index.css";

import { EventId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  deriveAgentPanelModel,
  deriveThreadSubagents,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
} from "../threadWorkspaceViewModel";
import { BackgroundLivenessChip } from "./chat/BackgroundLivenessChip";
import { AgentsPanel } from "./AgentsPanel";

function agent(
  id: string,
  overrides: Partial<RuntimeSubagent> & {
    readonly status?: RuntimeSubagentStatus;
  } = {},
): RuntimeSubagent {
  const firstSeenAt = overrides.firstSeenAt ?? "2026-08-10T10:00:00.000Z";
  return {
    id,
    kind: "subagent",
    title: `Task for ${id}`,
    role: null,
    model: "gpt-5.6-sol",
    effort: "high",
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
    recentActivity: [],
    firstSeenAt,
    startedAt: firstSeenAt,
    completedAt: null,
    updatedAt: firstSeenAt,
    ...overrides,
  };
}

function rowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-agent-row]")].map(
    (row) => row.dataset.agentId ?? "",
  );
}

describe("AgentsPanel", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount().catch(() => {});
    mounted = null;
    document.body.innerHTML = "";
  });

  it("separates background navigation from stopping and identifies waiting agents", async () => {
    const onOpenAgents = vi.fn();
    const onStop = vi.fn();
    mounted = await render(
      <BackgroundLivenessChip
        liveness="working"
        liveCount={2}
        waitingCount={1}
        onOpenAgents={onOpenAgents}
        onStop={onStop}
        stopping={false}
      />,
    );
    await page
      .getByRole("button", { name: "2 agents active in the background · 1 waiting" })
      .click();
    expect(onOpenAgents).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    expect(onStop).toHaveBeenCalledOnce();
    await mounted.rerender(
      <BackgroundLivenessChip
        liveness="monitoring"
        liveCount={0}
        onStop={onStop}
        stopping={true}
      />,
    );
    await expect
      .element(page.getByRole("status", { name: "Monitoring in the background" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  });

  it("opens ordered commands and output within Agents, then returns to the roster", async () => {
    const activities = [
      {
        id: EventId.make("spawn"),
        kind: "task.started",
        payload: { taskId: "child", agentKind: "agent", status: "running" },
        sequence: 1,
      },
      {
        id: EventId.make("tool"),
        kind: "tool.completed",
        payload: {
          agentId: "child",
          itemType: "command_execution",
          title: "Bash",
          status: "completed",
          data: {
            toolCallId: "cmd",
            command: "cat README.md",
            rawOutput: "Documentation contents",
          },
        },
        sequence: 2,
      },
    ].map((activity) =>
      Object.assign(activity, {
        createdAt: "2026-08-10T10:00:00.000Z",
        summary: "Agent activity",
        tone: "tool" as const,
        turnId: null,
      }),
    );
    mounted = await render(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel
          model={deriveAgentPanelModel({ agents: [agent("child", { status: "waiting" })] })}
          subagents={deriveThreadSubagents(activities)}
        />
      </div>,
    );
    await page.getByRole("button", { name: /Open .*Waiting/ }).click();
    await expect.element(page.getByRole("button", { name: "All agents" })).toBeVisible();
    expect(document.querySelectorAll("[data-agent-tool]")).toHaveLength(1);
    await page.getByText("Read", { exact: false }).first().click();
    await expect.element(page.getByText("Documentation contents", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "All agents" }).click();
    expect(rowIds()).toEqual(["child"]);
  });

  it("keeps fixed role-aware rows in spawn order while live state changes", async () => {
    const onOpenAgent = vi.fn();
    const reviewer = agent("reviewer-1", {
      title: "Review reconnect handling",
      role: "code-reviewer",
      progress: "Inspecting the resume handshake",
      firstSeenAt: "2026-08-10T10:00:00.000Z",
    });
    const verifier = agent("verifier-1", {
      title: "Verify queued interruption",
      role: "release-verifier",
      progress: "Running the provider fixture",
      firstSeenAt: "2026-08-10T10:00:01.000Z",
    });

    mounted = await render(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel
          model={deriveAgentPanelModel({ agents: [verifier, reviewer] })}
          onOpenAgent={onOpenAgent}
        />
      </div>,
    );

    expect(rowIds()).toEqual(["reviewer-1", "verifier-1"]);
    await expect.element(page.getByText("Code Reviewer", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Release Verifier", { exact: true })).toBeVisible();
    const initialHeights = [...document.querySelectorAll<HTMLElement>("[data-agent-row]")].map(
      (row) => row.getBoundingClientRect().height,
    );
    expect(initialHeights.every((height) => Math.abs(height - 72) <= 1)).toBe(true);

    await mounted.rerender(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel
          model={deriveAgentPanelModel({
            agents: [
              { ...verifier, usage: { totalTokens: 12_500 }, updatedAt: "2026-08-10T10:01:10Z" },
              {
                ...reviewer,
                status: "completed",
                result: "Reconnect behavior is sound",
                usage: { totalTokens: 8_400, toolUses: 7 },
                completedAt: "2026-08-10T10:01:00.000Z",
                updatedAt: "2026-08-10T10:01:00.000Z",
              },
            ],
          })}
          onOpenAgent={onOpenAgent}
        />
      </div>,
    );

    expect(rowIds()).toEqual(["reviewer-1", "verifier-1"]);
    const updatedHeights = [...document.querySelectorAll<HTMLElement>("[data-agent-row]")].map(
      (row) => row.getBoundingClientRect().height,
    );
    expect(updatedHeights).toEqual(initialHeights);
    await page.getByText("Reconnect behavior is sound", { exact: true }).click();
    expect(onOpenAgent).toHaveBeenCalledWith("reviewer-1");
  });

  it("preserves workflow expansion across member updates and settlement", async () => {
    const workflow = agent("workflow-1", {
      kind: "workflow",
      title: "Release readiness",
      workflowName: "Release readiness",
      phases: [{ index: 0, title: "Review" }],
    });
    const reviewer = agent("workflow-1:wf:0", {
      kind: "workflow_agent",
      role: "reviewer",
      title: "Review lifecycle fixes",
      parentAgentId: workflow.id,
      agentIndex: 0,
      phaseIndex: 0,
      phaseTitle: "Review",
    });

    mounted = await render(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel model={deriveAgentPanelModel({ agents: [workflow, reviewer] })} />
      </div>,
    );

    await page.getByRole("button", { name: "Collapse workflow" }).click();
    await expect
      .element(page.getByRole("button", { name: "Collapse workflow" }))
      .not.toBeInTheDocument();

    await mounted.rerender(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel
          model={deriveAgentPanelModel({
            agents: [{ ...workflow, updatedAt: "2026-08-10T10:02:00.000Z" }, reviewer],
          })}
        />
      </div>,
    );
    await expect
      .element(page.getByRole("button", { name: "Collapse workflow" }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: /Release readiness/ }).click();
    await expect.element(page.getByRole("button", { name: "Collapse workflow" })).toBeVisible();

    await mounted.rerender(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel
          model={deriveAgentPanelModel({
            agents: [
              {
                ...workflow,
                status: "completed",
                completedAt: "2026-08-10T10:03:00.000Z",
              },
              {
                ...reviewer,
                status: "completed",
                completedAt: "2026-08-10T10:02:30.000Z",
              },
            ],
          })}
        />
      </div>,
    );
    await expect.element(page.getByRole("button", { name: "Collapse workflow" })).toBeVisible();
  });

  it("shows every future workflow phase as pending until its agent slot arrives", async () => {
    const workflow = agent("workflow-sequential", {
      kind: "workflow",
      title: "Work, review, verify",
      workflowName: "Work, review, verify",
      phases: [
        { index: 1, title: "Work" },
        { index: 2, title: "Review" },
        { index: 3, title: "Verify" },
      ],
    });
    const worker = agent("workflow-sequential:wf:1", {
      kind: "workflow_agent",
      title: "Implement the change",
      parentAgentId: workflow.id,
      agentIndex: 1,
      phaseIndex: 1,
      phaseTitle: "Work",
    });

    mounted = await render(
      <div className="h-[520px] w-[440px]">
        <AgentsPanel model={deriveAgentPanelModel({ agents: [workflow, worker] })} />
      </div>,
    );

    await expect.element(page.getByLabelText("Review pending")).toBeVisible();
    await expect.element(page.getByLabelText("Verify pending")).toBeVisible();
    expect(
      [...document.querySelectorAll<HTMLElement>("[data-workflow-pending-step]")].map(
        (row) => row.dataset.phaseTitle,
      ),
    ).toEqual(["Review", "Verify"]);

    const reviewer = agent("workflow-sequential:wf:2", {
      kind: "workflow_agent",
      title: "Review the change",
      status: "pending",
      parentAgentId: workflow.id,
      agentIndex: 2,
      phaseIndex: 2,
      phaseTitle: "Review",
      startedAt: null,
    });
    await mounted.rerender(
      <div className="h-[520px] w-[440px]">
        <AgentsPanel model={deriveAgentPanelModel({ agents: [workflow, worker, reviewer] })} />
      </div>,
    );

    await expect.element(page.getByLabelText("Review pending")).not.toBeInTheDocument();
    await expect.element(page.getByLabelText("Verify pending")).toBeVisible();
    expect(rowIds()).toEqual([worker.id, reviewer.id]);
  });
});
