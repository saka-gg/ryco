import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { GitCommandError, SourceControlRepositoryError } from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  CLONE_ENV,
  CLONE_KEPT_OUTPUT_BYTES,
  CLONE_ORPHAN_GRACE_MS,
  CLONE_OUTCOME_RETENTION_MS,
  CLONE_STAGING_HOST,
  CLONE_STALL_TIMEOUT_MS,
  cloneFailureDetail,
  cloneIntoDestination,
  cloneStagingDirectoryName,
  cloneStagingOwner,
  cloneStagingToken,
  isGitCloneProgressLine,
  makeCloneJobs,
  runWatchedGitClone,
  withCloneStaging,
  type PreparedCloneDestination,
} from "./gitCloneRun.ts";

const ok = (): GitVcsDriver.ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const commandFailure = (detail: string) =>
  new GitCommandError({
    operation: "SourceControlRepositoryService.cloneRepository",
    command: "git clone --progress -- https://user:tok123@github.com/x/y.git target",
    cwd: "/tmp",
    detail,
  });

const stubGit = (
  execute: GitVcsDriver.GitVcsDriverShape["execute"],
): Pick<GitVcsDriver.GitVcsDriverShape, "execute"> => ({ execute });

const TARGET = { parentPath: "/tmp/parent", directoryName: "target" };
const URL = "https://github.com/octocat/ryco.git";

/** A scratch folder outside any repository, removed afterwards. */
const scratchFolder = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "ryco-git-clone-run-"))),
  (folder) => Effect.promise(() => rm(folder, { recursive: true, force: true })),
);

const destinationIn = (parentPath: string, name = "ryco"): PreparedCloneDestination => ({
  parentPath,
  directoryName: name,
  destinationPath: path.join(parentPath, name),
});

const exists = (target: string) =>
  lstat(target).then(
    () => true,
    () => false,
  );

const allowStaging = () => Effect.succeed(true);

/** Writes a repository-like tree into the target, like git does. */
const writeRepository = (target: { parentPath: string; directoryName: string }) =>
  Effect.promise(async () => {
    const dir = path.join(target.parentPath, target.directoryName);
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(dir, "README.md"), "hello\n");
  });

describe("isGitCloneProgressLine", () => {
  it("recognises progress redraws", () => {
    for (const line of [
      "Receiving objects:  45% (1234/2742), 12.00 MiB | 3.00 MiB/s",
      "remote: Counting objects: 100% (5/5), done.",
      "remote: Enumerating objects: 12, done.",
      "Resolving deltas:   3% (1/30)",
      "Updating files:  78% (2104/2700)",
      "Filtering content: 50% (2/4), 1.00 MiB | 1.00 MiB/s",
      "remote: Total 12 (delta 0), reused 0 (delta 0), pack-reused 12",
      "Checking connectivity: 1200, done.",
    ]) {
      assert.isTrue(isGitCloneProgressLine(line), line);
    }
  });

  it("keeps git's real messages", () => {
    for (const line of [
      "fatal: repository 'https://github.com/x/y.git/' not found",
      "remote: Repository not found.",
      "Permission denied (publickey).",
      "warning: Clone succeeded, but checkout failed.",
    ]) {
      assert.isFalse(isGitCloneProgressLine(line), line);
    }
  });
});

/** A host tag that is not this machine's. */
const OTHER_HOST = CLONE_STAGING_HOST === "000000" ? "111111" : "000000";

describe("staging names", () => {
  it("names a hidden sibling owned by this process on this machine", () => {
    const token = cloneStagingToken("darwin");
    const name = cloneStagingDirectoryName("ryco", { token, pid: 4242, platform: "darwin" });
    assert.strictEqual(name, `.ryco.ryco-clone-${CLONE_STAGING_HOST}-4242-${token}`);
    assert.match(token, /^[0-9a-f-]{36}$/);
    assert.match(CLONE_STAGING_HOST, /^[0-9a-f]{6}$/);
    assert.deepStrictEqual(cloneStagingOwner(name, "ryco", "darwin"), {
      host: CLONE_STAGING_HOST,
      pid: 4242,
    });
  });

  it("keeps Windows staging names short", () => {
    const token = cloneStagingToken("win32");
    assert.match(token, /^[0-9a-f]{8}$/);
    const name = cloneStagingDirectoryName("a-very-long-repository-name-for-windows", {
      token,
      host: OTHER_HOST,
      pid: 7,
      platform: "win32",
    });
    assert.strictEqual(name, `.a-very-long-repo.ryco-clone-${OTHER_HOST}-7-${token}`);
    assert.deepStrictEqual(
      cloneStagingOwner(name, "a-very-long-repository-name-for-windows", "win32"),
      { host: OTHER_HOST, pid: 7 },
    );
  });

  it("clips long names on whole characters within the byte budget", () => {
    const name = cloneStagingDirectoryName("é".repeat(200), {
      token: randomUUID(),
      pid: 1,
      platform: "linux",
    });
    assert.isAtMost(Buffer.byteLength(name), 255);
    assert.notInclude(name, "�");
  });

  it("ignores entries that are not staging folders of this destination", () => {
    for (const entry of [
      "ryco",
      ".ryco",
      `.ryco.ryco-clone-${CLONE_STAGING_HOST}-12-not-a-token`,
      `.ryco.ryco-clone-12-${randomUUID()}`,
      `.other.ryco-clone-${CLONE_STAGING_HOST}-12-${randomUUID()}`,
      `.ryco.ryco-import-${CLONE_STAGING_HOST}-12-${randomUUID()}`,
    ]) {
      assert.isNull(cloneStagingOwner(entry, "ryco", "darwin"), entry);
    }
  });
});

describe("cloneFailureDetail", () => {
  it("joins the tail and falls back when it is empty", () => {
    assert.strictEqual(cloneFailureDetail(["a", "b"]), "a b");
    assert.strictEqual(cloneFailureDetail([]), "The repository could not be cloned.");
    assert.isAtMost(
      cloneFailureDetail(["x".repeat(400), "y".repeat(400), "z".repeat(400)]).length,
      1_000,
    );
  });
});

describe("runWatchedGitClone", () => {
  it.effect("passes --progress, the clone environment, a capped buffer and the callbacks", () =>
    Effect.gen(function* () {
      const calls: GitVcsDriver.ExecuteGitInput[] = [];
      const outcome = yield* runWatchedGitClone({
        git: stubGit((input) => Effect.sync(() => (calls.push(input), ok()))),
        target: TARGET,
        remoteUrl: URL,
        env: { GIT_ASKPASS: "/tmp/askpass.sh", RYCO_GIT_PASSWORD: "secret" },
        provider: "github",
      });
      assert.deepStrictEqual(outcome, { kind: "complete" });
      const [call] = calls;
      assert.deepStrictEqual(call?.args, ["clone", "--progress", "--", URL, "target"]);
      assert.strictEqual(call?.cwd, "/tmp/parent");
      assert.deepInclude(call?.env ?? {}, CLONE_ENV);
      assert.strictEqual(call?.env?.GIT_ASKPASS, "/tmp/askpass.sh");
      assert.strictEqual(call?.timeoutMs, Number.POSITIVE_INFINITY);
      assert.strictEqual(call?.maxOutputBytes, CLONE_KEPT_OUTPUT_BYTES);
      assert.isTrue(call?.truncateOutputAtMaxBytes);
      assert.isTrue(call?.progress?.splitStderrAtCarriageReturn);
      assert.isTrue(call?.progress?.keepLineCallbacksAfterTruncation);
      assert.isDefined(call?.progress?.onStderrLine);
      assert.isDefined(call?.progress?.onStdoutLine);
    }),
  );

  it.effect("fails a clone that prints nothing for five minutes and stops git", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runWatchedGitClone({
        git: stubGit((input) =>
          input.progress!.onStderrLine!("Cloning into 'target'...").pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        ),
        target: TARGET,
        remoteUrl: URL,
        provider: "github",
      }).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(CLONE_STALL_TIMEOUT_MS - 1);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(1);
      const error = yield* Fiber.join(fiber);
      assert.match(error.detail, /printed nothing for 5 minutes/);
      assert.isTrue(interrupted);
    }),
  );

  it.effect("keeps a clone alive while git prints progress, far past two minutes", () =>
    Effect.gen(function* () {
      const minutes = 45;
      const fiber = yield* runWatchedGitClone({
        git: stubGit((input) =>
          Effect.gen(function* () {
            for (let minute = 1; minute <= minutes; minute += 1) {
              yield* Effect.sleep("4 minutes");
              yield* input.progress!.onStderrLine!(
                `Receiving objects:  ${minute}% (${minute}/100), 1.00 MiB | 10.00 KiB/s`,
              );
            }
            return ok();
          }),
        ),
        target: TARGET,
        remoteUrl: URL,
        provider: "github",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(`${minutes * 4} minutes`);
      assert.deepStrictEqual(yield* Fiber.join(fiber), { kind: "complete" });
    }),
  );

  it.effect("explains a failure with git's messages, not its progress or credentials", () =>
    Effect.gen(function* () {
      const progress = Array.from(
        { length: 4_000 },
        (_, index) => `Receiving objects:  ${index % 100}% (${index}/4000), 1.00 MiB | 1.00 MiB/s`,
      );
      const messages = [
        "Cloning into 'target'...",
        ...progress,
        "remote: Repository not found.",
        "fatal: repository 'https://user:tok123@github.com/x/y.git/' not found",
      ];
      const error = yield* runWatchedGitClone({
        git: stubGit((input) =>
          Effect.forEach(messages, (line) => input.progress!.onStderrLine!(line)).pipe(
            Effect.andThen(Effect.fail(commandFailure(`git clone failed: ${messages.join("\r")}`))),
          ),
        ),
        target: TARGET,
        remoteUrl: URL,
        provider: "github",
      }).pipe(Effect.flip);

      assert.include(error.detail, "Repository not found");
      assert.include(error.detail, "fatal:");
      assert.notInclude(error.detail, "Receiving objects");
      assert.notInclude(error.detail, "tok123");
      assert.isUndefined(error.cause);
      // What crosses the wire: no command line, no credentials, no progress, and small.
      const encoded = JSON.stringify(Schema.encodeSync(SourceControlRepositoryError)(error));
      assert.notInclude(encoded, "tok123");
      assert.notInclude(encoded, "Receiving objects");
      assert.isBelow(Buffer.byteLength(encoded), 8 * 1024);
    }),
  );

  it.effect("says git could not start when it printed nothing", () =>
    Effect.gen(function* () {
      const error = yield* runWatchedGitClone({
        git: stubGit(() =>
          Effect.fail(
            commandFailure(
              "git clone --progress -- https://user:tok123@github.com/x/y.git target failed to spawn.",
            ),
          ),
        ),
        target: TARGET,
        remoteUrl: URL,
        provider: "github",
      }).pipe(Effect.flip);
      assert.match(error.detail, /git could not be started/);
      assert.notInclude(error.detail, "tok123");
    }),
  );
});

describe("withCloneStaging", () => {
  it.effect("publishes the staging folder onto a missing destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destination = destinationIn(parent);
        const targets: string[] = [];
        yield* withCloneStaging(
          { destination, provider: "github", allowStagingAt: allowStaging },
          (target) =>
            Effect.sync(() => targets.push(target.directoryName)).pipe(
              Effect.andThen(writeRepository(target)),
            ),
        );
        assert.match(targets[0] ?? "", /^\.ryco\.ryco-clone-[0-9a-f]{6}-\d+-[0-9a-f-]{36}$/);
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), ["ryco"]);
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(path.join(destination.destinationPath, ".git", "HEAD"), "utf8"),
          ),
          "ref: refs/heads/main\n",
        );
      }),
    ),
  );

  it.effect("replaces an existing empty destination folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destination = destinationIn(parent);
        yield* Effect.promise(() => mkdir(destination.destinationPath));
        yield* withCloneStaging(
          { destination, provider: "github", allowStagingAt: allowStaging },
          writeRepository,
        );
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), ["ryco"]);
        assert.isTrue(
          yield* Effect.promise(() => exists(path.join(destination.destinationPath, "README.md"))),
        );
      }),
    ),
  );

  it.effect("removes the staging folder when the clone fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destination = destinationIn(parent);
        const result = yield* withCloneStaging(
          { destination, provider: "github", allowStagingAt: allowStaging },
          (target) => writeRepository(target).pipe(Effect.andThen(Effect.fail("boom" as const))),
        ).pipe(Effect.flip);
        assert.strictEqual(result, "boom");
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), []);
      }),
    ),
  );

  it.effect("removes the staging folder when interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destination = destinationIn(parent);
        const written = yield* Deferred.make<void>();
        const fiber = yield* withCloneStaging(
          { destination, provider: "github", allowStagingAt: allowStaging },
          (target) =>
            writeRepository(target).pipe(
              Effect.andThen(Deferred.succeed(written, undefined)),
              Effect.andThen(Effect.never),
            ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(written);
        assert.strictEqual((yield* Effect.promise(() => readdir(parent))).length, 1);
        yield* Fiber.interrupt(fiber);
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), []);
      }),
    ),
  );

  it.effect("refuses to publish over files written meanwhile and keeps them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destination = destinationIn(parent);
        const error = yield* withCloneStaging(
          { destination, provider: "github", allowStagingAt: allowStaging },
          (target) =>
            writeRepository(target).pipe(
              Effect.andThen(
                Effect.promise(async () => {
                  await mkdir(destination.destinationPath);
                  await writeFile(path.join(destination.destinationPath, "user.txt"), "mine\n");
                }),
              ),
            ),
        ).pipe(Effect.flip);
        assert.match(String((error as SourceControlRepositoryError).detail), /no longer empty/);
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), ["ryco"]);
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(destination.destinationPath)), [
          "user.txt",
        ]);
      }),
    ),
  );

  it.effect("clones in place when staging is not allowed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destination = destinationIn(parent);
        const targets: string[] = [];
        yield* withCloneStaging(
          { destination, provider: "github", allowStagingAt: () => Effect.succeed(false) },
          (target) => Effect.sync(() => targets.push(target.directoryName)),
        );
        assert.deepStrictEqual(targets, ["ryco"]);
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), []);
      }),
    ),
  );

  it.effect("clones in place when the destination is a symbolic link to an empty folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const real = path.join(parent, "real");
        yield* Effect.promise(() => mkdir(real));
        const destination = destinationIn(parent, "link");
        yield* Effect.promise(() => symlink(real, destination.destinationPath));
        const targets: string[] = [];
        yield* withCloneStaging(
          { destination, provider: "github", allowStagingAt: allowStaging },
          (target) => Effect.sync(() => targets.push(target.directoryName)),
        );
        assert.deepStrictEqual(targets, ["link"]);
        assert.deepStrictEqual((yield* Effect.promise(() => readdir(parent))).toSorted(), [
          "link",
          "real",
        ]);
      }),
    ),
  );

  it.effect.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "clones in place when the parent folder is not writable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* scratchFolder;
          const destination = destinationIn(parent);
          yield* Effect.promise(() => mkdir(destination.destinationPath));
          yield* Effect.acquireRelease(
            Effect.promise(() => chmod(parent, 0o555)),
            () => Effect.promise(() => chmod(parent, 0o755)),
          );
          const targets: string[] = [];
          yield* withCloneStaging(
            { destination, provider: "github", allowStagingAt: allowStaging },
            (target) => Effect.sync(() => targets.push(target.directoryName)),
          );
          assert.deepStrictEqual(targets, ["ryco"]);
        }),
      ),
  );

  it.effect(
    "removes staging folders a stopped server here left behind, not those of live ones or other machines",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* scratchFolder;
          const destination = destinationIn(parent);
          // A process that has exited: its pid is free.
          const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
          const deadPid = exited.pid!;
          const dead = cloneStagingDirectoryName("ryco", { token: randomUUID(), pid: deadPid });
          const live = cloneStagingDirectoryName("ryco", {
            token: randomUUID(),
            pid: process.ppid,
          });
          // A shared folder: that pid means nothing on this machine.
          const otherMachine = cloneStagingDirectoryName("ryco", {
            token: randomUUID(),
            host: OTHER_HOST,
            pid: deadPid,
          });
          const unrelated = `.other.ryco-clone-${CLONE_STAGING_HOST}-${deadPid}-${randomUUID()}`;
          for (const name of [dead, live, otherMachine, unrelated]) {
            yield* Effect.promise(() =>
              mkdir(path.join(parent, name, "objects"), { recursive: true }),
            );
          }
          yield* withCloneStaging(
            { destination, provider: "github", allowStagingAt: allowStaging },
            writeRepository,
          );
          assert.deepStrictEqual(
            (yield* Effect.promise(() => readdir(parent))).toSorted(),
            [live, otherMachine, unrelated, "ryco"].toSorted(),
          );
        }),
      ),
  );

  it.effect.skipIf(process.platform === "win32")(
    "keeps a running clone's staging folder when another clone names the parent differently",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scratchFolder;
          const parent = path.join(root, "parent");
          const alias = path.join(root, "alias");
          yield* Effect.promise(async () => {
            await mkdir(parent);
            await symlink(parent, alias);
          });
          const staged = yield* Deferred.make<string>();
          const release = yield* Deferred.make<void>();
          const first = yield* withCloneStaging(
            {
              destination: destinationIn(parent),
              provider: "github",
              allowStagingAt: allowStaging,
            },
            (target) =>
              writeRepository(target).pipe(
                Effect.andThen(Deferred.succeed(staged, target.directoryName)),
                Effect.andThen(Deferred.await(release)),
              ),
          ).pipe(Effect.flip, Effect.forkChild);
          const firstStaging = yield* Deferred.await(staged);

          // A second clone into the same folder, spelled through the symbolic link: its sweep
          // must not take the first one's staging folder for a leftover.
          yield* withCloneStaging(
            { destination: destinationIn(alias), provider: "github", allowStagingAt: allowStaging },
            (target) =>
              Effect.promise(() => readdir(parent)).pipe(
                Effect.tap((entries) => Effect.sync(() => assert.include(entries, firstStaging))),
                Effect.andThen(writeRepository(target)),
              ),
          );
          yield* Deferred.succeed(release, undefined);
          const error = yield* Fiber.join(first);
          assert.match(String((error as SourceControlRepositoryError).detail), /no longer empty/);
          assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), ["ryco"]);
        }),
      ),
  );
});

// ---------------------------------------------------------------------------------------------
// Real git: a non-zero exit after the whole repository was fetched (critique M2)
// ---------------------------------------------------------------------------------------------

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-git-clone-run-" })),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, stdio: "pipe", env: { ...process.env, LC_ALL: "C" } });

/** A bare repository with `.gitattributes` routing `*.dat` through a `boom` filter. */
const makeBareRepository = (root: string) =>
  Effect.promise(async () => {
    const source = path.join(root, "source");
    await mkdir(source);
    runGit(source, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(source, ".gitattributes"), "*.dat filter=boom\n");
    await writeFile(path.join(source, "a.dat"), "data\n");
    await writeFile(path.join(source, "README"), "hi\n");
    runGit(source, ["add", "."]);
    runGit(source, [
      "-c",
      "user.email=test@test.com",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    const bare = path.join(root, "remote.git");
    runGit(root, ["clone", "-q", "--bare", source, bare]);
    return bare;
  });

/** Process-only git config for the clone, as `GIT_CONFIG_*` (nothing is written to any config). */
const gitConfigEnv = (entries: ReadonlyArray<readonly [string, string]>) =>
  Object.fromEntries([
    ["GIT_CONFIG_COUNT", String(entries.length)],
    ...entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ]) as Record<string, string>;

const cloneWithConfig = (input: {
  readonly root: string;
  readonly remote: string;
  readonly env: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const parent = path.join(input.root, "clones");
    yield* Effect.promise(() => mkdir(parent));
    const destination = destinationIn(parent, "repo");
    const error = yield* cloneIntoDestination({
      git,
      destination,
      remoteUrl: input.remote,
      provider: "unknown",
      checkDestination: Effect.void,
      allowStagingAt: allowStaging,
      withCredentials: (use) => use(input.env),
    }).pipe(Effect.flip);
    return { error, parent, destination };
  });

it.layer(GitLayer)("non-zero exits that leave a complete repository", (it) => {
  it.effect("publishes a repository whose checkout failed in a smudge filter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* scratchFolder;
        const remote = yield* makeBareRepository(root);
        const { error, parent, destination } = yield* cloneWithConfig({
          root,
          remote,
          env: gitConfigEnv([
            ["filter.boom.smudge", "false"],
            ["filter.boom.required", "true"],
          ]),
        });
        assert.include(error.detail, `The repository was cloned to ${destination.destinationPath}`);
        assert.include(error.detail, "smudge filter boom failed");
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), ["repo"]);
        assert.isTrue(
          yield* Effect.promise(() =>
            exists(path.join(destination.destinationPath, ".git", "HEAD")),
          ),
        );
      }),
    ),
  );

  it.effect.skipIf(process.platform === "win32")(
    "publishes a repository whose post-checkout hook failed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scratchFolder;
          const remote = yield* makeBareRepository(root);
          const hooks = path.join(root, "hooks");
          yield* Effect.promise(async () => {
            await mkdir(hooks);
            await writeFile(path.join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n");
            await chmod(path.join(hooks, "post-checkout"), 0o755);
          });
          const { error, parent, destination } = yield* cloneWithConfig({
            root,
            remote,
            env: gitConfigEnv([["core.hooksPath", hooks]]),
          });
          assert.include(
            error.detail,
            `The repository was cloned to ${destination.destinationPath}`,
          );
          assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), ["repo"]);
          assert.isTrue(
            yield* Effect.promise(() => exists(path.join(destination.destinationPath, "a.dat"))),
          );
        }),
      ),
  );

  it.effect("removes everything when the remote does not exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* scratchFolder;
        const { error, parent } = yield* cloneWithConfig({
          root,
          remote: path.join(root, "missing.git"),
          env: {},
        });
        assert.match(error.detail, /does not exist|not found|not appear to be a git repository/);
        assert.notInclude(error.detail, "was cloned");
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), []);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------------------------
// Detached clones (critique M1)
// ---------------------------------------------------------------------------------------------

const RESULT = (cwd: string) => ({ cwd, remoteUrl: URL, repository: null });

describe("makeCloneJobs", () => {
  it.effect("a dropped request leaves the clone running, and the same request joins it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destinationPath = path.join(parent, "ryco");
        const jobs = yield* makeCloneJobs;
        const release = yield* Deferred.make<void>();
        let starts = 0;
        let interrupted = false;
        const clone = Effect.sync(() => {
          starts += 1;
        }).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
          Effect.as(RESULT(destinationPath)),
        );
        const key = `${destinationPath}\n${URL}`;

        const first = yield* jobs.runOrJoin({ key, destinationPath, clone }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.strictEqual(starts, 1);
        yield* Fiber.interrupt(first);
        assert.isFalse(interrupted);

        const second = yield* jobs
          .runOrJoin({ key, destinationPath, clone })
          .pipe(Effect.forkChild);
        const third = yield* jobs.runOrJoin({ key, destinationPath, clone }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(second), RESULT(destinationPath));
        assert.deepStrictEqual(yield* Fiber.join(third), RESULT(destinationPath));
        assert.strictEqual(starts, 1);
        assert.isFalse(interrupted);
      }),
    ),
  );

  it.effect("answers with a finished clone's outcome while its repository is there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destination = destinationIn(parent);
        const jobs = yield* makeCloneJobs;
        let starts = 0;
        const clone = Effect.sync(() => {
          starts += 1;
        }).pipe(
          Effect.andThen(writeRepository(destination)),
          Effect.as(RESULT(destination.destinationPath)),
        );
        const request = {
          key: `${destination.destinationPath}\n${URL}`,
          destinationPath: destination.destinationPath,
          clone,
        };
        yield* jobs.runOrJoin(request);
        assert.deepStrictEqual(yield* jobs.runOrJoin(request), RESULT(destination.destinationPath));
        assert.strictEqual(starts, 1);

        // Kept for a while only.
        yield* TestClock.adjust(CLONE_OUTCOME_RETENTION_MS);
        yield* jobs.runOrJoin(request);
        assert.strictEqual(starts, 2);

        // Not once the repository is gone.
        yield* Effect.promise(() => rm(destination.destinationPath, { recursive: true }));
        yield* jobs.runOrJoin(request);
        assert.strictEqual(starts, 3);
      }),
    ),
  );

  it.effect("starts a fresh clone after one that failed without leaving a repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destinationPath = path.join(parent, "ryco");
        const jobs = yield* makeCloneJobs;
        let starts = 0;
        const clone = Effect.suspend(() => {
          starts += 1;
          return starts === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "github",
                  detail: "Repository not found.",
                }),
              )
            : Effect.succeed(RESULT(destinationPath));
        });
        const request = { key: `${destinationPath}\n${URL}`, destinationPath, clone };
        const failed = yield* jobs.runOrJoin(request).pipe(Effect.flip);
        assert.strictEqual(failed.detail, "Repository not found.");
        assert.deepStrictEqual(yield* jobs.runOrJoin(request), RESULT(destinationPath));
        assert.strictEqual(starts, 2);
      }),
    ),
  );

  it.effect("stops a clone nobody waits for and removes its staging folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = yield* scratchFolder;
        const destination = destinationIn(parent);
        const jobs = yield* makeCloneJobs;
        const staged = yield* Deferred.make<void>();
        const cloneDone = yield* Deferred.make<void>();
        let interrupted = false;
        const clone = withCloneStaging(
          { destination, provider: "github", allowStagingAt: allowStaging },
          (target) =>
            writeRepository(target).pipe(
              Effect.andThen(Deferred.succeed(staged, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
        ).pipe(
          Effect.as(RESULT(destination.destinationPath)),
          Effect.ensuring(Deferred.succeed(cloneDone, undefined)),
        );
        const request = {
          key: `${destination.destinationPath}\n${URL}`,
          destinationPath: destination.destinationPath,
          clone,
        };

        const caller = yield* jobs.runOrJoin(request).pipe(Effect.forkChild);
        yield* Deferred.await(staged);
        yield* Fiber.interrupt(caller);
        assert.strictEqual((yield* Effect.promise(() => readdir(parent))).length, 1);

        // Re-attaching within the grace keeps it.
        yield* TestClock.adjust(CLONE_ORPHAN_GRACE_MS - 1_000);
        const rejoined = yield* jobs.runOrJoin(request).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(CLONE_ORPHAN_GRACE_MS);
        assert.isFalse(interrupted);
        yield* Fiber.interrupt(rejoined);

        // Alone for the whole grace: stopped, and its staging folder is gone.
        yield* TestClock.adjust(CLONE_ORPHAN_GRACE_MS);
        yield* Deferred.await(cloneDone);
        assert.isTrue(interrupted);
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(parent)), []);
      }),
    ),
  );

  it.effect("stops every clone when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeCloneJobs;
          const caller = yield* jobs
            .runOrJoin({
              key: "k",
              destinationPath: "/nonexistent",
              clone: Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
            })
            .pipe(Effect.forkDetach);
          yield* Deferred.await(started);
          return caller;
        }),
      ).pipe(Effect.flatMap(Fiber.await));
      assert.isTrue(interrupted);
      assert.isTrue(Exit.hasInterrupts(exit));
    }),
  );
});
