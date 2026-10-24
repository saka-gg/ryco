import "../../../../index.css";
// The feature stylesheet loads with its page or dialog chunk in the app.
import "../../overview.css";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SubagentStopAction } from "@ryco/client-runtime/state/session/subagentStop";
import { EnvironmentId, ThreadId, WorktreeId } from "@ryco/contracts";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { PaneFocusContext } from "../../../chat/PaneFocus";
import { CROWN_FLYOUT_CLOSE_DELAY_MS, CROWN_FLYOUT_WIDTH_PX } from "../crownLayout";
import type { CrownOverviewProps, CrownSectionDetailProps, CrownShipBinding } from "../crownTypes";
import { CrownOverview } from "../CrownOverview";
import { CrownSectionDetail } from "./CrownSectionDetail";
import {
  auditWorkflowAgents,
  crownDirectAgents,
  crownLayoutFixture,
  crownPullRequestFixture,
  makeAgentPanelModel,
  makeLayout,
  makeWorkflowMember,
} from "../crownTestFixtures";
import { makeRuntimeAgent } from "../../../agents/agentRosterTestFixtures";
import { agentStopRequests } from "../../../agents/agentStopRequests";

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

function stopLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button[aria-label^='Stop']")].map(
    (button) => button.getAttribute("aria-label") ?? "",
  );
}

function BranchControlStub(): ReactNode {
  return <button type="button" className="flex h-9 w-full items-center px-3" aria-label="Branch" />;
}

describe("CrownSectionDetail interactions", () => {
  afterEach(() => {
    for (const host of hosts.splice(0)) host.remove();
    agentStopRequests.clear();
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

  it("offers Stop on live direct agents in the Subagents detail, never on workflow members", async () => {
    const stop = vi.fn<SubagentStopAction["stop"]>(() => Promise.resolve());
    // One thread per variant: a stop the node took stays pending for every
    // control of that agent, so a second surface on the same thread shows it.
    const stopAgentFor = (variant: string): SubagentStopAction => ({
      threadRef: scopeThreadRef(
        EnvironmentId.make("environment-local"),
        ThreadId.make(`thread-${variant}`),
      ),
      runtimeSessionId: "rt-1",
      unavailableReason: null,
      stop,
    });
    const onOpenAgent = vi.fn();
    // Every row carries the current runtime's stop flag, as an older server
    // also sends it on workflow members (the running "review:card" here).
    const agentPanelModel = makeAgentPanelModel(
      [...auditWorkflowAgents(), ...crownDirectAgents()].map((agent) =>
        Object.assign(agent, { runtimeSessionId: "rt-1", canStop: true }),
      ),
    );

    for (const variant of ["card", "flyout"] as const) {
      const { container, unmount } = await mountDetail({
        section: "agents",
        variant,
        isGitRepo: true,
        layout: crownLayoutFixture({
          agentPanelModel,
          onOpenAgent,
          stopAgent: stopAgentFor(variant),
        }),
      });
      expect(stopLabels()).toEqual(["Stop Scout"]);
      // With Stop beside it, the row still takes 30px, its divider included.
      const scoutRow = container.querySelector('[data-agent-id="agent-scout"]')!.parentElement!;
      expect(scoutRow.getBoundingClientRect().height).toBe(30);
      // Stop takes pointer events once its row is hovered (always, on a device
      // that can't hover), so the same steps reach it on any runner.
      await page.getByRole("button", { name: "Open Scout transcript. Running." }).hover();
      await page.getByRole("button", { name: "Stop Scout" }).click();
      expect(stop).toHaveBeenLastCalledWith({
        taskId: "agent-scout",
        runtimeSessionId: "rt-1",
        attempt: 0,
      });
      await unmount();
    }
    expect(stop).toHaveBeenCalledTimes(2);
    expect(onOpenAgent).not.toHaveBeenCalled();

    // Without a stop action the rows are the roster's own, with nothing beside them.
    const { container } = await mountDetail({
      section: "agents",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture({ agentPanelModel, onOpenAgent }),
    });
    expect(stopLabels()).toEqual([]);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-agent-row]")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.parentElement?.classList.contains("group/agent-row"))).toBe(
      false,
    );
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
      '[data-agent-id="wf-audit:card"] [data-slot="agent-status-badge"]',
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

  it("opens the shown pull request without a number, even from the plain button", async () => {
    const onOpenPullRequestInApp = vi.fn();
    const { url: _url, ...pullRequest } = crownPullRequestFixture;
    await mountDetail({
      section: "pr",
      variant: "flyout",
      isGitRepo: true,
      layout: crownLayoutFixture({ pullRequest, onOpenPullRequestInApp }),
    });

    await page.getByRole("button", { name: "Open in Ryco" }).click();
    // The click event must never travel as a pull request number to pin.
    expect(onOpenPullRequestInApp).toHaveBeenCalledWith();
  });

  it("opens another of the workspace's pull requests in Ryco by its number", async () => {
    const onOpenPullRequestInApp = vi.fn();
    const guard = guardLinkClicks();
    try {
      await mountDetail({
        section: "pr",
        variant: "flyout",
        isGitRepo: true,
        layout: crownLayoutFixture({
          onOpenPullRequestInApp,
          otherPullRequests: [
            {
              number: 690,
              title: "Follow-up",
              url: "https://github.com/ryco/ryco/pull/690",
              state: "open",
              isDraft: false,
              terminalAt: null,
              headRefName: "feature/follow-up",
              baseRefName: "main",
              source: "manual",
              linkedAt: "2026-10-01T09:00:00.000Z",
              dismissedAt: null,
            },
          ],
        }),
      });
      const row = page.getByRole("link", { name: /#690/ });
      await row.click();
      expect(guard.state.preventedByApp).toBe(true);
      expect(onOpenPullRequestInApp).toHaveBeenCalledWith(690);

      guard.state.preventedByApp = null;
      row
        .element()
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
      expect(guard.state.preventedByApp).toBe(false);
      expect(onOpenPullRequestInApp).toHaveBeenCalledTimes(1);
    } finally {
      guard.dispose();
    }
  });

  it("offers linking a pull request in the card, with or without one shown", async () => {
    const linking = {
      environmentId: EnvironmentId.make("environment-local"),
      worktreeId: WorktreeId.make("worktree-crown"),
      cwd: "/repo/ryco",
      workspaceTitle: "Crown",
      workspaceBranch: "feature/crown",
      links: [],
      storedNumbers: new Set<number>(),
      shownNumber: null,
      canEdit: true,
      onOpenPullRequest: vi.fn(),
    };
    const empty = await mountDetail({
      section: "pr",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture({ pullRequest: null, pullRequestLinking: linking }),
    });
    await expect.element(empty.getByRole("button", { name: "Link pull request…" })).toBeEnabled();

    const shown = await mountDetail({
      section: "pr",
      variant: "card",
      isGitRepo: true,
      layout: crownLayoutFixture({ pullRequestLinking: { ...linking, canEdit: false } }),
    });
    await expect.element(shown.getByRole("button", { name: "Link another…" })).toBeDisabled();

    // The hover preview stays read-only.
    const preview = await mountDetail({
      section: "pr",
      variant: "flyout",
      isGitRepo: true,
      layout: crownLayoutFixture({ pullRequest: null, pullRequestLinking: linking }),
    });
    expect(preview.container.textContent).not.toContain("Link pull request");
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
    // The hover reveal is `(hover: hover)`-gated CSS (Tailwind v4). Linux
    // headless reports `hover: none` once any earlier file in the shared
    // browser cycles touch emulation (see test/browserPointer.ts), so the
    // hover path only runs where the environment is hover-capable.
    if (window.matchMedia("(hover: hover)").matches) {
      await link.hover();
      await expect.poll(opacity).toBe(1);
      await page.getByRole("button", { name: "Unit tests, Running, Test / Run vitest" }).hover();
      await expect.poll(opacity).toBe(0);
    }
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

/** A Ship binding whose calls the tests can read, with plan and run state to set. */
function makeShip(overrides: Partial<CrownShipBinding> = {}): CrownShipBinding & {
  readonly calls: { ship: number; messages: string[] };
} {
  const calls = { ship: 0, messages: [] as string[] };
  return {
    steps: ["commit", "push", "pr"],
    label: "Commit, push & create PR",
    disabledReason: null,
    changeRequestLabel: "PR",
    phase: "idle",
    runSteps: [],
    activeStep: null,
    stepDetails: { pull: "2 incoming", commit: "3 files", push: "to origin", pr: "for review" },
    ship: () => {
      calls.ship += 1;
    },
    commitMessage: "",
    setCommitMessage: (message) => {
      calls.messages.push(message);
    },
    commitOnly: null,
    pull: null,
    openPullRequest: null,
    ...overrides,
    calls,
  };
}

describe("Crown Ship button", () => {
  const mounts: Array<{ unmount: () => Promise<void> | void; host: HTMLElement }> = [];

  afterEach(async () => {
    for (const mount of mounts.splice(0).toReversed()) {
      await mount.unmount();
      mount.host.remove();
    }
  });

  async function mountCrown(ship: CrownShipBinding) {
    await page.viewport(1200, 800);
    const host = document.createElement("div");
    host.style.position = "relative";
    host.style.width = "1200px";
    host.style.height = "800px";
    const outside = document.createElement("button");
    outside.type = "button";
    outside.textContent = "Outside";
    outside.style.position = "absolute";
    outside.style.left = "20px";
    outside.style.top = "400px";
    document.body.append(host, outside);
    const props: CrownOverviewProps = {
      ...crownLayoutFixture(),
      threadTitle: "Overview rail",
      readiness: { remoteStatus: true, pullRequestLookup: true },
      isGitRepo: true,
      latestTurn: null,
      turnSettled: true,
      agentRunning: false,
      scopeKey: "thread-1|/repo",
      userGitActionActive: false,
      ship,
    };
    const screen = await render(
      <PaneFocusContext value={true}>
        <CrownOverview {...props} />
      </PaneFocusContext>,
      { container: host },
    );
    mounts.push({ unmount: () => screen.unmount(), host }, { unmount: () => {}, host: outside });
    return {
      root: () => host.querySelector<HTMLElement>('[data-slot="crown-overview"]')!,
      flyout: () => host.querySelector<HTMLElement>('[data-slot="crown-flyout"]')!,
      rerender: (next: CrownShipBinding) =>
        screen.rerender(
          <PaneFocusContext value={true}>
            <CrownOverview {...props} ship={next} />
          </PaneFocusContext>,
        ),
    };
  }

  const pastCloseDelay = () =>
    new Promise((resolve) => setTimeout(resolve, CROWN_FLYOUT_CLOSE_DELAY_MS + 120));

  it("replaces the Branch and Push icons with one Ship button", async () => {
    await mountCrown(makeShip());
    await expect.element(page.getByRole("button", { name: "Ship", exact: true })).toBeVisible();
    expect(document.querySelector('[data-slot="crown-rail"] [data-nav-key="branch"]')).toBeNull();
    const ship = document.querySelector<HTMLElement>(
      '[data-slot="crown-rail"] [data-nav-key="ship"]',
    )!;
    expect(ship.getAttribute("aria-description")).toBe("Commit, push & create PR");
    expect(ship.dataset.ready).toBe("true");
    expect(ship.textContent).toContain("3");
  });

  it("previews what one click runs, and ships on click without opening the card", async () => {
    const binding = makeShip();
    const crown = await mountCrown(binding);
    await page.getByRole("button", { name: "Ship", exact: true }).hover();
    await expect.poll(() => crown.flyout().dataset.open).toBe("true");
    const preview = crown.flyout();
    expect(preview.getAttribute("aria-label")).toBe("Ship preview");
    expect(
      [...preview.querySelectorAll('[data-slot="crown-ship-step"]')].map((row) => row.textContent),
    ).toEqual(["Commit3 files", "Pushto origin", "Create PRfor review"]);
    expect(preview.textContent).toContain("Commit message is written for you");
    expect(preview.textContent).toContain("Click the rocket to ship");

    await page.getByRole("button", { name: "Ship", exact: true }).click();
    expect(binding.calls.ship).toBe(1);
    expect(crown.root().dataset.mode).not.toBe("card");
  });

  it("opens the branch card when there is nothing to ship", async () => {
    const binding = makeShip({ steps: [], label: "Nothing to ship", disabledReason: "Up to date" });
    const crown = await mountCrown(binding);
    const ship = document.querySelector<HTMLElement>(
      '[data-slot="crown-rail"] [data-nav-key="ship"]',
    )!;
    expect(ship.dataset.ready).toBeUndefined();
    await page.getByRole("button", { name: "Ship", exact: true }).click();
    expect(binding.calls.ship).toBe(0);
    await expect.poll(() => crown.root().dataset.mode).toBe("card");
    expect(crown.root().querySelector(".crown-card-title")?.textContent).toBe("Branch");
  });

  it("shows the run's progress in the preview and on the icon", async () => {
    const crown = await mountCrown(makeShip());
    await page.getByRole("button", { name: "Ship", exact: true }).hover();
    await expect.poll(() => crown.flyout().dataset.open).toBe("true");
    await crown.rerender(
      makeShip({ phase: "running", runSteps: ["commit", "push", "pr"], activeStep: "push" }),
    );
    await expect
      .poll(() =>
        [...crown.flyout().querySelectorAll<HTMLElement>('[data-slot="crown-ship-step"]')].map(
          (row) => row.dataset.state,
        ),
      )
      .toEqual(["done", "now", "todo"]);
    expect(crown.flyout().querySelector('[data-slot="crown-ship-hint"]')).toBeNull();
    const icon = document.querySelector<HTMLElement>(
      '[data-slot="crown-rail"] [data-nav-key="ship"]',
    )!;
    expect(icon.dataset.phase).toBe("running");
    expect(
      [...icon.querySelectorAll(".crown-ring-seg")].map((segment) =>
        segment.getAttribute("data-s"),
      ),
    ).toEqual(["pass", "current", "queued"]);
  });

  it("holds the preview open while the commit message is edited", async () => {
    const binding = makeShip();
    const crown = await mountCrown(binding);
    await page.getByRole("button", { name: "Ship", exact: true }).hover();
    await expect.poll(() => crown.flyout().dataset.open).toBe("true");
    await page.getByRole("button", { name: "Edit" }).click();
    const field = page.getByRole("textbox", { name: "Commit message" });
    await expect.element(field).toHaveFocus();
    await userEvent.keyboard("w");
    expect(binding.calls.messages).toEqual(["w"]);
    await page.getByRole("button", { name: "Outside" }).hover();
    await pastCloseDelay();
    expect(crown.flyout().dataset.open).toBe("true");

    // Enter in the field ships, like the rail button.
    await userEvent.keyboard("{Enter}");
    expect(binding.calls.ship).toBe(1);
  });
});
