import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";

import { processGovernorStats } from "../processGovernor.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { configureTestGitCommitIdentity } from "./testing/GitTestRepo.ts";

const TestLayer = GitVcsDriver.vcsLayer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    yield* process.run({ operation: "GitVcsDriver.test.git", command: "git", cwd, args });
  });

const writeFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });

/**
 * A checkout with tracked, untracked, ignored, tracked-but-now-ignored, binary
 * and linked files, under config that would change what a plain `git grep`
 * prints or refuses.
 */
const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-git-grep-" });
  const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-git-grep-outside-" });
  yield* git(cwd, ["init"]);
  yield* configureTestGitCommitIdentity(cwd, git);
  for (const [key, value] of [
    ["submodule.recurse", "true"],
    ["grep.fullName", "true"],
    ["color.grep", "always"],
    ["grep.patternType", "perl"],
  ] as const) {
    yield* git(cwd, ["config", key, value]);
  }
  yield* writeFile(cwd, "a.ts", "needle tracked\n");
  yield* writeFile(cwd, "a/b.ts", "first\nneedle tracked\n");
  yield* writeFile(cwd, "dist/out.js", "needle bundled\n");
  yield* writeFile(cwd, "generated/stale.json", "needle stale\n");
  yield* writeFile(cwd, "bin.dat", "needle\0binary\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "init"]);
  yield* writeFile(cwd, ".gitignore", "generated/\n*.log\n");
  yield* writeFile(cwd, "a-b.ts", "needle untracked\n");
  yield* writeFile(cwd, "a/a.ts", "needle untracked\n");
  yield* writeFile(cwd, "debug.log", "needle ignored\n");
  yield* writeFile(outside, "secret.txt", "needle outside\n");
  yield* fileSystem.symlink(path.join(outside, "secret.txt"), path.join(cwd, "link.txt"));
  return cwd;
});

const search = (cwd: string, options: Partial<VcsDriver.VcsWorkspaceContentSearchOptions> = {}) =>
  Effect.gen(function* () {
    const driver = yield* VcsDriver.VcsDriver;
    assert.isDefined(driver.streamWorkspaceContentMatches);
    return driver.streamWorkspaceContentMatches(cwd, {
      query: "needle",
      caseSensitive: false,
      wholeWord: false,
      afterPath: "",
      maxLinesPerFile: 100,
      excludedTopLevelNames: [],
      ...options,
    });
  });

const searchPaths = (cwd: string, options?: Partial<VcsDriver.VcsWorkspaceContentSearchOptions>) =>
  search(cwd, options).pipe(
    Effect.flatMap(Stream.runCollect),
    Effect.map((files) => files.map((file) => file.path)),
  );

const runningGitChildren = () =>
  processGovernorStats().find((stats) => stats.pool === "git")?.inFlight ?? 0;

it.layer(TestLayer)("GitVcsDriver.streamWorkspaceContentMatches", (it) => {
  it.effect("searches tracked and untracked files in path order, skipping the rest", () =>
    Effect.gen(function* () {
      const cwd = yield* makeCheckout;

      const files = yield* search(cwd).pipe(Effect.flatMap(Stream.runCollect));

      // Untracked files sort in among tracked ones; ignored (even when still
      // tracked), binary and linked files are left out.
      assert.deepStrictEqual(
        files.map((file) => file.path),
        ["a-b.ts", "a.ts", "a/a.ts", "a/b.ts", "dist/out.js"],
      );
      assert.deepStrictEqual(files[3]?.lines, [
        { lineNumber: 2, text: "needle tracked", matchStart: 0, cutStart: false, cutEnd: false },
      ]);
    }),
  );

  it.effect("leaves out excluded top-level folders and files up to the cursor path", () =>
    Effect.gen(function* () {
      const cwd = yield* makeCheckout;

      assert.deepStrictEqual(
        yield* searchPaths(cwd, { afterPath: "a.ts", excludedTopLevelNames: ["dist", "a-b.ts"] }),
        ["a/a.ts", "a/b.ts"],
      );
    }),
  );

  it.effect("lists paths relative to a subfolder it searches", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = yield* makeCheckout;

      assert.deepStrictEqual(yield* searchPaths(path.join(cwd, "a")), ["a.ts", "b.ts"]);
    }),
  );

  it.effect("matches the query as literal text, read from stdin", () =>
    Effect.gen(function* () {
      const cwd = yield* makeCheckout;
      yield* writeFile(cwd, "odd.ts", `-e "quoted" $HOME *.ts\nother\n`);

      for (const query of ["-e", '"quoted"', "$HOME", "*.ts", "-"]) {
        assert.deepStrictEqual(yield* searchPaths(cwd, { query }), ["odd.ts"]);
      }
    }),
  );

  it.effect("applies match case and whole word", () =>
    Effect.gen(function* () {
      const cwd = yield* makeCheckout;
      yield* writeFile(cwd, "words.ts", "Haystack\nhaystacks\nhay_stack haystack\n");
      const lineNumbers = (options: Partial<VcsDriver.VcsWorkspaceContentSearchOptions>) =>
        search(cwd, { query: "haystack", ...options }).pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.map((files) => files.flatMap((file) => file.lines.map((line) => line.lineNumber))),
        );

      assert.deepStrictEqual(yield* lineNumbers({}), [1, 2, 3]);
      assert.deepStrictEqual(yield* lineNumbers({ caseSensitive: true }), [2, 3]);
      assert.deepStrictEqual(yield* lineNumbers({ wholeWord: true }), [1, 3]);
    }),
  );

  it.effect("keeps the first lines of a file up to the cap", () =>
    Effect.gen(function* () {
      const cwd = yield* makeCheckout;
      yield* writeFile(cwd, "many.ts", "needle\n".repeat(5));

      const files = yield* search(cwd, { afterPath: "dist/out.js", maxLinesPerFile: 2 }).pipe(
        Effect.flatMap(Stream.runCollect),
      );

      assert.deepStrictEqual(
        files.map((file) => [file.path, file.lines.map((line) => line.lineNumber)]),
        [["many.ts", [1, 2]]],
      );
    }),
  );

  it.effect("stops git and frees its process slot when the reader stops", () =>
    Effect.gen(function* () {
      const cwd = yield* makeCheckout;
      for (let index = 0; index < 60; index += 1) {
        yield* writeFile(cwd, `many/${String(index).padStart(2, "0")}.ts`, "needle\n");
      }
      let runningWhileRead = 0;

      yield* search(cwd, { afterPath: "dist/out.js" }).pipe(
        Effect.flatMap((files) =>
          Stream.runForEachWhile(files, () =>
            Effect.sync(() => {
              // More files are waiting than the reader buffers, so git still holds its slot.
              runningWhileRead = runningGitChildren();
              return false;
            }),
          ),
        ),
      );

      assert.equal(runningWhileRead, 1);
      assert.equal(runningGitChildren(), 0);
    }),
  );
});
