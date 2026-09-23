import fsPromises from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PlatformError, Scope } from "effect";

import { GitCommandError } from "@ryco/contracts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { configureTestGitCommitIdentity } from "./testing/GitTestRepo.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-git-vcs-driver-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const OverrideTestLayer = Layer.merge(ServerConfigLayer, NodeServices.layer);

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* configureTestGitCommitIdentity(cwd, git);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("readRangeContext", () => {
    it.effect("returns empty context when base and HEAD are identical", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.deepStrictEqual(yield* driver.readRangeContext(cwd, initialBranch), {
          commitSummary: "",
          diffSummary: "",
          diffPatch: "",
        });
      }),
    );

    it.effect("preserves patch truncation and its marker for large ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature/large-patch"]);
        yield* writeTextFile(cwd, "large.txt", "feature change\n".repeat(5_000));
        yield* git(cwd, ["add", "large.txt"]);
        yield* git(cwd, ["commit", "-m", "Large feature commit"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const context = yield* driver.readRangeContext(cwd, initialBranch);
        assert.include(context.commitSummary, "Large feature commit");
        assert.include(context.diffSummary, "5000 insertions(+)");
        assert.include(context.diffPatch, "+feature change");
        assert.isTrue(context.diffPatch.endsWith("\n\n[truncated]"));
        assert.equal(Buffer.byteLength(context.diffPatch), 59_000 + "\n\n[truncated]".length);
      }),
    );

    it.effect("propagates invalid base errors", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver.readRangeContext(cwd, "missing-base").pipe(Effect.flip);
        assert.instanceOf(error, GitCommandError);
        assert.include(error.operation, "GitVcsDriver.readRangeContext.");
        assert.include(error.detail, "missing-base");
      }),
    );

    it.effect("fails when the base has no common ancestor", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "--orphan", "unrelated"]);
        yield* git(cwd, ["commit", "-m", "Unrelated root"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver.readRangeContext(cwd, initialBranch).pipe(Effect.flip);
        assert.instanceOf(error, GitCommandError);
        assert.include(error.operation, "GitVcsDriver.readRangeContext.mergeBase");
        assert.include(error.detail, "no common ancestor");
        assert.include(error.detail, "Fetch the base branch and its history");
        assert.include(error.detail, "rebase or cherry-pick");
      }),
    );

    it.effect("rejects criss-cross histories instead of choosing an arbitrary merge base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "left"]);
        yield* writeTextFile(cwd, "left.txt", "left\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Left change"]);
        const left = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "right", "HEAD~1"]);
        yield* writeTextFile(cwd, "right.txt", "right\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Right change"]);
        const right = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["merge", "--no-ff", left, "-m", "Merge left"]);
        yield* git(cwd, ["checkout", "left"]);
        yield* git(cwd, ["merge", "--no-ff", right, "-m", "Merge right"]);
        yield* git(cwd, ["checkout", "right"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Feature change"]);

        const bases = (yield* git(cwd, ["merge-base", "--all", "left", "HEAD"])).split("\n");
        assert.sameMembers(bases, [left, right]);
        // Git's implicit choice includes a change already present on both sides.
        assert.include(yield* git(cwd, ["diff", "--stat", "left...HEAD"]), "2 files changed");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const error = yield* driver.readRangeContext(cwd, "left").pipe(Effect.flip);
        assert.instanceOf(error, GitCommandError);
        assert.include(error.detail, "multiple merge bases");
        assert.include(error.detail, "Merge or rebase");
      }),
    );
  });

  describe("repository status", () => {
    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("reports refName and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "export const value = 1;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.include(
          status.workingTree.files.map((file) => file.path),
          "feature.ts",
        );
      }),
    );

    it.effect("uses non-interactive env when refreshing upstream status", () =>
      Effect.gen(function* () {
        const calls: GitVcsDriver.ExecuteGitInput[] = [];
        const ok = (stdout = "") =>
          ({
            exitCode: 0 as GitVcsDriver.ExecuteGitResult["exitCode"],
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }) satisfies GitVcsDriver.ExecuteGitResult;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            Effect.sync(() => {
              calls.push(input);
              const [command] = input.args;
              if (command === "rev-parse" && input.args.includes("@{upstream}")) {
                return ok("origin/main\n");
              }
              if (command === "rev-parse" && input.args.includes("--git-common-dir")) {
                return ok(".git\n");
              }
              if (command === "--git-dir") {
                return ok();
              }
              if (command === "remote" && input.args.length === 1) {
                return ok("origin\n");
              }
              if (command === "remote" && input.args[1] === "get-url") {
                return ok("git@example.com:owner/repo.git\n");
              }
              if (command === "status") {
                return ok(
                  [
                    "# branch.oid abc123",
                    "# branch.head main",
                    "# branch.upstream origin/main",
                    "# branch.ab +0 -0",
                    "",
                  ].join("\n"),
                );
              }
              if (command === "diff") {
                return ok();
              }
              if (command === "symbolic-ref") {
                return ok("refs/remotes/origin/main\n");
              }
              if (command === "config") {
                return ok();
              }
              if (command === "rev-list") {
                return ok("0\n");
              }
              if (command === "show-ref") {
                return ok();
              }
              throw new Error(`Unexpected git command: ${input.args.join(" ")}`);
            }),
        });

        yield* driver.statusDetails("/repo");

        const fetchCall = calls.find(
          (call) => call.operation === "GitVcsDriver.fetchRemoteForStatus",
        );
        assert.isDefined(fetchCall);
        assert.equal(fetchCall?.env?.GIT_TERMINAL_PROMPT, "0");
        assert.equal(fetchCall?.env?.SSH_ASKPASS_REQUIRE, "never");
        assert.deepStrictEqual(
          calls
            .filter((call) => call.args[0] === "diff" && call.args.includes("--numstat"))
            .map((call) => call.args),
          [["diff", "HEAD", "--numstat"]],
        );
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("falls back to staged and unstaged numstat for an unborn repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* writeTextFile(cwd, "first.txt", "first line\n");
        yield* git(cwd, ["add", "first.txt"]);

        const status = yield* driver.statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.deepInclude(status.workingTree.files, {
          path: "first.txt",
          insertions: 1,
          deletions: 0,
        });
      }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports committed changes vs base even with a clean working tree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature/committed"]);
        yield* writeTextFile(cwd, "feature.txt", "line1\nline2\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        // The change is fully committed, so the working tree is clean but the
        // committed-vs-base diff still reflects it.
        assert.equal(status.workingTree.files.length, 0);
        assert.deepEqual(status.committed, {
          files: [{ path: "feature.txt", insertions: 2, deletions: 0 }],
          insertions: 2,
          deletions: 0,
        });
      }),
    );

    it.effect("omits committed-vs-base on the default branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isDefaultBranch, true);
        assert.equal(status.committed, undefined);
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("creates, checks out, renames, and lists refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/original" });
        const switchRef = yield* driver.switchRef({ cwd, refName: "feature/original" });
        assert.equal(switchRef.refName, "feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        assert.equal(renamed.branch, "feature/renamed");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/renamed");

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(
          refs.refs.find((refName) => refName.name === "feature/renamed")?.current,
          true,
        );
      }),
    );

    it.effect("returns the existing refName when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        assert.equal(result.branch, current);
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect(
      "uses configured defaults, preserves explicit paths and registrations after reset",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const root = yield* makeTmpDir("custom-worktree-root-");
          const settings = yield* ServerSettingsService;
          yield* settings.updateSettings({ worktreeRoot: root });
          const driver = yield* makeGitVcsDriverCore().pipe(Effect.provide(OverrideTestLayer));
          const created = yield* driver.createWorktree({
            cwd,
            path: null,
            refName: initialBranch,
            newRefName: "feature/custom",
          });
          const fileSystem = yield* FileSystem.FileSystem;
          assert.isTrue(created.worktree.path.startsWith(`${yield* fileSystem.realPath(root)}/`));
          const explicit = `${yield* makeTmpDir("explicit-worktree-")}/checkout`;
          const imported = yield* driver.createWorktree({
            cwd,
            path: explicit,
            refName: initialBranch,
            newRefName: "feature/explicit",
          });
          assert.equal(imported.worktree.path, yield* fileSystem.realPath(explicit));
          yield* settings.updateSettings({
            worktreeRoot: "/unavailable-root-for-future-checkouts",
          });
          assert.include(yield* driver.listWorktreePaths(cwd), created.worktree.path);
          yield* settings.updateSettings({ worktreeRoot: "" });
          assert.include(yield* driver.listWorktreePaths(cwd), imported.worktree.path);
          assert.equal(
            yield* git(created.worktree.path, ["branch", "--show-current"]),
            "feature/custom",
          );
        }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );

    it.effect("rejects explicit out-of-root worktree creation before Git mutation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const allowed = yield* makeTmpDir("restricted-worktree-root-");
        const outside = yield* makeTmpDir("outside-worktree-root-");
        const config = yield* ServerConfig;
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ServerConfig, {
            ...config,
            workspaceAccessRoot: allowed,
          }),
        );
        const error = yield* driver
          .createWorktree({
            cwd,
            path: `${outside}/checkout`,
            refName: initialBranch,
            newRefName: "feature/forbidden",
          })
          .pipe(Effect.flip);
        assert.include(error.detail, "restricted");
        assert.equal(yield* (yield* FileSystem.FileSystem).exists(`${outside}/checkout`), false);
        assert.equal(yield* git(cwd, ["branch", "--list", "feature/forbidden"]), "");
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("fails collisions without touching existing files or creating branches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const destination = yield* makeTmpDir("occupied-worktree-");
        yield* writeTextFile(destination, "keep.txt", "unchanged");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const error = yield* driver
          .createWorktree({
            cwd,
            path: destination,
            refName: initialBranch,
            newRefName: "feature/collision",
          })
          .pipe(Effect.flip);
        assert.include(error.detail, "already exists");
        assert.equal(
          yield* (yield* FileSystem.FileSystem).readFileString(`${destination}/keep.txt`),
          "unchanged",
        );
        assert.equal(yield* git(cwd, ["branch", "--list", "feature/collision"]), "");
      }),
    );

    it.effect(
      "lets Git arbitrate concurrent destination collisions without overwriting a winner",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const destination = `${yield* makeTmpDir("concurrent-worktrees-")}/checkout`;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const results = yield* Effect.all(
            ["one", "two"].map((name) =>
              driver
                .createWorktree({
                  cwd,
                  path: destination,
                  refName: initialBranch,
                  newRefName: `feature/${name}`,
                })
                .pipe(Effect.result),
            ),
            { concurrency: 2 },
          );
          assert.equal(results.filter((result) => result._tag === "Success").length, 1);
          assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
          assert.equal(
            yield* (yield* FileSystem.FileSystem).readFileString(`${destination}/README.md`),
            "# test\n",
          );
        }),
    );
    it.effect(
      "fetches origin branches and creates from the fresh remote instead of the local base",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(remote);
          const cwd = yield* makeTmpDir();
          yield* git(cwd, ["clone", remote, "."]);
          yield* configureTestGitCommitIdentity(cwd, git);
          yield* git(cwd, ["commit", "--allow-empty", "-m", "local-only commit"]);
          const localHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(remote, ["branch", "remote-only"]);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const refs = yield* driver.listRefs({ cwd, fetchOrigin: true, originOnly: true });
          assert.isTrue(refs.refs.some((ref) => ref.name === `origin/${initialBranch}`));
          assert.isTrue(refs.refs.some((ref) => ref.name === "origin/remote-only"));
          assert.isTrue(refs.refs.every((ref) => ref.isRemote && ref.remoteName === "origin"));
          // Origin moves after the picker loaded. Creation must fetch again.
          yield* git(remote, ["commit", "--allow-empty", "-m", "new remote commit"]);
          const remoteHead = yield* git(remote, ["rev-parse", "HEAD"]);
          const pathService = yield* Path.Path;
          const root = yield* makeTmpDir();
          const created = yield* driver.createWorktree({
            cwd,
            path: pathService.join(root, "fresh"),
            refName: `origin/${initialBranch}`,
            newRefName: "feature/custom",
            fetchOrigin: true,
          });
          assert.equal(yield* git(created.worktree.path, ["rev-parse", "HEAD"]), remoteHead);
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), localHead);
          assert.equal(
            yield* git(created.worktree.path, ["branch", "--show-current"]),
            "feature/custom",
          );
          // Resolve the remote default even when no origin/HEAD symbolic ref exists.
          yield* git(cwd, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
          const automatic = yield* driver.createWorktree({
            cwd,
            path: pathService.join(root, "default"),
            refName: "origin/HEAD",
            newRefName: "feature/default",
            fetchOrigin: true,
          });
          assert.equal(yield* git(automatic.worktree.path, ["rev-parse", "HEAD"]), remoteHead);
          const local = yield* driver.createWorktree({
            cwd,
            path: pathService.join(root, "local"),
            refName: initialBranch,
            newRefName: "feature/local",
            fetchOrigin: false,
          });
          assert.equal(yield* git(local.worktree.path, ["rev-parse", "HEAD"]), localHead);
          yield* git(remote, ["branch", "-D", "remote-only"]);
          const pruned = yield* driver.listRefs({ cwd, fetchOrigin: true, originOnly: true });
          assert.isFalse(pruned.refs.some((ref) => ref.name === "origin/remote-only"));
        }),
    );
    it.effect("does not create a worktree when fetching origin fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const result = yield* driver
          .createWorktree({
            cwd,
            path: null,
            refName: initialBranch,
            newRefName: "must-not-exist",
            fetchOrigin: true,
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(yield* git(cwd, ["branch", "--list", "must-not-exist"]), "");
      }),
    );
    it.effect("creates and removes a worktree for a new refName", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(
          created.worktree.path,
          yield* (yield* FileSystem.FileSystem).realPath(worktreePath),
        );
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );

    it.effect("does not copy dependency install directories by default", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "fast-worktree");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "node_modules/vite/index.js", "export const vite = true;\n");

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/no-dependency-copy",
        });

        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "node_modules")),
          false,
        );
      }),
    );

    it.effect("initializes recursive submodules in a new worktree", () =>
      Effect.gen(function* () {
        const leafRepo = yield* makeTmpDir("git-submodule-leaf-");
        yield* initRepoWithCommit(leafRepo);
        yield* writeTextFile(leafRepo, "leaf.txt", "leaf content\n");
        yield* git(leafRepo, ["add", "leaf.txt"]);
        yield* git(leafRepo, ["commit", "-m", "add leaf content"]);

        const nestedRepo = yield* makeTmpDir("git-submodule-nested-");
        yield* initRepoWithCommit(nestedRepo);
        yield* git(nestedRepo, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          leafRepo,
          "nested/leaf",
        ]);
        yield* git(nestedRepo, ["commit", "-m", "add nested submodule"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          nestedRepo,
          "modules/nested",
        ]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "submodule-worktree",
        );
        const baseDriver = yield* GitVcsDriver.GitVcsDriver;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            baseDriver.execute(
              input.operation === "GitVcsDriver.createWorktree.initializeSubmodules"
                ? {
                    ...input,
                    env: { ...input.env, GIT_ALLOW_PROTOCOL: "file" },
                  }
                : input,
            ),
        }).pipe(Effect.provide(OverrideTestLayer));

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/submodules",
        });

        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(
          yield* fileSystem.exists(
            pathService.join(worktreePath, "modules", "nested", "nested", "leaf", "leaf.txt"),
          ),
          true,
        );
      }),
    );

    it.effect("skips submodule initialization when the worktree has no submodules", () =>
      Effect.gen(function* () {
        const calls: GitVcsDriver.ExecuteGitInput[] = [];
        const cwd = yield* makeTmpDir();
        const worktreePath = (yield* Path.Path).join(
          yield* makeTmpDir("git-worktree-without-submodules-"),
          "checkout",
        );
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return {
                exitCode: 0 as GitVcsDriver.ExecuteGitResult["exitCode"],
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        });

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: "main",
          newRefName: "feature/no-submodules",
        });

        assert.deepStrictEqual(
          calls.map((call) => call.operation),
          ["GitVcsDriver.createWorktree"],
        );
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("reports a partially created worktree when submodule initialization fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const worktreePath = (yield* Path.Path).join(
          yield* makeTmpDir("git-worktree-with-submodules-"),
          "checkout",
        );
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            (input.operation === "GitVcsDriver.createWorktree"
              ? fileSystem
                  .makeDirectory(worktreePath, { recursive: true })
                  .pipe(
                    Effect.andThen(
                      fileSystem.writeFileString(
                        `${worktreePath}/.gitmodules`,
                        '[submodule "module"]\n',
                      ),
                    ),
                    Effect.orDie,
                  )
              : Effect.void
            ).pipe(
              Effect.as({
                exitCode: (input.operation === "GitVcsDriver.createWorktree.initializeSubmodules"
                  ? 1
                  : 0) as GitVcsDriver.ExecuteGitResult["exitCode"],
                stdout: "",
                stderr:
                  input.operation === "GitVcsDriver.createWorktree.initializeSubmodules"
                    ? "fatal: unable to clone submodule"
                    : "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
            ),
        });

        const error = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: "main",
            newRefName: "feature/broken-submodule",
          })
          .pipe(Effect.flip);

        assert.equal(error.operation, "GitVcsDriver.createWorktree.initializeSubmodules");
        assert.include(error.detail, "The worktree was created");
        assert.include(error.detail, "fatal: unable to clone submodule");
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("copies dependency install directories when deprecated hydration is requested", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "dependency-copy-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "apps/web/package.json", '{"name":"web"}\n');
        yield* git(cwd, ["add", "apps/web/package.json"]);
        yield* git(cwd, ["commit", "-m", "add workspace package"]);
        yield* writeTextFile(
          cwd,
          "node_modules/.bun/vite@1.0.0/node_modules/vite/index.js",
          "export const vite = true;\n",
        );
        yield* Effect.tryPromise(() =>
          fsPromises.symlink(
            ".bun/vite@1.0.0/node_modules/vite",
            pathService.join(cwd, "node_modules", "vite"),
          ),
        );
        yield* Effect.tryPromise(() =>
          fsPromises.mkdir(pathService.join(cwd, "apps", "web", "node_modules"), {
            recursive: true,
          }),
        );
        yield* Effect.tryPromise(() =>
          fsPromises.symlink(
            "../../../node_modules/.bun/vite@1.0.0/node_modules/vite",
            pathService.join(cwd, "apps", "web", "node_modules", "vite"),
          ),
        );

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/dependency-copy",
          dependencyHydration: "copyInstallDirs",
        });

        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(
          yield* fileSystem.exists(
            pathService.join(
              worktreePath,
              "node_modules",
              ".bun",
              "vite@1.0.0",
              "node_modules",
              "vite",
              "index.js",
            ),
          ),
          true,
        );

        const rootLink = yield* Effect.tryPromise(() =>
          fsPromises.lstat(pathService.join(worktreePath, "node_modules", "vite")),
        );
        const workspaceLink = yield* Effect.tryPromise(() =>
          fsPromises.lstat(pathService.join(worktreePath, "apps", "web", "node_modules", "vite")),
        );
        assert.equal(rootLink.isSymbolicLink(), true);
        assert.equal(workspaceLink.isSymbolicLink(), true);
        assert.equal(
          yield* Effect.tryPromise(() =>
            fsPromises.readlink(
              pathService.join(worktreePath, "apps", "web", "node_modules", "vite"),
            ),
          ),
          "../../../node_modules/.bun/vite@1.0.0/node_modules/vite",
        );
      }),
    );
  });

  describe("commit context", () => {
    it.effect("stages selected files and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");

        const commit = yield* driver.commit(cwd, "Add a", "");
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* (yield* GitVcsDriver.GitVcsDriver).prepareCommitContext(cwd);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* driver.prepareCommitContext(cwd);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("publishes a branch tracking its base under its own name, not the base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "dev"]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/x", "origin/dev"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        assert.equal(yield* git(remote, ["log", "-1", "--pretty=%s", "feature/x"]), "Add feature");
        assert.equal(yield* git(remote, ["rev-parse", "dev"]), devSha);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/x",
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/x.gh-merge-base"), "dev");
      }),
    );

    it.effect("keeps a recorded merge base when publishing a tracked branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/y", "origin/main"]);
        yield* git(cwd, ["config", "branch.feature/y.gh-merge-base", "release/v2"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.gh-merge-base"),
          "release/v2",
        );
      }),
    );

    it.effect("still pushes a git-mangled tracking alias to its upstream head", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
        yield* git(cwd, ["push", "my-org/upstream", "main:effect-atom"]);
        yield* git(cwd, ["fetch", "my-org/upstream"]);
        // Git cannot use just `effect-atom` for this tracked ref, so it keeps
        // the unambiguous local alias `upstream/effect-atom`.
        yield* git(cwd, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "upstream/effect-atom",
        );
        yield* writeTextFile(cwd, "alias.txt", "alias\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add alias update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "upstream/effect-atom",
          upstreamBranch: "my-org/upstream/effect-atom",
          setUpstream: false,
        });
        assert.equal(
          yield* git(remote, ["log", "-1", "--pretty=%s", "effect-atom"]),
          "Add alias update",
        );
      }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});
