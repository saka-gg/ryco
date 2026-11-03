import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError, type VcsListWorkspaceFilesResult } from "@ryco/contracts";

import { ServerConfig } from "../../config.ts";
import type { VcsDriverShape, VcsListWorkspaceFilesOptions } from "../../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceAccessPolicyLayer } from "./WorkspaceAccessPolicy.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const EPOCH = DateTime.makeUnsafe(0);

type ListWorkspaceFiles = (
  cwd: string,
  options?: VcsListWorkspaceFilesOptions,
) => Effect.Effect<VcsListWorkspaceFilesResult, VcsProcessExitError>;

function listing(paths: ReadonlyArray<string>, truncated = false): VcsListWorkspaceFilesResult {
  return {
    paths,
    truncated,
    freshness: { source: "live-local", observedAt: EPOCH, expiresAt: Option.none() },
  } as VcsListWorkspaceFilesResult;
}

function makeDriver(listWorkspaceFiles: ListWorkspaceFiles): VcsDriverShape {
  return {
    capabilities: {
      kind: "git",
      supportsWorktrees: true,
      supportsBookmarks: false,
      supportsAtomicSnapshot: false,
      supportsPushDefaultRemote: true,
      ignoreClassifier: "native",
    },
    execute: () =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    detectRepository: () => Effect.succeed(null),
    isInsideWorkTree: () => Effect.succeed(true),
    listWorkspaceFiles,
    listRemotes: () =>
      Effect.succeed({
        remotes: [],
        freshness: { source: "live-local", observedAt: EPOCH, expiresAt: Option.none() },
      }),
    filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
    initRepository: () => Effect.void,
  };
}

/** WorkspaceEntries over a fake checkout whose listing is `listWorkspaceFiles`. */
function makeLayer(listWorkspaceFiles: ListWorkspaceFiles) {
  const driver = makeDriver(listWorkspaceFiles);
  const registry = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    get: () => Effect.succeed(driver),
    detect: (input) =>
      Effect.succeed({
        kind: "git" as const,
        driver,
        repository: {
          kind: "git" as const,
          rootPath: input.cwd,
          metadataPath: null,
          freshness: { source: "live-local" as const, observedAt: EPOCH, expiresAt: Option.none() },
        },
      }),
  });
  return WorkspaceEntriesLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
    Layer.provide(registry),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-workspace-index-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

const makeTempDir = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-workspace-index-" });
});

const search = (cwd: string, query: string, limit = 50) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries;
    return yield* workspaceEntries.search({ cwd, query, limit });
  });

/** Lets background fibers (and real I/O they wait on) make progress. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

describe("WorkspaceEntries index store", () => {
  it.effect("searches every listed file, not an alphabetical prefix of the workspace", () => {
    // 30k files: the previous index kept only the first 25k entries in path
    // order, so everything under later top-level folders was unreachable.
    const paths = Array.from(
      { length: 30_000 },
      (_, index) => `pkg${String(index % 30).padStart(2, "0")}/src/file-${index}.ts`,
    );
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const result = yield* search(cwd, "pkg29/src/file-29999.ts");
      expect(result.entries[0]?.path).toBe("pkg29/src/file-29999.ts");
      expect(result.partial).toBeUndefined();

      const workspaceEntries = yield* WorkspaceEntries;
      const listed = yield* workspaceEntries.listEntries({ cwd });
      // The tree payload stays capped, keeps the shallowest entries first and
      // drops the derivable parent path.
      expect(listed.entries).toHaveLength(25_000);
      expect(listed.truncated).toBe(true);
      expect(listed.entries.slice(0, 30).every((entry) => entry.kind === "directory")).toBe(true);
      expect(listed.entries.some((entry) => "parentPath" in entry)).toBe(false);
    }).pipe(Effect.provide(makeLayer(() => Effect.succeed(listing(paths)))));
  });

  it.effect("ranks the shallowest entries first for an empty query", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const result = yield* search(cwd, "", 4);
      expect(result.entries.map((entry) => entry.path)).toEqual([
        "apps",
        "packages",
        "README.md",
        "apps/web",
      ]);
      expect(result.entries[3]?.parentPath).toBe("apps");
      expect(result.truncated).toBe(true);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.succeed(listing(["apps/web/src/index.ts", "packages/shared/a.ts", "README.md"])),
        ),
      ),
    ),
  );

  it.effect("drops paths under ignored top-level directories and indexes each directory once", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const result = yield* search(cwd, "", 50);
      expect(result.entries.map((entry) => entry.path).toSorted()).toEqual([
        "src",
        "src/a",
        "src/a/one.ts",
        "src/a/two.ts",
        "src/b.ts",
      ]);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.succeed(
            listing(["src/a/one.ts", "src/a/two.ts", "src/b.ts", "dist/out.js", "node_modules/x"]),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "serves the previous index while an invalidated root rebuilds in the background",
    () => {
      let paths = ["src/old.ts"];
      let calls = 0;
      return Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const workspaceEntries = yield* WorkspaceEntries;
        expect((yield* search(cwd, "old")).entries.map((entry) => entry.path)).toContain(
          "src/old.ts",
        );
        expect(calls).toBe(1);

        paths = ["src/old.ts", "src/new.ts"];
        yield* workspaceEntries.invalidate(cwd);

        // The read does not wait for the rebuild it starts: it answers from the
        // previous index.
        expect((yield* search(cwd, "new")).entries).toEqual([]);
        yield* settle;
        expect(calls).toBe(2);
        expect((yield* search(cwd, "new")).entries.map((entry) => entry.path)).toContain(
          "src/new.ts",
        );

        // The debounced rebuild scheduled by the invalidation finds nothing left to do.
        yield* TestClock.adjust(250);
        yield* settle;
        expect(calls).toBe(2);
      }).pipe(
        Effect.provide(
          makeLayer(() =>
            Effect.sync(() => {
              calls += 1;
              return listing(paths);
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "flags search results from an invalidated index and waits for the rebuild in listEntries",
    () => {
      let paths = ["src/old.ts"];
      return Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const workspaceEntries = yield* WorkspaceEntries;
        expect((yield* search(cwd, "old")).refreshing).toBeUndefined();

        paths = ["src/old.ts", "src/new.ts"];
        yield* workspaceEntries.invalidate(cwd);
        expect((yield* search(cwd, "old")).refreshing).toBe(true);

        // The files tree refetches right after a turn: it must see the turn's files.
        const listed = yield* workspaceEntries.listEntries({ cwd });
        expect(listed.entries.map((entry) => entry.path)).toContain("src/new.ts");
        expect((yield* search(cwd, "new")).refreshing).toBeUndefined();
      }).pipe(Effect.provide(makeLayer(() => Effect.sync(() => listing(paths)))));
    },
  );

  it.effect("keeps a cold root's index on invalidation and revalidates it on the next read", () => {
    let paths = ["src/old.ts"];
    let calls = 0;
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      yield* search(cwd, "old");
      expect(calls).toBe(1);

      // A turn that ends long after the last `@` read of this checkout.
      yield* TestClock.adjust(10 * 60_000 + 1);
      paths = ["src/old.ts", "src/new.ts"];
      yield* workspaceEntries.invalidate(cwd);
      yield* TestClock.adjust(250);
      yield* settle;
      // Nobody reads the root, so nothing rebuilds it yet.
      expect(calls).toBe(1);

      // The next `@` answers at once from the kept index, flagged as not final.
      const stale = yield* search(cwd, "old");
      expect(stale.entries.map((entry) => entry.path)).toContain("src/old.ts");
      expect(stale.refreshing).toBe(true);
      yield* settle;
      expect(calls).toBe(2);

      const fresh = yield* search(cwd, "new");
      expect(fresh.entries.map((entry) => entry.path)).toContain("src/new.ts");
      expect(fresh.refreshing).toBeUndefined();
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.sync(() => {
            calls += 1;
            return listing(paths);
          }),
        ),
      ),
    );
  });

  it.effect("keeps a file written into a cold root visible before any rebuild", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      yield* search(cwd, "x");

      yield* TestClock.adjust(10 * 60_000 + 1);
      yield* workspaceEntries.recordFileWrite(cwd, "docs/new-plan.md");
      const result = yield* search(cwd, "new-plan");
      expect(result.entries.map((entry) => entry.path)).toEqual(["docs/new-plan.md"]);
      expect(result.refreshing).toBe(true);
    }).pipe(
      Effect.provide(
        // Rebuilds do not list the file yet (an editor still holds it open, say),
        // so only the kept, patched index can surface it.
        makeLayer(() => Effect.succeed(listing(["src/existing.ts"]))),
      ),
    ),
  );

  it.effect("collapses a burst of invalidations into one background rebuild", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      yield* search(cwd, "a");

      yield* workspaceEntries.invalidate(cwd);
      yield* workspaceEntries.invalidate(cwd);
      yield* workspaceEntries.invalidate(cwd);
      yield* settle;
      expect(calls).toBe(1);

      yield* TestClock.adjust(250);
      yield* settle;
      expect(calls).toBe(2);
      yield* search(cwd, "a");
      yield* settle;
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.sync(() => {
            calls += 1;
            return listing(["a.ts"]);
          }),
        ),
      ),
    );
  });

  it.effect("revalidates an old index in the background instead of blocking the read", () => {
    let paths = ["a.ts"];
    let calls = 0;
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      yield* search(cwd, "a");
      paths = ["a.ts", "b.ts"];

      yield* TestClock.adjust(15_000);
      // Stale but immediate; the refresh it starts lands for the next read.
      expect((yield* search(cwd, "b.ts")).entries).toEqual([]);
      yield* settle;
      expect(calls).toBe(2);
      expect((yield* search(cwd, "b.ts")).entries.map((entry) => entry.path)).toEqual(["b.ts"]);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.sync(() => {
            calls += 1;
            return listing(paths);
          }),
        ),
      ),
    );
  });

  it.effect("adds files written through Ryco to the index before any rebuild", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      yield* search(cwd, "x");

      yield* workspaceEntries.recordFileWrite(cwd, "docs/plans/new-plan.md");
      expect((yield* search(cwd, "new-plan")).entries.map((entry) => entry.path)).toEqual([
        "docs/plans/new-plan.md",
      ]);
      expect((yield* search(cwd, "docs/plans")).entries.map((entry) => entry.path)).toContain(
        "docs/plans",
      );
    }).pipe(
      Effect.provide(
        // Rebuilds never finish, so only the in-place patch can surface the file.
        makeLayer(
          (() => {
            let calls = 0;
            return () =>
              calls++ === 0 ? Effect.succeed(listing(["src/existing.ts"])) : Effect.never;
          })(),
        ),
      ),
    ),
  );

  it.effect("adds only the ancestors of a written file that the index lacks", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      yield* search(cwd, "x");

      yield* workspaceEntries.recordFileWrite(cwd, "docs/plans/a.md");
      const listed = (yield* search(cwd, "", 50)).entries.map((entry) => entry.path);
      expect(listed.toSorted()).toEqual([
        "docs",
        "docs/plans",
        "docs/plans/a.md",
        "docs/readme.md",
      ]);
    }).pipe(
      Effect.provide(
        makeLayer(
          (() => {
            let calls = 0;
            return () =>
              calls++ === 0 ? Effect.succeed(listing(["docs/readme.md"])) : Effect.never;
          })(),
        ),
      ),
    ),
  );

  it.effect("lists every indexed file for content search in UTF-8 byte order", () => {
    const paths = Array.from({ length: 30_000 }, (_, index) => `pkg/file-${index}.ts`);
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      const files = yield* workspaceEntries.readSearchFiles(cwd);
      // The whole index, not the capped listEntries payload; files only.
      expect(files.paths).toHaveLength(30_005);
      expect(files.paths.slice(0, 3)).toEqual(["README.md", "a.ts", "a/b.ts"]);
      expect(files.paths.slice(-2)).toEqual(["\uE000.ts", "😀.ts"]);
      expect(files.paths).not.toContain("dist/out.js");
      expect(files.partial).toBe(false);
      // Memoized until the index changes.
      expect((yield* workspaceEntries.readSearchFiles(cwd)).paths).toBe(files.paths);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.succeed(
            listing(["😀.ts", "a.ts", "\uE000.ts", "a/b.ts", "README.md", "dist/out.js", ...paths]),
          ),
        ),
      ),
    );
  });

  it.effect("answers content search from the current index without waiting for a rebuild", () => {
    let paths = ["src/old.ts"];
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      expect((yield* workspaceEntries.readSearchFiles(cwd)).paths).toEqual(["src/old.ts"]);

      yield* workspaceEntries.recordFileWrite(cwd, "docs/new.md");
      expect((yield* workspaceEntries.readSearchFiles(cwd)).paths).toEqual([
        "docs/new.md",
        "src/old.ts",
      ]);

      paths = ["src/old.ts", "src/new.ts"];
      yield* workspaceEntries.invalidate(cwd);
      // Unlike listEntries, it never waits for the pending rebuild.
      expect((yield* workspaceEntries.readSearchFiles(cwd)).paths).not.toContain("src/new.ts");
    }).pipe(
      Effect.provide(
        // Rebuilds never finish, so a read that waited for one would hang.
        makeLayer(
          (() => {
            let calls = 0;
            return () => (calls++ === 0 ? Effect.sync(() => listing(paths)) : Effect.never);
          })(),
        ),
      ),
    );
  });

  it.effect("runs one build for concurrent cold reads of a root", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      const [searched, listed] = yield* Effect.all(
        [search(cwd, "a"), workspaceEntries.listEntries({ cwd })],
        { concurrency: "unbounded" },
      );
      expect(searched.entries.map((entry) => entry.path)).toEqual(["a.ts"]);
      expect(listed.entries.map((entry) => entry.path)).toEqual(["a.ts"]);
      expect(calls).toBe(1);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.yieldNow.pipe(
            Effect.andThen(
              Effect.sync(() => {
                calls += 1;
                return listing(["a.ts"]);
              }),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("does not rebuild after a save of a file the index already lists", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const workspaceEntries = yield* WorkspaceEntries;
      yield* search(cwd, "x");

      yield* workspaceEntries.recordFileWrite(cwd, "src/existing.ts");
      yield* TestClock.adjust(250);
      yield* settle;
      yield* search(cwd, "x");
      yield* settle;
      expect(calls).toBe(1);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.sync(() => {
            calls += 1;
            return listing(["src/existing.ts"]);
          }),
        ),
      ),
    );
  });

  it.effect("serves tracked files when the full listing misses the cold-build deadline", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const pending = yield* Effect.forkChild(search(cwd, "tracked"));
      yield* settle;
      yield* TestClock.adjust(4_000);
      yield* settle;
      const result = yield* Fiber.join(pending);
      expect(result.entries.map((entry) => entry.path)).toEqual(["tracked.ts"]);
      expect(result.partial).toBe(true);
      expect(result.truncated).toBe(true);
      // The full build still runs and will replace the stand-in: not final.
      expect(result.refreshing).toBe(true);
      const again = yield* search(cwd, "tracked");
      expect(again.refreshing).toBe(true);
    }).pipe(
      Effect.provide(
        makeLayer((_cwd, options) =>
          options?.trackedOnly ? Effect.succeed(listing(["tracked.ts"])) : Effect.never,
        ),
      ),
    ),
  );

  it.effect("stops flagging the stand-in once the full listing lands", () => {
    const release = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const pending = yield* Effect.forkChild(search(cwd, "ts"));
      yield* settle;
      yield* TestClock.adjust(4_000);
      yield* settle;
      expect((yield* Fiber.join(pending)).refreshing).toBe(true);

      yield* Deferred.succeed(release, undefined);
      yield* settle;
      const settled = yield* search(cwd, "ts");
      expect(settled.entries.map((entry) => entry.path).toSorted()).toEqual([
        "tracked.ts",
        "untracked.ts",
      ]);
      expect(settled.partial).toBeUndefined();
      expect(settled.refreshing).toBeUndefined();
    }).pipe(
      Effect.provide(
        makeLayer((_cwd, options) =>
          options?.trackedOnly
            ? Effect.succeed(listing(["tracked.ts"]))
            : Deferred.await(release).pipe(Effect.as(listing(["tracked.ts", "untracked.ts"]))),
        ),
      ),
    );
  });

  it.effect("falls back to tracked files when the full listing fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const result = yield* search(cwd, "tracked");
      expect(result.entries.map((entry) => entry.path)).toEqual(["tracked.ts"]);
      expect(result.partial).toBe(true);
      // The fallback is the build's final answer, so clients may cache it.
      expect(result.refreshing).toBeUndefined();
    }).pipe(
      Effect.provide(
        makeLayer((cwd, options) =>
          options?.trackedOnly
            ? Effect.succeed(listing(["tracked.ts"]))
            : Effect.fail(
                new VcsProcessExitError({
                  operation: "test",
                  command: "git ls-files",
                  cwd,
                  exitCode: 128,
                  detail: "boom",
                }),
              ),
        ),
      ),
    ),
  );

  it.effect("reports a failed build without retrying it on every keystroke", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      const first = yield* search(cwd, "a").pipe(Effect.flip);
      expect(first.detail).toContain("boom");
      const callsAfterFirst = calls;

      const second = yield* search(cwd, "ab").pipe(Effect.flip);
      expect(second.detail).toContain("boom");
      expect(calls).toBe(callsAfterFirst);

      yield* TestClock.adjust(5_000);
      yield* search(cwd, "abc").pipe(Effect.flip);
      expect(calls).toBeGreaterThan(callsAfterFirst);
    }).pipe(
      Effect.provide(
        makeLayer((cwd) =>
          Effect.suspend(() => {
            calls += 1;
            return Effect.fail(
              new VcsProcessExitError({
                operation: "test",
                command: "git ls-files",
                cwd,
                exitCode: 128,
                detail: "boom",
              }),
            );
          }),
        ),
      ),
    );
  });

  it.effect("keeps the shallowest files past the entry cap without blocking the event loop", () => {
    // 1k top-level files plus 210k files two levels down: over the 200k cap.
    const topLevel = Array.from({ length: 1_000 }, (_, index) => `top-${index}.ts`);
    const nested = Array.from(
      { length: 210_000 },
      (_, index) => `pkg${index % 50}/src${index % 7}/file-${index}.ts`,
    );
    let building = false;
    let ticksWhileBuilding = 0;
    return Effect.gen(function* () {
      const cwd = yield* makeTempDir();
      // Counts the turns other fibers get while the listing is indexed.
      const ticker = yield* Effect.forkChild(
        Effect.forever(
          Effect.yieldNow.pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (building) ticksWhileBuilding += 1;
              }),
            ),
          ),
        ),
      );
      const result = yield* search(cwd, "", 300_000);
      building = false;
      yield* Fiber.interrupt(ticker);

      expect(result.partial).toBe(true);
      expect(result.entries.length).toBeLessThanOrEqual(200_000);
      const indexed = new Set(result.entries.map((entry) => entry.path));
      expect(topLevel.filter((filePath) => !indexed.has(filePath))).toEqual([]);
      const packages = Array.from({ length: 50 }, (_, pkg) => `pkg${pkg}`);
      expect(packages.filter((directoryPath) => !indexed.has(directoryPath))).toEqual([]);
      // Every kept file comes with its ancestor directories.
      const orphans = result.entries.filter(
        (entry) =>
          entry.parentPath !== undefined &&
          (!indexed.has(entry.parentPath) || !indexed.has(entry.parentPath.split("/")[0] ?? "")),
      );
      expect(orphans).toEqual([]);
      // The per-path pass, the over-cap selection and the entry construction
      // each yield between chunks, not only the per-path pass (which alone
      // gives the ticker about 5 turns here).
      expect(ticksWhileBuilding).toBeGreaterThanOrEqual(12);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.sync(() => {
            building = true;
            return listing([...topLevel, ...nested]);
          }),
        ),
      ),
    );
  });

  it.effect("drops the least recently read roots past the entry budget", () => {
    const calls = new Map<string, number>();
    const bigListing = Array.from({ length: 120_000 }, (_, index) => `f${index}.ts`);
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = yield* makeTempDir();
      const fileSystem = yield* FileSystem.FileSystem;
      const roots = ["one", "two", "three"].map((name) => path.join(base, name));
      for (const root of roots) yield* fileSystem.makeDirectory(root);

      for (const root of roots) {
        yield* TestClock.adjust(1);
        yield* search(root, "f1");
      }
      // 3 x 120k entries exceed the 300k budget: the first root was dropped
      // and rebuilds on its next read, while the latest one stays warm.
      yield* search(roots[2]!, "f2");
      yield* search(roots[0]!, "f2");
      expect(calls.get("three")).toBe(1);
      expect(calls.get("one")).toBe(2);
    }).pipe(
      Effect.provide(
        makeLayer((cwd) =>
          Effect.sync(() => {
            const name = cwd.slice(cwd.lastIndexOf("/") + 1);
            calls.set(name, (calls.get(name) ?? 0) + 1);
            return listing(bigListing);
          }),
        ),
      ),
    );
  });
});
