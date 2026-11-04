import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectImportId } from "@ryco/contracts/project-copy";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";

import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import {
  commitFiles,
  git,
  gitStatus,
  initRepository,
  isProcessAlive,
  tempRoots,
  waitFor,
  withProcessEnv,
  writeChangesPatch,
  writeFakeSsh,
} from "../projectCopyGit.fixtures.ts";
import type { ProjectCopyChildProcess } from "../Services/ProjectCopyProcess.ts";
import { ProjectImportGit, type ProjectImportCloneProgress } from "../Services/ProjectImportGit.ts";
import { GitNetworkLive } from "./GitNetworkLive.ts";
import {
  COMMITS_PREREQUISITES_MESSAGE,
  excludePatternFor,
  importHeadRef,
  parseCloneProgress,
  ProjectImportGitLive,
} from "./ProjectImportGitLive.ts";

const roots = tempRoots();
afterEach(() => roots.cleanup());

const TestLayer = ProjectImportGitLive.pipe(
  Layer.provideMerge(
    GitNetworkLive.pipe(
      Layer.provide(
        Layer.mock(SourceControlProviderRegistry)({ detectProviderFromRemoteUrl: () => null }),
      ),
    ),
  ),
  Layer.provide(WorkspacePathsLive),
  Layer.provideMerge(NodeServices.layer),
);

const lfsInstalled = gitStatus(tmpdir(), "lfs", "version") === 0;
const importId = "6f1c2a4e-8b3d-4c5a-9e7f-0a1b2c3d4e5f" as ProjectImportId;
const ORIGIN_URL = "git@fakehost:o/r.git";

interface Origin {
  readonly root: string;
  /** A working clone that pushes to the origin. */
  readonly work: string;
  readonly bare: string;
  readonly fakeSsh: string;
}

/** A bare origin served over the fake ssh at `git@fakehost:o/r.git`, seeded with `files`. */
function makeOrigin(files: Readonly<Record<string, string | Uint8Array>>): Origin {
  const root = roots.make("ryco-import-git-");
  const work = initRepository(path.join(root, "work"));
  commitFiles(work, files, "first");
  const bare = path.join(root, "o", "r.git");
  git(root, "clone", "--quiet", "--bare", "--", work, bare);
  git(work, "remote", "add", "origin", bare);
  git(work, "fetch", "--quiet", "origin");
  git(work, "branch", "--quiet", "--set-upstream-to=origin/main", "main");
  return { root, work, bare, fakeSsh: writeFakeSsh(root).path };
}

/** A clone of the origin the way a user's checkout on the source node looks. */
function sourceCheckout(origin: Origin, name = "source"): string {
  const source = path.join(origin.root, name);
  git(origin.root, "clone", "--quiet", "--", origin.bare, source);
  initRepository(source);
  return source;
}

/** The job's empty staging directory, as the import job creates it. */
function stagingDirectory(origin: Origin, name = "dest"): string {
  const parent = path.join(origin.root, `${name}-parent`);
  const staging = path.join(parent, `.${name}.ryco-import-${importId}`);
  mkdirSync(staging, { recursive: true });
  return staging;
}

/** `git bundle create <file> HEAD --not <every oid the origin advertises>` (the export's commits bundle). */
function commitsBundle(source: string, origin: Origin, file: string): void {
  const oids = git(source, "ls-remote", "--heads", "--tags", "--", `file://${origin.bare}`)
    .split("\n")
    .map((line) => line.split("\t")[0] ?? "")
    .filter((oid) => oid.length > 0);
  git(source, "bundle", "create", "--quiet", file, "HEAD", "--not", ...oids);
}

const servedBy = (origin: Origin, extra?: Record<string, string>) =>
  withProcessEnv({
    GIT_SSH_COMMAND: origin.fakeSsh,
    FAKE_SSH_ROOT: origin.root,
    FAKE_SSH_MODE: undefined,
    ...extra,
  });

const read = (file: string) => readFileSync(file);

describe("parseCloneProgress", () => {
  it("weights receiving objects and resolving deltas into one percentage", () => {
    assert.deepStrictEqual(parseCloneProgress("Receiving objects:  50% (5/10), 1.00 KiB"), {
      percent: 40,
      detail: "Receiving objects:  50% (5/10), 1.00 KiB",
    });
    assert.strictEqual(parseCloneProgress("Resolving deltas: 100% (3/3), done.")?.percent, 100);
    assert.isNull(parseCloneProgress("remote: Counting objects: 100% (3/3), done."));
  });

  it("writes exclude lines that match exactly one path", () => {
    assert.strictEqual(excludePatternFor(".env"), "/.env");
    assert.strictEqual(excludePatternFor("config/[x]*.local"), "/config/\\[x\\]\\*.local");
    assert.strictEqual(excludePatternFor("#notes "), "/\\#notes\\ ");
  });
});

describe("ProjectImportGitLive", () => {
  it.live(
    "clones without checkout, brings a bundle-only branch and applies the changes byte for byte",
    () =>
      Effect.gen(function* () {
        const importGit = yield* ProjectImportGit;
        const origin = makeOrigin({ "README.md": "hello\n", ".gitignore": "node_modules/\n" });
        const source = sourceCheckout(origin);
        git(source, "checkout", "--quiet", "-b", "feature");
        commitFiles(source, { "feature.txt": "local only\n" }, "local one");
        const sourceHead = commitFiles(
          source,
          { "binary.bin": new Uint8Array([0, 1, 2, 255, 0, 10]) },
          "local two",
        );
        // Uncommitted work: unstaged, staged, untracked, Latin-1, binary, and an ignored .env
        // the destination does not ignore (it is excluded only on the source).
        writeFileSync(path.join(source, "README.md"), "hello, edited\n");
        writeFileSync(path.join(source, "staged.txt"), "staged\n");
        git(source, "add", "staged.txt");
        mkdirSync(path.join(source, "notes"));
        writeFileSync(path.join(source, "notes", "untracked.txt"), "untracked\n");
        writeFileSync(path.join(source, "latin1.txt"), new Uint8Array([0xe9, 0x74, 0xe9, 0x0a]));
        writeFileSync(path.join(source, "binary.bin"), new Uint8Array([0, 255, 254, 0, 7]));
        writeFileSync(path.join(source, ".git", "info", "exclude"), ".env\n");
        writeFileSync(path.join(source, ".env"), "SECRET=1\n");
        const bundle = path.join(origin.root, "commits.bundle");
        const patch = path.join(origin.root, "changes.patch");
        commitsBundle(source, origin, bundle);
        writeChangesPatch(source, patch, [".env"]);

        const staging = stagingDirectory(origin);
        const progress: Array<ProjectImportCloneProgress> = [];
        const children: Array<ProjectCopyChildProcess | null> = [];
        const output: Array<string> = [];
        yield* importGit
          .cloneNoCheckout({
            repositoryRoot: staging,
            remoteUrl: ORIGIN_URL,
            remoteName: "origin",
            onProgress: (update) => Effect.sync(() => progress.push(update)),
            observer: {
              onChild: (child) => Effect.sync(() => children.push(child)),
              onOutput: (chunk) => Effect.sync(() => output.push(chunk)),
            },
          })
          .pipe(servedBy(origin));
        assert.strictEqual(git(staging, "remote", "get-url", "origin"), ORIGIN_URL);
        // No checkout yet: the working tree is still empty.
        assert.isFalse(existsSync(path.join(staging, "README.md")));
        assert.isAbove(progress.length, 0);
        assert.isTrue(progress.every((update) => update.percent >= 0 && update.percent <= 100));
        assert.isNumber(children[0]?.pid);
        assert.isNull(children.at(-1));
        assert.include(output.join(""), "Receiving objects");

        const fetched = yield* importGit.fetchCommitsBundle({
          repositoryRoot: staging,
          importId,
          bundlePath: bundle,
        });
        assert.strictEqual(fetched.headOid, sourceHead);

        const checkedOut = yield* importGit.checkout({
          repositoryRoot: staging,
          importId,
          remoteName: "origin",
          checkout: { branch: "feature", headOid: sourceHead },
          relativeRootInRepository: "",
        });
        assert.deepStrictEqual(checkedOut, {
          branch: "feature",
          headOid: sourceHead,
          upstream: null,
        });
        assert.strictEqual(git(staging, "symbolic-ref", "--short", "HEAD"), "feature");
        assert.notStrictEqual(
          gitStatus(staging, "rev-parse", "--verify", "--quiet", importHeadRef(importId)),
          0,
        );

        const applied = yield* importGit.applyChanges({
          repositoryRoot: staging,
          importId,
          patchPath: patch,
          baseOid: sourceHead,
          ignoredPaths: [".env"],
        });
        assert.deepStrictEqual(applied, { status: "applied" });
        for (const file of [
          "README.md",
          "staged.txt",
          "notes/untracked.txt",
          "latin1.txt",
          "binary.bin",
          ".env",
          "feature.txt",
        ]) {
          assert.deepStrictEqual(
            read(path.join(staging, file)),
            read(path.join(source, file)),
            file,
          );
        }
        // The index is untouched, and the copied .env can never be committed here.
        assert.strictEqual(gitStatus(staging, "diff", "--cached", "--quiet"), 0);
        assert.strictEqual(gitStatus(staging, "check-ignore", "-q", "--", ".env"), 0);
        assert.include(
          readFileSync(path.join(staging, ".git", "info", "exclude"), "utf8"),
          "/.env",
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.live("ends on the source's exact commit when the source is behind its remote", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({ "README.md": "one\n" });
      const source = sourceCheckout(origin);
      const sourceHead = git(source, "rev-parse", "HEAD");
      commitFiles(origin.work, { "README.md": "two\n" }, "newer on the remote");
      git(origin.work, "push", "--quiet", "origin", "main");

      const staging = stagingDirectory(origin);
      yield* importGit
        .cloneNoCheckout({ repositoryRoot: staging, remoteUrl: ORIGIN_URL, remoteName: "origin" })
        .pipe(servedBy(origin));
      const checkedOut = yield* importGit.checkout({
        repositoryRoot: staging,
        importId,
        remoteName: "origin",
        checkout: { branch: "main", headOid: sourceHead },
        relativeRootInRepository: "",
      });
      assert.deepStrictEqual(checkedOut, {
        branch: "main",
        headOid: sourceHead,
        upstream: "origin/main",
      });
      assert.strictEqual(readFileSync(path.join(staging, "README.md"), "utf8"), "one\n");
      assert.strictEqual(git(staging, "rev-list", "--count", "HEAD..origin/main"), "1");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live(
    "takes the remote's default branch without a checkout and detaches without a branch",
    () =>
      Effect.gen(function* () {
        const importGit = yield* ProjectImportGit;
        const origin = makeOrigin({ "README.md": "one\n" });
        const head = git(origin.work, "rev-parse", "HEAD");
        const staging = stagingDirectory(origin);
        yield* importGit
          .cloneNoCheckout({ repositoryRoot: staging, remoteUrl: ORIGIN_URL, remoteName: "origin" })
          .pipe(servedBy(origin));
        const defaultBranch = yield* importGit.checkout({
          repositoryRoot: staging,
          importId,
          remoteName: "origin",
          checkout: null,
          relativeRootInRepository: "",
        });
        assert.deepStrictEqual(defaultBranch, {
          branch: "main",
          headOid: head,
          upstream: "origin/main",
        });

        const detached = yield* importGit.checkout({
          repositoryRoot: staging,
          importId,
          remoteName: "origin",
          checkout: { branch: null, headOid: head },
          relativeRootInRepository: "",
        });
        assert.deepStrictEqual(detached, { branch: null, headOid: head, upstream: null });
        assert.notStrictEqual(gitStatus(staging, "symbolic-ref", "--quiet", "HEAD"), 0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.live("fails checkout-failed for a commit the repository does not have", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({ "README.md": "one\n" });
      const staging = stagingDirectory(origin);
      yield* importGit
        .cloneNoCheckout({ repositoryRoot: staging, remoteUrl: ORIGIN_URL, remoteName: "origin" })
        .pipe(servedBy(origin));
      const error = yield* importGit
        .checkout({
          repositoryRoot: staging,
          importId,
          remoteName: "origin",
          checkout: { branch: "main", headOid: "1".repeat(40) },
          relativeRootInRepository: "",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "checkout-failed");
      assert.include(error.message, "111111111111");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("fails commits-failed when the bundle builds on commits the remote lacks", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({ "README.md": "one\n" });
      const source = sourceCheckout(origin);
      const unpushed = commitFiles(source, { "a.txt": "a\n" }, "never pushed");
      commitFiles(source, { "b.txt": "b\n" }, "on top");
      const bundle = path.join(origin.root, "commits.bundle");
      // A bundle that assumes the destination has `unpushed` (a stale or fork-only remote ref).
      git(source, "bundle", "create", "--quiet", bundle, "HEAD", "--not", unpushed);

      const staging = stagingDirectory(origin);
      yield* importGit
        .cloneNoCheckout({ repositoryRoot: staging, remoteUrl: ORIGIN_URL, remoteName: "origin" })
        .pipe(servedBy(origin));
      const error = yield* importGit
        .fetchCommitsBundle({ repositoryRoot: staging, importId, bundlePath: bundle })
        .pipe(Effect.flip);
      assert.strictEqual(error.code, "commits-failed");
      assert.strictEqual(error.message, COMMITS_PREREQUISITES_MESSAGE);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("imports a repository bundle with its branches, tags, remotes and upstream", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const root = roots.make("ryco-import-bundle-");
      const source = initRepository(path.join(root, "source"));
      const first = commitFiles(source, { "README.md": "one\n" }, "first");
      git(source, "tag", "v1");
      git(source, "remote", "add", "origin", "https://github.com/octocat/ryco.git");
      git(source, "update-ref", "refs/remotes/origin/main", first);
      git(source, "checkout", "--quiet", "-b", "topic");
      const topic = commitFiles(source, { "topic.txt": "topic\n" }, "topic");
      git(source, "checkout", "--quiet", "main");
      const head = commitFiles(source, { "README.md": "two\n" }, "second");
      // A checkpoint ref the export leaves out.
      git(source, "update-ref", "refs/ryco/checkpoints/turn-1", topic);
      const bundle = path.join(root, "repository.bundle");
      git(
        source,
        "bundle",
        "create",
        "--quiet",
        bundle,
        "--branches",
        "--tags",
        "--remotes",
        "HEAD",
      );

      const staging = path.join(root, "dest", `.dest.ryco-import-${importId}`);
      mkdirSync(staging, { recursive: true });
      yield* importGit.initFromBundle({ repositoryRoot: staging, bundlePath: bundle });
      const { warnings } = yield* importGit.setRemotes({
        repositoryRoot: staging,
        remotes: [
          { name: "origin", url: "https://x-token@github.com/octocat/ryco.git" },
          { name: "fork", url: "git@github.com:me/ryco.git" },
          { name: "mirror", url: "/srv/git/ryco.git" },
          // curl would skip the third slash and send the token.
          { name: "deploy", url: "https:///ghp_token@github.com/octocat/ryco.git" },
        ],
        keepRemoteName: null,
      });
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0] ?? "", "mirror");
      assert.strictEqual(
        git(staging, "remote", "get-url", "origin"),
        "https://github.com/octocat/ryco.git",
      );
      assert.strictEqual(git(staging, "remote", "get-url", "fork"), "git@github.com:me/ryco.git");
      assert.strictEqual(
        git(staging, "remote", "get-url", "deploy"),
        "https:///github.com/octocat/ryco.git",
      );

      const checkedOut = yield* importGit.checkout({
        repositoryRoot: staging,
        importId,
        remoteName: null,
        checkout: { branch: "main", headOid: head },
        relativeRootInRepository: "",
      });
      assert.deepStrictEqual(checkedOut, {
        branch: "main",
        headOid: head,
        upstream: "origin/main",
      });
      assert.strictEqual(git(staging, "rev-parse", "refs/heads/topic"), topic);
      assert.strictEqual(git(staging, "rev-parse", "refs/tags/v1"), first);
      assert.strictEqual(git(staging, "rev-parse", "refs/remotes/origin/main"), first);
      assert.strictEqual(git(staging, "for-each-ref", "refs/ryco/"), "");
      assert.strictEqual(readFileSync(path.join(staging, "README.md"), "utf8"), "two\n");

      // Without a checkout, the import ends where the bundle's HEAD was.
      const second = path.join(root, "dest", `.second.ryco-import-${importId}`);
      mkdirSync(second, { recursive: true });
      yield* importGit.initFromBundle({ repositoryRoot: second, bundlePath: bundle });
      const fromHead = yield* importGit.checkout({
        repositoryRoot: second,
        importId,
        remoteName: null,
        checkout: null,
        relativeRootInRepository: "",
      });
      assert.deepStrictEqual(fromHead, { branch: "main", headOid: head, upstream: null });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("never replaces the clone remote", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({ "README.md": "one\n" });
      const staging = stagingDirectory(origin);
      yield* importGit
        .cloneNoCheckout({ repositoryRoot: staging, remoteUrl: ORIGIN_URL, remoteName: "origin" })
        .pipe(servedBy(origin));
      const { warnings } = yield* importGit.setRemotes({
        repositoryRoot: staging,
        remotes: [
          { name: "origin", url: "https://github.com/octocat/ryco.git" },
          { name: "upstream", url: "https://github.com/upstream/ryco.git" },
        ],
        keepRemoteName: "origin",
      });
      assert.deepStrictEqual(warnings, []);
      assert.strictEqual(git(staging, "remote", "get-url", "origin"), ORIGIN_URL);
      assert.strictEqual(
        git(staging, "remote", "get-url", "upstream"),
        "https://github.com/upstream/ryco.git",
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("keeps a patch that does not apply, and one made on another commit", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({ "a.txt": "one\n" });
      const source = sourceCheckout(origin);
      const base = git(source, "rev-parse", "HEAD");
      writeFileSync(path.join(source, "a.txt"), "one, edited on the source\n");
      const patch = path.join(origin.root, "changes.patch");
      writeChangesPatch(source, patch);

      const staging = stagingDirectory(origin);
      yield* importGit
        .cloneNoCheckout({ repositoryRoot: staging, remoteUrl: ORIGIN_URL, remoteName: "origin" })
        .pipe(servedBy(origin));
      yield* importGit.checkout({
        repositoryRoot: staging,
        importId,
        remoteName: "origin",
        checkout: { branch: "main", headOid: base },
        relativeRootInRepository: "",
      });
      writeFileSync(path.join(staging, "a.txt"), "different here\n");

      const conflict = yield* importGit.applyChanges({
        repositoryRoot: staging,
        importId,
        patchPath: patch,
        baseOid: base,
        ignoredPaths: [],
      });
      assert.strictEqual(conflict.status, "kept");
      if (conflict.status !== "kept") return;
      assert.strictEqual(conflict.reason, "apply-failed");
      assert.strictEqual(conflict.keptPatchPath, `.git/ryco-imports/${importId}.patch`);
      assert.deepStrictEqual(read(path.join(staging, conflict.keptPatchPath)), read(patch));
      assert.strictEqual(readFileSync(path.join(staging, "a.txt"), "utf8"), "different here\n");
      assert.strictEqual(gitStatus(staging, "diff", "--cached", "--quiet"), 0);

      const elsewhere = yield* importGit.applyChanges({
        repositoryRoot: staging,
        importId,
        patchPath: patch,
        baseOid: "2".repeat(40),
        ignoredPaths: [],
      });
      assert.strictEqual(elsewhere.status, "kept");
      if (elsewhere.status === "kept") assert.strictEqual(elsewhere.reason, "base-mismatch");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("applies from the repository root and checks a monorepo project folder", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({
        "README.md": "root\n",
        "packages/app/index.ts": "export {};\n",
      });
      symlinkSync("app", path.join(origin.work, "packages", "linked"));
      symlinkSync(tmpdir(), path.join(origin.work, "packages", "escape"));
      commitFiles(origin.work, {}, "symlinks");
      git(origin.work, "push", "--quiet", "origin", "main");
      const source = sourceCheckout(origin);
      const base = git(source, "rev-parse", "HEAD");
      writeFileSync(path.join(source, "README.md"), "root, edited\n");
      writeFileSync(path.join(source, "packages", "app", "index.ts"), "export const x = 1;\n");
      const patch = path.join(origin.root, "changes.patch");
      writeChangesPatch(source, patch);

      const staging = stagingDirectory(origin);
      yield* importGit
        .cloneNoCheckout({ repositoryRoot: staging, remoteUrl: ORIGIN_URL, remoteName: "origin" })
        .pipe(servedBy(origin));
      const checkoutAt = (relativeRootInRepository: string) =>
        importGit.checkout({
          repositoryRoot: staging,
          importId,
          remoteName: "origin",
          checkout: { branch: "main", headOid: base },
          relativeRootInRepository,
        });
      yield* checkoutAt("packages/app");
      for (const relative of [
        "packages/missing",
        "packages/linked",
        "packages/escape",
        "README.md",
      ]) {
        const error = yield* checkoutAt(relative).pipe(Effect.flip);
        assert.strictEqual(error.code, "checkout-failed", relative);
      }

      const applied = yield* importGit.applyChanges({
        repositoryRoot: staging,
        importId,
        patchPath: patch,
        baseOid: base,
        ignoredPaths: [],
      });
      assert.deepStrictEqual(applied, { status: "applied" });
      assert.strictEqual(readFileSync(path.join(staging, "README.md"), "utf8"), "root, edited\n");
      assert.strictEqual(
        readFileSync(path.join(staging, "packages", "app", "index.ts"), "utf8"),
        "export const x = 1;\n",
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("maps an unknown host key and refused credentials to remote-unreachable", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({ "README.md": "one\n" });
      const clone = (mode: string) =>
        importGit
          .cloneNoCheckout({
            repositoryRoot: stagingDirectory(origin, mode),
            remoteUrl: ORIGIN_URL,
            remoteName: "origin",
          })
          .pipe(Effect.flip, servedBy(origin, { FAKE_SSH_MODE: mode }));

      const hostKey = yield* clone("host-key");
      assert.strictEqual(hostKey.code, "remote-unreachable");
      assert.strictEqual(hostKey.message, "host-key-unknown fakehost");
      assert.include(hostKey.detail ?? "", "Host key verification failed");

      const denied = yield* clone("denied");
      assert.strictEqual(denied.code, "remote-unreachable");
      assert.include(denied.message, "Permission denied (publickey)");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("cancelling the clone kills git and ssh before it completes", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({ "README.md": "one\n" });
      const pidFile = path.join(origin.root, "ssh.pid");
      const children: Array<ProjectCopyChildProcess | null> = [];
      const fiber = yield* importGit
        .cloneNoCheckout({
          repositoryRoot: stagingDirectory(origin),
          remoteUrl: ORIGIN_URL,
          remoteName: "origin",
          observer: { onChild: (child) => Effect.sync(() => children.push(child)) },
        })
        .pipe(
          servedBy(origin, { FAKE_SSH_MODE: "hang", FAKE_SSH_PID_FILE: pidFile }),
          Effect.forkChild,
        );
      yield* waitFor(() => {
        try {
          return readFileSync(pidFile, "utf8").trim().length > 0;
        } catch {
          return false;
        }
      }, "the clone's ssh to start");
      yield* Fiber.interrupt(fiber);

      const gitChild = children[0];
      assert.isNotNull(gitChild ?? null);
      assert.isFalse(isProcessAlive(gitChild?.pid ?? -1));
      if (process.platform !== "win32") assert.strictEqual(gitChild?.pgid, gitChild?.pid);
      assert.isNull(children.at(-1));
      const sshPid = Number(readFileSync(pidFile, "utf8").trim());
      yield* waitFor(() => !isProcessAlive(sshPid), "the clone's ssh to exit");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("updates submodules over the user's ssh, with progress, without clone credentials", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const origin = makeOrigin({ "README.md": "one\n" });
      const library = initRepository(path.join(origin.root, "library"));
      const libraryHead = commitFiles(library, { "lib.txt": "library\n" }, "library");
      git(
        origin.root,
        "clone",
        "--quiet",
        "--bare",
        "--",
        library,
        path.join(origin.root, "o", "lib.git"),
      );
      writeFileSync(
        path.join(origin.work, ".gitmodules"),
        '[submodule "lib"]\n\tpath = lib\n\turl = git@fakehost:o/lib.git\n',
      );
      // A gitlink without a checked-out submodule (`git add -A` would drop it again).
      git(origin.work, "update-index", "--add", "--cacheinfo", `160000,${libraryHead},lib`);
      git(origin.work, "add", ".gitmodules");
      git(origin.work, "commit", "--quiet", "-m", "add the submodule");
      const head = git(origin.work, "rev-parse", "HEAD");
      git(origin.work, "push", "--quiet", "origin", "main");

      const staging = stagingDirectory(origin);
      const output: Array<string> = [];
      yield* Effect.gen(function* () {
        yield* importGit.cloneNoCheckout({
          repositoryRoot: staging,
          remoteUrl: ORIGIN_URL,
          remoteName: "origin",
        });
        yield* importGit.checkout({
          repositoryRoot: staging,
          importId,
          remoteName: "origin",
          checkout: { branch: "main", headOid: head },
          relativeRootInRepository: "",
        });
        yield* importGit.updateSubmodules({
          repositoryRoot: staging,
          observer: { onOutput: (chunk) => Effect.sync(() => output.push(chunk)) },
        });
      }).pipe(servedBy(origin));
      assert.strictEqual(readFileSync(path.join(staging, "lib", "lib.txt"), "utf8"), "library\n");
      // A long submodule clone keeps printing, so the no-output stall limit never ends it early.
      assert.include(output.join(""), "Receiving objects");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("checks out and patches LFS pointers when a required git-lfs filter cannot run", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const pointer = (oid: string) =>
        `version https://git-lfs.github.com/spec/v1\noid sha256:${oid.repeat(64)}\nsize 1\n`;
      // The fixture's own git never runs an LFS filter (the machine may configure a missing one).
      const noLfs = [
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.clean=",
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.required=false",
      ];
      const origin = makeOrigin({ "README.md": "one\n" });
      writeFileSync(
        path.join(origin.work, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      writeFileSync(path.join(origin.work, "large.bin"), pointer("a"));
      git(origin.work, ...noLfs, "add", "-A");
      git(origin.work, ...noLfs, "commit", "--quiet", "-m", "lfs");
      const head = git(origin.work, "rev-parse", "HEAD");
      git(origin.work, "push", "--quiet", "origin", "main");
      // Uncommitted changes to a plain file and to the pointer itself.
      writeFileSync(path.join(origin.work, "README.md"), "one, edited\n");
      writeFileSync(path.join(origin.work, "large.bin"), pointer("b"));
      const patch = path.join(origin.root, "changes.patch");
      git(origin.work, ...noLfs, "diff", "--binary", "--no-color", `--output=${patch}`, "HEAD");

      const staging = stagingDirectory(origin);
      yield* importGit
        .cloneNoCheckout({ repositoryRoot: staging, remoteUrl: ORIGIN_URL, remoteName: "origin" })
        .pipe(servedBy(origin));
      // What `git lfs install` writes, naming a git-lfs this node does not have.
      git(staging, "config", "filter.lfs.process", "ryco-missing-git-lfs filter-process");
      git(staging, "config", "filter.lfs.smudge", "ryco-missing-git-lfs smudge -- %f");
      git(staging, "config", "filter.lfs.clean", "ryco-missing-git-lfs clean -- %f");
      git(staging, "config", "filter.lfs.required", "true");
      assert.notStrictEqual(
        gitStatus(staging, "checkout", "--quiet", "-f", "--detach", head, "--"),
        0,
        "a plain checkout fails on the missing filter",
      );

      const checkedOut = yield* importGit.checkout({
        repositoryRoot: staging,
        importId,
        remoteName: "origin",
        checkout: { branch: "main", headOid: head },
        relativeRootInRepository: "",
      });
      assert.deepStrictEqual(checkedOut, {
        branch: "main",
        headOid: head,
        upstream: "origin/main",
      });
      assert.strictEqual(readFileSync(path.join(staging, "large.bin"), "utf8"), pointer("a"));

      const applied = yield* importGit.applyChanges({
        repositoryRoot: staging,
        importId,
        patchPath: patch,
        baseOid: head,
        ignoredPaths: [],
      });
      assert.deepStrictEqual(applied, { status: "applied" });
      assert.strictEqual(readFileSync(path.join(staging, "README.md"), "utf8"), "one, edited\n");
      assert.strictEqual(readFileSync(path.join(staging, "large.bin"), "utf8"), pointer("b"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("pulls LFS files with progress forced on, so a long download is never a stall", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const root = roots.make("ryco-import-lfs-progress-");
      const repository = initRepository(path.join(root, "repo"));
      writeFileSync(path.join(repository, ".gitattributes"), "*.bin filter=lfs -text\n");
      writeFileSync(path.join(repository, "large.bin"), "pointer\n");
      const noLfs = ["-c", "filter.lfs.process=", "-c", "filter.lfs.clean="];
      git(repository, ...noLfs, "-c", "filter.lfs.required=false", "add", "-A");
      git(
        repository,
        ...noLfs,
        "-c",
        "filter.lfs.required=false",
        "commit",
        "--quiet",
        "-m",
        "lfs",
      );
      // A stand-in git-lfs that records what `git lfs pull` was run with.
      const binDir = path.join(root, "bin");
      mkdirSync(binDir);
      const record = path.join(root, "lfs-pull.env");
      writeFileSync(
        path.join(binDir, "git-lfs"),
        `#!/bin/sh\ncase "$1" in\n  version) echo "git-lfs/3.6.0" ;;\n  pull) printf '%s %s' "$GIT_LFS_FORCE_PROGRESS" "$*" > "${record}" ;;\nesac\n`,
        { mode: 0o755 },
      );
      const result = yield* importGit
        .lfsPull({ repositoryRoot: repository, remoteName: "origin" })
        .pipe(withProcessEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }));
      assert.deepStrictEqual(result, { status: "pulled" });
      assert.strictEqual(readFileSync(record, "utf8"), "1 pull -- origin");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("runs nothing for a checkout without LFS files", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const repository = initRepository(path.join(roots.make("ryco-import-no-lfs-"), "repo"));
      commitFiles(repository, { "README.md": "plain\n" }, "plain");
      const result = yield* importGit.lfsPull({ repositoryRoot: repository, remoteName: "origin" });
      assert.deepStrictEqual(result, { status: "not-used" });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live.skipIf(lfsInstalled)("reports a missing git-lfs instead of failing", () =>
    Effect.gen(function* () {
      const importGit = yield* ProjectImportGit;
      const repository = initRepository(path.join(roots.make("ryco-import-lfs-"), "repo"));
      writeFileSync(
        path.join(repository, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      writeFileSync(path.join(repository, "large.bin"), "pointer\n");
      // Without git-lfs, an identity clean filter stands in for it.
      const noLfs = [
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.clean=cat",
        "-c",
        "filter.lfs.required=false",
      ];
      git(repository, ...noLfs, "add", "-A");
      git(repository, ...noLfs, "commit", "--quiet", "-m", "lfs");
      const result = yield* importGit.lfsPull({ repositoryRoot: repository, remoteName: "origin" });
      assert.deepStrictEqual(result, { status: "lfs-missing" });
    }).pipe(Effect.provide(TestLayer)),
  );
});
