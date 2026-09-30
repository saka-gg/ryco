import "../index.css";

import { EnvironmentId } from "@ryco/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import PlanSidebar from "./PlanSidebar";
import type { ThreadSubagentView } from "../threadWorkspaceViewModel";

describe("PlanSidebar overview panel", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  it("scrolls the phone overview surface when many subagents are visible", async () => {
    const host = document.createElement("div");
    host.style.width = "380px";
    host.style.height = "360px";
    document.body.append(host);

    const subagents: ThreadSubagentView[] = Array.from({ length: 30 }, (_, index) => ({
      key: `subagent:${index}`,
      name: `Researcher ${index + 1}`,
      status: index % 3 === 0 ? "finished" : "running",
      origin: null,
      capability: null,
      tool: "spawnAgent",
      detail: `Inspect task ${index + 1} and report progress.`,
      providerThreadIds: [`child-thread-${index}`],
      providerSessionIds: [],
      startedAt: "2026-06-04T10:00:00.000Z",
      updatedAt: "2026-06-04T10:00:00.000Z",
      entries: [],
      messages: [],
    }));

    const mounted = await render(
      <PlanSidebar
        activePlan={null}
        activeProposedPlan={null}
        subagents={subagents}
        environmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        workspaceRoot={undefined}
        mode="sheet"
      />,
      { container: host },
    );

    try {
      // The Subagents section is collapsed by default (matching the lab); expand
      // it so the long agent list overflows the viewport. Target it by label so
      // the test doesn't depend on section ordering.
      const subagentsHeader =
        Array.from(host.querySelectorAll<HTMLElement>("button[aria-expanded]")).find((button) =>
          (button.textContent ?? "").includes("Subagents"),
        ) ?? null;
      expect(subagentsHeader).not.toBeNull();
      subagentsHeader!.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');

      expect(viewport).not.toBeNull();
      expect(viewport!.clientHeight).toBeGreaterThan(0);
      expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);

      viewport!.scrollTop = viewport!.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));

      expect(viewport!.scrollTop).toBeGreaterThan(0);
    } finally {
      await mounted.unmount();
      host.remove();
    }
  });

  it("renders pull request checks after expanding the Status Board lane", async () => {
    const host = document.createElement("div");
    host.style.width = "380px";
    host.style.height = "640px";
    document.body.append(host);

    const mounted = await render(
      <PlanSidebar
        activePlan={null}
        activeProposedPlan={null}
        pullRequest={{
          number: 124,
          title: "Consolidate chat right panel",
          state: "open",
          checkStatus: null,
          checksLoading: false,
          hasMergeConflicts: false,
          activeCheckCount: 0,
          runs: [],
          latestRuns: [
            {
              id: "run:1:job:branch",
              name: "Branch",
              statusLabel: "Skipped",
              statusKind: "passed",
              tone: "success",
            },
            {
              id: "run:1:job:quality",
              name: "Pull Request / Quality",
              statusLabel: "Succeeded",
              statusKind: "passed",
              tone: "success",
            },
          ],
        }}
        environmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        workspaceRoot={undefined}
      />,
      { container: host },
    );

    try {
      const checksButton = Array.from(
        host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
      ).find((button) => (button.textContent ?? "").includes("Checks"));
      expect(checksButton).toBeDefined();
      checksButton!.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const text = host.textContent ?? "";
      expect(text).toContain("#124");
      expect(text).toContain("Branch");
      expect(text).toContain("Pull Request / Quality");

      const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      expect(viewport).not.toBeNull();
      expect(viewport!.className).toContain("[scrollbar-gutter:stable]");
    } finally {
      await mounted.unmount();
      host.remove();
    }
  });

  it("keeps status-board lanes compact and separates the pull request link", async () => {
    const host = document.createElement("div");
    host.style.width = "380px";
    host.style.height = "640px";
    document.body.append(host);

    const mounted = await render(
      <PlanSidebar
        activePlan={null}
        activeProposedPlan={null}
        changes={{
          files: [
            { path: "overviewLayouts.tsx", insertions: 68, deletions: 12 },
            { path: "overviewSections.tsx", insertions: 51, deletions: 18 },
            { path: "PlanSidebar.tsx", insertions: 24, deletions: 4 },
            { path: "PlanSidebar.browser.tsx", insertions: 22, deletions: 3 },
            { path: "overviewLayouts.test.tsx", insertions: 19, deletions: 5 },
          ],
          insertions: 184,
          deletions: 42,
          refName: "feat/overview-redesign",
          aheadCount: 2,
          behindCount: 0,
        }}
        pullRequest={{
          number: 264,
          title: "Make the status board compact",
          url: "https://github.com/ryco/ryco/pull/264",
          state: "open",
          checkStatus: null,
          checksLoading: false,
          hasMergeConflicts: true,
          activeCheckCount: 0,
          runs: [],
          latestRuns: [],
        }}
        branchControl={
          <button
            type="button"
            className="h-9 w-full truncate text-left"
            data-testid="overview-branch-selector"
          >
            feat/overview-redesign-with-a-long-name
          </button>
        }
        sourceControlActions={<button type="button">Existing Git actions</button>}
        overviewItems={[
          { label: "Environment", value: "Local", detail: "local", icon: "environment" },
        ]}
        environmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        workspaceRoot={undefined}
        mode="sheet"
      />,
      { container: host },
    );

    try {
      const laneButtons = Array.from(
        host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
      );
      const changesButton =
        laneButtons.find((button) => (button.textContent ?? "").includes("Changes")) ?? null;
      const pullRequestButton =
        laneButtons.find((button) => (button.textContent ?? "").includes("Pull Request #264")) ??
        null;
      const pullRequestLink = host.querySelector<HTMLAnchorElement>(
        'a[aria-label="Open pull request #264 in a new tab"]',
      );
      const environmentHeader = Array.from(
        host.querySelectorAll<HTMLElement>('[data-slot="overview-section-lane-header"]'),
      ).find((header) => (header.textContent ?? "").includes("Environment"));
      const branchHeader = host.querySelector<HTMLElement>('[data-slot="overview-branch-header"]');
      const branchControl = host.querySelector<HTMLElement>(
        '[data-slot="overview-branch-control"]',
      );
      const branchSelector = host.querySelector<HTMLElement>(
        '[data-testid="overview-branch-selector"]',
      );

      expect(branchHeader).not.toBeNull();
      expect(branchControl).not.toBeNull();
      expect(branchSelector).not.toBeNull();
      const branchSelectorHeight = Math.round(branchSelector!.getBoundingClientRect().height);
      expect(branchSelectorHeight).toBe(36);
      expect(Math.round(branchHeader!.getBoundingClientRect().height)).toBe(
        branchSelectorHeight + 1,
      );
      expect(branchControl!.getBoundingClientRect().width).toBeGreaterThan(200);
      expect(Math.round(branchSelector!.getBoundingClientRect().width)).toBe(
        Math.round(branchControl!.getBoundingClientRect().width),
      );

      expect(changesButton).not.toBeNull();
      expect(changesButton!.getAttribute("aria-expanded")).toBe("false");
      expect(changesButton!.textContent).toContain("5 files");
      expect(changesButton!.textContent).toContain("+184");
      expect(changesButton!.textContent).toContain("−42");
      expect(Math.round(changesButton!.getBoundingClientRect().height)).toBe(40);

      expect(pullRequestButton).not.toBeNull();
      expect(pullRequestButton!.getAttribute("aria-expanded")).toBe("false");
      expect(Math.round(pullRequestButton!.getBoundingClientRect().height)).toBe(40);
      expect(pullRequestButton!.textContent).toContain("Make the status board compact");

      expect(environmentHeader).not.toBeUndefined();
      expect(environmentHeader!.dataset.expandable).toBe("false");
      expect(environmentHeader!.querySelector("button")).toBeNull();
      expect(Math.round(environmentHeader!.getBoundingClientRect().height)).toBe(40);
      expect(environmentHeader!.textContent).toContain("Local");
      expect(environmentHeader!.textContent).not.toContain("local");

      expect(pullRequestLink).not.toBeNull();
      expect(pullRequestLink!.target).toBe("_blank");
      expect(pullRequestLink!.rel).toBe("noreferrer");
      pullRequestLink!.addEventListener("click", (event) => event.preventDefault(), { once: true });
      pullRequestLink!.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(pullRequestButton!.getAttribute("aria-expanded")).toBe("false");

      pullRequestButton!.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(pullRequestButton!.getAttribute("aria-expanded")).toBe("true");
      expect(host.textContent).toContain("Make the status board compact");
      expect(host.textContent).toContain("Existing Git actions");
    } finally {
      await mounted.unmount();
      host.remove();
    }
  });
});
