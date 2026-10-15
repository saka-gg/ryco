import { readFileSync } from "node:fs";
import path from "node:path";

import { staticClosure, type BundleGraph } from "./bundleGraph.ts";

/**
 * Import depth of the built web bundle's dynamic imports.
 *
 * The build lets every dynamic import preload its target's whole static
 * closure (`apps/web/src/viteBuild/modulePreload.ts`), so opening a route or a
 * dialog fetches its chunk graph in one parallel round instead of discovering
 * it level by level (3-5 sequential rounds per phase before). A preload map
 * that misses part of the closure brings those rounds back without changing
 * any byte count, so this check reads the maps Vite wrote into each chunk and
 * reports dynamic imports whose target closure is not fully preloaded.
 */

export interface DynamicImportPreload {
  /** The chunk that runs the `import()`. */
  readonly host: string;
  /** The imported chunk. */
  readonly target: string;
  /** Files the import preloads before evaluating `target`. */
  readonly preloaded: ReadonlySet<string>;
}

export interface UncoveredDynamicImport {
  readonly host: string;
  readonly target: string;
  /**
   * Static dependencies of `target` that neither the host's own closure nor
   * the preload map loads: each one is discovered only after its importer
   * downloads, one network round per level.
   */
  readonly missing: ReadonlyArray<string>;
}

export interface UnreadableDynamicImport {
  readonly host: string;
  readonly target: string;
}

export interface PreloadCoverageReport {
  /** Preload-managed `import()` calls the check read. */
  readonly checkedImports: number;
  /**
   * Whether any chunk carries Vite's preload map. A build with maps but no
   * readable import means the output format changed under the parser, and the
   * check would otherwise pass without checking anything.
   */
  readonly hasPreloadMaps: boolean;
  /**
   * Relative `import()` calls in chunks that carry a preload map whose wrapper
   * the parser could not read. Vite wraps every dynamic import of such a chunk,
   * so each one is a format change the check would otherwise skip silently.
   */
  readonly unreadable: ReadonlyArray<UnreadableDynamicImport>;
  readonly uncovered: ReadonlyArray<UncoveredDynamicImport>;
}

const PRELOAD_DEPS_TABLE = /m\.f\s*=\s*(\[[^\]]*\])/;
const RELATIVE_IMPORT = /import\(\s*([`"'])\.\/([^`"']+\.js)\1\s*\)/g;
const PRELOAD_MAP_ARGUMENT = /^\s*(?:__vite__mapDeps\(\[([\d,\s]*)\]\)|\[\s*\])\s*\)/;
/** How far past an `import()` the preload helper's map argument may sit. */
const MAX_WRAPPER_SCAN_CHARS = 4_096;

/**
 * The deps-map argument of the preload helper call that wraps the `import()`
 * spanning `[start, end)`, or `null` when the import is not wrapped. Vite emits
 * three shapes, all `helper(fn, map)`:
 *
 * - `t(()=>import("./x.js"),map)`
 * - `t(()=>import("./x.js").then(e=>e.X),map)` (named-export lazies)
 * - `t(async()=>{let{a}=await import("./x.js");return{a}},map)` (destructured
 *   dynamic imports)
 *
 * Walking forward with a bracket depth finds the helper's argument separator:
 * at the arrow's expression body level (depth 0), or for an awaited import in
 * a block body, right after that body closes (depth -1). The map is
 * `__vite__mapDeps([..])` or `[]`.
 */
function readWrappingPreloadMap(
  source: string,
  start: number,
  end: number,
): RegExpExecArray | null {
  const inBlockBody = /\bawait\s*$/u.test(source.slice(Math.max(0, start - 16), start));
  const separatorDepth = inBlockBody ? -1 : 0;
  let depth = 0;
  const limit = Math.min(source.length, end + MAX_WRAPPER_SCAN_CHARS);
  for (let index = end; index < limit; index += 1) {
    const char = source[index]!;
    if (char === "`" || char === '"' || char === "'") {
      // Skip the literal; the wrappers carry no nested template expressions.
      let close = index + 1;
      while (close < limit && source[close] !== char) {
        close += source[close] === "\\" ? 2 : 1;
      }
      index = close;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth < separatorDepth || (depth < 0 && char !== "}")) return null;
    } else if (char === "," && depth === separatorDepth) {
      return PRELOAD_MAP_ARGUMENT.exec(source.slice(index + 1, index + 1 + MAX_WRAPPER_SCAN_CHARS));
    } else if (char === ";" && depth === 0 && !inBlockBody) {
      // The import's own statement ended outside any wrapper.
      return null;
    }
  }
  return null;
}

/**
 * The relative dynamic imports of one chunk: those wrapped by Vite's preload
 * helper, with the files each preloads, and the targets of the others.
 */
function readChunkDynamicImports(
  host: string,
  source: string,
): {
  readonly preloads: ReadonlyArray<DynamicImportPreload>;
  readonly unwrapped: ReadonlyArray<string>;
} {
  const table = PRELOAD_DEPS_TABLE.exec(source)?.[1];
  const files: ReadonlyArray<string> = table ? (JSON.parse(table) as string[]) : [];
  const preloads: DynamicImportPreload[] = [];
  const unwrapped: string[] = [];
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const target = match[2]!;
    const map = readWrappingPreloadMap(source, match.index, match.index + match[0].length);
    if (!map) {
      unwrapped.push(target);
      continue;
    }
    const indices = (map[1] ?? "")
      .split(",")
      .map((index) => index.trim())
      .filter((index) => index.length > 0)
      .map(Number);
    const preloaded = new Set<string>();
    for (const index of indices) {
      const file = files[index];
      // Map entries are base-relative (`assets/x.js`); chunks import siblings.
      if (file?.endsWith(".js")) preloaded.add(path.posix.basename(file));
    }
    preloads.push({ host, target, preloaded });
  }
  return { preloads, unwrapped };
}

/**
 * Dynamic imports wrapped by Vite's preload helper in one chunk, with the
 * files each preloads. Imports without the helper (worker chunks, imports Vite
 * left alone) are not listed: nothing preloads for them by design.
 */
export function parseDynamicImportPreloads(
  host: string,
  source: string,
): ReadonlyArray<DynamicImportPreload> {
  return readChunkDynamicImports(host, source).preloads;
}

/** Every preload-managed dynamic import whose target closure is not fully preloaded. */
export function checkPreloadCoverage(graph: BundleGraph, assetsDir: string): PreloadCoverageReport {
  const closures = new Map<string, ReadonlySet<string>>();
  const closureOf = (file: string) => {
    let closure = closures.get(file);
    if (!closure) {
      closure = staticClosure(graph, file);
      closures.set(file, closure);
    }
    return closure;
  };
  let checkedImports = 0;
  let hasPreloadMaps = false;
  const unreadable: UnreadableDynamicImport[] = [];
  const uncovered: UncoveredDynamicImport[] = [];
  for (const host of graph.keys()) {
    const source = readFileSync(path.join(assetsDir, host), "utf8");
    if (!source.includes("import(")) continue;
    const { preloads, unwrapped } = readChunkDynamicImports(host, source);
    if (PRELOAD_DEPS_TABLE.test(source)) {
      hasPreloadMaps = true;
      // Vite wraps every dynamic import of a chunk it writes a map into.
      for (const target of unwrapped) unreadable.push({ host, target });
    }
    for (const preload of preloads) {
      checkedImports += 1;
      if (!graph.has(preload.target)) continue;
      const loaded = closureOf(host);
      const missing = [...closureOf(preload.target)].filter(
        (file) => file !== preload.target && !loaded.has(file) && !preload.preloaded.has(file),
      );
      if (missing.length > 0) {
        uncovered.push({ host, target: preload.target, missing: missing.toSorted() });
      }
    }
  }
  return { checkedImports, hasPreloadMaps, unreadable, uncovered };
}
