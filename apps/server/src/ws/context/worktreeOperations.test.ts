import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  OrchestrationProjectShell,
  OrchestrationWorktreeShell,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { makeWorktreeOperations } from "./worktreeOperations.ts";

const NOW = "2026-09-15T00:00:00.000Z";
function fixture() {
  const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id: "project",
    title: "Project",
    workspaceRoot: "/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  let snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [project],
    threads: [],
    worktrees: [],
    updatedAt: NOW,
  };
  const commands: OrchestrationCommand[] = [];
  let isRepo = true;
  let sequence = 0;
  const operations = makeWorktreeOperations({
    projectionSnapshotQuery: {
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getShellSnapshot: () => Effect.sync(() => snapshot),
    },
    gitWorkflow: {
      localStatus: () => Effect.succeed({ isRepo, refName: "trunk" }),
      listWorktreePaths: () => Effect.succeed(isRepo ? [project.workspaceRoot] : []),
    },
    vcsProvisioning: { initRepository: () => Effect.void },
    serverSettings: { getSettings: Effect.succeed({ worktreeBranchPrefix: "ryco" }) },
    serverCommandId: (tag: string) => CommandId.make(`${tag}-${++sequence}`),
    dispatchNormalizedCommand: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        if (command.type === "worktree.create") {
          const row = Schema.decodeUnknownSync(OrchestrationWorktreeShell)({
            ...command,
            title: command.branch,
            updatedAt: command.createdAt,
            archivedAt: null,
            manualPosition: 0,
          });
          snapshot = { ...snapshot, worktrees: [...(snapshot.worktrees ?? []), row] };
        }
        return { sequence };
      }),
    refreshGitStatus: () => Effect.void,
  } as unknown as Parameters<typeof makeWorktreeOperations>[0]);
  return {
    operations,
    commands,
    project,
    get snapshot() {
      return snapshot;
    },
    set snapshot(value) {
      snapshot = value;
    },
    markNonGit: () => {
      isRepo = false;
    },
  };
}

describe("main workspace recovery", () => {
  it("registers a legacy project's root once using its current branch", async () => {
    const f = fixture();
    await Effect.runPromise(f.operations.reconcileProjectWorktrees(f.project.id));
    await Effect.runPromise(f.operations.reconcileProjectWorktrees(f.project.id));
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({
      type: "worktree.create",
      worktreeId: "worktree-project-main",
      projectId: "project",
      branch: "trunk",
      origin: "main",
      worktreePath: null,
    });
  });
  it("shares the recovered main workspace with repository initialization", async () => {
    const f = fixture();
    await Effect.runPromise(f.operations.reconcileProjectWorktrees(f.project.id));
    await Effect.runPromise(f.operations.initializeGitForProject(f.project.id));
    expect(f.commands.filter((command) => command.type === "worktree.create")).toHaveLength(1);
  });
  it("does not register non-repositories", async () => {
    const f = fixture();
    f.markNonGit();
    await Effect.runPromise(f.operations.reconcileProjectWorktrees(f.project.id));
    expect(f.commands).toEqual([]);
  });
  it("does not overwrite a workspace that already owns the stable main ID", async () => {
    const f = fixture();
    f.snapshot = {
      ...f.snapshot,
      worktrees: [
        Schema.decodeUnknownSync(OrchestrationWorktreeShell)({
          worktreeId: "worktree-project-main",
          projectId: ProjectId.make("other"),
          title: "Other",
          branch: "topic",
          worktreePath: "/other",
          origin: "manual",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          manualPosition: 0,
        }),
      ],
    };
    await expect(
      Effect.runPromise(f.operations.reconcileProjectWorktrees(f.project.id)),
    ).rejects.toThrow("already in use");
    expect(f.commands).toEqual([]);
  });
});
