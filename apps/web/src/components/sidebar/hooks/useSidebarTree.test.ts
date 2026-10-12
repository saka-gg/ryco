import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@ryco/contracts";
import { DEFAULT_INTERACTION_MODE, type Project } from "../../../types";
import { DraftId } from "../../../composerDraftStore";
import { composeSidebarTree, type SidebarTreeThread, type SidebarWorktree } from "./useSidebarTree";

const environmentId = EnvironmentId.make("environment-local");

describe("composeSidebarTree", () => {
  it("groups sessions by worktree while retaining derived bucket metadata", () => {
    const tree = composeSidebarTree({
      diffStatsByWorktreeIdRecord: {
        "worktree-main": null,
      },
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.make("thread-done"),
          statusPill: { label: "Completed", colorClass: "", dotClass: "", pulse: false },
          worktreeId: "worktree-main",
        }),
      ],
      worktrees: [
        makeWorktree({
          worktreeId: "worktree-main",
        }),
      ],
    });

    const worktree = tree.projects[0]?.worktrees[0];
    expect(worktree?.buckets.done.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-done"),
    ]);
    expect(worktree?.sessions.map((thread) => thread.id)).toEqual([ThreadId.make("thread-done")]);
    expect(worktree?.aggregateStatus).toBe("done");
  });

  it("uses manual bucket overrides before runtime-derived buckets", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          manualStatusBucket: "review",
          statusPill: { label: "Working", colorClass: "", dotClass: "", pulse: false },
          worktreeId: "worktree-main",
        }),
      ],
      worktrees: [makeWorktree()],
    });

    expect(tree.projects[0]?.worktrees[0]?.buckets.review).toHaveLength(1);
    expect(tree.projects[0]?.worktrees[0]?.buckets.in_progress).toHaveLength(0);
  });

  it("flattens sessions for non-git projects", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), false]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.make("thread-flat"),
          worktreeId: null,
        }),
        makeThread({
          archivedAt: "2026-05-02T00:00:00.000Z",
          id: ThreadId.make("thread-archived"),
          worktreeId: null,
        }),
      ],
      worktrees: [],
    });

    expect(tree.projects[0]?.flatSessions.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-flat"),
    ]);
    expect(tree.projects[0]?.archivedSessions.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-archived"),
    ]);
    expect(tree.projects[0]?.worktrees).toHaveLength(0);
  });

  it("pins main before manually ordered worktrees", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [],
      worktrees: [
        makeWorktree({
          branch: "feature/a",
          manualPosition: 0,
          origin: "branch",
          worktreeId: "worktree-feature",
          worktreePath: "/repo/project-feature",
        }),
        makeWorktree({
          branch: "main",
          manualPosition: 10,
          origin: "main",
          worktreeId: "worktree-main",
        }),
      ],
    });

    expect(tree.projects[0]?.worktrees.map((entry) => entry.worktree.worktreeId)).toEqual([
      "worktree-main",
      "worktree-feature",
    ]);
  });

  it("synthesizes a main worktree for legacy git sidebar data without worktree rows", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          branch: "trunk",
          statusPill: { label: "Completed", colorClass: "", dotClass: "", pulse: false },
          worktreePath: null,
        }),
      ],
      worktrees: [],
    });

    const worktree = tree.projects[0]?.worktrees[0];
    expect(worktree?.worktree.origin).toBe("main");
    expect(worktree?.worktree.branch).toBe("trunk");
    expect(worktree?.buckets.done).toHaveLength(1);
  });

  it("keeps drafts outside worktree synthesis and preserves the main branch label", () => {
    const draft = makeThread({
      id: ThreadId.make("thread-draft"),
      branch: "release/next",
      createdAt: "2026-05-03T00:00:00.000Z",
      draftId: DraftId.make("draft-new-thread"),
      title: "New thread",
      updatedAt: "2026-05-03T00:00:00.000Z",
    });
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [draft],
      worktrees: [makeWorktree()],
    });

    const project = tree.projects[0];
    expect(project?.draftSessions).toEqual([draft]);
    expect(project?.worktrees).toHaveLength(1);
    expect(project?.worktrees[0]?.worktree.branch).toBe("main");
    expect(project?.worktrees[0]?.sessions).toEqual([]);
  });

  it("keeps changed branches in the original project directory under one row", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.make("thread-main"),
          branch: "main",
          worktreePath: null,
        }),
        makeThread({
          id: ThreadId.make("thread-feature"),
          branch: "feature/legacy",
          updatedAt: "2026-05-02T00:00:00.000Z",
          worktreePath: null,
        }),
      ],
      worktrees: [],
    });

    expect(tree.projects[0]?.worktrees.map((entry) => entry.worktree.origin)).toEqual(["main"]);
    expect(tree.projects[0]?.worktrees[0]?.worktree.branch).toBe("feature/legacy");
    expect(tree.projects[0]?.worktrees[0]?.sessions.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-main"),
      ThreadId.make("thread-feature"),
    ]);
  });

  it("merges an explicit project-root path with the original project row", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [],
      worktrees: [
        makeWorktree({
          origin: "main",
          worktreeId: "worktree-main",
          worktreePath: null,
        }),
        makeWorktree({
          branch: "feature/root",
          origin: "branch",
          updatedAt: "2026-05-02T00:00:00.000Z",
          worktreeId: "worktree-root-path",
          worktreePath: "/repo/project/",
        }),
      ],
    });

    expect(tree.projects[0]?.worktrees).toHaveLength(1);
    expect(tree.projects[0]?.worktrees[0]?.worktree.origin).toBe("main");
    expect(tree.projects[0]?.worktrees[0]?.worktree.branch).toBe("feature/root");
  });

  it("binds a thread to its directory before a stale worktree id", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.make("thread-moved"),
          branch: "feature/b",
          worktreeId: "worktree-a",
          worktreePath: "/repo/worktrees/b",
        }),
      ],
      worktrees: [
        makeWorktree({
          branch: "feature/a",
          origin: "branch",
          worktreeId: "worktree-a",
          worktreePath: "/repo/worktrees/a",
        }),
        makeWorktree({
          branch: "feature/b",
          origin: "branch",
          worktreeId: "worktree-b",
          worktreePath: "/repo/worktrees/b",
        }),
      ],
    });

    const worktrees = tree.projects[0]?.worktrees ?? [];
    expect(
      worktrees.find((entry) => entry.worktree.worktreePath === "/repo/worktrees/a")?.sessions,
    ).toHaveLength(0);
    expect(
      worktrees
        .find((entry) => entry.worktree.worktreePath === "/repo/worktrees/b")
        ?.sessions.map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-moved")]);
  });

  it("assigns every session to its node in one pass across directory, link and branch rules", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({ id: ThreadId.make("on-main"), branch: "main" }),
        makeThread({
          id: ThreadId.make("by-directory"),
          branch: "feature/a",
          worktreePath: "/repo/worktrees/a/",
        }),
        makeThread({
          id: ThreadId.make("by-link"),
          branch: "feature/b",
          worktreeId: "worktree-b",
          worktreePath: "/elsewhere/b",
        }),
        makeThread({
          id: ThreadId.make("archived"),
          branch: "feature/a",
          worktreePath: "/repo/worktrees/a",
          archivedAt: "2026-05-02T00:00:00.000Z",
        }),
      ],
      worktrees: [
        makeWorktree({ worktreeId: "worktree-main", worktreePath: null }),
        makeWorktree({
          branch: "feature/a",
          origin: "branch",
          worktreeId: "worktree-a",
          worktreePath: "/repo/worktrees/a",
        }),
        makeWorktree({
          branch: "feature/b",
          origin: "branch",
          worktreeId: "worktree-b",
          worktreePath: "/repo/worktrees/b",
        }),
      ],
    });

    const sessionsByNode = new Map(
      (tree.projects[0]?.worktrees ?? []).map((entry) => [
        entry.worktree.worktreeId,
        {
          sessions: entry.sessions.map((thread) => thread.id),
          archived: entry.archivedSessions.map((thread) => thread.id),
        },
      ]),
    );
    expect(sessionsByNode.get("worktree-main")?.sessions).toEqual(["on-main"]);
    expect(sessionsByNode.get("worktree-a")).toEqual({
      sessions: ["by-directory"],
      archived: ["archived"],
    });
    expect(sessionsByNode.get("worktree-b")?.sessions).toEqual(["by-link"]);
  });

  it("keeps a session on its linked worktree when its directory is spelled differently", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.make("thread-symlinked"),
          branch: "feature/a",
          worktreeId: "worktree-a",
          // The same directory reached through a symlinked home.
          worktreePath: "/link/worktrees/a",
        }),
      ],
      worktrees: [
        makeWorktree({
          branch: "feature/a",
          origin: "branch",
          worktreeId: "worktree-a",
          worktreePath: "/repo/worktrees/a",
        }),
      ],
    });

    const worktrees = tree.projects[0]?.worktrees ?? [];
    expect(
      worktrees
        .find((entry) => entry.worktree.worktreeId === "worktree-a")
        ?.sessions.map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-symlinked")]);
    // No phantom node splits off for the second spelling of the directory.
    expect(worktrees.filter((entry) => entry.sessions.length > 0)).toHaveLength(1);
  });

  it("renders one session when duplicate inputs share a scoped thread id", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-duplicate"),
      worktreePath: null,
    });
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [thread, { ...thread, title: "Duplicate draft" }],
      worktrees: [makeWorktree()],
    });

    expect(tree.projects[0]?.worktrees[0]?.sessions).toHaveLength(1);
    expect(tree.projects[0]?.worktrees[0]?.sessions[0]?.title).toBe("Thread");
  });

  it("keeps identical path strings on different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const tree = composeSidebarTree({
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [],
      worktrees: [
        makeWorktree({
          environmentId,
          origin: "branch",
          sourceProjectCwd: "/repo/project",
          worktreeId: "worktree-local",
          worktreePath: "/repo/shared",
        }),
        makeWorktree({
          environmentId: remoteEnvironmentId,
          origin: "branch",
          sourceProjectCwd: "/repo/project",
          worktreeId: "worktree-remote",
          worktreePath: "/repo/shared",
        }),
      ],
    });

    expect(tree.projects[0]?.worktrees.map((entry) => entry.worktree.worktreeId)).toEqual([
      "worktree-local",
      "worktree-remote",
    ]);
  });

  it("preserves Unix path case while normalizing Windows directory identity", () => {
    const unixTree = composeSidebarTree({
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [],
      worktrees: [
        makeWorktree({
          origin: "branch",
          worktreeId: "worktree-upper",
          worktreePath: "/repo/Feature",
        }),
        makeWorktree({
          origin: "branch",
          worktreeId: "worktree-lower",
          worktreePath: "/repo/feature",
        }),
      ],
    });
    const windowsTree = composeSidebarTree({
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject({ cwd: "C:\\repo\\project" })],
      threads: [],
      worktrees: [
        makeWorktree({
          origin: "branch",
          worktreeId: "worktree-windows-a",
          worktreePath: "C:\\Repo\\Feature\\",
        }),
        makeWorktree({
          origin: "branch",
          worktreeId: "worktree-windows-b",
          worktreePath: "c:/repo/feature",
        }),
      ],
    });

    expect(unixTree.projects[0]?.worktrees).toHaveLength(2);
    expect(windowsTree.projects[0]?.worktrees).toHaveLength(1);
  });

  it("synthesizes a path worktree for threads materialized without a worktree row", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.make("thread-worktree"),
          branch: "feature/materialized",
          worktreePath: "/repo/.ryco/worktrees/feature-materialized",
        }),
      ],
      worktrees: [],
    });

    const worktree = tree.projects[0]?.worktrees[0];
    expect(worktree?.worktree.origin).toBe("branch");
    expect(worktree?.worktree.worktreePath).toBe("/repo/.ryco/worktrees/feature-materialized");
    expect(worktree?.sessions.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-worktree"),
    ]);
  });

  it("merges duplicate base worktree rows for the same project", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [
        makeThread({
          id: ThreadId.make("thread-a"),
          branch: "master",
          worktreeId: "worktree-main-explicit",
          worktreePath: null,
        }),
        makeThread({
          id: ThreadId.make("thread-b"),
          branch: "master",
          worktreeId: null,
          worktreePath: null,
        }),
      ],
      worktrees: [
        makeWorktree({
          branch: "master",
          origin: "main",
          worktreeId: "worktree-main-explicit",
          worktreePath: null,
        }),
        makeWorktree({
          branch: "master",
          origin: "main",
          worktreeId: "worktree-main-duplicate",
          worktreePath: null,
        }),
      ],
    });

    expect(tree.projects[0]?.worktrees.map((entry) => entry.worktree.branch)).toEqual(["master"]);
    expect(tree.projects[0]?.worktrees[0]?.sessions.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-a"),
      ThreadId.make("thread-b"),
    ]);
  });

  it("keeps the newest title when equivalent worktrees are merged", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [],
      worktrees: [
        makeWorktree({
          title: "Old title",
          updatedAt: "2026-05-01T00:00:00.000Z",
          worktreeId: "worktree-main-stale",
        }),
        makeWorktree({
          title: "New title",
          updatedAt: "2026-05-02T00:00:00.000Z",
          worktreeId: "worktree-main-renamed",
        }),
      ],
    });

    expect(tree.projects[0]?.worktrees[0]?.worktree.title).toBe("New title");
  });

  it("keeps the real projected worktree id when merging with a synthesized row", () => {
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs: Date.parse("2026-05-08T00:00:00.000Z"),
      projects: [makeProject()],
      threads: [],
      worktrees: [
        makeWorktree({
          origin: "main",
          worktreeId: "main:project-1:main",
          worktreePath: null,
        }),
        makeWorktree({
          origin: "main",
          title: "Renamable main",
          worktreeId: "worktree-project-1-main",
          worktreePath: null,
        }),
      ],
    });

    expect(tree.projects[0]?.worktrees[0]?.worktree.worktreeId).toBe("worktree-project-1-main");
    expect(tree.projects[0]?.worktrees[0]?.worktree.title).toBe("Renamable main");
  });

  it("suggests archive only for stale all-done worktrees", () => {
    const nowMs = Date.parse("2026-05-08T00:00:00.000Z");
    const tree = composeSidebarTree({
      isGitRepoByProjectId: new Map([[ProjectId.make("project-1"), true]]),
      nowMs,
      projects: [makeProject()],
      threads: [
        makeThread({
          statusPill: { label: "Completed", colorClass: "", dotClass: "", pulse: false },
          updatedAt: "2026-04-30T23:59:59.000Z",
          worktreeId: "worktree-main",
        }),
      ],
      worktrees: [makeWorktree()],
    });

    expect(tree.projects[0]?.worktrees[0]?.shouldSuggestArchive).toBe(true);
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
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
    ...overrides,
  };
}

function makeThread(overrides: Partial<SidebarTreeThread> = {}): SidebarTreeThread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    manualStatusBucket: null,
    statusPill: null,
    worktreeId: null,
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<SidebarWorktree> = {}): SidebarWorktree {
  return {
    worktreeId: "worktree-main",
    projectId: ProjectId.make("project-1"),
    branch: "main",
    worktreePath: null,
    origin: "main",
    archivedAt: null,
    manualPosition: 0,
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}
