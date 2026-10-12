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

export interface PreloadCoverageReport {
  /** Preload-managed `import()` calls the check read. */
  readonly checkedImports: number;
  /**
   * Whether any chunk carries Vite's preload map. A build with maps but no
   * readable import means the output format changed under the parser, and the
   * check would otherwise pass without checking anything.
   */
  readonly hasPreloadMaps: boolean;
  readonly uncovered: ReadonlyArray<UncoveredDynamicImport>;
}

const PRELOAD_DEPS_TABLE = /m\.f\s*=\s*(\[[^\]]*\])/;
const PRELOADED_IMPORT =
  /import\(\s*[`"']\.\/([^`"']+\.js)[`"']\s*\)\s*,\s*(?:__vite__mapDeps\(\[([\d,\s]*)\]\)|\[\s*\])/g;

/**
 * Dynamic imports wrapped by Vite's preload helper in one chunk, with the
 * files each preloads. Imports without the helper (worker chunks, imports Vite
 * left alone) are not listed: nothing preloads for them by design.
 */
export function parseDynamicImportPreloads(
  host: string,
  source: string,
): ReadonlyArray<DynamicImportPreload> {
  const table = PRELOAD_DEPS_TABLE.exec(source)?.[1];
  const files: ReadonlyArray<string> = table ? (JSON.parse(table) as string[]) : [];
  const imports: DynamicImportPreload[] = [];
  for (const match of source.matchAll(PRELOADED_IMPORT)) {
    const target = match[1]!;
    const indices = (match[2] ?? "")
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
    imports.push({ host, target, preloaded });
  }
  return imports;
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
  const uncovered: UncoveredDynamicImport[] = [];
  for (const host of graph.keys()) {
    const source = readFileSync(path.join(assetsDir, host), "utf8");
    if (!source.includes("import(")) continue;
    if (PRELOAD_DEPS_TABLE.test(source)) hasPreloadMaps = true;
    for (const preload of parseDynamicImportPreloads(host, source)) {
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
  return { checkedImports, hasPreloadMaps, uncovered };
}
