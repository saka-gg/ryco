import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  OrchestrationProjectShell,
  OrchestrationWorktreeShell,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import {
  describeInitialCommitFailure,
  INITIAL_COMMIT_MESSAGE,
  makeWorktreeOperations,
  minimalGitignore,
} from "./worktreeOperations.ts";

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

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A project folder with real Git under an isolated configuration: no system or user config,
 * and either a complete identity or one Git must refuse (`user.useConfigOnly` without values).
 */
async function gitFixture(input: {
  readonly identity: boolean;
  readonly files?: Readonly<Record<string, string>>;
}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-initialize-git-")));
  scratchDirectories.push(root);
  const workspaceRoot = path.join(root, "project");
  await mkdir(workspaceRoot);
  for (const [file, content] of Object.entries(input.files ?? {})) {
    await mkdir(path.dirname(path.join(workspaceRoot, file)), { recursive: true });
    await writeFile(path.join(workspaceRoot, file), content);
  }
  const globalConfig = path.join(root, "gitconfig");
  await writeFile(
    globalConfig,
    input.identity
      ? "[user]\n\tname = Ada\n\temail = ada@example.com\n[commit]\n\tgpgsign = false\n"
      : "[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgsign = false\n",
  );
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: ReadonlyArray<string>, extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync("git", args, { cwd: workspaceRoot, env: { ...env, ...extraEnv }, encoding: "utf8" });
  const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
    id: "project",
    title: "Project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const commands: OrchestrationCommand[] = [];
  let snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [project],
    threads: [],
    worktrees: [],
    updatedAt: NOW,
  };
  const operations = makeWorktreeOperations({
    projectionSnapshotQuery: {
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getShellSnapshot: () => Effect.sync(() => snapshot),
    },
    gitWorkflow: { localStatus: () => Effect.succeed({ isRepo: true, refName: "main" }) },
    vcsProvisioning: {
      initRepository: () => Effect.sync(() => void git(["init", "-q", "-b", "main"])),
    },
    gitDriver: {
      execute: (request: {
        readonly args: ReadonlyArray<string>;
        readonly env?: NodeJS.ProcessEnv;
      }) =>
        Effect.sync(() => {
          const result = git(request.args, request.env);
          return {
            exitCode: result.status ?? 1,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    },
    serverCommandId: (tag: string) => CommandId.make(`${tag}-${commands.length}`),
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
        return { sequence: commands.length };
      }),
    refreshGitStatus: () => Effect.void,
  } as unknown as Parameters<typeof makeWorktreeOperations>[0]);
  return { workspaceRoot, operations, commands, git, project };
}

describe.skipIf(!gitAvailable)("initializeGitForProject options", () => {
  it("writes a minimal .gitignore and makes the first commit", async () => {
    const f = await gitFixture({
      identity: true,
      files: { "plan.md": "# Plan\n", "node_modules/dep/index.js": "x", ".env": "SECRET=1" },
    });
    const result = await Effect.runPromise(
      f.operations.initializeGitForProject(f.project.id, {
        writeGitignore: true,
        initialCommit: true,
      }),
    );

    expect(result).toEqual({ initialCommitCreated: true });
    expect(await readFile(path.join(f.workspaceRoot, ".gitignore"), "utf8")).toBe(
      minimalGitignore(f.project.projectMetadataDir),
    );
    expect(f.git(["log", "--format=%s"]).stdout.trim()).toBe(INITIAL_COMMIT_MESSAGE);
    expect(f.git(["ls-files"]).stdout.trim().split("\n").toSorted()).toEqual([
      ".gitignore",
      "plan.md",
    ]);
    expect(f.commands.map((command) => command.type)).toContain("worktree.create");
  });

  it("never overwrites an existing .gitignore", async () => {
    const f = await gitFixture({ identity: true, files: { ".gitignore": "dist/\n" } });
    await Effect.runPromise(
      f.operations.initializeGitForProject(f.project.id, {
        writeGitignore: true,
        initialCommit: true,
      }),
    );
    expect(await readFile(path.join(f.workspaceRoot, ".gitignore"), "utf8")).toBe("dist/\n");
  });

  it("keeps the repository and explains a missing Git identity", async () => {
    const f = await gitFixture({ identity: false, files: { "plan.md": "# Plan\n" } });
    const result = await Effect.runPromise(
      f.operations.initializeGitForProject(f.project.id, { initialCommit: true }),
    );

    expect(result).toEqual({
      initialCommitCreated: false,
      commitError:
        "Git has no name or email on this machine. Set user.name and user.email, then commit.",
    });
    expect(f.git(["rev-parse", "--is-inside-work-tree"]).stdout.trim()).toBe("true");
    expect(f.commands.map((command) => command.type)).toContain("worktree.create");
  });

  it("leaves existing history and empty folders without a commit", async () => {
    const empty = await gitFixture({ identity: true });
    expect(
      await Effect.runPromise(
        empty.operations.initializeGitForProject(empty.project.id, { initialCommit: true }),
      ),
    ).toEqual({ initialCommitCreated: false });

    const existing = await gitFixture({ identity: true, files: { "a.txt": "a" } });
    existing.git(["init", "-q", "-b", "main"]);
    existing.git(["add", "--all"]);
    existing.git(["commit", "-q", "-m", "Earlier work"]);
    await writeFile(path.join(existing.workspaceRoot, "b.txt"), "b");
    expect(
      await Effect.runPromise(
        existing.operations.initializeGitForProject(existing.project.id, { initialCommit: true }),
      ),
    ).toEqual({ initialCommitCreated: false });
    expect(existing.git(["log", "--format=%s"]).stdout.trim()).toBe("Earlier work");
  });

  it("answers Initialize Git without options exactly as before", async () => {
    const f = await gitFixture({ identity: true, files: { "plan.md": "# Plan\n" } });
    expect(await Effect.runPromise(f.operations.initializeGitForProject(f.project.id))).toEqual({});
    expect(f.git(["rev-parse", "--verify", "--quiet", "HEAD"]).status).not.toBe(0);
    await expect(readFile(path.join(f.workspaceRoot, ".gitignore"), "utf8")).rejects.toThrow();
  });
});

describe("initial commit failures", () => {
  it.each([
    [
      "Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email \"you@example.com\"\n\nfatal: unable to auto-detect email address (got 'ada@mac.(none)')",
      "Git has no name or email on this machine. Set user.name and user.email, then commit.",
    ],
    [
      "error: gpg failed to sign the data\nfatal: failed to write commit object",
      "Git could not sign the first commit. Check your commit signing setup, then commit.",
    ],
    ["git commit timed out.", expect.stringContaining("took too long")],
    ["husky - pre-commit hook exited with code 1", expect.stringContaining("Git hook")],
    [
      "fatal: something unexpected\nmore detail",
      "The first commit failed: something unexpected. Fix it, then commit.",
    ],
    ["", "The first commit failed. Commit from a terminal to see why."],
  ])("explains %j", (detail, message) => {
    expect(describeInitialCommitFailure(detail)).toEqual(message);
  });

  it("ignores Ryco's own worktrees and secrets in a new .gitignore", () => {
    expect(minimalGitignore(undefined)).toBe(
      ".DS_Store\nnode_modules/\n.env\n.env.*\n/.ryco/worktrees/\n",
    );
    expect(minimalGitignore("meta\\ryco/")).toContain("/meta/ryco/worktrees/\n");
  });
});
