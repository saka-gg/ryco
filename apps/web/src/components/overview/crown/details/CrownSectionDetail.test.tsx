import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { OverviewLayoutProps } from "../../overviewTypes";
import type { CrownSectionDetailProps } from "../crownTypes";
import { CrownSectionDetail } from "./CrownSectionDetail";
import {
  auditWorkflowAgents,
  crownDirectAgents,
  crownLayoutFixture,
  crownPullRequestFixture,
  makeAgentPanelModel,
  makeLayout,
} from "../crownTestFixtures";

type Section = CrownSectionDetailProps["section"];

const SECTIONS: ReadonlyArray<Section> = ["branch", "changes", "checks", "plan", "agents", "pr"];

function renderDetail(
  section: Section,
  options: {
    variant?: CrownSectionDetailProps["variant"];
    layout?: OverviewLayoutProps;
    isGitRepo?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <CrownSectionDetail
      section={section}
      variant={options.variant ?? "flyout"}
      layout={options.layout ?? crownLayoutFixture()}
      isGitRepo={options.isGitRepo ?? true}
    />,
  );
}

function headingOf(markup: string): string | null {
  const match = /<div[^>]*data-slot="crown-detail-heading"[^>]*>(.*?)<\/div>/.exec(markup);
  return match
    ? match[1]!
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : null;
}

describe("CrownSectionDetail", () => {
  it.each(SECTIONS)("renders %s with a heading only in the flyout variant", (section) => {
    const flyout = renderDetail(section, { variant: "flyout" });
    const card = renderDetail(section, { variant: "card" });

    expect(flyout).toContain(`data-section="${section}"`);
    expect(flyout).toContain('data-variant="flyout"');
    expect(flyout).toContain('data-slot="crown-detail-heading"');
    expect(card).toContain(`data-section="${section}"`);
    expect(card).toContain('data-variant="card"');
    expect(card).not.toContain('data-slot="crown-detail-heading"');
  });

  it("puts each section's label and mono meta in the flyout heading", () => {
    expect(headingOf(renderDetail("branch"))).toBe("Branch ↑2 ↓1");
    expect(headingOf(renderDetail("changes"))).toBe("Changes +337 −35");
    expect(headingOf(renderDetail("checks"))).toBe("Checks 1/4");
    expect(headingOf(renderDetail("plan"))).toBe("Plan 2/5");
    expect(headingOf(renderDetail("agents"))).toBe("Subagents 2 live");
    expect(headingOf(renderDetail("pr"))).toBe("PR #683 Open");
  });

  it("shows the branch picker, sync and upstream rows, then the source-control actions", () => {
    const markup = renderDetail("branch", {
      variant: "card",
      layout: crownLayoutFixture({
        branchControl: <div data-testid="branch-control">feature/crown</div>,
        sourceControlActions: <div data-testid="git-actions">Commit</div>,
      }),
    });
    const order = ["branch-control", "Sync", "Upstream", "Tracking origin", "git-actions"].map(
      (needle) => markup.indexOf(needle),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].toSorted((a, b) => a - b));

    const unpushed = renderDetail("branch", {
      layout: crownLayoutFixture({
        changes: {
          ...crownLayoutFixture().changes!,
          aheadCount: 0,
          behindCount: 0,
          hasUpstream: false,
        },
      }),
    });
    expect(unpushed).toContain("Not pushed yet");
    expect(unpushed).toContain("In sync");
    expect(headingOf(unpushed)).toBe("Branch in sync");
  });

  it("previews the branch with its git action buttons, without the picker or split button", () => {
    const markup = renderDetail("branch", {
      variant: "flyout",
      layout: crownLayoutFixture({
        branchControl: <div data-testid="branch-control">picker</div>,
        sourceControlActions: <div data-testid="git-actions">Commit</div>,
        sourceControlQuickActions: <div data-testid="git-quick-actions">Commit Push</div>,
      }),
    });
    expect(markup).not.toContain("branch-control");
    expect(markup).not.toContain("git-actions");
    expect(markup).not.toContain("Click to commit or push");
    const order = ["feature/crown", "Sync", "Tracking origin", "git-quick-actions"].map((needle) =>
      markup.indexOf(needle),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].toSorted((a, b) => a - b));

    // Without the buttons (no checkout) the preview stays read-only and points at the card.
    const readOnly = renderDetail("branch", { variant: "flyout" });
    expect(readOnly).not.toContain("<button");
    expect(readOnly).toContain("Click to commit or push");
  });

  it("keeps the git action buttons out of the branch card", () => {
    const markup = renderDetail("branch", {
      variant: "card",
      layout: crownLayoutFixture({
        sourceControlActions: <div data-testid="git-actions">Commit</div>,
        sourceControlQuickActions: <div data-testid="git-quick-actions">Commit Push</div>,
      }),
    });
    expect(markup).toContain("git-actions");
    expect(markup).not.toContain("git-quick-actions");
  });

  it("groups changed files into Local and Committed with coloured status letters", () => {
    const markup = renderDetail("changes", { variant: "card" });
    expect(markup).toContain('data-slot="crown-changes-split-bar"');
    expect(markup).toContain("flex-grow:337");
    expect(markup).toContain("flex-grow:35");
    expect(markup.indexOf(">Local<")).toBeLessThan(markup.indexOf(">Committed<"));
    expect(markup).toContain("PlanSidebar.tsx");
    expect(markup).toContain("apps/web/src/components/");
    expect(markup).toContain('title="packages/contracts/src/notes.ts"');
    expect(markup).toMatch(/text-warning-foreground[^"]*">M</);
    expect(markup).toMatch(/text-success-foreground[^"]*">A</);
    expect(markup).toMatch(/text-destructive-foreground[^"]*">D</);
    expect(markup).not.toContain("Open review");
  });

  it("caps card file groups at five rows with a +N more line and lists every file in the flyout", () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      insertions: 1,
      deletions: 0,
    }));
    const layout = crownLayoutFixture({
      changes: { ...crownLayoutFixture().changes!, files },
      onOpenReview: () => {},
    });
    const card = renderDetail("changes", { variant: "card", layout });
    const flyout = renderDetail("changes", { variant: "flyout", layout });

    expect(card.match(/<li /g)).toHaveLength(5);
    expect(card).toContain("+3 more");
    expect(card).not.toContain(">Local<");
    expect(flyout.match(/<li /g)).toHaveLength(8);
    expect(flyout).not.toContain("more</p>");
    // Uncategorised files without a status letter get a neutral dot.
    expect(card).toContain("rounded-full bg-muted-foreground/60");
    expect(card).toContain("Open review");
  });

  it("renders one row per check, each a single host link when it has a URL", () => {
    const markup = renderDetail("checks", { variant: "card" });
    expect(markup.match(/data-slot="crown-check-row"/g)).toHaveLength(4);
    // Without an in-app opener, URL rows are plain host links with a ↗ affordance.
    expect(markup).toContain(
      '<a href="https://github.com/ryco/ryco/actions/runs/2" target="_blank" rel="noreferrer" aria-label="Typecheck, Failed"',
    );
    expect(markup).toContain('aria-label="Format, Succeeded, 14s"');
    expect(markup.match(/data-opens="host"/g)).toHaveLength(2);
    expect(markup.match(/lucide-arrow-up-right/g)).toHaveLength(2);
    // The failed row's old "View" link is folded into the row: no nested links.
    expect(markup).not.toContain(">View<");
    expect(markup.match(/<a /g)).toHaveLength(2);
    // URL-less rows stay static.
    expect(markup).not.toContain("<button");
    // Running rows show their active step and an indeterminate bar.
    expect(markup).toContain("Test / Run vitest");
    expect(markup.match(/crown-check-bar/g)).toHaveLength(1);
    expect(markup).toContain("crown-spin");
    expect(markup).toContain("Pending");
    expect(markup).toContain("CI on PR #683 · feature/crown");
  });

  it("opens every check in Ryco when the pull request has an in-app opener", () => {
    const markup = renderDetail("checks", {
      variant: "flyout",
      layout: crownLayoutFixture({ onOpenPullRequestCheck: () => undefined }),
    });
    // URL rows stay host links (⌘/Ctrl-click) but lead into the reader.
    expect(markup.match(/data-opens="app"/g)).toHaveLength(4);
    expect(markup.match(/<a /g)).toHaveLength(2);
    expect(markup.match(/title="⌘\/Ctrl-click opens the host page"/g)).toHaveLength(2);
    // URL-less rows become buttons.
    expect(markup).toContain(
      '<button type="button" aria-label="Unit tests, Running, Test / Run vitest"',
    );
    expect(markup).toContain('<button type="button" aria-label="Browser suite, Pending"');
    expect(markup.match(/lucide-chevron-right/g)).toHaveLength(4);
    expect(markup).not.toContain("lucide-arrow-up-right");
  });

  it("keeps host links for default-branch CI without a pull request", () => {
    const { number: _number, ...branchChecks } = crownPullRequestFixture;
    const markup = renderDetail("checks", {
      layout: crownLayoutFixture({
        pullRequest: branchChecks,
        onOpenPullRequestCheck: () => undefined,
      }),
    });
    expect(markup).not.toContain('data-opens="app"');
    expect(markup.match(/data-opens="host"/g)).toHaveLength(2);
    expect(markup).not.toContain("<button");
  });

  it("shows the checks error line and a branch-only footnote", () => {
    const { number: _number, ...branchChecks } = crownPullRequestFixture;
    const terminal = renderDetail("checks", {
      layout: crownLayoutFixture({
        pullRequest: {
          ...branchChecks,
          latestRuns: [],
          checksError: {
            kind: "terminal",
            message: "GitHub CLI is not authenticated.",
            raw: "gh: not logged in",
          },
        },
      }),
    });
    expect(terminal).toMatch(/text-destructive-foreground">GitHub CLI is not authenticated\./);
    expect(terminal).not.toContain("No checks reported");
    expect(terminal).toContain("CI on feature/crown");

    const transient = renderDetail("checks", {
      layout: crownLayoutFixture({
        pullRequest: {
          ...crownPullRequestFixture,
          checksError: {
            kind: "transient",
            message: "Checks are taking a while.",
            raw: "timeout",
          },
        },
      }),
    });
    expect(transient).toMatch(/text-muted-foreground">Checks are taking a while\./);
  });

  it("draws plan progress with completed, active and pending step markers", () => {
    const markup = renderDetail("plan", { variant: "card" });
    expect(markup).toContain('aria-valuenow="40"');
    expect(markup).toContain("width:40%");
    expect(markup.match(/data-status="completed"/g)).toHaveLength(2);
    expect(markup.match(/crown-step-active/g)).toHaveLength(1);
    expect(markup.match(/data-status="pending"/g)).toHaveLength(2);
    expect(markup).toContain("Ship the crown rail on existing data.");
    expect(markup).toContain('aria-label="Overview plan actions"');
  });

  it("shows a workflow run as a card: header, phase strip, status line and member rows", () => {
    const markup = renderDetail("agents", { variant: "card" });
    expect(markup.match(/data-slot="crown-workflow-card"/g)).toHaveLength(1);
    // Without an opener the header is static.
    expect(markup).toMatch(/<div[^>]*data-slot="crown-workflow-header"/);
    expect(markup).toContain(">Audit<");
    expect(markup).toContain("3/4");
    // The run's tokens sit on its status line, never in the header.
    expect(markup).toMatch(/data-slot="crown-workflow-tokens">72.6k tok</);
    expect(markup).toContain('title="Audit"');

    const phases = [
      ...markup.matchAll(/data-slot="crown-workflow-phase" data-state="(\w+)" data-tone="(\w+)"/g),
    ];
    expect(phases.map((match) => [match[1], match[2]])).toEqual([
      ["done", "failed"],
      ["running", "running"],
      ["pending", "pending"],
    ]);
    expect(markup).toContain('<ol aria-label="Phases"');
    expect(markup).toContain('<span class="sr-only">Work, 2 done · 1 failed</span>');
    expect(markup).toContain('<span class="sr-only">Review, 1 active · 1 done</span>');
    expect(markup).toContain('<span class="sr-only">Verify, not started</span>');
    const fills = [
      ...markup.matchAll(
        /class="([^"]*)" data-slot="crown-workflow-phase-fill" style="width:(\d+)%"/g,
      ),
    ];
    expect(fills.map((match) => match[2])).toEqual(["100", "50", "0"]);
    // A done phase with a failed member never reads as success.
    expect(fills[0]![1]).toContain("bg-destructive");
    expect(fills[0]![1]).not.toContain("bg-success");
    expect(fills[1]![1]).toContain("crown-agent-pulse");

    expect(markup).toMatch(/data-slot="crown-workflow-status">Review · 1 working</);
    // The card lists every member (limit 5) in roster order, as compact rows.
    const rows = [
      ...markup.matchAll(/data-agent-row="true" data-agent-id="([^"]+)" data-density="compact"/g),
    ];
    expect(rows.map((match) => match[1])).toEqual([
      "wf-audit:map",
      "wf-audit:types",
      "wf-audit:card",
      "wf-audit:alerts",
      "agent-scout",
      "agent-docs",
    ]);
    expect(markup).not.toContain('data-slot="crown-workflow-more"');
  });

  it("puts direct agents under a Direct group and totals the roster in the card footnote", () => {
    const card = renderDetail("agents", { variant: "card" });
    expect(card).toMatch(/<span>Direct<\/span><span class="tabular-nums">2<\/span>/);
    expect(card.indexOf('data-slot="crown-workflows"')).toBeLessThan(
      card.indexOf('data-slot="crown-direct-agents"'),
    );
    expect(card).toContain("Reading crownAlerts.logic.ts");
    expect(card).toContain("84.2k tok · 2 active · 4 settled");

    const flyout = renderDetail("agents", { variant: "flyout" });
    expect(flyout).not.toContain("84.2k tok");
    expect(flyout).not.toContain('data-slot="crown-workflow-tokens"');
    // The flyout lists three members, the rest fold into "+N more", as mini
    // rows: its column is too narrow for an activity line.
    expect(flyout.match(/data-agent-row="true"/g)).toHaveLength(5);
    expect(flyout.match(/data-density="mini"/g)).toHaveLength(5);
    expect(flyout).not.toContain("Reading crownAlerts.logic.ts");
    expect(flyout).toMatch(/<p[^>]*data-slot="crown-workflow-more">\+1 more<\/p>/);

    // With only direct agents the group needs no header.
    const directOnly = renderDetail("agents", {
      layout: makeLayout({ agentPanelModel: makeAgentPanelModel(crownDirectAgents()) }),
    });
    expect(directOnly).not.toContain(">Direct<");
    expect(directOnly).not.toContain('data-slot="crown-workflow-card"');
    expect(directOnly.match(/data-agent-row="true"/g)).toHaveLength(2);
  });

  it("makes the header, +N more and member rows buttons when they can open the Agents tab", () => {
    const markup = renderDetail("agents", {
      variant: "flyout",
      layout: crownLayoutFixture({ onOpenAgent: () => {}, onOpenAgentsWorkflow: () => {} }),
    });
    expect(markup).toMatch(
      /<button type="button"[^>]*data-slot="crown-workflow-header" aria-label="Open Audit in Agents, Review · 1 working"/,
    );
    expect(markup).toMatch(
      /<button type="button"[^>]*data-slot="crown-workflow-more" aria-label="Show all 4 agents of Audit in Agents">\+1 more/,
    );
    expect(markup).toContain('aria-label="Open work:types transcript. Failed."');
    expect(markup).toContain('aria-label="Open Scout transcript. Running."');
  });

  it("words a settled run's outcome and stands a memberless run in for itself", () => {
    const finished = renderDetail("agents", {
      layout: makeLayout({
        agentPanelModel: makeAgentPanelModel(
          auditWorkflowAgents({ coordinator: "completed", members: { card: "completed" } }),
        ),
      }),
    });
    expect(finished).toMatch(
      /text-destructive-foreground"[^>]*data-slot="crown-workflow-status">1 failed</,
    );
    expect(finished.match(/data-state="done"/g)).toHaveLength(3);
    // Verify never ran: no fill, and it says so instead of "0 done".
    expect(finished).toMatch(
      /data-state="done" data-tone="skipped" title="Verify · not run"><span class="sr-only">Verify, not run<\/span>/,
    );
    const finishedFills = [
      ...finished.matchAll(/data-slot="crown-workflow-phase-fill" style="width:(\d+)%"/g),
    ];
    expect(finishedFills.map((match) => match[1])).toEqual(["100", "100", "0"]);

    const bare = renderDetail("agents", {
      layout: makeLayout({
        agentPanelModel: makeAgentPanelModel(auditWorkflowAgents().slice(0, 1)),
      }),
    });
    expect(bare).toMatch(/data-slot="crown-workflow-status">Working</);
    expect(bare).toContain('data-agent-id="wf-audit"');
    expect(bare.match(/data-state="pending"/g)).toHaveLength(3);
  });

  it("shows the pull request title, reviews, comments, merge state and the open action", () => {
    const markup = renderDetail("pr", {
      variant: "card",
      layout: crownLayoutFixture({ onOpenPullRequestInApp: () => {} }),
    });
    expect(markup).toContain("#683");
    expect(markup).toContain("Overview rail + worktree notes");
    expect(markup).toContain("1 approved · 2 requested");
    expect(markup).toMatch(/Comments<\/span><span[^>]*>3</);
    expect(markup).toContain("No conflicts");
    expect(markup).toContain('href="https://github.com/ryco/ryco/pull/683"');
    expect(markup).toContain("Open in Ryco");

    const { url: _url, ...withoutUrl } = crownPullRequestFixture;
    const conflicted = renderDetail("pr", {
      layout: crownLayoutFixture({
        pullRequest: {
          ...withoutUrl,
          mergeability: "conflicting",
          hasMergeConflicts: true,
        },
      }),
    });
    expect(conflicted).toContain("Conflicts");
    expect(conflicted).not.toContain("Open in Ryco");
    expect(conflicted).not.toContain("<a ");
  });

  it.each([
    ["changes", "No file changes"],
    ["checks", "No checks reported"],
    ["plan", "No plan yet"],
    ["agents", "No subagents in this thread"],
    ["pr", "No pull request for this branch yet"],
  ] as const)("renders the %s empty state", (section, message) => {
    for (const variant of ["flyout", "card"] as const) {
      const markup = renderDetail(section, { variant, layout: makeLayout() });
      expect(markup).toContain('data-slot="crown-detail-empty"');
      expect(markup).toContain(message);
    }
  });

  it("replaces git sections with a not-a-repository notice outside git", () => {
    for (const section of ["branch", "changes", "checks", "pr"] as const) {
      const markup = renderDetail(section, { isGitRepo: false });
      expect(markup).toContain("Not a git repository");
    }
    for (const section of ["plan", "agents"] as const) {
      expect(renderDetail(section, { isGitRepo: false })).not.toContain("Not a git repository");
    }
  });
});
