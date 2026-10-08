import "../../index.css";

import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ChatHeaderBar } from "./ChatHeaderBar";

describe("ChatHeaderBar", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("draws breadcrumb chevrons only between segments, never ahead of the first", async () => {
    const breadcrumb = () => document.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"]')!;
    const chevrons = () => breadcrumb().querySelectorAll("svg").length;

    // No project (e.g. a thread whose project is not loaded): just the title.
    mounted = await render(
      <ChatHeaderBar
        projectName={undefined}
        isGitRepo
        worktreeBranch={null}
        worktreeTitle={null}
        worktreeOrigin={null}
        sessionTitle="New thread"
      />,
    );
    await expect.element(page.getByText("New thread")).toBeInTheDocument();
    expect(chevrons()).toBe(0);
    expect(breadcrumb().firstElementChild?.textContent).toBe("New thread");

    // A worktree without a project leads with the worktree.
    await mounted.rerender(
      <ChatHeaderBar
        projectName=""
        isGitRepo
        worktreeBranch="feature/x"
        worktreeTitle={null}
        worktreeOrigin="branch"
        sessionTitle="Implementation"
      />,
    );
    await expect.element(page.getByText("Implementation")).toBeInTheDocument();
    expect(chevrons()).toBe(1);
    expect(breadcrumb().firstElementChild?.textContent).toBe("feature/x");

    // All three segments: two separators.
    await mounted.rerender(
      <ChatHeaderBar
        projectName="Ryco"
        isGitRepo
        worktreeBranch="feature/x"
        worktreeTitle={null}
        worktreeOrigin="branch"
        sessionTitle="Implementation"
      />,
    );
    await expect.element(page.getByText("Ryco")).toBeInTheDocument();
    expect(chevrons()).toBe(2);
    expect(breadcrumb().textContent).toBe("Rycofeature/xImplementation");
  });

  it("shows the active worktree issue number and opens the linked item dialog action", async () => {
    const onOpen = vi.fn();

    mounted = await render(
      <ChatHeaderBar
        projectName="Ryco"
        isGitRepo
        worktreeBranch="issue/112"
        worktreeTitle="Top bar issue number"
        worktreeOrigin="issue"
        worktreeIssueNumber={112}
        worktreeIssueState="open"
        sessionTitle="Implementation"
        onOpenLinkedWorktreeItem={onOpen}
      />,
    );

    await expect.element(page.getByText("Issue #112")).toBeInTheDocument();

    await page.getByRole("button", { name: "Issue #112 — Open" }).click();

    expect(onOpen).toHaveBeenCalledWith({ kind: "issue", number: 112 });
  });

  it("shows the active worktree PR number", async () => {
    mounted = await render(
      <ChatHeaderBar
        projectName="Ryco"
        isGitRepo
        worktreeBranch="pr/113"
        worktreeTitle="Top bar PR number"
        worktreeOrigin="pr"
        worktreePrNumber={113}
        worktreePrState="open"
        worktreePrIsDraft={false}
        sessionTitle="Implementation"
      />,
    );

    await expect.element(page.getByText("PR #113")).toBeInTheDocument();
  });

  it("uses deterministic issue then PR ordering when both links exist", async () => {
    mounted = await render(
      <ChatHeaderBar
        projectName="Ryco"
        isGitRepo
        worktreeBranch="feature/link-both"
        worktreeTitle="Linked issue and PR"
        worktreeOrigin="pr"
        worktreeIssueNumber={112}
        worktreeIssueState="closed"
        worktreePrNumber={113}
        worktreePrState="merged"
        sessionTitle="Implementation"
      />,
    );

    const text = document.body.textContent ?? "";
    expect(text.indexOf("Issue #112")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("PR #113")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Issue #112")).toBeLessThan(text.indexOf("PR #113"));
  });

  it("does not show a source-control identifier when the worktree is unassigned", async () => {
    mounted = await render(
      <ChatHeaderBar
        projectName="Ryco"
        isGitRepo
        worktreeBranch="feature/no-linked-item"
        worktreeTitle="No linked item"
        worktreeOrigin="manual"
        sessionTitle="Implementation"
      />,
    );

    expect(document.querySelector("[data-linked-worktree-item]")).toBeNull();
    expect(document.body.textContent).not.toContain("Issue #");
    expect(document.body.textContent).not.toContain("PR #");
  });

  it("keeps long breadcrumb labels from overlapping linked issue and PR badges", async () => {
    mounted = await render(
      <div style={{ width: "760px" }}>
        <ChatHeaderBar
          projectName="A very long project name that should truncate before the badges"
          isGitRepo
          worktreeBranch="feature/super-long-worktree-branch-name-that-keeps-going"
          worktreeTitle="Extremely long worktree title that should give space to the identifiers"
          worktreeOrigin="pr"
          worktreeIssueNumber={112}
          worktreeIssueState="open"
          worktreePrNumber={113}
          worktreePrState="open"
          sessionTitle="A long active session title that must not collide with the linked badges"
          inlineActions={<span data-testid="header-actions">Actions</span>}
        />
      </div>,
    );

    const breadcrumb = document.querySelector('nav[aria-label="Breadcrumb"]');
    const issueBadge = document.querySelector('[data-linked-worktree-item="issue"]');
    const prBadge = document.querySelector('[data-linked-worktree-item="pr"]');
    const actions = document.querySelector('[data-testid="header-actions"]');

    expect(breadcrumb).not.toBeNull();
    expect(issueBadge).not.toBeNull();
    expect(prBadge).not.toBeNull();
    expect(actions).not.toBeNull();

    const breadcrumbRect = breadcrumb!.getBoundingClientRect();
    const issueRect = issueBadge!.getBoundingClientRect();
    const prRect = prBadge!.getBoundingClientRect();
    const actionsRect = actions!.getBoundingClientRect();

    expect(breadcrumbRect.right).toBeLessThanOrEqual(issueRect.left + 0.5);
    expect(issueRect.right).toBeLessThanOrEqual(prRect.left + 0.5);
    expect(prRect.right).toBeLessThanOrEqual(actionsRect.left + 0.5);
  });
});
