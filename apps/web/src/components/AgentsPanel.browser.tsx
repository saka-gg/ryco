import "../index.css";

import { EventId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { deriveAgentPanelModel, deriveThreadSubagents } from "../threadWorkspaceViewModel";
import { makeRuntimeAgent } from "./agents/agentRosterTestFixtures";
import { BackgroundLivenessChip } from "./chat/BackgroundLivenessChip";
import { AgentsPanel } from "./AgentsPanel";

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
          model={deriveAgentPanelModel({
            agents: [makeRuntimeAgent("child", { status: "waiting" })],
          })}
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
    const reviewer = makeRuntimeAgent("reviewer-1", {
      title: "Review reconnect handling",
      role: "code-reviewer",
      progress: "Inspecting the resume handshake",
      firstSeenAt: "2026-08-10T10:00:00.000Z",
    });
    const verifier = makeRuntimeAgent("verifier-1", {
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
    expect(initialHeights.every((height) => Math.abs(height - 40) <= 1)).toBe(true);

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

  it("leads workflow rows with their functional label instead of a codename", async () => {
    const workflow = makeRuntimeAgent("workflow-labels", {
      kind: "workflow",
      title: "Ship it",
      workflowName: "Ship it",
      phases: [{ index: 0, title: "Verify" }],
    });
    const verifier = makeRuntimeAgent("workflow-labels:wf:0", {
      kind: "workflow_agent",
      title: "verify:implementor",
      progress: "Running the focused suite",
      parentAgentId: workflow.id,
      agentIndex: 0,
      phaseIndex: 0,
      phaseTitle: "Verify",
    });

    mounted = await render(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel model={deriveAgentPanelModel({ agents: [workflow, verifier] })} />
      </div>,
    );

    const row = document.querySelector<HTMLElement>(`[data-agent-id="${verifier.id}"]`);
    expect(row?.textContent).toContain("verify:implementor");
    expect(row?.textContent).toContain("Running the focused suite");
    expect(row?.querySelector('[title="verify:implementor"]')?.textContent).toBe(
      "verify:implementor",
    );
    // Model and token metadata belong to the detail view, not the row.
    expect(row?.textContent).not.toContain("tok");
    expect(row?.textContent).not.toContain("gpt-5.6-sol");
  });

  it("names quiet statuses in the row and tells same-labelled agents apart", async () => {
    const first = makeRuntimeAgent("explore-1", {
      title: "Explore",
      status: "interrupted",
      progress: "Reading",
    });
    const second = makeRuntimeAgent("explore-2", {
      title: "Explore",
      status: "failed",
      error: "Boom",
      firstSeenAt: "2026-08-10T10:00:01.000Z",
    });
    mounted = await render(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel model={deriveAgentPanelModel({ agents: [first, second] })} />
      </div>,
    );
    const rows = [...document.querySelectorAll<HTMLElement>("[data-agent-row]")];
    expect(rows[0]?.textContent).toContain("Interrupted");
    expect(rows[1]?.textContent).toContain("Failed");
    expect(rows[1]?.textContent).toContain("Explore 2");
    expect(rows[0]?.textContent).not.toContain("Explore 2");
  });

  it("preserves workflow expansion across member updates and settlement", async () => {
    const workflow = makeRuntimeAgent("workflow-1", {
      kind: "workflow",
      title: "Release readiness",
      workflowName: "Release readiness",
      phases: [{ index: 0, title: "Review" }],
    });
    const reviewer = makeRuntimeAgent("workflow-1:wf:0", {
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

    const header = page.getByRole("button", { name: /Release readiness/ });
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    await header.click();
    await expect.element(header).toHaveAttribute("aria-expanded", "false");

    await mounted.rerender(
      <div className="h-[420px] w-[440px]">
        <AgentsPanel
          model={deriveAgentPanelModel({
            agents: [{ ...workflow, updatedAt: "2026-08-10T10:02:00.000Z" }, reviewer],
          })}
        />
      </div>,
    );
    await expect.element(header).toHaveAttribute("aria-expanded", "false");

    await header.click();
    await expect.element(header).toHaveAttribute("aria-expanded", "true");

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
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
  });

  it("shows every future workflow phase as pending until its agent slot arrives", async () => {
    const workflow = makeRuntimeAgent("workflow-sequential", {
      kind: "workflow",
      title: "Work, review, verify",
      workflowName: "Work, review, verify",
      phases: [
        { index: 1, title: "Work" },
        { index: 2, title: "Review" },
        { index: 3, title: "Verify" },
      ],
    });
    const worker = makeRuntimeAgent("workflow-sequential:wf:1", {
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

    const reviewer = makeRuntimeAgent("workflow-sequential:wf:2", {
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

  it("lands a workflow focus once per request: expands, scrolls, flashes, re-triggers", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const live = makeRuntimeAgent("workflow-live", {
      kind: "workflow",
      title: "Live sweep",
      workflowName: "Live sweep",
    });
    const settled = makeRuntimeAgent("workflow-settled", {
      kind: "workflow",
      title: "Settled audit",
      workflowName: "Settled audit",
      status: "completed",
      completedAt: "2026-08-10T10:05:00.000Z",
      firstSeenAt: "2026-08-10T10:00:01.000Z",
    });
    const member = makeRuntimeAgent("workflow-settled:wf:0", {
      kind: "workflow_agent",
      title: "audit:files",
      status: "completed",
      parentAgentId: settled.id,
      agentIndex: 0,
      completedAt: "2026-08-10T10:04:00.000Z",
    });
    const model = deriveAgentPanelModel({ agents: [live, settled, member] });
    const onFocusWorkflowHandled = vi.fn();
    const panel = (focusWorkflowId: string | null) => (
      <div className="h-[420px] w-[440px]">
        <AgentsPanel
          model={model}
          focusWorkflowId={focusWorkflowId}
          onFocusWorkflowHandled={onFocusWorkflowHandled}
        />
      </div>
    );
    const section = () =>
      [...document.querySelectorAll<HTMLElement>("[data-workflow-section]")].find((element) =>
        element.textContent?.includes("Settled audit"),
      )!;
    const header = page.getByRole("button", { name: /Settled audit/ });

    try {
      mounted = await render(panel(null));
      // A settled workflow starts collapsed.
      await expect.element(header).toHaveAttribute("aria-expanded", "false");
      expect(onFocusWorkflowHandled).not.toHaveBeenCalled();

      await mounted.rerender(panel(settled.id));
      await expect.element(header).toHaveAttribute("aria-expanded", "true");
      await vi.waitFor(() => {
        expect(scrollIntoView.mock.contexts).toContain(section());
      });
      await vi.waitFor(() => {
        expect(section().firstElementChild?.className).toMatch(/\blanding-flash/);
      });
      expect(onFocusWorkflowHandled).toHaveBeenCalledOnce();
      // The live workflow is neither scrolled to nor flashed.
      expect(document.querySelectorAll(".landing-flash, .landing-flash-static")).toHaveLength(1);

      // The same value does not land again; the owner clears it, then a repeat
      // request re-expands and re-scrolls.
      await mounted.rerender(panel(settled.id));
      expect(onFocusWorkflowHandled).toHaveBeenCalledOnce();
      await header.click();
      await expect.element(header).toHaveAttribute("aria-expanded", "false");
      await mounted.rerender(panel(null));
      const scrollsBefore = scrollIntoView.mock.calls.length;
      await mounted.rerender(panel(settled.id));
      await expect.element(header).toHaveAttribute("aria-expanded", "true");
      await vi.waitFor(() => {
        expect(scrollIntoView.mock.calls.length).toBeGreaterThan(scrollsBefore);
      });
      expect(onFocusWorkflowHandled).toHaveBeenCalledTimes(2);
    } finally {
      scrollIntoView.mockRestore();
    }
  });
});
