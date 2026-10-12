import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { configureTestGitCommitIdentity } from "./testing/GitTestRepo.ts";

const TestLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-git-list-files-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({ operation: "GitVcsDriver.test.git", cwd, args, timeoutMs: 10_000 });
  });

const writeFile = (cwd: string, relativePath: string, contents = "x\n") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });

/**
 * A checkout with tracked, untracked, ignored-untracked and tracked-but-now-
 * ignored files.
 */
const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-git-list-files-" });
  yield* git(cwd, ["init"]);
  yield* configureTestGitCommitIdentity(cwd, git);
  yield* writeFile(cwd, "src/tracked.ts");
  yield* writeFile(cwd, "generated/stale.json");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "init"]);
  yield* writeFile(cwd, ".gitignore", "generated/\n*.log\n");
  yield* writeFile(cwd, "notes/untracked.md");
  yield* writeFile(cwd, "debug.log");
  return cwd;
});

it.layer(TestLayer)("GitVcsDriver.listWorkspaceFiles", (it) => {
  it.effect("lists tracked files first, then untracked ones, without ignored paths", () =>
    Effect.gen(function* () {
      const cwd = yield* makeCheckout;
      const driver = yield* VcsDriver.VcsDriver;

      const result = yield* driver.listWorkspaceFiles(cwd);

      // `generated/stale.json` stays tracked but now matches an ignore rule.
      assert.deepStrictEqual(result.paths, ["src/tracked.ts", ".gitignore", "notes/untracked.md"]);
      assert.equal(result.truncated, false);
    }),
  );

  it.effect("lists only tracked files when asked", () =>
    Effect.gen(function* () {
      const cwd = yield* makeCheckout;
      const driver = yield* VcsDriver.VcsDriver;

      const result = yield* driver.listWorkspaceFiles(cwd, { trackedOnly: true });

      assert.deepStrictEqual(result.paths, ["src/tracked.ts"]);
    }),
  );
});
