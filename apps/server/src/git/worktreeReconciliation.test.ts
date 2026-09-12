import { describe, expect, it } from "vite-plus/test";

import { ProjectId, ThreadId, WorktreeId } from "@ryco/contracts";

import {
  isCaseSensitiveFileSystem,
  generatedWorktreeTitle,
  partitionReconcilableProjectRoots,
  planWorktreeReconciliation,
  type PlanWorktreeReconciliationInput,
  type ReconcilableThread,
} from "./worktreeReconciliation.ts";

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const project = { id: projectId, workspaceRoot: "/repo" };

/** Resolves the symlinked spelling of the project root, like a Dropbox mount. */
const canonicalizePath = (value: string): string =>
  value.replace(/^\/link\/repo/, "/repo").replace(/\/+$/, "") || "/";

const makeThread = (
  input: Omit<Partial<ReconcilableThread>, "id"> & { id: string },
): ReconcilableThread => ({
  branch: "main",
  projectId,
  worktreeId: null,
  worktreePath: null,
  ...input,
  id: ThreadId.make(input.id),
});

const plan = (input: Partial<PlanWorktreeReconciliationInput>) =>
  planWorktreeReconciliation({
    canonicalizePath,
    caseSensitiveFileSystem: true,
    gitWorktreePaths: [],
    project,
    threads: [],
    worktrees: [],
    ...input,
  });

describe("partitionReconcilableProjectRoots", () => {
  it("keeps missing project roots out of git reconciliation without discarding them", () => {
    const missingProject = {
      id: ProjectId.make("project-missing"),
      workspaceRoot: "/worktrees/removed",
    };
    const result = partitionReconcilableProjectRoots(
      [project, missingProject],
      (workspaceRoot) => workspaceRoot === project.workspaceRoot,
    );

    expect(result.available).toEqual([project]);
    expect(result.missing).toEqual([missingProject]);
  });
});

describe("planWorktreeReconciliation", () => {
  it("adopts a live worktree that holds sessions but has no worktree row", () => {
    const result = plan({
      gitWorktreePaths: ["/repo", "/worktrees/ios-staging"],
      threads: [makeThread({ id: "thread-1", worktreePath: "/worktrees/ios-staging" })],
    });

    expect(result.adopt).toEqual([
      {
        branch: "main",
        threadIds: [ThreadId.make("thread-1")],
        title: "ios-staging",
        worktreePath: "/worktrees/ios-staging",
      },
    ]);
    expect(result.attach).toEqual([]);
    expect(result.detach).toEqual([]);
  });

  it("titles an adopted worktree after its directory so a main-branch worktree is not a second 'main'", () => {
    const result = plan({
      gitWorktreePaths: ["/worktrees/ios-staging"],
      threads: [
        makeThread({ id: "thread-1", branch: "main", worktreePath: "/worktrees/ios-staging" }),
      ],
    });

    expect(result.adopt[0]?.title).toBe("ios-staging");
    expect(result.adopt[0]?.branch).toBe("main");
  });

  it("preserves the generated branch label when adopting an older New Thread worktree", () => {
    const worktreePath = "/worktrees/ryco-1234abcd__abcde";
    const result = plan({
      gitWorktreePaths: [worktreePath],
      threads: [makeThread({ id: "thread-1", branch: "ryco/fix-inbox", worktreePath })],
    });
    expect(result.adopt[0]?.title).toBe("ryco/fix-inbox");
  });

  it("groups every session in the same directory under one adoption", () => {
    const result = plan({
      gitWorktreePaths: ["/worktrees/ios-staging"],
      threads: [
        makeThread({ id: "thread-1", branch: null, worktreePath: "/worktrees/ios-staging" }),
        makeThread({ id: "thread-2", branch: "feat/x", worktreePath: "/worktrees/ios-staging" }),
      ],
    });

    expect(result.adopt).toHaveLength(1);
    expect(result.adopt[0]?.threadIds).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
    ]);
    expect(result.adopt[0]?.branch).toBe("feat/x");
  });

  it("detaches sessions whose worktree is gone from disk", () => {
    const result = plan({
      gitWorktreePaths: ["/repo"],
      threads: [makeThread({ id: "thread-1", worktreePath: "/worktrees/deleted" })],
    });

    expect(result.detach).toEqual([ThreadId.make("thread-1")]);
    expect(result.adopt).toEqual([]);
  });

  it("detaches sessions that point at the project root under another spelling", () => {
    const result = plan({
      gitWorktreePaths: ["/repo"],
      threads: [makeThread({ id: "thread-1", worktreePath: "/link/repo" })],
    });

    expect(result.detach).toEqual([ThreadId.make("thread-1")]);
    expect(result.adopt).toEqual([]);
  });

  it("attaches sessions to an existing row reached through a different spelling", () => {
    const result = plan({
      canonicalizePath: (value) => value.replace(/^\/link\/worktrees/, "/worktrees"),
      gitWorktreePaths: ["/repo", "/worktrees/feature"],
      threads: [makeThread({ id: "thread-1", worktreePath: "/link/worktrees/feature" })],
      worktrees: [
        {
          projectId,
          worktreeId: WorktreeId.make("worktree-1"),
          worktreePath: "/worktrees/feature",
        },
      ],
    });

    expect(result.attach).toEqual([
      { threadId: ThreadId.make("thread-1"), worktreeId: WorktreeId.make("worktree-1") },
    ]);
    expect(result.adopt).toEqual([]);
    expect(result.detach).toEqual([]);
  });

  it("leaves sessions already linked to their directory's worktree alone", () => {
    const result = plan({
      gitWorktreePaths: ["/worktrees/feature"],
      threads: [
        makeThread({
          id: "thread-1",
          worktreeId: WorktreeId.make("worktree-1"),
          worktreePath: "/worktrees/feature",
        }),
      ],
      worktrees: [
        {
          projectId,
          worktreeId: WorktreeId.make("worktree-1"),
          worktreePath: "/worktrees/feature",
        },
      ],
    });

    expect(result).toEqual({ adopt: [], attach: [], detach: [] });
  });

  it("relinks a session whose recorded worktree no longer matches its directory", () => {
    const result = plan({
      gitWorktreePaths: ["/worktrees/feature"],
      threads: [
        makeThread({
          id: "thread-1",
          worktreeId: WorktreeId.make("worktree-stale"),
          worktreePath: "/worktrees/feature",
        }),
      ],
      worktrees: [
        {
          projectId,
          worktreeId: WorktreeId.make("worktree-1"),
          worktreePath: "/worktrees/feature",
        },
      ],
    });

    expect(result.attach).toEqual([
      { threadId: ThreadId.make("thread-1"), worktreeId: WorktreeId.make("worktree-1") },
    ]);
  });

  it("matches case-insensitively on case-insensitive filesystems only", () => {
    const input = {
      gitWorktreePaths: ["/worktrees/Feature"],
      threads: [makeThread({ id: "thread-1", worktreePath: "/worktrees/feature" })],
      worktrees: [
        {
          projectId,
          worktreeId: WorktreeId.make("worktree-1"),
          worktreePath: "/worktrees/Feature",
        },
      ],
    };

    expect(plan({ ...input, caseSensitiveFileSystem: false }).attach).toEqual([
      { threadId: ThreadId.make("thread-1"), worktreeId: WorktreeId.make("worktree-1") },
    ]);
    expect(plan({ ...input, caseSensitiveFileSystem: true }).detach).toEqual([
      ThreadId.make("thread-1"),
    ]);
  });

  it("ignores threads and worktrees belonging to other projects", () => {
    const result = plan({
      gitWorktreePaths: ["/worktrees/feature"],
      threads: [
        makeThread({
          id: "thread-1",
          projectId: otherProjectId,
          worktreePath: "/worktrees/other",
        }),
      ],
      worktrees: [
        {
          projectId: otherProjectId,
          worktreeId: WorktreeId.make("worktree-other"),
          worktreePath: "/worktrees/feature",
        },
      ],
    });

    expect(result).toEqual({ adopt: [], attach: [], detach: [] });
  });

  it("does nothing when git reports no worktrees at all", () => {
    const result = plan({
      gitWorktreePaths: [],
      threads: [makeThread({ id: "thread-1", worktreePath: "/worktrees/feature" })],
    });

    expect(result).toEqual({ adopt: [], attach: [], detach: [] });
  });

  it("leaves live worktrees without sessions unregistered", () => {
    const result = plan({ gitWorktreePaths: ["/repo", "/worktrees/untouched"] });

    expect(result).toEqual({ adopt: [], attach: [], detach: [] });
  });
});

describe("isCaseSensitiveFileSystem", () => {
  it("treats macOS and Windows as case-insensitive", () => {
    expect(isCaseSensitiveFileSystem("darwin")).toBe(false);
    expect(isCaseSensitiveFileSystem("win32")).toBe(false);
    expect(isCaseSensitiveFileSystem("linux")).toBe(true);
  });
});

describe("generatedWorktreeTitle", () => {
  const input = { branch: "ryco/fix-inbox", worktreePath: "/worktrees/ryco-1234abcd__abcde" };
  it("repairs an already-adopted generated directory label", () => {
    expect(generatedWorktreeTitle({ ...input, title: "ryco-1234abcd__abcde" })).toBe(input.branch);
  });
  it.each([
    {
      worktreeBranchPrefix: "team/tasks",
      branch: "team/tasks/fix-inbox",
      directory: "team-tasks-1234abcd__abcde",
    },
    {
      worktreeBranchPrefix: "team/tasks",
      branch: "ryco/fix-inbox",
      directory: "ryco-1234abcd__abcde",
    },
    { worktreeBranchPrefix: "", branch: "fix-inbox", directory: "1234abcd__abcde" },
  ])("repairs generated labels for $branch", ({ directory, ...settings }) => {
    expect(
      generatedWorktreeTitle({
        ...settings,
        worktreePath: `/worktrees/${directory}`,
        title: directory,
      }),
    ).toBe(settings.branch);
  });
  it("does not title configured temporary branches or unrelated namespaces", () => {
    expect(
      generatedWorktreeTitle({
        worktreeBranchPrefix: "team/tasks",
        branch: "team/tasks/1234abcd",
        worktreePath: "/worktrees/team-tasks-1234abcd__abcde",
      }),
    ).toBeNull();
    expect(
      generatedWorktreeTitle({
        ...input,
        worktreeBranchPrefix: "team/tasks",
        branch: "other/fix-inbox",
      }),
    ).toBeNull();
  });
  it("preserves custom titles, normal worktree names and temporary branches", () => {
    expect(generatedWorktreeTitle({ ...input, title: "My feature" })).toBeNull();
    expect(
      generatedWorktreeTitle({ ...input, worktreePath: "/worktrees/ryco-feature" }),
    ).toBeNull();
    expect(generatedWorktreeTitle({ ...input, branch: "ryco/1234abcd" })).toBeNull();
  });
});
