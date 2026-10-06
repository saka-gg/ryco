import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE } from "../../types";
import { DraftId } from "../../composerDraftStore";
import type {
  SidebarTreeProject,
  SidebarTreeThread,
  SidebarTreeWorktree,
  SidebarWorktree,
} from "./hooks/useSidebarTree";
import type { SidebarStatusBucket } from "../Sidebar.logic";
import { SidebarWorktreeList } from "./SidebarWorktreeList";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");

describe("SidebarWorktreeList", () => {
  it("renders worktree sections collapsed by default and expands them on demand", async () => {
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={makeTreeProject()}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("main");
    expect(document.body.textContent).not.toContain("Release checklist");

    await page.getByRole("button", { name: "Expand main", exact: true }).click();

    await expect.element(page.getByText("Release checklist")).toBeInTheDocument();
  });

  it("renders draft sessions before worktrees as project-level rows", async () => {
    const draft = {
      ...makeThread(),
      id: ThreadId.make("thread-draft"),
      branch: "release/next",
      draftId: DraftId.make("draft-new-thread"),
      title: "New thread",
      worktreeId: null,
    };
    const orderedKeys: string[][] = [];
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread, keys) => {
          orderedKeys.push([...keys]);
          return <div data-testid={`rendered-${thread.id}`}>{thread.title}</div>;
        }}
        treeProject={{ ...makeTreeProject(), draftSessions: [draft] }}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    const draftRow = page.getByTestId("rendered-thread-draft").element();
    const mainRow = page.getByText("main", { exact: true }).element();
    expect(draftRow.compareDocumentPosition(mainRow) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(orderedKeys[0]).toEqual([
      "environment-local:thread-draft",
      "environment-local:thread-1",
    ]);
    expect(document.body.textContent).not.toContain("release/next");
  });

  it("passes each expanded worktree row its resolved git status target", async () => {
    const gitStatusTargets: unknown[] = [];
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={(thread) => ({
          environmentId: thread.environmentId,
          cwd: `/status/${thread.id}`,
        })}
        renderThread={(_thread, _keys, gitStatusTarget) => {
          gitStatusTargets.push(gitStatusTarget);
          return <div>Rendered session</div>;
        }}
        treeProject={makeTreeProject()}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    expect(gitStatusTargets).toEqual([]);
    await page.getByRole("button", { name: "Expand main", exact: true }).click();
    await expect.element(page.getByText("Rendered session")).toBeInTheDocument();
    expect(gitStatusTargets.at(-1)).toEqual({
      environmentId,
      cwd: "/status/thread-1",
    });
  });

  it("expands a worktree when clicking its title without opening it", async () => {
    const onOpenWorktree = vi.fn();
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={makeTreeProject()}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={onOpenWorktree}
        onRenameWorktree={vi.fn()}
      />,
    );

    expect(document.body.textContent).not.toContain("Release checklist");

    await page.getByText("main").click();

    await expect.element(page.getByText("Release checklist")).toBeInTheDocument();
    expect(onOpenWorktree).not.toHaveBeenCalled();
  });

  it("previews five sessions and reveals the rest behind a text toggle", async () => {
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={makeManySessionsTreeProject(7)}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "Expand main", exact: true }).click();

    await expect.element(page.getByText("Session 1", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Session 5", { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Session 6");
    expect(document.body.textContent).not.toContain("Session 7");

    await page.getByRole("button", { name: "Show 2 more", exact: true }).click();

    await expect.element(page.getByText("Session 7", { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).toContain("Session 6");

    await page.getByRole("button", { name: "Show less", exact: true }).click();

    await expect.element(page.getByText("Session 5", { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Session 6");
  });

  it("shows every matching session without a toggle while a thread filter is active", async () => {
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={makeManySessionsTreeProject(7)}
        visibleThreadKeys={new Set(["environment-local:thread-1", "environment-local:thread-6"])}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    await expect.element(page.getByText("Session 1", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Session 6", { exact: true })).toBeInTheDocument();
    // No preview toggle is rendered while filtering (the button carries both
    // `aria-expanded` and a left border; the worktree header lacks the border).
    expect(document.querySelector('[aria-expanded][class*="border-l"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Show");
  });

  it("renders state-aware chips for every linked PR/issue lifecycle state", async () => {
    const treeProject = makeVariantsTreeProject();
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={treeProject}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    await expect.element(page.getByLabelText("Issue #101 — Open")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Issue #102 — Closed")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Pull request #201 — Draft")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Pull request #202 — Open")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Pull request #203 — Merged")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Pull request #204 — Closed")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Pull request #205")).toBeInTheDocument();
  });

  it("shows only the PR badge for a worktree linked to both a PR and an issue", async () => {
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={makeLinkedIssueAndPrTreeProject()}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    await expect.element(page.getByLabelText("Pull request #202 — Open")).toBeInTheDocument();
    expect(document.querySelector('[aria-label="Issue #101 — Open"]')).toBeNull();

    const badges = [...document.querySelectorAll<HTMLElement>("[data-linked-worktree-item]")];
    expect(badges.map((badge) => badge.dataset.linkedWorktreeItem)).toEqual(["pr"]);
    expect(document.body.textContent).toContain("#202");
    expect(document.body.textContent).not.toContain("#101");
  });

  it("keeps a badge's Enter and Space from toggling its workspace row", async () => {
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={makeLinkedIssueAndPrTreeProject()}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    const badge = page.getByLabelText("Pull request #202 — Open").element() as HTMLElement;
    const row = badge.closest<HTMLElement>('[role="button"][aria-expanded]');
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    // One key at a time, letting React commit, so a toggle cannot hide behind another.
    for (const key of ["Enter", " "]) {
      badge.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(row?.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("opens a workspace's pull requests from its badge only when it has several", async () => {
    // The frozen phone tier keeps the badge's dialog.
    await page.viewport(1_280, 800);
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={makeFollowUpTreeProject()}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    // The row reads as before: one chip, the current pull request.
    const badge = page.getByLabelText("Pull request #677 — Open · 1 earlier");
    await expect.element(badge).toHaveAttribute("aria-haspopup", "dialog");
    expect(document.body.textContent).not.toContain("#675");

    await badge.click();

    await expect.element(page.getByText("Earlier")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "#675 Ship the lifecycle, Merged" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "#677 Projects map follow-up, Open" }))
      .toBeInTheDocument();
    // Not connected in this harness: no linking, no unlinking.
    expect(document.body.textContent).not.toContain("Link pull request…");
    expect(document.querySelector('[aria-label^="Unlink"]')).toBeNull();

    // Keys inside the (portaled) popover never reach the workspace row.
    const row = badge.element().closest<HTMLElement>('[role="button"][aria-expanded]');
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("button", { name: "#675 Ship the lifecycle, Merged" }))
      .toHaveFocus();
    expect(row?.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows an archived workspace's pull requests read-only", async () => {
    await page.viewport(1_280, 800);
    const live = makeFollowUpTreeProject();
    const archived = {
      ...live.worktrees[0]!,
      worktree: { ...live.worktrees[0]!.worktree, archivedAt: "2026-10-06T09:00:00.000Z" },
    };
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={{ ...live, worktrees: [], archivedWorktrees: [archived] }}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "Archived (1)" }).click();
    await page.getByLabelText("Pull request #677 — Open · 1 earlier").click();
    await expect
      .element(page.getByRole("button", { name: "#675 Ship the lifecycle, Merged" }))
      .toBeInTheDocument();
    expect(document.querySelector('[aria-label^="Unlink"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Link pull request…");
  });

  it("colors active worktree names instead of reserving a chat-activity dot slot", async () => {
    const treeProject = makeStatusDotTreeProject();
    await render(
      <SidebarWorktreeList
        attachThreadListAutoAnimateRef={() => undefined}
        projectExpanded
        resolveThreadGitStatusTarget={() => null}
        renderThread={(thread) => <div>{thread.title}</div>}
        treeProject={treeProject}
        visibleThreadKeys={null}
        onCopyWorktreePath={vi.fn()}
        onWorkspaceAction={vi.fn()}
        onNewSession={vi.fn()}
        onOpenInEditor={vi.fn()}
        onOpenWorktree={vi.fn()}
        onRenameWorktree={vi.fn()}
      />,
    );

    const idleToggle = page.getByRole("button", { name: "Expand idle-feat", exact: true });
    const idleRow = idleToggle.element().closest(".group\\/worktree");
    expect(idleRow?.querySelector("span.rounded-full")).toBeNull();

    const inProgressTitle = page.getByText("working-feat").element();
    expect(inProgressTitle.classList.contains("sidebar-status-text")).toBe(true);
    expect(inProgressTitle.classList.contains("sidebar-status-text--in-progress")).toBe(true);
    expect(inProgressTitle.classList.contains("sidebar-status-text--flow")).toBe(true);
    expect(inProgressTitle.style.getPropertyValue("--sidebar-status-text-spread")).toBe("24px");
    expect(inProgressTitle.style.getPropertyValue("--sidebar-status-text-period")).toBe("");
    expect(inProgressTitle.getAttribute("aria-label")).toBe("In progress: working-feat");
  });
});

function makeTreeProject(): SidebarTreeProject {
  const thread = makeThread();
  return {
    archivedSessions: [],
    archivedWorktrees: [],
    draftSessions: [],
    flatSessions: [],
    isGitRepo: true,
    project: {
      id: projectId,
      environmentId,
      name: "Project",
      cwd: "/repo/project",
      repositoryIdentity: null,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      scripts: [],
    },
    worktrees: [
      {
        aggregateStatus: "idle",
        archivedSessions: [],
        buckets: {
          done: [],
          idle: [thread],
          in_progress: [],
          review: [],
        },
        diffStats: null,
        sessions: [thread],
        shouldSuggestArchive: false,
        worktree: {
          worktreeId: "worktree-main",
          projectId,
          branch: "main",
          worktreePath: null,
          origin: "main",
          archivedAt: null,
          manualPosition: 0,
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      },
    ],
  };
}

function makeManySessionsTreeProject(count: number): SidebarTreeProject {
  const sessions = Array.from({ length: count }, (_, index) => makeSessionThread(index + 1));
  return {
    archivedSessions: [],
    archivedWorktrees: [],
    draftSessions: [],
    flatSessions: [],
    isGitRepo: true,
    project: makeProject(),
    worktrees: [
      {
        aggregateStatus: "idle",
        archivedSessions: [],
        buckets: { done: [], idle: sessions, in_progress: [], review: [] },
        diffStats: null,
        sessions,
        shouldSuggestArchive: false,
        worktree: {
          worktreeId: "worktree-main",
          projectId,
          branch: "main",
          worktreePath: null,
          origin: "main",
          archivedAt: null,
          manualPosition: 0,
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      },
    ],
  };
}

function makeSessionThread(index: number): SidebarTreeThread {
  return {
    ...makeThread(),
    id: ThreadId.make(`thread-${index}`),
    title: `Session ${index}`,
    worktreeId: "worktree-main",
  };
}

interface VariantSpec {
  worktreeId: string;
  branch: string;
  origin: "pr" | "issue";
  prNumber?: number;
  issueNumber?: number;
  prState?: "open" | "closed" | "merged" | null;
  prIsDraft?: boolean | null;
  issueState?: "open" | "closed" | null;
}

function makeVariantsTreeProject(): SidebarTreeProject {
  const specs: VariantSpec[] = [
    {
      worktreeId: "wt-issue-open",
      branch: "issue/open",
      origin: "issue",
      issueNumber: 101,
      issueState: "open",
    },
    {
      worktreeId: "wt-issue-closed",
      branch: "issue/closed",
      origin: "issue",
      issueNumber: 102,
      issueState: "closed",
    },
    {
      worktreeId: "wt-pr-draft",
      branch: "pr/draft",
      origin: "pr",
      prNumber: 201,
      prState: "open",
      prIsDraft: true,
    },
    {
      worktreeId: "wt-pr-open",
      branch: "pr/open",
      origin: "pr",
      prNumber: 202,
      prState: "open",
      prIsDraft: false,
    },
    {
      worktreeId: "wt-pr-merged",
      branch: "pr/merged",
      origin: "pr",
      prNumber: 203,
      prState: "merged",
    },
    {
      worktreeId: "wt-pr-closed",
      branch: "pr/closed",
      origin: "pr",
      prNumber: 204,
      prState: "closed",
    },
    {
      worktreeId: "wt-pr-unknown",
      branch: "pr/unknown",
      origin: "pr",
      prNumber: 205,
      prState: null,
    },
  ];
  return {
    archivedSessions: [],
    archivedWorktrees: [],
    draftSessions: [],
    flatSessions: [],
    isGitRepo: true,
    project: makeProject(),
    worktrees: specs.map((spec, index) =>
      makeWorktreeNode({
        aggregateStatus: "idle",
        manualPosition: index + 1,
        worktree: {
          worktreeId: spec.worktreeId,
          projectId,
          branch: spec.branch,
          worktreePath: `/tmp/${spec.branch}`,
          origin: spec.origin,
          prNumber: spec.prNumber ?? null,
          issueNumber: spec.issueNumber ?? null,
          prState: spec.prState ?? null,
          prIsDraft: spec.prIsDraft ?? null,
          issueState: spec.issueState ?? null,
          archivedAt: null,
          manualPosition: index + 1,
          updatedAt: "2026-05-17T00:00:00.000Z",
        },
      }),
    ),
  };
}

function makeLinkedIssueAndPrTreeProject(): SidebarTreeProject {
  return {
    archivedSessions: [],
    archivedWorktrees: [],
    draftSessions: [],
    flatSessions: [],
    isGitRepo: true,
    project: makeProject(),
    worktrees: [
      makeWorktreeNode({
        aggregateStatus: "idle",
        manualPosition: 1,
        worktree: {
          worktreeId: "wt-linked-issue-pr",
          projectId,
          branch: "feature/linked-issue-pr",
          worktreePath: "/tmp/feature/linked-issue-pr",
          origin: "pr",
          prNumber: 202,
          issueNumber: 101,
          prState: "open",
          prIsDraft: false,
          issueState: "open",
          archivedAt: null,
          manualPosition: 1,
          updatedAt: "2026-05-17T00:00:00.000Z",
        },
      }),
    ],
  };
}

function makeFollowUpTreeProject(): SidebarTreeProject {
  const link = (
    number: number,
    title: string,
    state: "open" | "merged",
    linkedAt: string,
  ): NonNullable<SidebarWorktree["pullRequests"]>[number] => ({
    number,
    title,
    url: `https://github.com/acme/ryco/pull/${number}`,
    state,
    isDraft: false,
    terminalAt: state === "merged" ? "2026-10-05T08:00:00.000Z" : null,
    headRefName: `feature/${number}`,
    baseRefName: "main",
    source: "created",
    linkedAt,
    dismissedAt: null,
  });
  return {
    archivedSessions: [],
    archivedWorktrees: [],
    draftSessions: [],
    flatSessions: [],
    isGitRepo: true,
    project: makeProject(),
    worktrees: [
      makeWorktreeNode({
        aggregateStatus: "idle",
        manualPosition: 1,
        worktree: {
          ...makeWorktreeSummary({ worktreeId: "wt-follow-up", branch: "feature/lifecycle" }),
          prNumber: 677,
          prState: "open",
          prIsDraft: false,
          pullRequests: [
            link(675, "Ship the lifecycle", "merged", "2026-10-04T08:00:00.000Z"),
            link(677, "Projects map follow-up", "open", "2026-10-06T08:00:00.000Z"),
          ],
        },
      }),
    ],
  };
}

function makeStatusDotTreeProject(): SidebarTreeProject {
  return {
    archivedSessions: [],
    archivedWorktrees: [],
    draftSessions: [],
    flatSessions: [],
    isGitRepo: true,
    project: makeProject(),
    worktrees: [
      makeWorktreeNode({
        aggregateStatus: "idle",
        manualPosition: 1,
        worktree: makeWorktreeSummary({
          worktreeId: "wt-idle",
          branch: "idle-feat",
        }),
      }),
      makeWorktreeNode({
        aggregateStatus: "in_progress",
        manualPosition: 2,
        worktree: makeWorktreeSummary({
          worktreeId: "wt-working",
          branch: "working-feat",
        }),
      }),
    ],
  };
}

function makeWorktreeNode(input: {
  aggregateStatus: SidebarStatusBucket;
  manualPosition: number;
  worktree: SidebarWorktree;
}): SidebarTreeWorktree {
  return {
    aggregateStatus: input.aggregateStatus,
    archivedSessions: [],
    buckets: { done: [], idle: [], in_progress: [], review: [] },
    diffStats: null,
    sessions: [],
    shouldSuggestArchive: false,
    worktree: input.worktree,
  };
}

function makeWorktreeSummary(input: { worktreeId: string; branch: string }): SidebarWorktree {
  return {
    worktreeId: input.worktreeId,
    projectId,
    branch: input.branch,
    worktreePath: `/tmp/${input.branch}`,
    origin: "branch",
    prNumber: null,
    issueNumber: null,
    prState: null,
    prIsDraft: null,
    issueState: null,
    archivedAt: null,
    manualPosition: 0,
    updatedAt: "2026-05-17T00:00:00.000Z",
  };
}

function makeProject() {
  return {
    id: projectId,
    environmentId,
    name: "Project",
    cwd: "/repo/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    scripts: [],
  };
}

function makeThread(): SidebarTreeThread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId,
    projectId,
    title: "Release checklist",
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    manualStatusBucket: null,
    statusPill: null,
    worktreeId: "worktree-main",
  };
}
