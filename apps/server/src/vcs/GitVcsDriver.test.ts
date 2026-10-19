import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";

import { GitCommandError } from "@ryco/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { configureTestGitCommitIdentity } from "./testing/GitTestRepo.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* configureTestGitCommitIdentity(cwd, runGit);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/ryco-index",
      },
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/ryco-index",
    });
  }).pipe(
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.sync(() => {
            observedEnv = input.env;
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
    ),
  );
});

const spawnedOperations: string[] = [];
const spawnCount = (operation: string) =>
  spawnedOperations.filter((spawned) => spawned === operation).length;

/** Real git, recording the operation of every process the VCS driver starts. */
const RecordingProcessLayer = Layer.effect(
  VcsProcess.VcsProcess,
  Effect.map(Effect.service(VcsProcess.VcsProcess), (real) =>
    VcsProcess.VcsProcess.of({
      ...real,
      run: (input) =>
        Effect.sync(() => spawnedOperations.push(input.operation)).pipe(
          Effect.andThen(real.run(input)),
        ),
    }),
  ),
).pipe(Layer.provide(VcsProcess.layer));

const RecordingLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(RecordingProcessLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-git-vcs-memo-" });
  yield* runGit(cwd, ["init"]);
  return cwd;
});

it.layer(RecordingLayer)("GitVcsDriver repository memo", (it) => {
  it.effect("lists remotes from memory until the repository config changes", () =>
    Effect.gen(function* () {
      spawnedOperations.length = 0;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* makeCheckout;
      yield* runGit(cwd, ["remote", "add", "origin", "https://example.com/acme/one.git"]);

      const first = yield* driver.listRemotes(cwd);
      const second = yield* driver.listRemotes(cwd);
      assert.deepStrictEqual(
        first.remotes.map((remote) => remote.url),
        ["https://example.com/acme/one.git"],
      );
      assert.deepStrictEqual(second.remotes, first.remotes);
      assert.equal(spawnCount("GitVcsDriver.listRemotes"), 1);

      // Edited behind the driver's back, to a URL of the same length.
      yield* runGit(cwd, ["remote", "set-url", "origin", "https://example.com/acme/two.git"]);
      const changed = yield* driver.listRemotes(cwd);
      assert.deepStrictEqual(
        changed.remotes.map((remote) => remote.url),
        ["https://example.com/acme/two.git"],
      );
      assert.equal(spawnCount("GitVcsDriver.listRemotes"), 2);

      yield* driver.listRemotes(cwd);
      assert.equal(spawnCount("GitVcsDriver.listRemotes"), 2);
    }),
  );

  it.effect("answers from the enclosing repository's config for nested directories", () =>
    Effect.gen(function* () {
      spawnedOperations.length = 0;
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* makeCheckout;
      const nested = `${cwd}/packages/web`;
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      yield* runGit(cwd, ["remote", "add", "origin", "https://example.com/acme/one.git"]);

      yield* driver.listRemotes(nested);
      yield* driver.listRemotes(nested);
      assert.equal(spawnCount("GitVcsDriver.listRemotes"), 1);

      yield* runGit(cwd, ["remote", "add", "upstream", "https://example.com/acme/up.git"]);
      const changed = yield* driver.listRemotes(nested);
      assert.deepStrictEqual(changed.remotes.map((remote) => remote.name).toSorted(), [
        "origin",
        "upstream",
      ]);
      assert.equal(spawnCount("GitVcsDriver.listRemotes"), 2);
    }),
  );

  it.effect("does not answer from memory once the directory is gone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* makeCheckout;
      const nested = `${cwd}/packages/web`;
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      yield* driver.listRemotes(nested);
      assert.isNotNull(yield* driver.detectRepository(nested));

      yield* fileSystem.remove(nested, { recursive: true });
      assert.equal((yield* Effect.exit(driver.listRemotes(nested)))._tag, "Failure");
      assert.equal((yield* Effect.exit(driver.detectRepository(nested)))._tag, "Failure");
    }),
  );

  it.effect("detects a repository once while its metadata is unchanged", () =>
    Effect.gen(function* () {
      spawnedOperations.length = 0;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* makeCheckout;

      const first = yield* driver.detectRepository(cwd);
      const second = yield* driver.detectRepository(cwd);
      assert.isNotNull(first);
      assert.equal(second?.rootPath, first?.rootPath);
      assert.equal(second?.metadataPath, first?.metadataPath);
      assert.equal(spawnCount("GitVcsDriver.detectRepository"), 1);

      // HEAD is part of what makes a directory a repository.
      yield* runGit(cwd, ["symbolic-ref", "HEAD", "refs/heads/other"]);
      assert.isNotNull(yield* driver.detectRepository(cwd));
      assert.equal(spawnCount("GitVcsDriver.detectRepository"), 2);
    }),
  );

  it.effect("keeps asking while a folder is not a repository and sees it become one", () =>
    Effect.gen(function* () {
      spawnedOperations.length = 0;
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-git-vcs-memo-" });

      assert.isNull(yield* driver.detectRepository(cwd));
      assert.isNull(yield* driver.detectRepository(cwd));
      assert.equal(spawnCount("GitVcsDriver.detectRepository"), 2);

      yield* runGit(cwd, ["init"]);
      assert.isNotNull(yield* driver.detectRepository(cwd));
      assert.equal(spawnCount("GitVcsDriver.detectRepository"), 3);
    }),
  );
});
