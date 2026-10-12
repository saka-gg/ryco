import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ProjectFaviconResolver } from "../Services/ProjectFaviconResolver.ts";
import {
  makeProjectFaviconResolverWith,
  ProjectFaviconResolverLive,
} from "./ProjectFaviconResolver.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "ryco-project-favicon-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  describe("readIcon", () => {
    it.effect("prefers well-known favicon files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.readIcon(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved?.path).toContain("favicon.svg");
        expect(Buffer.from(resolved!.bytes).toString()).toBe("<svg>favicon</svg>");
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.readIcon(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved?.path).toContain("public/brand/logo.svg");
        expect(Buffer.from(resolved!.bytes).toString()).toBe("<svg>brand</svg>");
      }),
    );

    it.effect("returns null when no icon is present", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.readIcon(cwd);

        expect(resolved).toBeNull();
      }),
    );
  });
});

describe("makeProjectFaviconResolverWith", () => {
  const icon = (root: string) => ({ path: `${root}/favicon.svg`, bytes: Buffer.from(root) });

  it.effect("resolves concurrent requests in shared children and reuses the answers", () =>
    Effect.gen(function* () {
      const batches: string[][] = [];
      const resolver = yield* makeProjectFaviconResolverWith({
        readFavicons: async (roots) => {
          batches.push([...roots]);
          return roots.map((root) =>
            root.endsWith("-none")
              ? ({ status: "absent" } as const)
              : ({ status: "found", icon: icon(root) } as const),
          );
        },
      });
      const roots = Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0 ? `/p${index}` : `/p${index}-none`,
      );

      const first = yield* Effect.forEach(roots, (root) => resolver.readIcon(root), {
        concurrency: "unbounded",
      });
      expect(first.filter((value) => value !== null)).toHaveLength(10);
      // Far fewer children than projects; none again for reconnects and new tabs.
      expect(batches.length).toBeLessThanOrEqual(2);
      expect(batches.flat().toSorted()).toEqual(roots.toSorted());

      yield* Effect.forEach(roots, (root) => resolver.readIcon(root), {
        concurrency: "unbounded",
      });
      expect(batches.flat()).toHaveLength(20);
    }).pipe(Effect.scoped),
  );

  it.effect("does not remember an unfinished read as a missing icon", () =>
    Effect.gen(function* () {
      let nowMs = 0;
      const batches: string[][] = [];
      const resolver = yield* makeProjectFaviconResolverWith({
        now: () => nowMs,
        readFavicons: async (roots) => {
          batches.push([...roots]);
          // The child stalls on /slow: it and every root after it are unfinished.
          const stallAt = roots.indexOf("/slow");
          return roots.map((root, index) =>
            stallAt >= 0 && index >= stallAt
              ? ({ status: "unavailable" } as const)
              : ({ status: "found", icon: icon(root) } as const),
          );
        },
      });

      const [slow, after] = yield* Effect.all(
        [resolver.readIcon("/slow"), resolver.readIcon("/after")],
        { concurrency: "unbounded" },
      );
      expect(slow).toBeNull();
      // The root behind the stall gets its own child and its icon.
      expect(after?.path).toBe("/after/favicon.svg");

      // The stalled root backs off briefly, then is read again.
      batches.length = 0;
      yield* resolver.readIcon("/slow");
      expect(batches).toEqual([]);
      nowMs += 61_000;
      yield* resolver.readIcon("/slow");
      expect(batches).toEqual([["/slow"]]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps serving after a broken batch and never strands its callers", () =>
    Effect.gen(function* () {
      let calls = 0;
      let breakClock = false;
      const resolver = yield* makeProjectFaviconResolverWith({
        now: () => {
          if (breakClock) {
            breakClock = false;
            throw new Error("clock failed");
          }
          return 0;
        },
        readFavicons: async (roots) => {
          calls += 1;
          if (calls === 1) throw new Error("spawn failed");
          return roots.map((root) => ({ status: "found", icon: icon(root) }) as const);
        },
      });

      // A rejected read is an unfinished one: its caller is answered at once.
      expect(yield* resolver.readIcon("/a")).toBeNull();
      expect((yield* resolver.readIcon("/b"))?.path).toBe("/b/favicon.svg");

      // A defect inside a batch answers its callers too (not at the 30 s
      // deadline), caches nothing for them and leaves the readers running.
      breakClock = true;
      expect(yield* resolver.readIcon("/c")).toBeNull();
      expect((yield* resolver.readIcon("/c"))?.path).toBe("/c/favicon.svg");
      expect((yield* resolver.readIcon("/d"))?.path).toBe("/d/favicon.svg");
    }).pipe(Effect.scoped),
  );
});
