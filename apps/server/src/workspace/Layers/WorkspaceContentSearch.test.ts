import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";

import type { ProjectSearchContentInput } from "@ryco/contracts";

import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import { WorkspaceContentSearch } from "../Services/WorkspaceContentSearch.ts";
import { WorkspaceEntries, type WorkspaceSearchFiles } from "../Services/WorkspaceEntries.ts";
import { WorkspaceAccessPolicyLayer } from "./WorkspaceAccessPolicy.ts";
import { makeContentSearchPage, WorkspaceContentSearchLive } from "./WorkspaceContentSearch.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const withEntries = <E>(
  entries: Layer.Layer<WorkspaceEntries, E, FileSystem.FileSystem | Path.Path>,
) =>
  WorkspaceContentSearchLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(entries),
    Layer.provideMerge(NodeServices.layer),
  );

/** The real index over folders outside any VCS, which it walks. */
const IndexedLayer = withEntries(
  WorkspaceEntriesLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
    ),
  ),
);

/** An index that lists `files` for every root. */
const listedLayer = (files: Effect.Effect<WorkspaceSearchFiles>) =>
  withEntries(Layer.mock(WorkspaceEntries)({ readSearchFiles: () => files }));

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
    expect(page.result({ timedOut: true, partial: false })).toEqual({
      matches: [match("a.ts", 1)],
      nextCursor: "v1:b.ts",
      timedOut: true,
    });
  });

  it("takes an oversized first file whole so every page moves on", () => {
    const page = makeContentSearchPage("a.ts", 1);
    expect(page.add({ path: "b.ts", matches: [match("b.ts", 1), match("b.ts", 2)] })).toBe(false);
    expect(page.result({ timedOut: false, partial: false }).nextCursor).toBe("v1:b.ts");
  });

  it("ends without a cursor when the files run out", () => {
    const page = makeContentSearchPage("a.ts", 10);
    page.add({ path: "b.ts", matches: [match("b.ts", 1)] });
    expect(page.result({ timedOut: false, partial: false })).toEqual({
      matches: [match("b.ts", 1)],
    });
  });
});
