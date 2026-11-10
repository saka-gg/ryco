import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { deriveAgentPanelModel, type AgentPanelModel } from "../../threadWorkspaceViewModel";
import { makeRuntimeAgent } from "../agents/agentRosterTestFixtures";
import { AgentSpawnRow } from "./AgentSpawnRow";

function Harness(props: {
  model: AgentPanelModel;
  onOpenAgents: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="w-[640px]">
      <AgentSpawnRow
        spawn={{ workflowId: null, agentTaskIds: ["a", "b"] }}
        model={props.model}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onOpenAgents={props.onOpenAgents}
        onOpenAgent={props.onOpenAgent}
      />
    </div>
  );
}

/** The marker's one line, without its monograms. */
const markerText = () =>
  document.querySelector("[data-agent-spawn-row] button .truncate")?.textContent;

describe("AgentSpawnRow", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount().catch(() => {});
    mounted = null;
    document.body.innerHTML = "";
  });

  it("reads as finished with its cost once settled, and calls out failures", async () => {
    const model = deriveAgentPanelModel({
      agents: [
        makeRuntimeAgent("a", {
          title: "fix:window-capture",
          status: "completed",
          usage: { totalTokens: 1_300_000 },
        }),
        makeRuntimeAgent("b", { title: "fix:paste-recall", status: "failed" }),
      ],
    });

    mounted = await render(<Harness model={model} onOpenAgents={vi.fn()} onOpenAgent={vi.fn()} />);

    const row = page.getByRole("button", { name: /2 subagents finished/ });
    await expect.element(row).toBeVisible();
    expect(markerText()).toBe(
      "2 subagents finished · fix:window-capture, fix:paste-recall · 1 failed · 1.3M tok",
    );
  });

  it("shows the latest action, expands in place and opens one agent", async () => {
    const onOpenAgents = vi.fn();
    const onOpenAgent = vi.fn();
    const model = deriveAgentPanelModel({
      agents: [
        makeRuntimeAgent("a", {
          title: "Trace t3code worktree flow",
          progress: "Running Show repo HEAD",
          updatedAt: "2026-08-10T10:00:05.000Z",
        }),
        makeRuntimeAgent("b", {
          title: "Trace Ryco worktree flow",
          progress: "Reading ComposerPrimaryActions.tsx",
          firstSeenAt: "2026-08-10T10:00:01.000Z",
          updatedAt: "2026-08-10T10:00:09.000Z",
        }),
      ],
    });

    mounted = await render(
      <Harness model={model} onOpenAgents={onOpenAgents} onOpenAgent={onOpenAgent} />,
    );

    const row = page.getByRole("button", { name: /Kicked off 2 subagents/ });
    await expect.element(row).toBeVisible();
    // One line: what started and how many still work; who acted last is the tooltip.
    expect(markerText()).toBe("Kicked off 2 subagents · 2 working");
    expect(row.element().getAttribute("title")).toBe(
      "Trace Ryco worktree flow · Reading ComposerPrimaryActions.tsx",
    );
    expect(row.element().getBoundingClientRect().height).toBeLessThanOrEqual(32);
    expect(document.querySelectorAll("[data-agent-row]")).toHaveLength(0);

    await row.click();
    await expect.element(row).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll("[data-agent-row]")).toHaveLength(2);

    await page.getByRole("button", { name: /Open Trace t3code worktree flow/ }).click();
    expect(onOpenAgent).toHaveBeenCalledWith("a");
    await page.getByRole("button", { name: "Open the Agents panel" }).click();
    expect(onOpenAgents).toHaveBeenCalledOnce();
  });
});
