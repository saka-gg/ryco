import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  VcsProcessExitError,
  type ProjectSearchContentInput,
  type ProjectSearchContentResult,
} from "@ryco/contracts";

import type {
  VcsDriverShape,
  VcsWorkspaceContentFile,
  VcsWorkspaceContentSearchOptions,
} from "../../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { configureTestGitCommitIdentity } from "../../vcs/testing/GitTestRepo.ts";
import { WorkspaceContentSearch } from "../Services/WorkspaceContentSearch.ts";
import { WorkspaceEntries, type WorkspaceSearchFiles } from "../Services/WorkspaceEntries.ts";
import { WorkspaceAccessPolicyLayer } from "./WorkspaceAccessPolicy.ts";
import { makeContentSearchPage, WorkspaceContentSearchLive } from "./WorkspaceContentSearch.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

type StreamMatches = NonNullable<VcsDriverShape["streamWorkspaceContentMatches"]>;

/** Every root is a folder outside any VCS. */
const NoVcsLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
  detect: () => Effect.succeed(null),
});

/** Every root is a git checkout whose `git grep` is `streamMatches`. */
const gitSearchLayer = (streamMatches: StreamMatches) =>
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    // Content search reads nothing else of the handle.
    detect: () =>
      Effect.succeed({
        driver: { streamWorkspaceContentMatches: streamMatches },
      } as unknown as VcsDriverRegistry.VcsDriverHandle),
  });

const withEntries = <E>(
  entries: Layer.Layer<WorkspaceEntries, E, FileSystem.FileSystem | Path.Path>,
  vcs: Layer.Layer<VcsDriverRegistry.VcsDriverRegistry> = NoVcsLayer,
) =>
  WorkspaceContentSearchLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(entries),
    Layer.provide(vcs),
    Layer.provideMerge(NodeServices.layer),
  );

/** The real index over folders outside any VCS, which it walks. */
const IndexedLayer = withEntries(
  WorkspaceEntriesLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
    Layer.provide(NoVcsLayer),
  ),
);

let gitGrepRuns = 0;

/** Real git, counting `git grep` runs. */
const CountingVcsProcessLayer = Layer.effect(
  VcsProcess.VcsProcess,
  Effect.map(Effect.service(VcsProcess.VcsProcess), (real) =>
    VcsProcess.VcsProcess.of({
      ...real,
      withProcess: (input, use) => {
        if (input.args.includes("grep")) gitGrepRuns += 1;
        return real.withProcess(input, use);
      },
    }),
  ),
).pipe(Layer.provide(VcsProcess.layer));

/** The real index and real git. */
const GitLayer = WorkspaceContentSearchLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(
    WorkspaceEntriesLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
    ),
  ),
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provideMerge(CountingVcsProcessLayer),
  Layer.provideMerge(NodeServices.layer),
);

/** An index that lists `files` for every root. */
const listedLayer = (
  files: Effect.Effect<WorkspaceSearchFiles>,
  vcs?: Layer.Layer<VcsDriverRegistry.VcsDriverRegistry>,
) => withEntries(Layer.mock(WorkspaceEntries)({ readSearchFiles: () => files }), vcs);

const makeTempDir = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-content-search-" });
});

const writeFile = Effect.fn(function* (cwd: string, relativePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

const search = (input: Omit<ProjectSearchContentInput, "limit"> & { readonly limit?: number }) =>
  Effect.gen(function* () {
    const contentSearch = yield* WorkspaceContentSearch;
    return yield* contentSearch.search({ limit: 200, ...input });
  });

const linesOf = (result: {
  readonly matches: ReadonlyArray<{ path: string; lineNumber: number }>;
}) => result.matches.map((match) => `${match.path}:${match.lineNumber}`);

/** Every page of a search, from `cursor` on. */
const searchAllPages = (input: ProjectSearchContentInput) =>
  Effect.gen(function* () {
    const pages: ProjectSearchContentResult[] = [];
    let cursor = input.cursor;
    do {
      const page = yield* search({ ...input, ...(cursor === undefined ? {} : { cursor }) });
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return pages;
  });

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    yield* process.run({ operation: "WorkspaceContentSearch.test.git", command: "git", cwd, args });
  });

const gitFile = (path: string, ...lineNumbers: ReadonlyArray<number>): VcsWorkspaceContentFile => ({
  path,
  lines: lineNumbers.map((lineNumber) => ({
    lineNumber,
    text: "needle",
    matchStart: 0,
    cutStart: false,
    cutEnd: false,
  })),
});

describe("WorkspaceContentSearch", () => {
  it.layer(IndexedLayer)("over the workspace index", (it) => {
    it.effect("returns matching lines in path order with line numbers and highlights", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeFile(cwd, "src/b.ts", "const a = 1;\n\nexport const needle = a;\n");
        yield* writeFile(cwd, "README.md", "A needle in the README.\n");
        yield* writeFile(cwd, "notes.txt", "Nothing here.\n");
        yield* writeFile(cwd, "node_modules/pkg/index.js", "needle\n");

        const result = yield* search({ cwd, query: "needle" });

        expect(linesOf(result)).toEqual(["README.md:1", "src/b.ts:3"]);
        expect(result.matches[1]).toEqual({
          path: "src/b.ts",
          lineNumber: 3,
          preview: "export const needle = a;",
          ranges: [{ start: 13, end: 19 }],
        });
        expect(result.nextCursor).toBeUndefined();
        expect(result.timedOut).toBeUndefined();
        expect(result.partial).toBeUndefined();
      }),
    );

    it.effect("applies match case and whole word", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeFile(cwd, "a.ts", "Needle\nneedle\nneedles\n");

        expect(linesOf(yield* search({ cwd, query: "needle" }))).toEqual([
          "a.ts:1",
          "a.ts:2",
          "a.ts:3",
        ]);
        expect(linesOf(yield* search({ cwd, query: "needle", caseSensitive: true }))).toEqual([
          "a.ts:2",
          "a.ts:3",
        ]);
        expect(linesOf(yield* search({ cwd, query: "needle", wholeWord: true }))).toEqual([
          "a.ts:1",
          "a.ts:2",
        ]);
      }),
    );

    it.effect("skips binary files and files too large to preview", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeFile(cwd, "binary.dat", "needle\0\n");
        yield* writeFile(cwd, "large.txt", `needle\n${"x".repeat(512 * 1024)}`);
        yield* writeFile(cwd, "small.txt", "needle\n");

        expect(linesOf(yield* search({ cwd, query: "needle" }))).toEqual(["small.txt:1"]);
      }),
    );

    it.effect("caps matches per file and pages whole files after the cursor", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeFile(cwd, "a.txt", "needle\n".repeat(150));
        yield* writeFile(cwd, "b.txt", "needle\n".repeat(10));
        yield* writeFile(cwd, "c.txt", "needle\n".repeat(10));

        // a.txt is capped at 100; b.txt would overflow the page, so it starts the next one.
        const first = yield* search({ cwd, query: "needle", limit: 105 });
        expect(first.matches).toHaveLength(100);
        expect(new Set(first.matches.map((match) => match.path))).toEqual(new Set(["a.txt"]));
        expect(first.nextCursor).toBe("v1:a.txt");

        const second = yield* search({
          cwd,
          query: "needle",
          limit: 105,
          ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
        });
        expect(second.matches).toHaveLength(20);
        expect(second.matches[0]?.path).toBe("b.txt");
        expect(second.nextCursor).toBeUndefined();

        // A page the matches fill exactly ends there.
        const exact = yield* search({ cwd, query: "needle", limit: 100 });
        expect(exact.matches).toHaveLength(100);
        expect(exact.nextCursor).toBe("v1:a.txt");
      }),
    );

    it.effect("refuses a cursor it did not issue", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const error = yield* search({ cwd, query: "needle", cursor: "a.txt" }).pipe(Effect.flip);
        expect(error._tag).toBe("WorkspaceContentSearchCursorError");
        expect(error.message).toBe("This search can't continue. Search again.");
      }),
    );

    it.effect("fails for a missing workspace root", () =>
      Effect.gen(function* () {
        const error = yield* search({ cwd: "/definitely/not/a/workspace", query: "needle" }).pipe(
          Effect.flip,
        );
        expect(error._tag).toBe("WorkspaceContentSearchError");
      }),
    );
  });

  it.effect("never reads through a link and skips paths the Files panel cannot open", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeTempDir();
      const outside = yield* makeTempDir();
      yield* writeFile(outside, "secret.txt", "needle\n");
      yield* fileSystem.symlink(`${outside}/secret.txt`, `${cwd}/link.txt`);
      yield* writeFile(cwd, " padded.txt", "needle\n");
      yield* writeFile(cwd, "real.txt", "needle\n");

      const result = yield* search({ cwd, query: "needle" }).pipe(
        Effect.provide(
          listedLayer(
            Effect.succeed({ paths: [" padded.txt", "link.txt", "real.txt"], partial: true }),
          ),
        ),
      );

      expect(linesOf(result)).toEqual(["real.txt:1"]);
      expect(result.partial).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads through a folder link only when it stays in the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeTempDir();
      const outside = yield* makeTempDir();
      yield* writeFile(outside, "secret.txt", "needle\n");
      yield* writeFile(cwd, "inner/a.txt", "needle\n");
      // As the Files panel opens them: a link to a folder inside the workspace
      // is followed, one that leaves it is not.
      yield* fileSystem.symlink(`${cwd}/inner`, `${cwd}/linked`);
      yield* fileSystem.symlink(outside, `${cwd}/escape`);

      const result = yield* search({ cwd, query: "needle" }).pipe(
        Effect.provide(
          listedLayer(
            Effect.succeed({
              paths: ["escape/secret.txt", "inner/a.txt", "linked/a.txt"],
              partial: false,
            }),
          ),
        ),
      );

      expect(linesOf(result)).toEqual(["inner/a.txt:1", "linked/a.txt:1"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("answers a cold index within the time budget, resuming where it was", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const fresh = yield* search({ cwd, query: "needle" }).pipe(Effect.forkChild);
      const resumed = yield* search({ cwd, query: "needle", cursor: "v1:b.txt" }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust(1_000);

      expect(yield* Fiber.join(fresh)).toEqual({ matches: [], nextCursor: "v1:", timedOut: true });
      expect(yield* Fiber.join(resumed)).toEqual({
        matches: [],
        nextCursor: "v1:b.txt",
        timedOut: true,
      });
    }).pipe(Effect.provide(listedLayer(Effect.never))),
  );
});

describe("WorkspaceContentSearch with git", () => {
  it.layer(GitLayer)("in a git checkout", (it) => {
    it.effect("searches with git grep and finds what scanning the index finds", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* git(cwd, ["init"]);
        yield* configureTestGitCommitIdentity(cwd, git);
        yield* writeFile(cwd, "src/a.ts", "needle one\nNeedle two\n");
        yield* writeFile(cwd, "dist/out.js", "needle bundled\n");
        yield* writeFile(cwd, "words.ts", "needles needle_x (needle)\r\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "init"]);
        yield* writeFile(cwd, ".gitignore", "*.log\n");
        yield* writeFile(cwd, "debug.log", "needle\n");
        yield* writeFile(cwd, "notes.md", "a needle\n");
        yield* writeFile(cwd, "large.txt", `needle\n${"x".repeat(512 * 1024)}`);

        for (const options of [{}, { caseSensitive: true }, { wholeWord: true }]) {
          const input = { cwd, query: "needle", limit: 2, ...options };
          const grepRunsBefore = gitGrepRuns;
          const grepped = yield* searchAllPages(input);
          // git answered every page: a failed or late one switches the rest to scanning.
          expect(gitGrepRuns - grepRunsBefore).toBe(grepped.length);
          const scanned = yield* searchAllPages({ ...input, cursor: "v1s:" });
          expect(gitGrepRuns - grepRunsBefore).toBe(grepped.length);
          expect(grepped.flatMap((page) => page.matches)).toEqual(
            scanned.flatMap((page) => page.matches),
          );
        }
        // Ignored, bundled and too-large files are left out by both.
        expect(linesOf(yield* search({ cwd, query: "needle" }))).toEqual([
          "notes.md:1",
          "src/a.ts:1",
          "src/a.ts:2",
          "words.ts:1",
        ]);
      }),
    );

    it.effect("scans no tracked file whose folder became a link out of the workspace", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const outside = yield* makeTempDir();
        yield* git(cwd, ["init"]);
        yield* configureTestGitCommitIdentity(cwd, git);
        yield* writeFile(cwd, "conf/secret.txt", "tracked needle\n");
        yield* writeFile(cwd, "real.txt", "needle\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "init"]);
        // The index still lists conf/secret.txt; the Files panel refuses to open it.
        yield* writeFile(outside, "secret.txt", "outside needle\n");
        yield* fileSystem.remove(`${cwd}/conf`, { recursive: true });
        yield* fileSystem.symlink(outside, `${cwd}/conf`);

        const grepped = yield* search({ cwd, query: "needle" });
        const scanned = yield* search({ cwd, query: "needle", cursor: "v1s:" });

        expect(linesOf(grepped)).toEqual(["real.txt:1"]);
        expect(scanned).toEqual(grepped);
      }),
    );
  });

  it.effect("keeps git to the files scanning the index would read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeTempDir();
      const outside = yield* makeTempDir();
      yield* writeFile(outside, "secret.txt", "needle\n");
      yield* fileSystem.symlink(outside, `${cwd}/escape`);
      yield* writeFile(cwd, "large.txt", `needle\n${"x".repeat(512 * 1024)}`);
      yield* writeFile(cwd, "real.txt", "needle\n");
      const grep = gitSearchLayer(() =>
        Stream.make(
          gitFile(" padded.txt", 1),
          gitFile("escape/secret.txt", 1),
          gitFile("large.txt", 1),
          gitFile("missing.txt", 1),
          gitFile("node_modules/pkg/index.js", 1),
          gitFile("real.txt", 1),
        ),
      );

      const result = yield* search({ cwd, query: "needle" }).pipe(
        Effect.provide(listedLayer(Effect.die("git grep searched"), grep)),
      );

      expect(result).toEqual({
        matches: [
          { path: "real.txt", lineNumber: 1, preview: "needle", ranges: [{ start: 0, end: 6 }] },
        ],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("scans the index after the last file git finished when git fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      for (const name of ["a.txt", "b.txt", "c.txt"]) yield* writeFile(cwd, name, "needle\n");
      const searches: VcsWorkspaceContentSearchOptions[] = [];
      const failingGrep = gitSearchLayer((_cwd, options) => {
        searches.push(options);
        return Stream.concat(
          Stream.make(gitFile("a.txt", 1)),
          Stream.fail(
            new VcsProcessExitError({
              operation: "test",
              command: "git grep",
              cwd,
              exitCode: 128,
              detail: "git grep exited with code 128.",
            }),
          ),
        );
      });
      const index = Effect.succeed({ paths: ["a.txt", "b.txt", "c.txt"], partial: false });

      const result = yield* search({ cwd, query: "needle", limit: 2 }).pipe(
        Effect.provide(listedLayer(index, failingGrep)),
      );

      expect(linesOf(result)).toEqual(["a.txt:1", "b.txt:1"]);
      // The rest of this search scans too.
      expect(result.nextCursor).toBe("v1s:b.txt");
      expect(searches).toHaveLength(1);
      expect(searches[0]).toMatchObject({ afterPath: "", maxLinesPerFile: 2 });
      expect(searches[0]?.excludedTopLevelNames).toContain("node_modules");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("continues a git page that ran out of time by scanning the index", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      yield* writeFile(cwd, "a.txt", "needle\n");
      yield* writeFile(cwd, "b.txt", "needle\n");
      const stalled = yield* Deferred.make<void>();
      let gitSearches = 0;
      const stallingGrep = gitSearchLayer(() => {
        gitSearches += 1;
        return Stream.concat(
          Stream.make(gitFile("a.txt", 1)),
          Stream.unwrap(Deferred.succeed(stalled, undefined).pipe(Effect.as(Stream.never))),
        );
      });
      const layer = listedLayer(
        Effect.succeed({ paths: ["a.txt", "b.txt"], partial: false }),
        stallingGrep,
      );

      const first = yield* search({ cwd, query: "needle" }).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(stalled);
      yield* TestClock.adjust(1_000);
      const firstPage = yield* Fiber.join(first);
      expect(linesOf(firstPage)).toEqual(["a.txt:1"]);
      expect(firstPage).toMatchObject({ nextCursor: "v1s:a.txt", timedOut: true });

      const nextPage = yield* search({
        cwd,
        query: "needle",
        ...(firstPage.nextCursor === undefined ? {} : { cursor: firstPage.nextCursor }),
      }).pipe(Effect.provide(layer));
      expect(linesOf(nextPage)).toEqual(["b.txt:1"]);
      expect(nextPage.nextCursor).toBeUndefined();
      expect(gitSearches).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("moves on from a git page that found nothing in time", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      for (const cursor of [undefined, "v1:b.txt"]) {
        const started = yield* Deferred.make<void>();
        const silentGrep = gitSearchLayer(() =>
          Stream.unwrap(Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never))),
        );
        const page = yield* search({
          cwd,
          query: "needle",
          ...(cursor === undefined ? {} : { cursor }),
        }).pipe(
          Effect.provide(listedLayer(Effect.die("git grep searched"), silentGrep)),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust(1_000);
        expect(yield* Fiber.join(page)).toEqual({
          matches: [],
          nextCursor: cursor === undefined ? "v1s:" : "v1s:b.txt",
          timedOut: true,
        });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("makeContentSearchPage", () => {
  const match = (path: string, lineNumber: number) => ({
    path,
    lineNumber,
    preview: "needle",
    ranges: [{ start: 0, end: 6 }],
  });

  it("resumes a timed-out page after the last file it scanned, matches or not", () => {
    const page = makeContentSearchPage("", 10);
    expect(page.add({ path: "a.ts", matches: [match("a.ts", 1)] })).toBe(true);
    expect(page.add({ path: "b.ts", matches: [] })).toBe(true);
    expect(page.result({ timedOut: true, partial: false, scanIndex: false })).toEqual({
      matches: [match("a.ts", 1)],
      nextCursor: "v1:b.ts",
      timedOut: true,
    });
    expect(page.result({ timedOut: true, partial: false, scanIndex: true }).nextCursor).toBe(
      "v1s:b.ts",
    );
  });

  it("takes an oversized first file whole so every page moves on", () => {
    const page = makeContentSearchPage("a.ts", 1);
    expect(page.add({ path: "b.ts", matches: [match("b.ts", 1), match("b.ts", 2)] })).toBe(false);
    expect(page.result({ timedOut: false, partial: false, scanIndex: false }).nextCursor).toBe(
      "v1:b.ts",
    );
  });

  it("ends without a cursor when the files run out", () => {
    const page = makeContentSearchPage("a.ts", 10);
    page.add({ path: "b.ts", matches: [match("b.ts", 1)] });
    expect(page.result({ timedOut: false, partial: false, scanIndex: false })).toEqual({
      matches: [match("b.ts", 1)],
    });
  });
});
