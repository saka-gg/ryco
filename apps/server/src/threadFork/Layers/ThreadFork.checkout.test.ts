import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CommandId,
  GitCommandError,
  ProjectId,
  ThreadForkError,
  type ThreadForkInput,
  ThreadId,
  VcsProcessSpawnError,
  WorktreeId,
} from "@ryco/contracts";
import { Effect, Option, PlatformError } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { threadForkIdentity } from "../forkLedger.ts";
import { THREAD_FORK_RETRY_WINDOW_MS } from "./ThreadFork.ts";
import {
  createForkHarness,
  type ForkHarness,
  type ForkHarnessOptions,
  historyAt,
  seedCompletedTurn,
  seedProject,
  seedThread,
} from "../threadFork.fixtures.ts";

const roots: string[] = [];
const harnesses: ForkHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const projectId = ProjectId.make("fork-git-project");
const sourceId = ThreadId.make("fork-git-source");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const exists = (candidate: string) =>
  stat(candidate).then(
    () => true,
    () => false,
  );

/** A repository with one commit: `tracked.txt` and a `.gitignore` that ignores `.env`. */
async function repository(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Fork fixture");
  git(repo, "config", "user.email", "fork@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repo, ".gitignore"), ".env\n");
  await writeFile(path.join(repo, "tracked.txt"), "v1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  return { root, repo, worktrees: path.join(root, "worktrees") };
}

async function harness(root: string, options: ForkHarnessOptions = {}) {
  const created = await createForkHarness({
    ...options,
    settings: { worktreeRoot: path.join(root, "worktrees"), ...options.settings },
  });
  harnesses.push(created);
  return created;
}

/** Everything about a repository a fork must not change. */
function repositoryState(repo: string) {
  return {
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: git(repo, "rev-parse", "HEAD"),
  };
}

const forkWorktrees = (repo: string) =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("branch refs/heads/ryco/fork-"));

const input = (
  forkKey: string,
  sourceMessageId: ThreadForkInput["sourceMessageId"],
  destination: ThreadForkInput["destination"],
): ThreadForkInput => ({ forkKey, sourceThreadId: sourceId, sourceMessageId, destination });

const failure = (h: ForkHarness, request: ThreadForkInput) =>
  h.run(Effect.flip(h.forks.fork(request))).then((error) => {
    expect(error).toBeInstanceOf(ThreadForkError);
    return error;
  });

describe("ThreadFork checkouts", () => {
  it("shares the current checkout without touching dirty files or running Git mutations", async () => {
    const { root, repo } = await repository("ryco-fork-current-");
    const feature = path.join(root, "feature");
    git(repo, "worktree", "add", "-b", "feature", feature);
    await writeFile(path.join(feature, "tracked.txt"), "uncommitted work\n");
    await writeFile(path.join(feature, "scratch.txt"), "untracked work\n");
    const gitCalls: string[] = [];
    const h = await harness(root, {
      gitWorkflow: (base) => ({
        createWorktree: (request) => (
          gitCalls.push("createWorktree"),
          base.createWorktree(request)
        ),
        removeWorktree: (request) => (
          gitCalls.push("removeWorktree"),
          base.removeWorktree(request)
        ),
        deleteBranch: (request) => (gitCalls.push("deleteBranch"), base.deleteBranch(request)),
      }),
    });
    await seedProject(h, { projectId, workspaceRoot: repo });
    const worktreeId = WorktreeId.make("worktree-feature");
    await h.run(
      h.engine.dispatch({
        type: "worktree.create",
        commandId: CommandId.make("seed-feature-worktree"),
        worktreeId,
        projectId,
        branch: "feature",
        worktreePath: feature,
        origin: "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: historyAt(0),
      }),
    );
    await seedThread(h, {
      threadId: sourceId,
      projectId,
      instance: "opencode",
      worktreePath: feature,
      branch: "feature",
    });
    await h.run(
      h.engine.dispatch({
        type: "thread.attach-to-worktree",
        commandId: CommandId.make("seed-feature-attach"),
        threadId: sourceId,
        worktreeId,
        attachedAt: historyAt(0),
      }),
    );
    const turn = await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
    const before = { main: repositoryState(repo), feature: repositoryState(feature) };

    const result = await h.run(
      h.forks.fork(input("fork-key-current-001", turn.replyId, { kind: "current-checkout" })),
    );

    expect(result.checkout).toEqual({
      kind: "current-checkout",
      worktreePath: feature,
      branch: "feature",
    });
    const shell = await h.shell(result.threadId);
    expect(shell).toMatchObject({ worktreeId, worktreePath: feature, branch: "feature" });
    expect(gitCalls).toEqual([]);
    expect({ main: repositoryState(repo), feature: repositoryState(feature) }).toEqual(before);
    expect(await readFile(path.join(feature, "tracked.txt"), "utf8")).toBe("uncommitted work\n");
  });

  it("starts a new worktree from the turn's checkpoint without ignored files or touching other checkouts", async () => {
    const { root, repo, worktrees } = await repository("ryco-fork-checkpoint-");
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    // The turn's work: a tracked change, a new file, and an ignored secret.
    await writeFile(path.join(repo, "tracked.txt"), "v2 from the turn\n");
    await writeFile(path.join(repo, "notes.txt"), "notes from the turn\n");
    await writeFile(path.join(repo, ".env"), "SECRET=1\n");
    const checkpointRef = checkpointRefForThreadTurn(sourceId, 1);
    await h.run(h.checkpoints.captureCheckpoint({ cwd: repo, checkpointRef }));
    const turn = await seedCompletedTurn(h, {
      threadId: sourceId,
      index: 1,
      instance: "opencode",
      checkpoint: { ref: checkpointRef, count: 1 },
    });
    // The source moves on after the turn: a later commit.
    await writeFile(path.join(repo, "tracked.txt"), "v3 committed later\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "later");
    const laterCommit = git(repo, "rev-parse", "HEAD");
    const unrelated = path.join(root, "unrelated");
    git(repo, "worktree", "add", "-b", "unrelated", unrelated);
    await writeFile(path.join(unrelated, "other.txt"), "someone else's work\n");
    const before = { source: repositoryState(repo), unrelated: repositoryState(unrelated) };

    const result = await h.run(
      h.forks.fork(
        input("fork-key-checkpoint1", turn.replyId, {
          kind: "new-worktree",
          start: { kind: "checkpoint" },
        }),
      ),
    );

    const identity = threadForkIdentity("fork-key-checkpoint1");
    expect(result.checkout).toMatchObject({
      kind: "new-worktree",
      worktreeId: identity.worktreeId,
      branch: identity.branch("ryco"),
      start: "checkpoint",
      baseRef: laterCommit,
    });
    if (result.checkout.kind !== "new-worktree") throw new Error("expected a new worktree");
    const created = result.checkout.worktreePath;
    expect(created.startsWith(`${worktrees}${path.sep}`)).toBe(true);
    // Files match the end of the turn; ignored files are never copied; HEAD is the source's
    // current commit, so the later commit shows as an uncommitted change.
    expect(await readFile(path.join(created, "tracked.txt"), "utf8")).toBe("v2 from the turn\n");
    expect(await readFile(path.join(created, "notes.txt"), "utf8")).toBe("notes from the turn\n");
    expect(await exists(path.join(created, ".env"))).toBe(false);
    expect(git(created, "rev-parse", "HEAD")).toBe(laterCommit);
    expect(git(created, "branch", "--show-current")).toBe(identity.branch("ryco"));
    expect(git(created, "diff", "--cached", "--name-only")).toBe("");
    expect(git(created, "diff", "--name-only")).toBe("tracked.txt");
    expect(git(created, "ls-files", "--others", "--exclude-standard")).toBe("notes.txt");
    // The source checkout and an unrelated worktree are untouched (beyond the new worktree's
    // registration), and the fork's pin refs are gone.
    const after = { source: repositoryState(repo), unrelated: repositoryState(unrelated) };
    expect(after.source.status).toBe(before.source.status);
    expect(after.source.head).toBe(before.source.head);
    expect(after.unrelated).toEqual({
      ...before.unrelated,
      worktrees: after.unrelated.worktrees,
      refs: after.unrelated.refs,
    });
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
    expect(await readFile(path.join(repo, ".env"), "utf8")).toBe("SECRET=1\n");
    const shell = await h.shell(result.threadId);
    expect(shell).toMatchObject({
      worktreeId: identity.worktreeId,
      worktreePath: created,
      branch: identity.branch("ryco"),
    });
  });

  it("refuses an invalid base ref and a taken branch name without creating or removing anything", async () => {
    const { root, repo } = await repository("ryco-fork-refuse-");
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const turn = await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
    const before = repositoryState(repo);

    const invalid = await failure(
      h,
      input("fork-key-bad-ref-0001", turn.replyId, {
        kind: "new-worktree",
        start: { kind: "base-ref", baseRef: "no-such-branch" },
      }),
    );
    expect(invalid.reason).toBe("base-ref-invalid");
    expect(await h.ledgerRows()).toEqual([]);
    expect(repositoryState(repo)).toEqual(before);

    const checkpointless = await failure(
      h,
      input("fork-key-no-checkpoint", turn.replyId, {
        kind: "new-worktree",
        start: { kind: "checkpoint" },
      }),
    );
    expect(checkpointless.reason).toBe("checkpoint-unavailable");
    expect(repositoryState(repo)).toEqual(before);

    // Someone else's branch already has the name this fork would create.
    const takenKey = "fork-key-taken-branch";
    const takenBranch = threadForkIdentity(takenKey).branch("ryco");
    git(repo, "branch", takenBranch);
    const withBranch = repositoryState(repo);
    const taken = await failure(
      h,
      input(takenKey, turn.replyId, {
        kind: "new-worktree",
        start: { kind: "base-ref", baseRef: "main" },
      }),
    );
    expect(taken).toMatchObject({ reason: "preparation-failed", retryable: false });
    expect(repositoryState(repo)).toEqual(withBranch);
    expect(git(repo, "rev-parse", takenBranch)).toBe(before.head);
  });

  it("cleans up only its own worktree when Git fails, and a retry creates exactly one", async () => {
    const { root, repo } = await repository("ryco-fork-cleanup-");
    const unrelated = path.join(root, "unrelated");
    git(repo, "worktree", "add", "-b", "unrelated", unrelated);
    let failAfterCreate = true;
    const h = await harness(root, {
      gitWorkflow: (base) => ({
        ...base,
        // Git created the checkout, then a later setup step (e.g. submodules) failed.
        createWorktree: (request) =>
          base.createWorktree(request).pipe(
            Effect.flatMap((created) =>
              failAfterCreate
                ? Effect.fail(
                    new GitCommandError({
                      operation: "test.createWorktree",
                      command: "git submodule update",
                      cwd: request.cwd,
                      detail: "simulated setup failure",
                    }),
                  )
                : Effect.succeed(created),
            ),
          ),
      }),
    });
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const turn = await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
    const request = input("fork-key-cleanup-0001", turn.replyId, {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "main" },
    });
    const branch = threadForkIdentity(request.forkKey).branch("ryco");
    const unrelatedBefore = repositoryState(unrelated);

    const error = await failure(h, request);
    expect(error).toMatchObject({
      reason: "preparation-failed",
      retryable: true,
      attempt: "stopped",
    });
    expect(forkWorktrees(repo)).toEqual([]);
    expect(git(repo, "branch", "--list", branch)).toBe("");
    // A retry starts from the pinned commit again, so the pin stays until the fork settles.
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/ryco/forks")).toMatch(/\/base$/);
    expect(git(repo, "branch", "--list", "unrelated")).toContain("unrelated");
    expect(repositoryState(unrelated).status).toBe(unrelatedBefore.status);
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "failed" }]);
    expect(await h.shell(threadForkIdentity(request.forkKey).forkThreadId)).toBeUndefined();

    failAfterCreate = false;
    const [result, joined] = await Promise.all([
      h.run(h.forks.fork(request)),
      h.run(h.forks.fork(request)),
    ]);
    expect(joined.threadId).toBe(result.threadId);
    const replay = await h.run(h.forks.fork(request));
    expect(replay).toMatchObject({ threadId: result.threadId, replayed: true });
    expect(forkWorktrees(repo)).toEqual([`branch refs/heads/${branch}`]);
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "completed" }]);
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
  });

  it("recovers a run that stopped after creating its worktree without creating a second one", async () => {
    const { root, repo } = await repository("ryco-fork-resume-");
    const databasePath = path.join(root, "state.sqlite");
    const settings = { worktreeRoot: path.join(root, "worktrees") };
    const request = input("fork-key-resume-00001", `${sourceId}-reply-1` as never, {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "main" },
    });
    const first = await createForkHarness({
      databasePath,
      settings,
      service: {
        onRunPoint: (point) =>
          point === "checkout-created" ? Effect.die(new Error("simulated crash")) : Effect.void,
      },
    });
    try {
      await seedProject(first, { projectId, workspaceRoot: repo });
      await seedThread(first, { threadId: sourceId, projectId, instance: "opencode" });
      await seedCompletedTurn(first, { threadId: sourceId, index: 1, instance: "opencode" });
      const error = await failure(first, request);
      expect(error.retryable).toBe(true);
      expect(await first.ledgerRows()).toEqual([
        { forkKey: request.forkKey, phase: "checkout-preparing" },
      ]);
      expect(forkWorktrees(repo)).toHaveLength(1);
    } finally {
      await first.dispose();
    }

    const second = await harness(root, { databasePath, settings });
    await second.run(second.forks.recover());
    expect(await second.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "completed" }]);
    const branch = threadForkIdentity(request.forkKey).branch("ryco");
    expect(forkWorktrees(repo)).toEqual([`branch refs/heads/${branch}`]);
    const replay = await second.run(second.forks.fork(request));
    expect(replay.replayed).toBe(true);
    if (replay.checkout.kind !== "new-worktree") throw new Error("expected a new worktree");
    expect(await readFile(path.join(replay.checkout.worktreePath, "tracked.txt"), "utf8")).toBe(
      "v1\n",
    );
  });
});

describe("ThreadFork checkouts that fail", () => {
  it("refuses a checkpoint start once the original thread's checkout was removed, writing nothing", async () => {
    const { root, repo } = await repository("ryco-fork-removed-source-");
    const feature = path.join(root, "feature");
    git(repo, "worktree", "add", "-b", "feature", feature);
    const h = await harness(root);
    await seedProject(h, { projectId, workspaceRoot: repo });
    const worktreeId = WorktreeId.make("worktree-removed-feature");
    await h.run(
      h.engine.dispatch({
        type: "worktree.create",
        commandId: CommandId.make("seed-removed-feature-worktree"),
        worktreeId,
        projectId,
        branch: "feature",
        worktreePath: feature,
        origin: "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: historyAt(0),
      }),
    );
    await seedThread(h, {
      threadId: sourceId,
      projectId,
      instance: "opencode",
      worktreePath: feature,
      branch: "feature",
    });
    await h.run(
      h.engine.dispatch({
        type: "thread.attach-to-worktree",
        commandId: CommandId.make("seed-removed-feature-attach"),
        threadId: sourceId,
        worktreeId,
        attachedAt: historyAt(0),
      }),
    );
    await writeFile(path.join(feature, "tracked.txt"), "turn work\n");
    const checkpointRef = checkpointRefForThreadTurn(sourceId, 1);
    await h.run(h.checkpoints.captureCheckpoint({ cwd: feature, checkpointRef }));
    const turn = await seedCompletedTurn(h, {
      threadId: sourceId,
      index: 1,
      instance: "opencode",
      checkpoint: { ref: checkpointRef, count: 1 },
    });
    // The feature worktree is removed (e.g. after its pull request merged).
    git(repo, "worktree", "remove", "--force", feature);

    const error = await failure(
      h,
      input("fork-key-removed-source", turn.replyId, {
        kind: "new-worktree",
        start: { kind: "checkpoint" },
      }),
    );
    // Never "busy, try again": the checkpoint cannot be placed, a branch or commit can.
    expect(error).toMatchObject({
      reason: "checkpoint-unavailable",
      retryable: false,
      attempt: "none",
    });
    expect(error.message).toContain("checkout was removed");
    expect(await h.ledgerRows()).toEqual([]);
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
  });

  it("releases its pinned commits when preparing the worktree fails for good", async () => {
    const { root, repo } = await repository("ryco-fork-pins-final-");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    let movedProject: () => Promise<void> = async () => {};
    const h = await harness(root, {
      service: {
        onRunPoint: (point) =>
          point === "checkout-preparing" ? Effect.promise(() => movedProject()) : Effect.void,
      },
    });
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const turn = await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
    // The project is re-pointed while the fork prepares its worktree.
    movedProject = () =>
      h
        .run(
          h.engine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make("fork-pins-move-project"),
            projectId,
            workspaceRoot: elsewhere,
          }),
        )
        .then(() => undefined);
    const request = input("fork-key-pins-final-01", turn.replyId, {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "main" },
    });

    const error = await failure(h, request);
    expect(error).toMatchObject({
      reason: "destination-unavailable",
      retryable: false,
      attempt: "stopped",
    });
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
    expect(forkWorktrees(repo)).toEqual([]);
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "failed" }]);
  });

  it("keeps a branch with the fork's name that it did not create", async () => {
    const { root, repo } = await repository("ryco-fork-foreign-branch-");
    await writeFile(path.join(repo, "tracked.txt"), "v2\n");
    git(repo, "commit", "-am", "second");
    const request = input("fork-key-foreign-branch", `${sourceId}-reply-1` as never, {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "main" },
    });
    const branch = threadForkIdentity(request.forkKey).branch("ryco");
    const h = await harness(root, {
      gitWorkflow: (base) => ({
        ...base,
        // Someone creates the fork's branch name elsewhere right before Git runs.
        createWorktree: (createRequest) =>
          Effect.sync(() => git(repo, "branch", branch, "HEAD~1")).pipe(
            Effect.andThen(base.createWorktree(createRequest)),
          ),
      }),
    });
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
    const foreignTip = git(repo, "rev-parse", "HEAD~1");

    const error = await failure(h, request);
    expect(error).toMatchObject({ reason: "preparation-failed", attempt: "stopped" });
    // Its tip is not the fork's start commit, so cleanup never deletes it.
    expect(git(repo, "rev-parse", `refs/heads/${branch}`)).toBe(foreignTip);
    expect(forkWorktrees(repo)).toEqual([]);
  });

  it("tells the user when the new worktree's submodules were not initialized", async () => {
    const { root, repo } = await repository("ryco-fork-submodules-");
    const reason = "Submodule initialization disabled by project settings.";
    const h = await harness(root, {
      gitWorkflow: (base) => ({
        ...base,
        createWorktree: (request) =>
          base.createWorktree(request).pipe(
            Effect.map((created) => ({
              ...created,
              submoduleInitialization: {
                mode: "none",
                source: "project",
                status: "skipped",
                reason,
              } as const,
            })),
          ),
      }),
    });
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const turn = await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
    const request = input("fork-key-submodules-01", turn.replyId, {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "main" },
    });

    const result = await h.run(h.forks.fork(request));
    expect(result.notices).toEqual([reason]);
    const replay = await h.run(h.forks.fork(request));
    expect(replay.notices).toEqual([reason]);
  });

  it("stays unfinished until it removed its worktree after a rejected publication", async () => {
    const { root, repo } = await repository("ryco-fork-cleanup-retry-");
    let removalFails = true;
    let occupyForkId: () => Promise<void> = async () => {};
    const h = await harness(root, {
      gitWorkflow: (base) => ({
        ...base,
        removeWorktree: (request) =>
          removalFails
            ? Effect.fail(
                new GitCommandError({
                  operation: "test.removeWorktree",
                  command: "git worktree remove",
                  cwd: request.cwd,
                  detail: "simulated lock",
                }),
              )
            : base.removeWorktree(request),
      }),
      service: {
        onRunPoint: (point) =>
          point === "provider-ready" ? Effect.promise(() => occupyForkId()) : Effect.void,
      },
    });
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const turn = await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
    const request = input("fork-key-cleanup-retry-1", turn.replyId, {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "main" },
    });
    const forkId = threadForkIdentity(request.forkKey).forkThreadId;
    // Something else takes the fork's thread id, so the publication is rejected for good.
    occupyForkId = () =>
      seedThread(h, { threadId: forkId, projectId, instance: "opencode", title: "Squatter" });

    const first = await failure(h, request);
    expect(first).toMatchObject({ retryable: true, attempt: "running" });
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "provider-ready" }]);
    expect(forkWorktrees(repo)).toHaveLength(1);

    removalFails = false;
    const second = await failure(h, request);
    expect(second).toMatchObject({
      reason: "preparation-failed",
      retryable: false,
      attempt: "stopped",
    });
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "failed" }]);
    expect(forkWorktrees(repo)).toEqual([]);
    expect(git(repo, "branch", "--list", threadForkIdentity(request.forkKey).branch("ryco"))).toBe(
      "",
    );
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
  });

  it("fails for good and removes its worktree when the project is deleted before publication", async () => {
    const { root, repo } = await repository("ryco-fork-project-gone-");
    let deleteProject: () => Promise<void> = async () => {};
    const h = await harness(root, {
      service: {
        onRunPoint: (point) =>
          point === "provider-ready" ? Effect.promise(() => deleteProject()) : Effect.void,
      },
    });
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const turn = await seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
    deleteProject = () =>
      h
        .run(
          h.engine.dispatch({
            type: "project.delete",
            commandId: CommandId.make("fork-project-gone-delete"),
            projectId,
            force: true,
          }),
        )
        .then(() => undefined);
    const request = input("fork-key-project-gone-1", turn.replyId, {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "main" },
    });

    const error = await failure(h, request);
    expect(error).toMatchObject({
      reason: "destination-unavailable",
      retryable: false,
      attempt: "stopped",
    });
    expect(forkWorktrees(repo)).toEqual([]);
    expect(git(repo, "branch", "--list", threadForkIdentity(request.forkKey).branch("ryco"))).toBe(
      "",
    );
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
    await h.run(h.forks.recover());
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "failed" }]);
  });

  it("releases an abandoned retryable fork's pinned commits after the retry window", async () => {
    const { root, repo } = await repository("ryco-fork-expiry-");
    const databasePath = path.join(root, "state.sqlite");
    const settings = { worktreeRoot: path.join(root, "worktrees") };
    const request = input("fork-key-expiry-000001", `${sourceId}-reply-1` as never, {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "main" },
    });
    const first = await createForkHarness({
      databasePath,
      settings,
      gitWorkflow: (base) => ({
        ...base,
        createWorktree: (createRequest) =>
          Effect.fail(
            new GitCommandError({
              operation: "test.createWorktree",
              command: "git worktree add",
              cwd: createRequest.cwd,
              detail: "simulated failure",
            }),
          ),
      }),
    });
    try {
      await seedProject(first, { projectId, workspaceRoot: repo });
      await seedThread(first, { threadId: sourceId, projectId, instance: "opencode" });
      await seedCompletedTurn(first, { threadId: sourceId, index: 1, instance: "opencode" });
      expect(await failure(first, request)).toMatchObject({ retryable: true, attempt: "stopped" });
      // A retry would need the pinned start commit.
      expect(git(repo, "for-each-ref", "refs/ryco/forks")).not.toBe("");
      // Not yet expired.
      await first.run(first.forks.recover());
      expect(git(repo, "for-each-ref", "refs/ryco/forks")).not.toBe("");
    } finally {
      await first.dispose();
    }

    const later = new Date(Date.now() + THREAD_FORK_RETRY_WINDOW_MS + 60_000);
    const second = await harness(root, { databasePath, settings, service: { now: () => later } });
    await second.run(second.forks.recover());
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
    const expired = await failure(second, request);
    expect(expired).toMatchObject({ retryable: false, attempt: "stopped" });
    expect(expired.message).toContain("not retried in time");
    expect(forkWorktrees(repo)).toEqual([]);
  });
});

/** Git that cannot create worktrees while `failing()` holds. */
const failWorktreeCreation =
  (failing: () => boolean): NonNullable<ForkHarnessOptions["gitWorkflow"]> =>
  (base) => ({
    ...base,
    createWorktree: (createRequest) =>
      failing()
        ? Effect.fail(
            new GitCommandError({
              operation: "test.createWorktree",
              command: "git worktree add",
              cwd: createRequest.cwd,
              detail: "simulated failure",
            }),
          )
        : base.createWorktree(createRequest),
  });

/** A project thread on `repo` with one completed (handoff) turn. */
async function seedSourceTurn(
  h: ForkHarness,
  repo: string,
  thread: { readonly worktreePath?: string; readonly branch?: string } = {},
) {
  await seedProject(h, { projectId, workspaceRoot: repo });
  await seedThread(h, { threadId: sourceId, projectId, instance: "opencode", ...thread });
  return seedCompletedTurn(h, { threadId: sourceId, index: 1, instance: "opencode" });
}

const fromMain = { kind: "new-worktree", start: { kind: "base-ref", baseRef: "main" } } as const;

describe("ThreadFork checkouts after transient failures", () => {
  it("keeps the checkpoint start when Git could not run, and refuses it only when Git says no", async () => {
    const { root, repo } = await repository("ryco-fork-git-transient-");
    const feature = path.join(root, "feature");
    git(repo, "worktree", "add", "-b", "feature", feature);
    let gitDown = false;
    const h = await harness(root, {
      checkpoints: (store) => ({
        ...store,
        // Git cannot start in the original checkout for a moment (e.g. EAGAIN under load).
        resolveCommit: (resolveRequest) =>
          gitDown && resolveRequest.cwd === feature
            ? Effect.fail(
                new VcsProcessSpawnError({
                  operation: "test.resolveCommit",
                  command: "git rev-parse",
                  cwd: resolveRequest.cwd,
                  cause: new Error("spawn EAGAIN"),
                }),
              )
            : store.resolveCommit(resolveRequest),
      }),
    });
    await seedProject(h, { projectId, workspaceRoot: repo });
    await seedThread(h, {
      threadId: sourceId,
      projectId,
      instance: "opencode",
      worktreePath: feature,
      branch: "feature",
    });
    await writeFile(path.join(feature, "tracked.txt"), "turn work\n");
    const checkpointRef = checkpointRefForThreadTurn(sourceId, 1);
    await h.run(h.checkpoints.captureCheckpoint({ cwd: feature, checkpointRef }));
    const turn = await seedCompletedTurn(h, {
      threadId: sourceId,
      index: 1,
      instance: "opencode",
      checkpoint: { ref: checkpointRef, count: 1 },
    });
    const fromCheckpoint = { kind: "new-worktree", start: { kind: "checkpoint" } } as const;

    gitDown = true;
    const transient = await failure(
      h,
      input("fork-key-git-transient-01", turn.replyId, fromCheckpoint),
    );
    // Not "this turn has no usable checkpoint": clients keep the start and offer Retry.
    expect(transient).toMatchObject({
      reason: "destination-unavailable",
      retryable: true,
      attempt: "none",
    });
    expect(await h.ledgerRows()).toEqual([]);
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");

    gitDown = false;
    const result = await h.run(
      h.forks.fork(input("fork-key-git-transient-01", turn.replyId, fromCheckpoint)),
    );
    expect(result.checkout).toMatchObject({ kind: "new-worktree", start: "checkpoint" });

    // The original checkout is no longer a Git checkout at all: that answer is final.
    await rm(path.join(feature, ".git"), { force: true });
    const final = await failure(
      h,
      input("fork-key-git-transient-02", turn.replyId, fromCheckpoint),
    );
    expect(final).toMatchObject({
      reason: "checkpoint-unavailable",
      retryable: false,
      attempt: "none",
    });
  });

  it("never takes a Git that could not start in the project for a project without Git", async () => {
    const { root, repo } = await repository("ryco-fork-git-down-");
    let gitDown = false;
    const spawnFailed = (cwd: string) =>
      new VcsProcessSpawnError({
        operation: "test.git",
        command: "git rev-parse",
        cwd,
        cause: new Error("spawn EMFILE"),
      });
    const h = await harness(root, {
      // Every Git call in the project fails to start; the store reports it as it really does.
      checkpoints: (store) => ({
        ...store,
        isGitRepository: (cwd) =>
          gitDown && cwd === repo ? Effect.succeed(false) : store.isGitRepository(cwd),
        resolveCommit: (resolveRequest) =>
          gitDown && resolveRequest.cwd === repo
            ? Effect.fail(spawnFailed(resolveRequest.cwd))
            : store.resolveCommit(resolveRequest),
      }),
    });
    const turn = await seedSourceTurn(h, repo);
    const request = input("fork-key-git-down-000001", turn.replyId, fromMain);

    gitDown = true;
    const error = await failure(h, request);
    expect(error).toMatchObject({
      reason: "destination-unavailable",
      retryable: true,
      attempt: "none",
    });
    expect(error.message).not.toContain("need a Git project");

    gitDown = false;
    expect((await h.run(h.forks.fork(request))).checkout.kind).toBe("new-worktree");
  });

  it("starts the setup script once, after the fork is recorded as created", async () => {
    const { root, repo } = await repository("ryco-fork-setup-once-");
    let setupRuns = 0;
    let failCompleted = true;
    const h = await harness(root, {
      runSetupScript: () =>
        Effect.sync(() => {
          setupRuns++;
          return { status: "no-script" as const };
        }),
      ledger: (ledger) => ({
        ...ledger,
        // Publication committed, but recording the fork as created fails once.
        compareAndSetPhase: (casRequest) =>
          failCompleted && casRequest.nextPhase === "completed"
            ? Effect.sync(() => {
                failCompleted = false;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new PersistenceSqlError({ operation: "test", detail: "locked" })),
                ),
              )
            : ledger.compareAndSetPhase(casRequest),
      }),
      service: { redriveBackoff: ["1 hour"] },
    });
    const turn = await seedSourceTurn(h, repo);
    const request = input("fork-key-setup-once-0001", turn.replyId, fromMain);

    expect(await failure(h, request)).toMatchObject({ retryable: true, attempt: "running" });
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "published" }]);
    const result = await h.run(h.forks.fork(request));
    expect(result.checkout.kind).toBe("new-worktree");
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "completed" }]);

    // The launch is detached: give a second one the chance to show up.
    await vi.waitFor(() => expect(setupRuns).toBeGreaterThan(0), { timeout: 5_000, interval: 10 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(setupRuns).toBe(1);
  });

  it("removes its worktree folder when the repository itself is gone before publication", async () => {
    const { root, repo } = await repository("ryco-fork-repo-gone-");
    let removeRepository: () => Promise<void> = async () => {};
    const h = await harness(root, {
      service: {
        onRunPoint: (point) =>
          point === "provider-ready" ? Effect.promise(() => removeRepository()) : Effect.void,
      },
    });
    const turn = await seedSourceTurn(h, repo);
    removeRepository = async () => {
      await h.run(
        h.engine.dispatch({
          type: "project.delete",
          commandId: CommandId.make("fork-repo-gone-delete"),
          projectId,
          force: true,
        }),
      );
      await rm(repo, { recursive: true, force: true });
    };
    const request = input("fork-key-repo-gone-00001", turn.replyId, fromMain);

    expect(await failure(h, request)).toMatchObject({
      reason: "destination-unavailable",
      retryable: false,
      attempt: "stopped",
    });
    const row = Option.getOrThrow(await h.run(h.ledger.getByKey({ forkKey: request.forkKey })));
    expect(row.phase).toBe("failed");
    if (row.checkout?.kind !== "new-worktree") throw new Error("expected a recorded worktree");
    // Git cannot remove a checkout of a repository that is gone; the fork's folder still goes.
    expect(await exists(row.checkout.worktreePath)).toBe(false);
  });
});

describe("ThreadFork retry window", () => {
  const afterWindow = () => new Date(Date.now() + THREAD_FORK_RETRY_WINDOW_MS + 60_000);

  it("refuses a retry after the window on a node that kept running, and releases its pins", async () => {
    const { root, repo } = await repository("ryco-fork-window-live-");
    let failing = true;
    let clock = () => new Date();
    const h = await harness(root, {
      gitWorkflow: failWorktreeCreation(() => failing),
      service: { now: () => clock() },
    });
    const turn = await seedSourceTurn(h, repo);
    const request = input("fork-key-window-live-0001", turn.replyId, fromMain);
    expect(await failure(h, request)).toMatchObject({ retryable: true, attempt: "stopped" });
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).not.toBe("");

    // Weeks later, on the same running node, Git works again and the user retries.
    failing = false;
    clock = afterWindow;
    const expired = await failure(h, request);
    expect(expired).toMatchObject({ retryable: false, attempt: "stopped" });
    expect(expired.message).toContain("not retried in time");
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
    expect(forkWorktrees(repo)).toEqual([]);
    expect(await h.shell(threadForkIdentity(request.forkKey).forkThreadId)).toBeUndefined();
  });

  it("releases an abandoned fork's pinned commits on a node that keeps running, without a retry", async () => {
    const { root, repo } = await repository("ryco-fork-window-sweep-");
    let clock = () => new Date();
    const h = await harness(root, {
      startup: true,
      gitWorkflow: failWorktreeCreation(() => true),
      service: { now: () => clock(), recoverySweepInterval: "30 millis" },
    });
    const turn = await seedSourceTurn(h, repo);
    const request = input("fork-key-window-sweep-001", turn.replyId, fromMain);
    expect(await failure(h, request)).toMatchObject({ retryable: true, attempt: "stopped" });
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).not.toBe("");

    clock = afterWindow;
    await vi.waitFor(
      async () => {
        const row = Option.getOrThrow(await h.run(h.ledger.getByKey({ forkKey: request.forkKey })));
        expect(row.error).toMatchObject({ retryable: false });
        expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
      },
      { timeout: 10_000, interval: 30 },
    );
  });

  it("keeps a fork retried while the sweep was settling it, and its pinned commits", async () => {
    const { root, repo } = await repository("ryco-fork-window-race-");
    let clock = () => new Date();
    let meanwhile: () => Promise<void> = async () => {};
    const h = await harness(root, {
      gitWorkflow: failWorktreeCreation(() => true),
      ledger: (ledger) => ({
        ...ledger,
        listRetryableFailed: (listRequest) =>
          ledger.listRetryableFailed(listRequest).pipe(Effect.tap(() => Effect.promise(meanwhile))),
      }),
      service: { now: () => clock(), redriveBackoff: ["1 hour"] },
    });
    const turn = await seedSourceTurn(h, repo);
    const request = input("fork-key-window-race-0001", turn.replyId, fromMain);
    expect(await failure(h, request)).toMatchObject({ retryable: true, attempt: "stopped" });

    // The sweep has listed the fork as abandoned when the user retries it, and it fails again.
    meanwhile = async () => {
      meanwhile = async () => {};
      clock = () => new Date();
      expect(await failure(h, request)).toMatchObject({ retryable: true, attempt: "stopped" });
      clock = afterWindow;
    };
    clock = afterWindow;
    await h.run(h.forks.recover());

    // The sweep's earlier view does not settle the fresh failure.
    clock = () => new Date();
    const row = Option.getOrThrow(await h.run(h.ledger.getByKey({ forkKey: request.forkKey })));
    expect(row.error).toMatchObject({ retryable: true });
    expect(row.error?.message).not.toContain("not retried in time");
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).not.toBe("");
  });
});

/** Worktree folders reserved on the node (`managed_worktree_paths`). */
const reservations = (h: ForkHarness) =>
  h
    .run(h.sql<{ readonly count: number }>`SELECT COUNT(*) AS "count" FROM managed_worktree_paths`)
    .then((rows) => Number(rows[0]?.count ?? 0));

describe("ThreadFork destinations that cannot be used anymore", () => {
  const brokenRepositories = [
    [
      "its folder was moved away",
      (repo: string) => rename(repo, `${repo}-moved-away`),
      "no longer exists",
    ],
    [
      "it is no longer a Git repository",
      async (repo: string) => {
        await rm(path.join(repo, ".git"), { recursive: true, force: true });
        // Git's repository detection is cached for 2 seconds.
        await new Promise((resolve) => setTimeout(resolve, 2_100));
      },
      "no longer a Git repository",
    ],
  ] as const;
  for (const [name, breakRepository, message] of brokenRepositories) {
    it(`fails a retried fork for good, reserving nothing, once the project's repository ${name}`, async () => {
      const { root, repo } = await repository("ryco-fork-retry-repo-broken-");
      let failing = true;
      const h = await harness(root, {
        gitWorkflow: failWorktreeCreation(() => failing),
        service: { redriveBackoff: ["20 millis"] },
      });
      const turn = await seedSourceTurn(h, repo);
      const request = input("fork-key-retry-repo-broken", turn.replyId, fromMain);
      expect(await failure(h, request)).toMatchObject({ retryable: true, attempt: "stopped" });
      const reserved = await reservations(h);

      await breakRepository(repo);
      failing = false;
      const error = await failure(h, request);
      expect(error).toMatchObject({
        reason: "destination-unavailable",
        retryable: false,
        attempt: "stopped",
      });
      expect(error.message).toContain(message);
      // Settled: the node never drives it again, and no worktree folder was reserved for it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "failed" }]);
      expect(await h.run(h.forks.attemptState(request.forkKey))).toBe("stopped");
      expect(await reservations(h)).toBe(reserved);
    });
  }

  it("keeps the pinned commits of a fork it stopped trying before its checkout, for a retry", async () => {
    const { root, repo } = await repository("ryco-fork-give-up-pins-");
    let gitDown = false;
    const h = await harness(root, {
      checkpoints: (store) => ({
        ...store,
        // After acceptance, Git cannot start in the project for a long time.
        resolveCommit: (resolveRequest) =>
          gitDown && resolveRequest.cwd === repo
            ? Effect.fail(
                new VcsProcessSpawnError({
                  operation: "test.resolveCommit",
                  command: "git rev-parse",
                  cwd: resolveRequest.cwd,
                  cause: new Error("spawn EAGAIN"),
                }),
              )
            : store.resolveCommit(resolveRequest),
      }),
      service: {
        redriveBackoff: ["20 millis"],
        redriveLimit: 2,
        onRunPoint: (point) =>
          point === "accepted"
            ? Effect.sync(() => {
                gitDown = true;
              })
            : Effect.void,
      },
    });
    const turn = await seedSourceTurn(h, repo);
    const request = input("fork-key-give-up-pins-001", turn.replyId, fromMain);

    expect(await failure(h, request)).toMatchObject({ retryable: true, attempt: "running" });
    await vi.waitFor(
      async () =>
        expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "failed" }]),
      { timeout: 10_000, interval: 20 },
    );
    expect(await h.run(h.forks.attemptState(request.forkKey))).toBe("stopped");
    // Settled before its checkout existed: a retry may start it again from the pinned commit.
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/ryco/forks")).toMatch(/\/base$/);
    expect(forkWorktrees(repo)).toEqual([]);
    expect(await reservations(h)).toBe(0);

    gitDown = false;
    const result = await h.run(h.forks.fork(request));
    expect(result.checkout.kind).toBe("new-worktree");
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
  });

  it("fails for good, releasing its pinned commits, when the worktree root cannot be used", async () => {
    const { root, repo } = await repository("ryco-fork-root-refused-");
    const h = await harness(root, {
      settings: { worktreeRoot: "relative/worktrees" },
      service: { redriveBackoff: ["20 millis"] },
    });
    const turn = await seedSourceTurn(h, repo);
    const request = input("fork-key-root-refused-001", turn.replyId, fromMain);

    const error = await failure(h, request);
    expect(error).toMatchObject({
      reason: "destination-unavailable",
      retryable: false,
      attempt: "stopped",
    });
    expect(error.message).toContain("Worktree root");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "failed" }]);
    expect(git(repo, "for-each-ref", "refs/ryco/forks")).toBe("");
    expect(forkWorktrees(repo)).toEqual([]);
    expect(await reservations(h)).toBe(0);
  });

  it("reserves one worktree folder however often a run stops before recording it", async () => {
    const { root, repo, worktrees } = await repository("ryco-fork-reserve-once-");
    let unreadable = 2;
    const h = await harness(root, {
      // The reserved folder cannot be checked twice in a row (a stalled mount, a permission flap).
      fileSystem: (fileSystem) => ({
        ...fileSystem,
        exists: (candidate) =>
          Effect.suspend(() =>
            unreadable > 0 && candidate.startsWith(`${worktrees}${path.sep}`)
              ? ((unreadable -= 1),
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "access",
                    pathOrDescriptor: candidate,
                  }),
                ))
              : fileSystem.exists(candidate),
          ),
      }),
      service: { redriveBackoff: ["20 millis"] },
    });
    const turn = await seedSourceTurn(h, repo);
    const request = input("fork-key-reserve-once-001", turn.replyId, fromMain);

    expect(await failure(h, request)).toMatchObject({ retryable: true, attempt: "running" });
    await vi.waitFor(
      async () =>
        expect(await h.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "completed" }]),
      { timeout: 10_000, interval: 20 },
    );
    expect(unreadable).toBe(0);
    expect(await reservations(h)).toBe(1);
    const replay = await h.run(h.forks.fork(request));
    if (replay.checkout.kind !== "new-worktree") throw new Error("expected a new worktree");
    expect(replay.checkout.worktreePath.startsWith(`${worktrees}${path.sep}`)).toBe(true);
    expect(forkWorktrees(repo)).toHaveLength(1);
  });

  it("fails for good, removing its worktree folder, when it resumes in a repository that lost its Git data", async () => {
    const { root, repo } = await repository("ryco-fork-resume-not-git-");
    const databasePath = path.join(root, "state.sqlite");
    const settings = { worktreeRoot: path.join(root, "worktrees") };
    const request = input("fork-key-resume-not-git-1", `${sourceId}-reply-1` as never, fromMain);
    const first = await createForkHarness({
      databasePath,
      settings,
      service: {
        onRunPoint: (point) =>
          point === "checkout-created" ? Effect.die(new Error("simulated crash")) : Effect.void,
      },
    });
    let worktreePath = "";
    try {
      await seedSourceTurn(first, repo);
      expect(await failure(first, request)).toMatchObject({ attempt: "running" });
      const crashed = Option.getOrThrow(
        await first.run(first.ledger.getByKey({ forkKey: request.forkKey })),
      );
      expect(crashed.phase).toBe("checkout-preparing");
      if (crashed.checkout?.kind !== "new-worktree") throw new Error("expected a new worktree");
      worktreePath = crashed.checkout.worktreePath;
      expect(await exists(path.join(worktreePath, ".git"))).toBe(true);
    } finally {
      await first.dispose();
    }
    await rm(path.join(repo, ".git"), { recursive: true, force: true });

    const second = await harness(root, { databasePath, settings });
    await second.run(second.forks.recover());
    expect(await second.ledgerRows()).toEqual([{ forkKey: request.forkKey, phase: "failed" }]);
    const row = Option.getOrThrow(
      await second.run(second.ledger.getByKey({ forkKey: request.forkKey })),
    );
    expect(row.error).toMatchObject({
      reason: "destination-unavailable",
      message: "The project is no longer a Git repository.",
      retryable: false,
    });
    // Git can no longer remove the checkout it made; the fork's folder still goes.
    expect(await exists(worktreePath)).toBe(false);
  });
});
