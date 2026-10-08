import "../../../../index.css";

import type { ReactNode } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { CROWN_FLYOUT_WIDTH_PX } from "../crownLayout";
import type { CrownSectionDetailProps } from "../crownTypes";
import { CrownSectionDetail } from "./CrownSectionDetail";
import {
  crownLayoutFixture,
  crownPullRequestFixture,
  makeAgentPanelModel,
  makeLayout,
  makeWorkflowMember,
} from "../crownTestFixtures";
import { makeRuntimeAgent } from "../../../agents/agentRosterTestFixtures";

const hosts: HTMLElement[] = [];

/** Mounts a detail inside a flyout-sized box (272px with the prototype's 14px padding). */
async function mountDetail(props: CrownSectionDetailProps) {
  const host = document.createElement("div");
  host.style.width = `${CROWN_FLYOUT_WIDTH_PX}px`;
  host.style.padding = "14px";
  host.style.boxSizing = "border-box";
  document.body.append(host);
  hosts.push(host);
  return render(<CrownSectionDetail {...props} />, { container: host });
}

/**
 * Records whether the app prevented a click's default action, then prevents it
 * anyway so tests never navigate or open tabs. Window bubble listeners run
 * after React's root listener.
 */
function guardLinkClicks() {
  const state = { preventedByApp: null as boolean | null };
  const guard = (event: MouseEvent) => {
    state.preventedByApp = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener("click", guard);
  return { state, dispose: () => window.removeEventListener("click", guard) };
}

function BranchControlStub(): ReactNode {
  return <button type="button" className="flex h-9 w-full items-center px-3" aria-label="Branch" />;
}

describe("CrownSectionDetail interactions", () => {
  afterEach(() => {
    for (const host of hosts.splice(0)) host.remove();
  });

  it("opens the review from the Changes detail", async () => {
    const onOpenReview = vi.fn();
    await mountDetail({
      section: "changes",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture({ onOpenReview }),
    });

    await page.getByRole("button", { name: "Open review" }).click();
    expect(onOpenReview).toHaveBeenCalledTimes(1);
  });

  it("opens agents and their workflow run from the Subagents detail", async () => {
    const onOpenAgent = vi.fn();
    const onOpenAgentsWorkflow = vi.fn();
    const layout = crownLayoutFixture({ onOpenAgent, onOpenAgentsWorkflow });
    await mountDetail({ section: "agents", variant: "flyout", isGitRepo: true, layout });

    await page.getByRole("button", { name: "Open work:types transcript. Failed." }).click();
    expect(onOpenAgent).toHaveBeenLastCalledWith("wf-audit:types");
    await page.getByRole("button", { name: "Open Scout transcript. Running." }).click();
    expect(onOpenAgent).toHaveBeenLastCalledWith("agent-scout");

    await page.getByRole("button", { name: "Open Audit in Agents, Review · 1 working" }).click();
    await page.getByRole("button", { name: "Show all 4 agents of Audit in Agents" }).click();
    expect(onOpenAgentsWorkflow.mock.calls).toEqual([["wf-audit"], ["wf-audit"]]);
    expect(onOpenAgent).toHaveBeenCalledTimes(2);
  });

  it("fits the workflow card into the flyout with fixed 30px member rows", async () => {
    const { container } = await mountDetail({
      section: "agents",
      variant: "flyout",
      isGitRepo: true,
      layout: crownLayoutFixture({ onOpenAgent: () => {} }),
    });
    const card = container.querySelector<HTMLElement>('[data-slot="crown-workflow-card"]')!;
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-agent-row]")];
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.getBoundingClientRect().height).toBe(30);
    // Three equal phase columns, each a 4px bar.
    const bars = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-slot="crown-workflow-phase"] > span[aria-hidden]',
      ),
    ];
    expect(bars.map((bar) => bar.getBoundingClientRect().height)).toEqual([4, 4, 4]);
    const widths = new Set(bars.map((bar) => Math.round(bar.getBoundingClientRect().width)));
    expect(widths.size).toBe(1);
    await expect.element(page.getByRole("list", { name: "Phases" })).toBeVisible();
    // Running dots share the running phase fill's agent sky.
    const runningDot = container.querySelector<HTMLElement>(
      '[data-agent-id="wf-audit:card"] .rounded-full',
    )!;
    const runningFill = container.querySelector<HTMLElement>(
      '[data-tone="running"] [data-slot="crown-workflow-phase-fill"]',
    )!;
    expect(getComputedStyle(runningDot).backgroundColor).toBe(
      getComputedStyle(runningFill).backgroundColor,
    );
  });

  it("keeps every phase's member dots inside its own column, however many phases", async () => {
    const phases = Array.from({ length: 8 }, (_, index) => ({ index, title: `P${index}` }));
    const agents = [
      makeRuntimeAgent("wf-wide", { kind: "workflow", workflowName: "Big sweep", phases }),
      ...phases.flatMap((phase) =>
        Array.from({ length: phase.index === 2 ? 9 : 2 }, (_, member) =>
          makeWorkflowMember(`wf-wide:${phase.index}:${member}`, "wf-wide", phase.index, {
            agentIndex: phase.index * 10 + member,
          }),
        ),
      ),
    ];
    for (const count of [8, 4]) {
      const { container, unmount } = await mountDetail({
        section: "agents",
        variant: "flyout",
        isGitRepo: true,
        layout: makeLayout({
          agentPanelModel: makeAgentPanelModel(
            agents.flatMap((agent) => {
              if (agent.kind === "workflow") {
                return [{ ...agent, phases: phases.slice(0, count) }];
              }
              return (agent.phaseIndex ?? 0) < count ? [agent] : [];
            }),
          ),
        }),
      });
      const cells = [
        ...container.querySelectorAll<HTMLElement>(
          '[data-slot="crown-workflow-phase"] > :last-child',
        ),
      ];
      expect(cells).toHaveLength(count);
      for (const cell of cells) expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth);
      // The name keeps priority over the header meta and is never hidden.
      const name = container.querySelector<HTMLElement>('[title="Big sweep"]')!;
      expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
      await unmount();
    }
  });

  it("lines the Checks heading count up with the rows' meta", async () => {
    const { container } = await mountDetail({
      section: "checks",
      variant: "flyout",
      isGitRepo: true,
      layout: crownLayoutFixture({ onOpenPullRequestCheck: vi.fn() }),
    });
    const heading = container.querySelector<HTMLElement>('[data-slot="crown-detail-heading"]')!;
    // The innermost span holding the count: its text, not its padding.
    const count = [...heading.querySelectorAll<HTMLElement>("span")].findLast(
      (span) => span.textContent === "1/4",
    )!;
    const range = document.createRange();
    range.selectNodeContents(count);
    const countRight = range.getBoundingClientRect().right;
    const meta = page.getByText("14s", { exact: true }).element();
    expect(Math.abs(meta.getBoundingClientRect().right - countRight)).toBeLessThanOrEqual(1);
  });

  it("opens the pull request in Ryco on a plain click and leaves modified clicks to the link", async () => {
    const onOpenPullRequestInApp = vi.fn();
    const guard = guardLinkClicks();
    try {
      await mountDetail({
        section: "pr",
        variant: "card",
        isGitRepo: true,
        layout: crownLayoutFixture({ onOpenPullRequestInApp }),
      });
      const link = page.getByRole("link", { name: "Open in Ryco" });
      await expect.element(link).toHaveAttribute("href", crownPullRequestFixture.url!);
      await expect.element(link).toHaveAttribute("target", "_blank");
      await expect.element(link).toHaveAttribute("rel", "noreferrer");

      await link.click();
      expect(guard.state.preventedByApp).toBe(true);
      expect(onOpenPullRequestInApp).toHaveBeenCalledTimes(1);

      // ⌘/Ctrl-click keeps the host link: the app neither intercepts nor handles it.
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        guard.state.preventedByApp = null;
        link
          .element()
          .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }));
        expect(guard.state.preventedByApp).toBe(false);
      }
      expect(onOpenPullRequestInApp).toHaveBeenCalledTimes(1);
    } finally {
      guard.dispose();
    }
  });

  it("falls back to a plain button when the pull request has no host URL", async () => {
    const onOpenPullRequestInApp = vi.fn();
    const { url: _url, ...pullRequest } = crownPullRequestFixture;
    await mountDetail({
      section: "pr",
      variant: "flyout",
      isGitRepo: true,
      layout: crownLayoutFixture({ pullRequest, onOpenPullRequestInApp }),
    });

    await page.getByRole("button", { name: "Open in Ryco" }).click();
    expect(onOpenPullRequestInApp).toHaveBeenCalledTimes(1);
  });

  it("opens a check in Ryco on a plain click and leaves modified clicks to the host link", async () => {
    const onOpenPullRequestCheck = vi.fn();
    const guard = guardLinkClicks();
    try {
      const layout = crownLayoutFixture({ onOpenPullRequestCheck });
      await mountDetail({ section: "checks", variant: "flyout", isGitRepo: true, layout });
      const link = page.getByRole("link", { name: "Typecheck, Failed" });
      await expect
        .element(link)
        .toHaveAttribute("href", "https://github.com/ryco/ryco/actions/runs/2");
      await expect.element(link).toHaveAttribute("target", "_blank");

      await link.click();
      expect(guard.state.preventedByApp).toBe(true);
      expect(onOpenPullRequestCheck).toHaveBeenCalledTimes(1);
      expect(onOpenPullRequestCheck).toHaveBeenCalledWith(crownPullRequestFixture.latestRuns[1]);

      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        guard.state.preventedByApp = null;
        link
          .element()
          .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }));
        expect(guard.state.preventedByApp).toBe(false);
      }
      expect(onOpenPullRequestCheck).toHaveBeenCalledTimes(1);
    } finally {
      guard.dispose();
    }
  });

  it("makes a URL-less check a button when it opens in Ryco", async () => {
    const onOpenPullRequestCheck = vi.fn();
    await mountDetail({
      section: "checks",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture({ onOpenPullRequestCheck }),
    });

    await page.getByRole("button", { name: "Unit tests, Running, Test / Run vitest" }).click();
    expect(onOpenPullRequestCheck).toHaveBeenCalledWith(crownPullRequestFixture.latestRuns[2]);
  });

  it("keeps plain host links for checks without an in-app opener", async () => {
    const guard = guardLinkClicks();
    try {
      await mountDetail({
        section: "checks",
        variant: "card",
        isGitRepo: true,
        layout: crownLayoutFixture(),
      });

      await page.getByRole("link", { name: "Format, Succeeded, 14s" }).click();
      expect(guard.state.preventedByApp).toBe(false);
      await expect
        .element(page.getByRole("button", { name: "Unit tests, Running, Test / Run vitest" }))
        .not.toBeInTheDocument();
    } finally {
      guard.dispose();
    }
  });

  it("reveals a check row's affordance on hover and keyboard focus", async () => {
    await mountDetail({
      section: "checks",
      variant: "flyout",
      isGitRepo: true,
      layout: crownLayoutFixture({ onOpenPullRequestCheck: vi.fn() }),
    });
    const link = page.getByRole("link", { name: "Format, Succeeded, 14s" });
    const affordance = () =>
      link.element().querySelector<SVGElement>('[data-slot="crown-check-affordance"]')!;
    const opacity = () => Number(getComputedStyle(affordance()).opacity);

    expect(opacity()).toBe(0);
    await link.hover();
    await expect.poll(opacity).toBe(1);
    await page.getByRole("button", { name: "Unit tests, Running, Test / Run vitest" }).hover();
    await expect.poll(opacity).toBe(0);
    // Keyboard focus shows it too (focus-visible), along with the focus ring.
    (link.element() as HTMLElement).focus({ focusVisible: true } as FocusOptions);
    await expect.poll(opacity).toBe(1);
    expect(getComputedStyle(link.element()).outlineStyle).not.toBe("none");
  });

  it("names the plan actions menu for the overview", async () => {
    await mountDetail({
      section: "plan",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture(),
    });

    await expect
      .element(page.getByRole("button", { name: "Overview plan actions" }))
      .toBeInTheDocument();
  });

  it("keeps the pre-rendered branch picker at its 36px row height and full width", async () => {
    await mountDetail({
      section: "branch",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture({ branchControl: <BranchControlStub /> }),
    });

    const picker = page.getByRole("button", { name: "Branch" }).element();
    const rect = picker.getBoundingClientRect();
    expect(rect.height).toBe(36);
    expect(rect.width).toBeGreaterThan(200);
  });
});
