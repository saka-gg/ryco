import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * The static-import graph of a built web bundle (`apps/web/dist/assets`).
 *
 * A chunk's static closure is what the browser must download and evaluate
 * before that chunk runs; dynamic imports start new closures. Sources come from
 * the chunk's sourcemap (`RYCO_WEB_SOURCEMAP=hidden` builds emit them next to
 * the chunks without referencing them), so a guard can ask which modules a
 * closure carries rather than only how large it is.
 */

export interface BundleChunk {
  readonly file: string;
  readonly staticImports: ReadonlyArray<string>;
  readonly dynamicImports: ReadonlyArray<string>;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

export type BundleGraph = ReadonlyMap<string, BundleChunk>;

export interface ClosureSize {
  readonly files: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

const STATIC_IMPORT =
  /(?:^|[;\s}])(?:import|export)\s*(?:[^"'();]*?\s*from\s*)?["']\.\/([^"']+\.js)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']\.\/([^"']+\.js)["']\s*\)/g;

export function parseChunkImports(source: string): {
  readonly staticImports: ReadonlyArray<string>;
  readonly dynamicImports: ReadonlyArray<string>;
} {
  const staticImports = new Set<string>();
  for (const match of source.matchAll(STATIC_IMPORT)) {
    if (match[1]) staticImports.add(match[1]);
  }
  const dynamicImports = new Set<string>();
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    if (match[1] && !staticImports.has(match[1])) dynamicImports.add(match[1]);
  }
  return { staticImports: [...staticImports], dynamicImports: [...dynamicImports] };
}

export function readBundleGraph(assetsDir: string): BundleGraph {
  const graph = new Map<string, BundleChunk>();
  for (const file of readdirSync(assetsDir).toSorted()) {
    if (!file.endsWith(".js")) continue;
    const bytes = readFileSync(path.join(assetsDir, file));
    graph.set(file, {
      file,
      ...parseChunkImports(bytes.toString("utf8")),
      rawBytes: bytes.byteLength,
      gzipBytes: zlib.gzipSync(bytes).byteLength,
    });
  }
  return graph;
}

/** The hashed chunk emitted for `name` (`main` → `main-<hash>.js`). */
export function findChunk(graph: BundleGraph, name: string): string | null {
  return findChunks(graph, name)[0] ?? null;
}

/** Every emitted chunk named `name-<hash>.js`, in graph order. */
export function findChunks(graph: BundleGraph, name: string): readonly string[] {
  const pattern = new RegExp(
    `^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-[\\w-]{6,}\\.js$`,
    "u",
  );
  return [...graph.keys()].filter((file) => pattern.test(file));
}

export function staticClosure(graph: BundleGraph, root: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    const chunk = graph.get(file);
    if (!chunk) continue;
    seen.add(file);
    stack.push(...chunk.staticImports);
  }
  return seen;
}

export function closureSize(graph: BundleGraph, files: Iterable<string>): ClosureSize {
  let count = 0;
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const file of files) {
    const chunk = graph.get(file);
    if (!chunk) continue;
    count += 1;
    rawBytes += chunk.rawBytes;
    gzipBytes += chunk.gzipBytes;
  }
  return { files: count, rawBytes, gzipBytes };
}

/**
 * Repository-relative sources of one chunk from its sourcemap, or `null` when
 * the build emitted none. Installed packages keep their `node_modules/<name>/`
 * suffix (`node_modules/@noble/curves/…`) whatever the package manager layout.
 */
export function readChunkSources(assetsDir: string, file: string): ReadonlyArray<string> | null {
  const mapPath = path.join(assetsDir, `${file}.map`);
  if (!existsSync(mapPath)) return null;
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as { readonly sources?: unknown };
  if (!Array.isArray(map.sources)) return [];
  return map.sources
    .filter((source): source is string => typeof source === "string")
    .map(normalizeSourcePath);
}

/**
 * Sourcemap sources are relative to the map, and the web build always writes
 * its maps to `apps/web/dist/assets`, so resolving against that location yields
 * repository-relative paths even for a dist that was copied elsewhere.
 */
const WEB_ASSETS_DIR = "apps/web/dist/assets";

export function normalizeSourcePath(source: string): string {
  const posix = source.replaceAll("\\", "/");
  const installed = posix.lastIndexOf("node_modules/");
  if (installed >= 0) return posix.slice(installed);
  if (posix.startsWith("/")) return posix;
  return path.posix.normalize(path.posix.join(WEB_ASSETS_DIR, posix));
}
