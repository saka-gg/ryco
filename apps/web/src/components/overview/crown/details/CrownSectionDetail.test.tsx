import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { OverviewLayoutProps } from "../../overviewTypes";
import type { CrownSectionDetailProps } from "../crownTypes";
import { CrownSectionDetail } from "./CrownSectionDetail";
import { crownLayoutFixture, crownPullRequestFixture, makeLayout } from "../crownTestFixtures";

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
    expect(headingOf(renderDetail("agents"))).toBe("Subagents 1 live");
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

  it("previews the branch read-only in the flyout, without the stateful git controls", () => {
    const markup = renderDetail("branch", {
      variant: "flyout",
      layout: crownLayoutFixture({
        branchControl: <div data-testid="branch-control">picker</div>,
        sourceControlActions: <div data-testid="git-actions">Commit</div>,
      }),
    });
    expect(markup).not.toContain("branch-control");
    expect(markup).not.toContain("git-actions");
    expect(markup).not.toContain("<button");
    const order = ["feature/crown", "Sync", "Tracking origin", "Click to commit or push"].map(
      (needle) => markup.indexOf(needle),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].toSorted((a, b) => a - b));
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

  it("renders one row per check with a View link only on failed runs that have a URL", () => {
    const markup = renderDetail("checks", { variant: "card" });
    expect(markup.match(/data-slot="crown-check-row"/g)).toHaveLength(4);
    expect(markup).toContain(
      '<a href="https://github.com/ryco/ryco/actions/runs/2" target="_blank" rel="noreferrer" aria-label="View Typecheck"',
    );
    expect(markup).not.toContain('aria-label="View Format"');
    expect(markup.match(/>View</g)).toHaveLength(1);
    // Running rows show their active step and an indeterminate bar.
    expect(markup).toContain("Test / Run vitest");
    expect(markup.match(/crown-check-bar/g)).toHaveLength(1);
    expect(markup).toContain("crown-spin");
    expect(markup).toContain("Pending");
    expect(markup).toContain("CI on PR #683 · feature/crown");
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

  it("lists subagents with role, model and a status pill", () => {
    const markup = renderDetail("agents", { variant: "card" });
    expect(markup.match(/data-slot="crown-subagent-row"/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Test writer — Working"');
    expect(markup).toContain("Writing NotesPane tests · gpt-5");
    expect(markup).toContain("crown-agent-pulse");
    expect(markup).toContain('aria-label="Linter — Needs review"');
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
