import { vi } from "vite-plus/test";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { mintStorageCleanupClaim, type StorageCleanupClaim } from "../storage/cleanupClaim.ts";
import {
  acquireStorageSettingsLease,
  recordCreatedWorktree,
  storageLifecycleLock,
} from "../storage/lifecycle.ts";
import type { WorktreeIdentity } from "../storage/filesystem.ts";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { captureWorktreeIdentity, measureDirectory } from "../storage/filesystem.ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Scope,
  RcMap,
} from "effect";

import { DEFAULT_SERVER_SETTINGS, GitCommandError, ProjectId } from "@ryco/contracts";
import { beginWorktreeSetup } from "../project/worktreeSetupState.ts";
import { canonicalizeWorktreePath } from "../project/worktreeRoot.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  makeGitVcsDriverCore,
  parseGitCheckoutProgressPercent,
  parseGitConfigList,
  parseListedRefs,
} from "./GitVcsDriverCore.ts";
import { configureTestGitCommitIdentity } from "./testing/GitTestRepo.ts";

// Observe actual destination-lock acquisition for deterministic pre-mkdir races.
// Preserve the real semaphore/map behavior; only the get boundary is observable.
vi.mock("effect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect")>();
  return { ...actual, RcMap: { ...actual.RcMap, get: vi.fn(actual.RcMap.get) } };
});

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-git-vcs-driver-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const OverrideTestLayer = Layer.merge(ServerConfigLayer, NodeServices.layer);

const claimCreatedFixtureWorktree = (
  repository: string,
  candidate: string,
  quarantine: string,
  fingerprint: string,
  identity: WorktreeIdentity,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* recordCreatedWorktree(sql, repository, candidate);
    return yield* storageLifecycleLock.withPermit(
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
        }>`SELECT id FROM storage_owned_entries WHERE path = ${candidate}`;
        yield* sql`UPDATE storage_owned_entries SET state = 'removing', identity_json = ${JSON.stringify({ ...identity, quarantinePath: quarantine })} WHERE path = ${candidate}`;
        const lease = acquireStorageSettingsLease();
        yield* Effect.addFinalizer(() => Effect.sync(lease.release));
        const claim = yield* mintStorageCleanupClaim(sql, {
          id: rows[0]!.id,
          repository,
          candidate,
          quarantine,
          fingerprint,
          identity,
          lease,
        });
        return { claim, release: lease.release };
      }),
    );
  });

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

const repositoryIdentity = (cwd: string) =>
  git(cwd, ["rev-parse", "--git-common-dir"]).pipe(
    Effect.flatMap((commonDir) =>
      Effect.promise(() => canonicalizeWorktreePath(nodePath.resolve(cwd, commonDir))),
    ),
  );

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
              if (command === "diff" || (command === "-c" && input.args.includes("diff"))) {
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
            .filter((call) => call.args.includes("diff") && call.args.includes("--numstat"))
            .map((call) => call.args),
          [["-c", "diff.autoRefreshIndex=false", "diff", "HEAD", "--numstat"]],
        );
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("reads a feature branch's status with one base lookup and no optional locks", () =>
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
        const base = "a".repeat(40);
        const head = "b".repeat(40);
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            Effect.sync(() => {
              calls.push(input);
              const args = input.args.join(" ");
              if (args === "status --porcelain=2 --branch")
                return ok("# branch.oid abc\n# branch.head feature/x\n");
              if (args === "-c diff.autoRefreshIndex=false diff HEAD --numstat")
                return ok("1\t0\tsrc/a.ts\n");
              if (args === "symbolic-ref refs/remotes/origin/HEAD")
                return ok("refs/remotes/origin/main\n");
              if (args === "config -z --list")
                return ok("remote.origin.url\ngit@example.com:o/r.git\0core.bare\nfalse\0");
              if (input.args[0] === "for-each-ref") return ok("refs/remotes/origin/main\n");
              if (input.args[0] === "rev-parse") return ok(`${base}\n${head}\n`);
              if (input.args[0] === "rev-list") return ok("3\n");
              if (args === `diff --numstat ${base}...${head}`) return ok("4\t1\tsrc/b.ts\n");
              throw new Error(`Unexpected git command: ${args}`);
            }),
        });

        const status = yield* driver.statusDetailsLocal("/repo");

        assert.equal(status.branch, "feature/x");
        assert.equal(status.hasOriginRemote, true);
        assert.equal(status.aheadCount, 3);
        assert.equal(status.aheadOfDefaultCount, 3);
        assert.deepStrictEqual(status.committed?.files, [
          { path: "src/b.ts", insertions: 4, deletions: 1 },
        ]);
        // The base is resolved once and shared by both counts and the diff.
        // The working-tree diff never refreshes the index; the commit-pair diff has no working tree.
        assert.deepStrictEqual(calls.map((call) => call.args[0]).toSorted(), [
          "-c",
          "config",
          "diff",
          "for-each-ref",
          "rev-list",
          "rev-parse",
          "status",
          "symbolic-ref",
        ]);
        assert.deepStrictEqual(
          calls.find((call) => call.args[0] === "for-each-ref")?.args.slice(2),
          [
            "refs/heads/main",
            "refs/remotes/origin/main",
            "refs/heads/master",
            "refs/remotes/origin/master",
          ],
        );
        // Background reads never take `index.lock`.
        assert.isTrue(calls.every((call) => call.readOnly === true));

        // The commit-pair results are reused while neither end moves.
        calls.length = 0;
        yield* driver.statusDetailsLocal("/repo");
        assert.isFalse(calls.some((call) => call.args[0] === "rev-list"));
        assert.isFalse(calls.some((call) => call.args.join(" ").includes("...")));
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it("parses git config listings and remote names", () => {
      const snapshot = parseGitConfigList(
        [
          "remote.origin.url\ngit@example.com:o/r.git",
          "remote.upstream.url\nhttps://example.com/u/r",
          "branch.Feature/X.remote\norigin",
          "branch.Feature/X.gh-merge-base\ndevelop",
          "core.bare\nfalse",
          "core.bare\ntrue",
          "user.flag",
          "",
        ].join("\0"),
      );
      assert.deepStrictEqual(snapshot.remoteNames, ["origin", "upstream"]);
      // Section and key names are case-insensitive; the branch subsection is not.
      assert.equal(snapshot.get("Branch.Feature/X.Remote"), "origin");
      assert.equal(snapshot.get("branch.feature/x.remote"), null);
      assert.equal(snapshot.get("branch.Feature/X.gh-merge-base"), "develop");
      assert.equal(snapshot.get("core.bare"), "true");
      assert.equal(snapshot.get("user.flag"), null);
    });

    it("parses the listing for-each-ref returns for branch lists", () => {
      const refs = parseListedRefs(
        [
          ["refs/heads/main", "1700000000", "*", "", "/repo"].join("\0"),
          ["refs/heads/topic", "1700000500", " ", "", ""].join("\0"),
          ["refs/remotes/origin/HEAD", "", " ", "refs/remotes/origin/main", ""].join("\0"),
          "",
        ].join("\n"),
      );
      assert.deepStrictEqual(refs, [
        {
          refname: "refs/heads/main",
          lastCommit: 1700000000,
          isHead: true,
          symref: "",
          worktreePath: "/repo",
        },
        {
          refname: "refs/heads/topic",
          lastCommit: 1700000500,
          isHead: false,
          symref: "",
          worktreePath: "",
        },
        {
          refname: "refs/remotes/origin/HEAD",
          lastCommit: 0,
          isHead: false,
          symref: "refs/remotes/origin/main",
          worktreePath: "",
        },
      ]);
    });

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

    it.effect("reads status without rewriting the index for files whose stat data changed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        // Same content, newer mtime: a refreshing `git diff` rewrites the index under index.lock.
        const later = new Date(Date.now() + 60_000);
        yield* Effect.promise(() =>
          fsPromises.utimes(nodePath.join(cwd, "README.md"), later, later),
        );
        const index = nodePath.join(cwd, ".git", "index");
        const before = yield* Effect.promise(() =>
          Promise.all([fsPromises.readFile(index), fsPromises.stat(index)]),
        );

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsLocal(cwd);

        const after = yield* Effect.promise(() =>
          Promise.all([fsPromises.readFile(index), fsPromises.stat(index)]),
        );
        assert.isTrue(after[0].equals(before[0]));
        assert.equal(after[1].mtimeMs, before[1].mtimeMs);
        assert.equal(status.hasWorkingTreeChanges, false);
        assert.deepStrictEqual(status.workingTree.files, []);
      }),
    );

    it.effect("keeps only status-confirmed rows and renamed paths in the working tree", () =>
      Effect.gen(function* () {
        const ok = (stdout = "") =>
          ({
            exitCode: 0 as GitVcsDriver.ExecuteGitResult["exitCode"],
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }) satisfies GitVcsDriver.ExecuteGitResult;
        const hash = "c".repeat(40);
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            Effect.sync(() => {
              const args = input.args.join(" ");
              if (args === "status --porcelain=2 --branch")
                return ok(
                  [
                    "# branch.oid abc",
                    "# branch.head main",
                    `1 .M N... 100644 100644 100644 ${hash} ${hash} src/my file.ts`,
                    `2 R. N... 100644 100644 100644 ${hash} ${hash} R100 src/b.ts\tsrc/a.ts`,
                    "",
                  ].join("\n"),
                );
              if (args === "-c diff.autoRefreshIndex=false diff HEAD --numstat")
                // An older Git lists a stat-only change (`touched.ts`) as an unchanged row.
                return ok("3\t1\tsrc/my file.ts\n0\t0\tsrc/{a.ts => b.ts}\n0\t0\tsrc/touched.ts\n");
              if (args === "symbolic-ref refs/remotes/origin/HEAD")
                return ok("refs/remotes/origin/main\n");
              return ok();
            }),
        });

        const status = yield* driver.statusDetailsLocal("/repo");

        assert.deepStrictEqual(status.workingTree.files, [
          { path: "src/b.ts", insertions: 0, deletions: 0 },
          { path: "src/my file.ts", insertions: 3, deletions: 1 },
        ]);
        assert.equal(status.workingTree.insertions, 3);
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("reports a status fetch that git rejected as no fetch", () =>
      Effect.gen(function* () {
        let fetches = 0;
        const result = (exitCode: number, stdout = "") =>
          ({
            exitCode: exitCode as GitVcsDriver.ExecuteGitResult["exitCode"],
            stdout,
            stderr: exitCode === 0 ? "" : "fatal: unable to access remote",
            stdoutTruncated: false,
            stderrTruncated: false,
          }) satisfies GitVcsDriver.ExecuteGitResult;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            Effect.sync(() => {
              if (input.operation === "GitVcsDriver.fetchRemoteForStatus") {
                fetches += 1;
                return result(128);
              }
              if (input.args.includes("@{upstream}")) return result(0, "origin/main\n");
              if (input.args.includes("--git-common-dir")) return result(0, ".git\n");
              if (input.args[0] === "remote") return result(0, "origin\n");
              throw new Error(`Unexpected git command: ${input.args.join(" ")}`);
            }),
        });

        assert.isFalse(yield* driver.refreshStatusUpstream("/repo"));
        // The failed fetch still holds the interval: an unreachable remote is not retried at once.
        assert.isFalse(yield* driver.refreshStatusUpstream("/repo"));
        assert.equal(fetches, 1);
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("recomputes upstream counts only while HEAD stays on the status's branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const details = yield* driver.statusDetailsLocal(cwd);
        assert.equal(details.aheadCount, 0);

        yield* git(cwd, ["commit", "--allow-empty", "-m", "Local work"]);
        const tracked = yield* driver.refreshStatusTracking(cwd, details);
        assert.deepStrictEqual(tracked, { ...details, aheadCount: 1, behindCount: 0 });

        yield* git(cwd, ["checkout", "-b", "elsewhere"]);
        assert.isNull(yield* driver.refreshStatusTracking(cwd, details));
      }),
    );

    it.effect("serves a branch picker's later pages from one listing until git writes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "alpha"]);
        yield* git(cwd, ["branch", "beta"]);
        const base = yield* GitVcsDriver.GitVcsDriver;
        let listings = 0;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) => {
            if (input.operation === "GitVcsDriver.listRefs.forEachRef") listings += 1;
            return base.execute(input);
          },
        });

        const first = yield* driver.listRefs({ cwd, limit: 1 });
        const second = yield* driver.listRefs({ cwd, limit: 1, cursor: 1 });
        yield* driver.listRefs({ cwd, query: "alp" });
        assert.equal(listings, 1);
        assert.equal(first.totalCount, 3);
        assert.notEqual(first.refs[0]?.name, second.refs[0]?.name);

        // A ref this driver creates is listed at once.
        yield* driver.createRef({ cwd, refName: "gamma" });
        const after = yield* driver.listRefs({ cwd });
        assert.equal(listings, 2);
        assert.include(
          after.refs.map((ref) => ref.name),
          "gamma",
        );
      }).pipe(Effect.provide(ServerConfigLayer)),
    );

    it.effect("drops the branch listing when a status refresh reports refs may have moved", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const base = yield* GitVcsDriver.GitVcsDriver;
        let listings = 0;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) => {
            if (input.operation === "GitVcsDriver.listRefs.forEachRef") listings += 1;
            return base.execute(input);
          },
        });

        yield* driver.listRefs({ cwd });
        // An agent's own git command is invisible to this driver's write hook.
        yield* git(cwd, ["branch", "agent-branch"]);
        const cached = yield* driver.listRefs({ cwd });
        assert.equal(listings, 1);
        assert.notInclude(
          cached.refs.map((ref) => ref.name),
          "agent-branch",
        );

        yield* driver.invalidateRefListing(cwd);
        const fresh = yield* driver.listRefs({ cwd });
        assert.equal(listings, 2);
        assert.include(
          fresh.refs.map((ref) => ref.name),
          "agent-branch",
        );
      }).pipe(Effect.provide(ServerConfigLayer)),
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

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const status = yield* driver.statusDetails(cwd);

        // The change is fully committed, so the working tree is clean but the
        // committed-vs-base diff still reflects it.
        assert.equal(status.workingTree.files.length, 0);
        assert.deepEqual(status.committed, {
          files: [{ path: "feature.txt", insertions: 2, deletions: 0 }],
          insertions: 2,
          deletions: 0,
        });
        const repeated = yield* driver.statusDetails(cwd);
        assert.strictEqual(repeated.committed, status.committed);
        yield* writeTextFile(cwd, "feature.txt", "line1\nline2\nline3\n");
        const dirty = yield* driver.statusDetails(cwd);
        assert.strictEqual(dirty.committed, status.committed);
        assert.equal(dirty.workingTree.insertions, 1);
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "another feature commit"]);
        const advanced = yield* driver.statusDetails(cwd);
        assert.equal(advanced.committed?.insertions, 3);
        assert.notStrictEqual(advanced.committed, status.committed);
        yield* git(cwd, ["branch", "-f", "main", "HEAD"]);
        const movedBase = yield* driver.statusDetails(cwd);
        assert.equal(movedBase.committed?.insertions, 0);
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
    for (const reason of ["Operation timed out", "Operation canceled", "Cannot allocate memory"]) {
      it.effect(`preserves partial checkouts and explains mmap failure: ${reason}`, () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const checkout = (yield* Path.Path).join(yield* makeTmpDir("mmap-worktree-"), "checkout");
          const fs = yield* FileSystem.FileSystem;
          const base = yield* GitVcsDriver.GitVcsDriver;
          let attempts = 0;
          const driver = yield* makeGitVcsDriverCore({
            executeOverride: (input) =>
              Effect.gen(function* () {
                if (input.operation !== "GitVcsDriver.createWorktree")
                  return yield* base.execute(input);
                attempts++;
                // Git may register the checkout/branch before reading mapped data.
                const result = yield* base.execute({
                  ...input,
                  args: ["worktree", "add", "--no-checkout", ...input.args.slice(2)],
                });
                yield* fs
                  .writeFileString(`${checkout}/retain.txt`, "partial checkout data")
                  .pipe(Effect.orDie);
                return {
                  ...result,
                  exitCode: 128 as GitVcsDriver.ExecuteGitResult["exitCode"],
                  stderr: `fatal: mmap failed: ${reason}`,
                };
              }),
          });
          const error = yield* driver
            .createWorktree({
              cwd,
              path: checkout,
              refName: initialBranch,
              newRefName: "feature/mmap",
            })
            .pipe(Effect.flip);
          assert.include(error.detail, `mmap failed: ${reason}`);
          if (reason.startsWith("Operation")) assert.include(error.detail, "available offline");
          else assert.notInclude(error.detail, "available offline");
          assert.equal(attempts, 1);
          assert.equal(yield* fs.readFileString(`${checkout}/retain.txt`), "partial checkout data");
          assert.include(yield* base.listWorktreePaths(cwd), yield* fs.realPath(checkout));
          const incomplete = yield* driver.assertWorktreeSetupComplete(checkout).pipe(Effect.flip);
          assert.include(incomplete.detail, "incomplete setup");
        }).pipe(Effect.provide(OverrideTestLayer)),
      );
    }

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

    it.effect("rejects concurrent destination collisions without overwriting a winner", () =>
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
    it.effect("serializes canonical destination contenders before launching Git", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const root = yield* makeTmpDir("serialized-worktrees-");
        const destination = `${root}/checkout`;
        const base = yield* GitVcsDriver.GitVcsDriver;
        let launches = 0;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            Effect.gen(function* () {
              if (input.args[0] === "worktree" && input.args[1] === "add") {
                launches++;
                // Keep Git from creating the destination until both callers have
                // had a chance to pass an unguarded existence check.
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
              }
              return yield* base.execute(input);
            }),
        }).pipe(Effect.provide(ServerConfigLayer));
        const results = yield* Effect.all(
          [destination, `${root}/./checkout`].map((target, index) =>
            driver
              .createWorktree({
                cwd,
                path: target,
                refName: initialBranch,
                newRefName: `feature/serialized-${index}`,
              })
              .pipe(Effect.result),
          ),
          { concurrency: 2 },
        );
        assert.equal(launches, 1);
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
    it.effect("fetches only the base branch for a new worktree and reads origin/HEAD locally", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(remote);
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["clone", remote, "."]);
        yield* git(remote, ["branch", "unrelated"]);
        yield* git(remote, ["commit", "--allow-empty", "-m", "new remote commit"]);
        const remoteHead = yield* git(remote, ["rev-parse", "HEAD"]);
        const base = yield* GitVcsDriver.GitVcsDriver;
        const operations: string[] = [];
        const fetchArgs: Array<ReadonlyArray<string>> = [];
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) => {
            operations.push(input.operation);
            if (input.args[0] === "fetch") fetchArgs.push(input.args);
            return base.execute(input);
          },
        });
        const pathService = yield* Path.Path;
        const root = yield* makeTmpDir();
        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(root, "default"),
          refName: "origin/HEAD",
          newRefName: "feature/default",
          fetchOrigin: true,
        });

        assert.equal(yield* git(created.worktree.path, ["rev-parse", "HEAD"]), remoteHead);
        // The clone recorded origin/HEAD: no network round trip to ask origin.
        assert.notInclude(operations, "GitVcsDriver.originHead");
        assert.deepStrictEqual(fetchArgs, [
          [
            "fetch",
            "--no-tags",
            "origin",
            `+refs/heads/${initialBranch}:refs/remotes/origin/${initialBranch}`,
          ],
        ]);
        // Other heads of origin were not fetched.
        assert.equal(
          yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/unrelated"]),
          "",
        );
      }).pipe(Effect.provide(ServerConfigLayer)),
    );
    it.effect("starts a new worktree from a prefetched base without fetching again", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(remote);
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["clone", remote, "."]);
        yield* git(remote, ["commit", "--allow-empty", "-m", "new remote commit"]);
        const remoteHead = yield* git(remote, ["rev-parse", "HEAD"]);
        const base = yield* GitVcsDriver.GitVcsDriver;
        const fetchArgs: Array<ReadonlyArray<string>> = [];
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) => {
            if (input.args[0] === "fetch") fetchArgs.push(input.args);
            return base.execute(input);
          },
        });
        const pathService = yield* Path.Path;
        const root = yield* makeTmpDir();

        // Entering worktree mode prefetches the base; the send reuses it.
        yield* driver.prefetchWorktreeBase({ cwd, refName: `origin/${initialBranch}` });
        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(root, "prefetched"),
          refName: `origin/${initialBranch}`,
          newRefName: "feature/prefetched",
          fetchOrigin: true,
        });

        assert.equal(yield* git(created.worktree.path, ["rev-parse", "HEAD"]), remoteHead);
        assert.lengthOf(fetchArgs, 1);
        // Another base is fetched as usual.
        yield* git(remote, ["branch", "other"]);
        yield* driver.createWorktree({
          cwd,
          path: pathService.join(root, "other"),
          refName: "origin/other",
          newRefName: "feature/other",
          fetchOrigin: true,
        });
        assert.lengthOf(fetchArgs, 2);
      }).pipe(Effect.provide(ServerConfigLayer)),
    );
    it.effect("shares one base fetch between worktrees created together", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(remote);
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["clone", remote, "."]);
        // Origin moved, so parallel fetches of its branch would race for the
        // remote-tracking ref's lock (one prompt sent to several models).
        yield* git(remote, ["commit", "--allow-empty", "-m", "new remote commit"]);
        const remoteHead = yield* git(remote, ["rev-parse", "HEAD"]);
        const base = yield* GitVcsDriver.GitVcsDriver;
        const fetchArgs: Array<ReadonlyArray<string>> = [];
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) => {
            if (input.args[0] === "fetch") fetchArgs.push(input.args);
            return base.execute(input);
          },
        });
        const pathService = yield* Path.Path;
        const root = yield* makeTmpDir();

        const created = yield* Effect.forEach(
          [1, 2, 3, 4],
          (index) =>
            driver.createWorktree({
              cwd,
              path: pathService.join(root, `model-${index}`),
              refName: `origin/${initialBranch}`,
              newRefName: `compare/model-${index}`,
              fetchOrigin: true,
            }),
          { concurrency: "unbounded" },
        );

        assert.lengthOf(fetchArgs, 1);
        assert.lengthOf(new Set(created.map((result) => result.worktree.path)), 4);
        for (const result of created) {
          assert.equal(yield* git(result.worktree.path, ["rev-parse", "HEAD"]), remoteHead);
        }
        // Once it settled, the next creation fetches again.
        yield* driver.createWorktree({
          cwd,
          path: pathService.join(root, "later"),
          refName: `origin/${initialBranch}`,
          newRefName: "compare/later",
          fetchOrigin: true,
        });
        assert.lengthOf(fetchArgs, 2);
      }).pipe(Effect.provide(ServerConfigLayer)),
    );
    it.effect("creates the branches of worktrees created together one at a time", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(remote);
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["clone", remote, "."]);
        // Git as it was before it retried a held config lock (Apple's still is):
        // two branches created at once fail on `.git/config.lock`.
        yield* git(cwd, ["config", "core.configLockTimeout", "0"]);
        const base = yield* GitVcsDriver.GitVcsDriver;
        // Commands that write a new branch's upstream to the shared config.
        const writesBranchConfig = (args: ReadonlyArray<string>) =>
          (args[0] === "branch" && !args.includes("-m")) ||
          (args[0] === "worktree" && args[1] === "add" && args.includes("-b"));
        let running = 0;
        let mostAtOnce = 0;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            !writesBranchConfig(input.args)
              ? base.execute(input)
              : Effect.suspend(() => {
                  running += 1;
                  mostAtOnce = Math.max(mostAtOnce, running);
                  // Long enough for every creation to reach its own branch write.
                  return Effect.promise(
                    () => new Promise((resolve) => setTimeout(resolve, 50)),
                  ).pipe(
                    Effect.andThen(base.execute(input)),
                    Effect.ensuring(Effect.sync(() => (running -= 1))),
                  );
                }),
        });
        const pathService = yield* Path.Path;
        const root = yield* makeTmpDir();

        const created = yield* Effect.forEach(
          [1, 2, 3, 4],
          (index) =>
            driver.createWorktree({
              cwd,
              path: pathService.join(root, `model-${index}`),
              refName: `origin/${initialBranch}`,
              newRefName: `compare/model-${index}`,
              fetchOrigin: true,
            }),
          { concurrency: "unbounded" },
        );

        assert.equal(mostAtOnce, 1);
        assert.lengthOf(created, 4);
        for (const [index, result] of created.entries()) {
          const branch = `compare/model-${index + 1}`;
          assert.equal(yield* git(result.worktree.path, ["branch", "--show-current"]), branch);
          // The upstream Git sets for a branch cut from origin's is kept.
          assert.equal(
            yield* git(cwd, ["config", "--get", `branch.${branch}.merge`]),
            `refs/heads/${initialBranch}`,
          );
        }
      }).pipe(Effect.provide(ServerConfigLayer)),
    );
    it.effect("lets a prefetch join the base fetch of worktrees being created", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(remote);
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["clone", remote, "."]);
        yield* git(remote, ["commit", "--allow-empty", "-m", "new remote commit"]);
        const base = yield* GitVcsDriver.GitVcsDriver;
        const fetchArgs: Array<ReadonlyArray<string>> = [];
        const release = yield* Deferred.make<void>();
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            input.args[0] !== "fetch"
              ? base.execute(input)
              : Effect.suspend(() => {
                  fetchArgs.push(input.args);
                  return Deferred.await(release).pipe(Effect.andThen(base.execute(input)));
                }),
        });
        const pathService = yield* Path.Path;
        const root = yield* makeTmpDir();
        // Resolves once both creations reached their fetch.
        const reached = yield* Deferred.make<void>();
        let arrivals = 0;
        const create = (name: string) =>
          driver.createWorktree({
            cwd,
            path: pathService.join(root, name),
            refName: `origin/${initialBranch}`,
            newRefName: `compare/${name}`,
            fetchOrigin: true,
            progress: {
              onFetchStarted: () =>
                (arrivals += 1) === 2
                  ? Deferred.succeed(reached, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            },
          });

        // A compare send's creations hold one fetch; the composer prefetches meanwhile.
        const creations = yield* Effect.forkChild(
          Effect.forEach(["model-1", "model-2"], create, { concurrency: "unbounded" }),
        );
        yield* Deferred.await(reached);
        yield* Effect.yieldNow;
        const prefetch = yield* Effect.forkChild(
          driver.prefetchWorktreeBase({ cwd, refName: `origin/${initialBranch}` }),
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.lengthOf(fetchArgs, 1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(creations);
        yield* Fiber.join(prefetch);
        assert.lengthOf(fetchArgs, 1);
        // The prefetch took that fetch as its own: the next send reuses it.
        yield* create("later");
        assert.lengthOf(fetchArgs, 1);
      }).pipe(Effect.provide(ServerConfigLayer)),
    );
    it.effect("never fetches one base twice at once, however the base is named", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(remote);
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["clone", remote, "."]);
        yield* git(remote, ["commit", "--allow-empty", "-m", "new remote commit"]);
        const remoteHead = yield* git(remote, ["rev-parse", "HEAD"]);
        const base = yield* GitVcsDriver.GitVcsDriver;
        const fetchArgs: Array<ReadonlyArray<string>> = [];
        const release = yield* Deferred.make<void>();
        let running = 0;
        let mostAtOnce = 0;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            input.args[0] !== "fetch"
              ? base.execute(input)
              : Effect.suspend(() => {
                  fetchArgs.push(input.args);
                  running += 1;
                  mostAtOnce = Math.max(mostAtOnce, running);
                  return Deferred.await(release).pipe(
                    Effect.andThen(base.execute(input)),
                    Effect.ensuring(Effect.sync(() => (running -= 1))),
                  );
                }),
        });
        const pathService = yield* Path.Path;
        const root = yield* makeTmpDir();

        const first = yield* Effect.forkChild(
          driver.createWorktree({
            cwd,
            path: pathService.join(root, "by-remote-name"),
            refName: `origin/${initialBranch}`,
            newRefName: "compare/by-remote-name",
            fetchOrigin: true,
          }),
        );
        // `main` names the ref `origin/main` does: it joins that fetch.
        const sameRef = yield* Effect.forkChild(
          driver.prefetchWorktreeBase({ cwd, refName: initialBranch }),
        );
        // `origin/HEAD` names it too, without saying so: it waits its turn.
        const defaultBranch = yield* Effect.forkChild(
          driver.createWorktree({
            cwd,
            path: pathService.join(root, "by-default"),
            refName: "origin/HEAD",
            newRefName: "compare/by-default",
            fetchOrigin: true,
          }),
        );
        for (let tick = 0; tick < 20 && fetchArgs.length === 0; tick += 1) {
          yield* Effect.yieldNow;
        }
        yield* Effect.yieldNow;
        assert.lengthOf(fetchArgs, 1);
        yield* Deferred.succeed(release, undefined);
        const created = [yield* Fiber.join(first), yield* Fiber.join(defaultBranch)];
        yield* Fiber.join(sameRef);
        assert.equal(mostAtOnce, 1);
        assert.lengthOf(fetchArgs, 2);
        for (const result of created) {
          assert.equal(yield* git(result.worktree.path, ["rev-parse", "HEAD"]), remoteHead);
        }
      }).pipe(Effect.provide(ServerConfigLayer)),
    );
    it.effect("reports the fetch and Git's checkout meter while creating a worktree", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(remote);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        // Enough files that Git draws its "Updating files" meter.
        for (let index = 0; index < 400; index += 1) {
          yield* fileSystem.writeFileString(pathService.join(remote, `f${index}.txt`), `${index}`);
        }
        yield* git(remote, ["add", "-A"]);
        yield* git(remote, ["commit", "-m", "many files"]);
        const cwd = yield* makeTmpDir();
        // Through the transport: a local clone copies object files, and an
        // object store this freshly written can race that copy.
        yield* git(cwd, ["clone", "--no-local", remote, "."]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const root = yield* makeTmpDir();
        const events: string[] = [];
        const percents: number[] = [];

        yield* driver.createWorktree({
          cwd,
          path: pathService.join(root, "progress"),
          refName: `origin/${initialBranch}`,
          newRefName: "feature/progress",
          fetchOrigin: true,
          progress: {
            onFetchStarted: () => Effect.sync(() => events.push("fetch-started")),
            onFetchFinished: ({ reused, branch }) =>
              Effect.sync(() => events.push(`fetch-finished:${reused}:${branch}`)),
            onCheckoutStarted: () => Effect.sync(() => events.push("checkout-started")),
            onCheckoutProgress: (percent) => Effect.sync(() => percents.push(percent)),
          },
        });

        assert.deepEqual(events, [
          "fetch-started",
          `fetch-finished:false:${initialBranch}`,
          "checkout-started",
        ]);
        // Updates arrive one per meter redraw, not only with the final line.
        assert.isAbove(percents.length, 1);
        assert.equal(percents.at(-1), 100);
        assert.deepEqual(
          percents.toSorted((a, b) => a - b),
          percents,
        );
      }).pipe(Effect.provide(ServerConfigLayer)),
    );
    it.effect("parses Git's checkout meter lines", () =>
      Effect.sync(() => {
        assert.equal(parseGitCheckoutProgressPercent("Updating files:  78% (2104/2700)"), 78);
        assert.equal(
          parseGitCheckoutProgressPercent("Updating files: 100% (2700/2700), done."),
          100,
        );
        assert.isNull(parseGitCheckoutProgressPercent("Preparing worktree (new branch 'a')"));
      }),
    );
    it.effect("asks origin when the recorded origin/HEAD names a branch origin renamed", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(remote);
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["clone", remote, "."]);
        // The default branch is renamed after the clone: the clone's recorded
        // origin/HEAD still names the old branch, which origin no longer has.
        yield* git(remote, ["branch", "-m", initialBranch, "trunk"]);
        yield* git(remote, ["commit", "--allow-empty", "-m", "on trunk"]);
        const remoteHead = yield* git(remote, ["rev-parse", "HEAD"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        const root = yield* makeTmpDir();

        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(root, "renamed"),
          refName: "origin/HEAD",
          newRefName: "feature/renamed-default",
          fetchOrigin: true,
        });

        assert.equal(yield* git(created.worktree.path, ["rev-parse", "HEAD"]), remoteHead);
      }).pipe(Effect.provide(ServerConfigLayer)),
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

    it.effect(
      "verified storage cleanup removes a checkout while retaining Git registration and history",
      () =>
        Effect.gen(function* () {
          const raw = yield* makeTmpDir();
          const cwd = yield* Effect.promise(() => fsPromises.realpath(raw));
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const pathService = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const checkout = pathService.join(cwd, "verified-checkout");
          yield* driver.createWorktree({
            cwd,
            path: checkout,
            refName: initialBranch,
            newRefName: "verified-history",
          });
          const identity = yield* Effect.promise(() => captureWorktreeIdentity(cwd, checkout));
          const measured = yield* Effect.promise(() =>
            measureDirectory(
              checkout,
              { remaining: 30_000, deadline: Date.now() + 3000 },
              new Set(),
              true,
            ),
          );
          const quarantine = pathService.join(cwd, ".cleanup-verified-positive");
          const { claim } = yield* claimCreatedFixtureWorktree(
            cwd,
            checkout,
            quarantine,
            measured.fingerprint!,
            identity,
          );
          yield* driver.removeWorktree({
            cwd,
            path: checkout,
            force: false,
            cleanup: {
              quarantinePath: quarantine,
              claim,
              fingerprint: measured.fingerprint!,
              identity,
            },
          });
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(checkout));
          assert.include(yield* git(cwd, ["worktree", "list", "--porcelain"]), checkout);
          assert.isNotEmpty(yield* git(cwd, ["rev-parse", "refs/heads/verified-history"]));
        }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
    it.effect(
      "verified cleanup preserves ignored external archives arriving during quarantine",
      () =>
        Effect.gen(function* () {
          const raw = yield* makeTmpDir();
          const cwd = yield* Effect.promise(() => fsPromises.realpath(raw));
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const pathService = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const checkout = pathService.join(cwd, "late-archive-checkout");
          yield* driver.createWorktree({
            cwd,
            path: checkout,
            refName: initialBranch,
            newRefName: "archive-history",
          });
          yield* Effect.promise(() =>
            fsPromises.writeFile(pathService.join(checkout, ".gitignore"), "archive.json\n"),
          );
          yield* git(checkout, ["add", ".gitignore"]);
          yield* git(checkout, ["commit", "-m", "ignored archive policy"]);
          yield* git(cwd, ["merge", "--ff-only", "archive-history"]);
          const identity = yield* Effect.promise(() => captureWorktreeIdentity(cwd, checkout));
          const measured = yield* Effect.promise(() =>
            measureDirectory(
              checkout,
              { remaining: 30_000, deadline: Date.now() + 3000 },
              new Set(),
              true,
            ),
          );
          const quarantine = pathService.join(cwd, ".cleanup-late-archive");
          const { claim } = yield* claimCreatedFixtureWorktree(
            cwd,
            checkout,
            quarantine,
            measured.fingerprint!,
            identity,
          );
          const original = fsPromises.rename;
          const rename = vi
            .spyOn(fsPromises, "rename")
            .mockImplementation(async (source, target) => {
              await original(source, target);
              if (source === checkout)
                await fsPromises.writeFile(
                  pathService.join(quarantine, "archive.json"),
                  "external archive",
                );
            });
          yield* Effect.addFinalizer(() => Effect.sync(() => rename.mockRestore()));
          const result = yield* driver
            .removeWorktree({
              cwd,
              path: checkout,
              force: false,
              cleanup: {
                quarantinePath: quarantine,
                fingerprint: measured.fingerprint!,
                identity,
                claim,
              },
            })
            .pipe(Effect.result);
          rename.mockRestore();
          assert.equal(result._tag, "Failure");
          assert.equal(
            yield* Effect.promise(() =>
              fsPromises.readFile(pathService.join(quarantine, "archive.json"), "utf8"),
            ),
            "external archive",
          );
          assert.isNotEmpty(yield* git(cwd, ["rev-parse", "refs/heads/archive-history"]));
        }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
    it.effect(
      "refuses unclaimed manual worktree cleanup even with caller-supplied admission callbacks",
      () =>
        Effect.gen(function* () {
          const raw = yield* makeTmpDir();
          const cwd = yield* Effect.promise(() => fsPromises.realpath(raw));
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const pathService = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const checkout = pathService.join(cwd, "manual-checkout");
          yield* git(cwd, ["worktree", "add", "-b", "manual-history", checkout, initialBranch]);
          const identity = yield* Effect.promise(() => captureWorktreeIdentity(cwd, checkout));
          const size = yield* Effect.promise(() =>
            measureDirectory(
              checkout,
              { remaining: 30_000, deadline: Date.now() + 3000 },
              new Set(),
              true,
            ),
          );
          const result = yield* driver
            .removeWorktree({
              cwd,
              path: checkout,
              force: false,
              cleanup: {
                identity,
                fingerprint: size.fingerprint!,
                quarantinePath: pathService.join(cwd, ".cleanup-manual"),
                claim: Object.freeze({}) as StorageCleanupClaim,
                assertAdmission: () => {},
              },
            })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(checkout));
          assert.include(yield* git(cwd, ["worktree", "list", "--porcelain"]), checkout);
        }),
    );
    it.effect(
      "revalidates durable ownership and active admission for an authentic cleanup capability",
      () =>
        Effect.gen(function* () {
          const raw = yield* makeTmpDir();
          const cwd = yield* Effect.promise(() => fsPromises.realpath(raw));
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const pathService = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const sql = yield* SqlClient.SqlClient;
          const checkout = pathService.join(cwd, "proof-checkout");
          yield* driver.createWorktree({
            cwd,
            path: checkout,
            refName: initialBranch,
            newRefName: "proof-history",
          });
          const identity = yield* Effect.promise(() => captureWorktreeIdentity(cwd, checkout));
          const size = yield* Effect.promise(() =>
            measureDirectory(
              checkout,
              { remaining: 30_000, deadline: Date.now() + 3000 },
              new Set(),
              true,
            ),
          );
          const quarantine = pathService.join(cwd, ".cleanup-proof");
          const { claim, release } = yield* claimCreatedFixtureWorktree(
            cwd,
            checkout,
            quarantine,
            size.fingerprint!,
            identity,
          );
          const cleanup = {
            identity,
            fingerprint: size.fingerprint!,
            quarantinePath: quarantine,
            claim,
          };
          const additionalLease = yield* storageLifecycleLock.withPermit(
            Effect.sync(acquireStorageSettingsLease),
          );
          yield* Effect.addFinalizer(() => Effect.sync(additionalLease.release));
          const absent = yield* mintStorageCleanupClaim(sql, {
            id: "no-owned-row",
            repository: cwd,
            candidate: checkout,
            quarantine,
            fingerprint: size.fingerprint!,
            identity,
            lease: additionalLease,
          }).pipe(Effect.result);
          assert.equal(absent._tag, "Failure");
          const cloned = yield* driver
            .removeWorktree({ cwd, path: checkout, cleanup: { ...cleanup, claim: { ...claim } } })
            .pipe(Effect.result);
          assert.equal(cloned._tag, "Failure");
          yield* sql`UPDATE storage_owned_entries SET state = 'owned' WHERE path = ${checkout}`;
          const lostOwnership = yield* driver
            .removeWorktree({ cwd, path: checkout, cleanup })
            .pipe(Effect.result);
          assert.equal(lostOwnership._tag, "Failure");
          yield* sql`UPDATE storage_owned_entries SET state = 'removing' WHERE path = ${checkout}`;
          release();
          const expired = yield* driver
            .removeWorktree({ cwd, path: checkout, cleanup })
            .pipe(Effect.result);
          assert.equal(expired._tag, "Failure");
          assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(checkout));
        }).pipe(Effect.provide(SqlitePersistenceMemory)),
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

    it.effect("initializes exactly the requested depth in synthetic nested submodules", () =>
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
        yield* git(cwd, ["config", "submodule.recurse", "true"]);

        const pathService = yield* Path.Path;
        const worktreeRoot = yield* makeTmpDir("git-worktrees-");
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

        const fileSystem = yield* FileSystem.FileSystem;
        for (const configuredMode of [undefined, "recursive", "top-level", "none"] as const) {
          const mode = configuredMode ?? "recursive";
          // Commit a branch-owned policy, then dirty the source checkout to prove
          // resolution uses the newly created checkout rather than the source file.
          yield* writeTextFile(
            cwd,
            "ryco.json",
            JSON.stringify({ worktreeSubmodules: configuredMode }),
          );
          yield* git(cwd, ["add", "ryco.json"]);
          yield* git(cwd, ["commit", "-m", `configure ${mode}`]);
          yield* writeTextFile(cwd, "ryco.json", '{"worktreeSubmodules":"none"}');
          const worktreePath = pathService.join(worktreeRoot, configuredMode ?? "default");
          const created = yield* driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: `feature/${configuredMode ?? "default"}`,
          });
          assert.equal(
            yield* fileSystem.exists(pathService.join(worktreePath, "modules/nested/README.md")),
            mode !== "none",
          );
          assert.equal(
            yield* fileSystem.exists(
              pathService.join(worktreePath, "modules/nested/nested/leaf/leaf.txt"),
            ),
            mode === "recursive",
          );
          assert.deepStrictEqual(created.submoduleInitialization, {
            mode,
            source: configuredMode ? "repository" : "node",
            status: mode === "none" ? "skipped" : "initialized",
            reason:
              mode === "none"
                ? "Submodule initialization disabled by repository settings."
                : mode === "top-level"
                  ? "Initialized top-level submodules; nested submodules were left uninitialized."
                  : "Initialized submodules recursively.",
          });
        }
        yield* writeTextFile(cwd, "ryco.json", "{}");
        yield* git(cwd, ["add", "ryco.json"]);
        yield* git(cwd, ["commit", "-m", "inherit node policy"]);
        for (const mode of ["recursive", "top-level", "none"] as const) {
          const calls: GitVcsDriver.ExecuteGitInput[] = [];
          const policyDriver = yield* makeGitVcsDriverCore({
            executeOverride: (input) => {
              calls.push(input);
              return baseDriver.execute({
                ...input,
                env: { ...input.env, GIT_ALLOW_PROTOCOL: "file" },
              });
            },
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                OverrideTestLayer,
                ServerSettingsService.layerTest({
                  worktreeSubmodules: "none",
                  projectWorktreeSubmodules: { project: mode },
                }),
              ),
            ),
          );
          const worktreePath = pathService.join(worktreeRoot, `project-${mode}`);
          const created = yield* policyDriver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: `feature/project-${mode}`,
            projectId: ProjectId.make("project"),
          });
          assert.equal(created.submoduleInitialization?.source, "project");
          assert.equal(created.submoduleInitialization?.mode, mode);
          assert.equal(
            yield* fileSystem.exists(pathService.join(worktreePath, "modules/nested/README.md")),
            mode !== "none",
          );
          assert.equal(
            yield* fileSystem.exists(
              pathService.join(worktreePath, "modules/nested/nested/leaf/leaf.txt"),
            ),
            mode === "recursive",
          );
          const setup = calls.find(
            (call) => call.operation === "GitVcsDriver.createWorktree.initializeSubmodules",
          );
          assert.deepStrictEqual(
            setup?.args,
            mode === "none"
              ? undefined
              : ["submodule", "update", "--init", ...(mode === "recursive" ? ["--recursive"] : [])],
          );
        }
      }),
    );

    it.effect("uses the workflow snapshot without rereading mutable node settings", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitmodules", '[submodule "test"]\n');
        yield* git(cwd, ["add", ".gitmodules"]);
        yield* git(cwd, ["commit", "-m", "snapshot fixture"]);
        const root = yield* makeTmpDir();
        const calls: GitVcsDriver.ExecuteGitInput[] = [];
        const baseDriver = yield* GitVcsDriver.GitVcsDriver;
        const settingsSnapshot = {
          ...DEFAULT_SERVER_SETTINGS,
          worktreeRoot: root,
          worktreeSubmodules: "none" as const,
        };
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) => {
            calls.push(input);
            return baseDriver.execute(input);
          },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              OverrideTestLayer,
              Layer.mock(ServerSettingsService)({
                getSettings: Effect.die("Creation must use the supplied workflow snapshot."),
              }),
            ),
          ),
        );
        const result = yield* driver.createWorktree({
          cwd,
          path: null,
          refName: initialBranch,
          newRefName: "feature/snapshot",
          settingsSnapshot,
        });
        assert.isTrue(
          result.worktree.path.startsWith(
            `${yield* (yield* FileSystem.FileSystem).realPath(root)}/`,
          ),
        );
        assert.equal(result.submoduleInitialization?.mode, "none");
        assert.equal(result.submoduleInitialization?.status, "skipped");
        assert.isFalse(
          calls.some(
            (call) => call.operation === "GitVcsDriver.createWorktree.initializeSubmodules",
          ),
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
                stdout: input.operation === "GitVcsDriver.resolveGitCommonDir" ? ".git" : "",
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
          [
            "GitVcsDriver.resolveGitCommonDir",
            "GitVcsDriver.createWorktree.createBranch",
            "GitVcsDriver.createWorktree",
          ],
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
                stdout: input.operation === "GitVcsDriver.resolveGitCommonDir" ? ".git" : "",
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

    it.effect("cancels submodule setup without deleting the created checkout", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitmodules", '[submodule "test"]\n');
        yield* git(cwd, ["add", ".gitmodules"]);
        yield* git(cwd, ["commit", "-m", "submodule fixture"]);
        const worktreePath = (yield* Path.Path).join(yield* makeTmpDir(), "cancelled");
        const baseDriver = yield* GitVcsDriver.GitVcsDriver;
        const started = yield* Deferred.make<void>();
        let stopped = false;
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            input.operation === "GitVcsDriver.createWorktree.initializeSubmodules"
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      stopped = true;
                    }),
                  ),
                )
              : baseDriver.execute(input),
        }).pipe(Effect.provide(OverrideTestLayer));
        const fiber = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/cancelled",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.isTrue(stopped);
        assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(worktreePath));
      }),
    );

    it.effect("a second live core cannot reclaim or remove a creator before Git registration", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const root = yield* makeTmpDir();
        const checkout = yield* Effect.promise(() => canonicalizeWorktreePath(`${root}/live`));
        const beforeAdd = yield* Deferred.make<void>();
        const releaseAdd = yield* Deferred.make<void>();
        const base = yield* GitVcsDriver.GitVcsDriver;
        const creator = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            (input.operation === "GitVcsDriver.createWorktree"
              ? Deferred.succeed(beforeAdd, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseAdd)),
                )
              : Effect.void
            ).pipe(Effect.andThen(base.execute(input))),
        });
        const commands: string[] = [];
        const sibling = yield* makeGitVcsDriverCore({
          executeOverride: (input) => {
            commands.push(input.operation);
            return base.execute(input);
          },
        });
        const creation = yield* creator
          .createWorktree({
            cwd,
            path: checkout,
            refName: initialBranch,
            newRefName: "feature/live-owner",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(beforeAdd);
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(checkout));
        const config = yield* ServerConfig;
        const journal = nodePath.join(
          config.stateDir,
          "incomplete-worktree-setup",
          `${createHash("sha256").update(checkout).digest("hex")}.json`,
        );
        const reserved = yield* Effect.promise(() => fsPromises.readFile(journal, "utf8"));
        const owner = yield* Effect.promise(() => fsPromises.readFile(`${journal}.owner`, "utf8"));
        const createError = yield* sibling
          .createWorktree({
            cwd,
            path: checkout,
            refName: initialBranch,
            newRefName: "feature/conflicting-owner",
          })
          .pipe(Effect.flip);
        const removeError = yield* sibling
          .removeWorktree({ cwd, path: checkout, force: true })
          .pipe(Effect.flip);
        assert.include(createError.detail, "another active or unverified creator");
        assert.include(removeError.detail, "another active or unverified creator");
        assert.equal(yield* Effect.promise(() => fsPromises.readFile(journal, "utf8")), reserved);
        assert.equal(
          yield* Effect.promise(() => fsPromises.readFile(`${journal}.owner`, "utf8")),
          owner,
        );
        assert.notInclude(commands, "GitVcsDriver.worktreeSetup.registration");
        assert.notInclude(commands, "GitVcsDriver.createWorktree");
        assert.notInclude(commands, "GitVcsDriver.removeWorktree");
        yield* Deferred.succeed(releaseAdd, undefined);
        assert.equal((yield* Fiber.join(creation)).worktree.path, checkout);
        yield* sibling.assertWorktreeSetupComplete(checkout);
        assert.equal(yield* git(checkout, ["branch", "--show-current"]), "feature/live-owner");
        assert.equal(yield* git(cwd, ["branch", "--list", "feature/conflicting-owner"]), "");
        yield* sibling.removeWorktree({ cwd, path: checkout });
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect(
      "recovers a crash-window journal after restart only when checkout and registration are absent",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const root = yield* makeTmpDir();
          const checkout = yield* Effect.promise(() =>
            canonicalizeWorktreePath(`${root}/missing/checkout`),
          );
          const config = yield* ServerConfig;
          const repositoryPath = yield* repositoryIdentity(cwd);
          // Simulate the durable state left by a process crash before git worktree add.
          yield* beginWorktreeSetup(config.stateDir, checkout, repositoryPath);
          const ownerPath = nodePath.join(
            config.stateDir,
            "incomplete-worktree-setup",
            `${createHash("sha256").update(checkout).digest("hex")}.json.owner`,
          );
          // A terminated pre-mutation owner is proven by child exit and ESRCH;
          // elapsed time is never evidence that an owner or Git child is gone.
          const deadPid = yield* Effect.promise(
            () =>
              new Promise<number>((resolve, reject) => {
                const child = spawn(
                  process.execPath,
                  [
                    "-e",
                    `
              require("node:fs").writeFileSync(process.argv[1], JSON.stringify({
                version: 1, pid: process.pid, token: "crash-fixture", phase: "reserved"
              }), { flag: "wx", mode: 0o600 });
            `,
                    ownerPath,
                  ],
                  { stdio: "ignore" },
                );
                child.on("error", reject);
                child.on("close", (code) =>
                  code === 0 && child.pid
                    ? resolve(child.pid)
                    : reject(new Error("crash fixture failed")),
                );
              }),
          );
          assert.throws(() => process.kill(deadPid, 0));
          const restarted = yield* makeGitVcsDriverCore();
          const created = yield* restarted.createWorktree({
            cwd,
            path: checkout,
            refName: initialBranch,
            newRefName: "feature/crash-retry",
          });
          assert.equal(created.worktree.path, checkout);
          yield* restarted.assertWorktreeSetupComplete(checkout);
          assert.include(yield* restarted.listWorktreePaths(cwd), checkout);
          assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect(
      "explicit removal recovers an absent crash-window journal without Git or branch deletion",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const root = yield* makeTmpDir();
          const checkout = yield* Effect.promise(() => canonicalizeWorktreePath(`${root}/absent`));
          const config = yield* ServerConfig;
          yield* beginWorktreeSetup(config.stateDir, checkout, yield* repositoryIdentity(cwd));
          const base = yield* GitVcsDriver.GitVcsDriver;
          const commands: string[] = [];
          const restarted = yield* makeGitVcsDriverCore({
            executeOverride: (input) => {
              commands.push(input.operation);
              return base.execute(input);
            },
          });
          yield* restarted.removeWorktree({ cwd, path: checkout, force: true });
          assert.notInclude(commands, "GitVcsDriver.removeWorktree");
          yield* restarted.createWorktree({
            cwd,
            path: checkout,
            refName: initialBranch,
            newRefName: "feature/explicit-retry",
          });
          yield* restarted.assertWorktreeSetupComplete(checkout);
          assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect(
      "preserves setup state after external directory removal until Git registration is pruned",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const root = yield* makeTmpDir();
          const checkout = yield* Effect.promise(() => canonicalizeWorktreePath(`${root}/removed`));
          yield* git(cwd, [
            "worktree",
            "add",
            "-b",
            "feature/external-retry",
            checkout,
            initialBranch,
          ]);
          const config = yield* ServerConfig;
          yield* beginWorktreeSetup(config.stateDir, checkout, yield* repositoryIdentity(cwd));
          yield* Effect.promise(() => fsPromises.rm(checkout, { recursive: true, force: true }));
          const restarted = yield* makeGitVcsDriverCore();
          const registeredError = yield* restarted
            .createWorktree({ cwd, path: checkout, refName: "feature/external-retry" })
            .pipe(Effect.flip);
          assert.include(registeredError.detail, "incomplete setup");
          yield* git(cwd, ["worktree", "prune", "--expire", "now"]);
          yield* restarted.createWorktree({
            cwd,
            path: checkout,
            refName: "feature/external-retry",
          });
          yield* restarted.assertWorktreeSetupComplete(checkout);
          assert.equal(
            yield* git(checkout, ["branch", "--show-current"]),
            "feature/external-retry",
          );
        }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("recovers from another checkout after the source checkout is removed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const root = yield* makeTmpDir();
        const source = `${root}/source`;
        yield* git(cwd, ["worktree", "add", "-b", "feature/source", source, initialBranch]);
        const checkout = yield* Effect.promise(() => canonicalizeWorktreePath(`${root}/pending`));
        const config = yield* ServerConfig;
        yield* beginWorktreeSetup(config.stateDir, checkout, yield* repositoryIdentity(source));
        yield* git(cwd, ["worktree", "remove", source]);
        const restarted = yield* makeGitVcsDriverCore();
        yield* restarted.createWorktree({
          cwd,
          path: checkout,
          refName: initialBranch,
          newRefName: "feature/source-retry",
        });
        yield* restarted.assertWorktreeSetupComplete(checkout);
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("does not reclaim an orphan journal against an unrelated repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const otherRepo = yield* makeTmpDir();
        yield* initRepoWithCommit(otherRepo);
        const root = yield* makeTmpDir();
        const checkout = yield* Effect.promise(() => canonicalizeWorktreePath(`${root}/bound`));
        const config = yield* ServerConfig;
        yield* beginWorktreeSetup(config.stateDir, checkout, yield* repositoryIdentity(cwd));
        const driver = yield* makeGitVcsDriverCore();
        const error = yield* driver
          .removeWorktree({ cwd: otherRepo, path: checkout, force: true })
          .pipe(Effect.flip);
        assert.include(error.detail, "repository binding");
        yield* driver.createWorktree({
          cwd,
          path: checkout,
          refName: initialBranch,
          newRefName: "feature/bound-retry",
        });
        yield* driver.assertWorktreeSetupComplete(checkout);
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("refuses unbound legacy and malformed journals without mutating them", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const root = yield* makeTmpDir();
        const config = yield* ServerConfig;
        const driver = yield* makeGitVcsDriverCore();
        for (const kind of ["legacy", "malformed"] as const) {
          const checkout = yield* Effect.promise(() => canonicalizeWorktreePath(`${root}/${kind}`));
          yield* beginWorktreeSetup(config.stateDir, checkout, yield* repositoryIdentity(cwd));
          const journal = nodePath.join(
            config.stateDir,
            "incomplete-worktree-setup",
            `${createHash("sha256").update(checkout).digest("hex")}.json`,
          );
          const contents =
            kind === "legacy"
              ? JSON.stringify({ version: 1, checkoutPath: checkout })
              : "invalid journal fixture";
          yield* Effect.promise(() => fsPromises.writeFile(journal, contents));
          const error = yield* driver
            .createWorktree({
              cwd,
              path: checkout,
              refName: initialBranch,
              newRefName: `feature/${kind}`,
            })
            .pipe(Effect.flip);
          assert.include(
            error.detail,
            kind === "legacy" ? "operator inspection" : "Cannot safely parse",
          );
          yield* driver.removeWorktree({ cwd, path: checkout, force: true }).pipe(Effect.flip);
          assert.equal(yield* Effect.promise(() => fsPromises.readFile(journal, "utf8")), contents);
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(checkout));
          assert.equal(yield* git(cwd, ["branch", "--list", `feature/${kind}`]), "");
        }
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect(
      "retains orphan journals when registration inspection is failed, empty or truncated",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const root = yield* makeTmpDir();
          const config = yield* ServerConfig;
          const base = yield* GitVcsDriver.GitVcsDriver;
          for (const kind of ["failed", "empty", "truncated"] as const) {
            const checkout = yield* Effect.promise(() =>
              canonicalizeWorktreePath(`${root}/${kind}`),
            );
            yield* beginWorktreeSetup(config.stateDir, checkout, yield* repositoryIdentity(cwd));
            const driver = yield* makeGitVcsDriverCore({
              executeOverride: (input) =>
                input.operation === "GitVcsDriver.worktreeSetup.registration"
                  ? Effect.succeed({
                      exitCode: (kind === "failed"
                        ? 1
                        : 0) as GitVcsDriver.ExecuteGitResult["exitCode"],
                      stdout: kind === "truncated" ? `worktree ${cwd}\0\0` : "",
                      stderr: kind === "failed" ? "inspection denied" : "",
                      stdoutTruncated: kind === "truncated",
                      stderrTruncated: false,
                    })
                  : base.execute(input),
            });
            yield* driver.removeWorktree({ cwd, path: checkout, force: true }).pipe(Effect.flip);
            const retained = yield* driver.assertWorktreeSetupComplete(checkout).pipe(Effect.flip);
            assert.include(retained.detail, "incomplete setup");
            const restarted = yield* makeGitVcsDriverCore();
            yield* restarted.createWorktree({
              cwd,
              path: checkout,
              refName: initialBranch,
              newRefName: `feature/proven-${kind}`,
            });
          }
        }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("queues symlink-parent removal before mkdir on the creation lock through setup", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitmodules", '[submodule "fixture"]\n');
        yield* git(cwd, ["add", ".gitmodules"]);
        yield* git(cwd, ["commit", "-m", "pre-mkdir alias fixture"]);
        const root = yield* makeTmpDir();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${root}/actual`);
        yield* Effect.promise(() => fsPromises.symlink(`${root}/actual`, `${root}/alias`, "dir"));
        const checkout = yield* Effect.promise(() =>
          canonicalizeWorktreePath(`${root}/actual/alias-race`),
        );
        const alias = `${root}/alias/alias-race`;
        const beforeAdd = yield* Deferred.make<void>();
        const releaseAdd = yield* Deferred.make<void>();
        const beforeSetup = yield* Deferred.make<void>();
        const releaseSetup = yield* Deferred.make<void>();
        const removalQueued = yield* Deferred.make<void>();
        const beforeRemoval = yield* Deferred.make<void>();
        const releaseRemoval = yield* Deferred.make<void>();
        const base = yield* GitVcsDriver.GitVcsDriver;
        const get = vi.mocked(RcMap.get);
        const original = get.getMockImplementation()! as typeof RcMap.get;
        const keys: string[] = [];
        const locks: unknown[] = [];
        const observeGet = <K, A, E>(
          map: RcMap.RcMap<K, A, E>,
          key: K,
        ): Effect.Effect<A, E, Scope.Scope> =>
          original(map, key).pipe(
            Effect.tap((lock) => {
              if (typeof key !== "string" || !key.endsWith("alias-race")) return Effect.void;
              keys.push(key);
              locks.push(lock);
              return keys.length === 2
                ? Deferred.succeed(removalQueued, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
          );
        get.mockImplementation(observeGet);
        try {
          const order: string[] = [];
          let failSetup = true;
          const driver = yield* makeGitVcsDriverCore({
            executeOverride: (input) =>
              Effect.gen(function* () {
                if (input.operation === "GitVcsDriver.createWorktree") {
                  yield* Deferred.succeed(beforeAdd, undefined);
                  yield* Deferred.await(releaseAdd);
                  order.push("add");
                } else if (
                  input.operation === "GitVcsDriver.createWorktree.initializeSubmodules" &&
                  failSetup
                ) {
                  yield* Deferred.succeed(beforeSetup, undefined);
                  yield* Deferred.await(releaseSetup);
                  order.push("setup");
                  failSetup = false;
                  return {
                    exitCode: 1 as GitVcsDriver.ExecuteGitResult["exitCode"],
                    stdout: "",
                    stderr: "fixture setup failure",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  };
                } else if (input.operation === "GitVcsDriver.removeWorktree") {
                  yield* Deferred.succeed(beforeRemoval, undefined);
                  yield* Deferred.await(releaseRemoval);
                  order.push("remove");
                }
                return yield* base.execute(input);
              }),
          });
          const creation = yield* driver
            .createWorktree({
              cwd,
              path: checkout,
              refName: initialBranch,
              newRefName: "feature/alias-lock",
            })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(beforeAdd);
          assert.isFalse(yield* fs.exists(checkout));
          const removal = yield* driver
            .removeWorktree({ cwd, path: alias, force: true })
            .pipe(Effect.forkChild);
          yield* Deferred.await(removalQueued);
          assert.deepStrictEqual(keys, [checkout, checkout]);
          assert.strictEqual(locks[0], locks[1]);
          assert.deepStrictEqual(order, []);
          const reserved = yield* driver.assertWorktreeSetupComplete(alias).pipe(Effect.flip);
          assert.include(reserved.detail, "incomplete setup");
          yield* Deferred.succeed(releaseAdd, undefined);
          yield* Deferred.await(beforeSetup);
          assert.deepStrictEqual(order, ["add"]);
          const pending = yield* driver.assertWorktreeSetupComplete(alias).pipe(Effect.flip);
          assert.include(pending.detail, "incomplete setup");
          yield* Deferred.succeed(releaseSetup, undefined);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(creation)));
          yield* Deferred.await(beforeRemoval);
          assert.deepStrictEqual(order, ["add", "setup"]);
          assert.isTrue(yield* fs.exists(checkout));
          const retained = yield* driver.assertWorktreeSetupComplete(alias).pipe(Effect.flip);
          assert.include(retained.detail, "incomplete setup");
          yield* Deferred.succeed(releaseRemoval, undefined);
          yield* Fiber.join(removal);
          assert.deepStrictEqual(order, ["add", "setup", "remove"]);
          assert.isFalse(yield* fs.exists(checkout));
          yield* driver.assertWorktreeSetupComplete(alias);
          yield* driver.createWorktree({ cwd, path: alias, refName: "feature/alias-lock" });
          yield* driver.assertWorktreeSetupComplete(alias);
        } finally {
          get.mockImplementation(original);
        }
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("serializes worktree removal with setup completion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitmodules", '[submodule "fixture"]\n');
        yield* git(cwd, ["add", ".gitmodules"]);
        yield* git(cwd, ["commit", "-m", "serialized setup fixture"]);
        const checkout = `${yield* makeTmpDir()}/checkout`;
        const baseDriver = yield* GitVcsDriver.GitVcsDriver;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const order: string[] = [];
        const driver = yield* makeGitVcsDriverCore({
          executeOverride: (input) =>
            (input.operation === "GitVcsDriver.createWorktree.initializeSubmodules"
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      order.push("setup");
                    }),
                  ),
                )
              : input.operation === "GitVcsDriver.removeWorktree"
                ? Effect.sync(() => {
                    order.push("remove");
                  })
                : Effect.void
            ).pipe(Effect.andThen(baseDriver.execute(input))),
        });
        const creation = yield* driver
          .createWorktree({
            cwd,
            path: checkout,
            refName: initialBranch,
            newRefName: "feature/serialized",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const removal = yield* driver
          .removeWorktree({ cwd, path: checkout, force: true })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
        assert.deepStrictEqual(order, []);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(creation);
        yield* Fiber.join(removal);
        assert.deepStrictEqual(order, ["setup", "remove"]);
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(checkout));
        yield* driver.createWorktree({ cwd, path: checkout, refName: "feature/serialized" });
        yield* driver.assertWorktreeSetupComplete(checkout);
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect("releases setup reservations when Git fails before registering a checkout", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const checkout = `${yield* makeTmpDir()}/retry`;
        const driver = yield* makeGitVcsDriverCore();
        const error = yield* driver
          .createWorktree({
            cwd,
            path: checkout,
            refName: "missing-reference",
            newRefName: "feature/retry",
          })
          .pipe(Effect.flip);
        assert.include(error.detail, "missing-reference");
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(checkout));
        const completed = yield* driver.createWorktree({
          cwd,
          path: checkout,
          refName: initialBranch,
          newRefName: "feature/retry",
        });
        assert.equal(completed.worktree.refName, "feature/retry");
        yield* driver.assertWorktreeSetupComplete(checkout);
      }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect(
      "accepts ordinary registered checkouts without hydrating or reading their branch configuration",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          yield* writeTextFile(cwd, "ryco.json", "invalid adopted configuration");
          yield* writeTextFile(cwd, ".gitmodules", '[submodule "adopted"]\n');
          yield* git(cwd, ["add", "ryco.json", ".gitmodules"]);
          yield* git(cwd, ["commit", "-m", "ordinary imported checkout fixture"]);
          const checkout = `${yield* makeTmpDir()}/adopted`;
          yield* git(cwd, ["worktree", "add", "-b", "feature/adopted", checkout, initialBranch]);
          const driver = yield* makeGitVcsDriverCore();
          yield* driver.assertWorktreeSetupComplete(checkout);
          const error = yield* driver
            .createWorktree({ cwd, path: checkout, refName: "feature/adopted" })
            .pipe(Effect.flip);
          assert.include(error.detail, "destination already exists");
          assert.notInclude(error.detail, "incomplete setup");
          const fs = yield* FileSystem.FileSystem;
          assert.equal(
            yield* fs.readFileString(`${checkout}/ryco.json`),
            "invalid adopted configuration",
          );
          yield* driver.assertWorktreeSetupComplete(checkout);
        }).pipe(Effect.provide(OverrideTestLayer)),
    );

    it.effect(
      "cancels a real submodule Git process and its synthetic SSH child, retaining incomplete setup",
      () =>
        Effect.gen(function* () {
          const leaf = yield* makeTmpDir();
          yield* initRepoWithCommit(leaf);
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          yield* git(cwd, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            leaf,
            "modules/wait",
          ]);
          yield* git(cwd, [
            "config",
            "-f",
            ".gitmodules",
            "submodule.modules/wait.url",
            "ssh://fixture.invalid/repo",
          ]);
          yield* git(cwd, ["config", "submodule.modules/wait.url", "ssh://fixture.invalid/repo"]);
          yield* git(cwd, ["add", ".gitmodules"]);
          yield* git(cwd, ["commit", "-m", "blocking synthetic SSH fixture"]);
          const fixture = yield* makeTmpDir();
          const script = `${fixture}/ssh.cjs`;
          const pidFile = `${fixture}/child.pid`;
          const stoppedFile = `${fixture}/child.stopped`;
          yield* writeTextFile(
            fixture,
            "ssh.cjs",
            `const fs = require("node:fs");
process.on("SIGTERM", () => { fs.writeFileSync(process.argv[3], "terminated"); process.exit(0); });
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`,
          );
          const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
          const baseDriver = yield* GitVcsDriver.GitVcsDriver;
          const driver = yield* makeGitVcsDriverCore({
            executeOverride: (input) =>
              baseDriver.execute({
                ...input,
                env: {
                  ...input.env,
                  GIT_ALLOW_PROTOCOL: "ssh",
                  GIT_SSH_VARIANT: "ssh",
                  GIT_SSH_COMMAND: [process.execPath, script, pidFile, stoppedFile]
                    .map(quote)
                    .join(" "),
                },
              }),
          });
          const checkout = `${fixture}/checkout`;
          const fs = yield* FileSystem.FileSystem;
          const waitForFile = (file: string) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 300; attempt++) {
                if (yield* fs.exists(file)) return;
                yield* Effect.promise(
                  () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
                );
              }
              throw new Error(`Timed out waiting for synthetic process file ${file}`);
            });
          const fiber = yield* driver
            .createWorktree({
              cwd,
              path: checkout,
              refName: initialBranch,
              newRefName: "feature/real-cancel",
            })
            .pipe(Effect.forkChild);
          yield* waitForFile(pidFile);
          yield* Fiber.interrupt(fiber);
          assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
          if (process.platform !== "win32") {
            yield* waitForFile(stoppedFile);
            assert.equal(yield* fs.readFileString(stoppedFile), "terminated");
          } else {
            const pid = Number(yield* fs.readFileString(pidFile));
            const running = () => {
              try {
                process.kill(pid, 0);
                return true;
              } catch {
                return false;
              }
            };
            for (let attempt = 0; attempt < 300 && running(); attempt++)
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
            assert.isFalse(running());
          }
          assert.isTrue(yield* fs.exists(checkout));
          assert.include(yield* driver.listWorktreePaths(cwd), yield* fs.realPath(checkout));
          const restarted = yield* makeGitVcsDriverCore();
          const error = yield* restarted.assertWorktreeSetupComplete(checkout).pipe(Effect.flip);
          assert.include(error.detail, "incomplete setup");
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
