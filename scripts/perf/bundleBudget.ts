import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  closureSize,
  findChunk,
  findChunks,
  readBundleGraph,
  readChunkSources,
  staticClosure,
  type BundleGraph,
  type ClosureSize,
} from "./bundleGraph.ts";
import type {
  BundleBudgetPolicy,
  BundleChunkRule,
  BundleClosureBudget,
  ForbiddenBundleSource,
} from "./model.ts";
import { checkPreloadCoverage } from "./preloadCoverage.ts";

/**
 * Per-closure budgets and forbidden-module rules for the standard web build.
 *
 * Whole-dist totals (`bundleMeasurement.ts`) cannot see a module moving onto the
 * boot path, which is how the boot graph grew by a third without any route file
 * changing. This walks the real chunk graph instead: each budget is the static
 * closure of one chunk, and its sources come from the build's hidden
 * sourcemaps, so a hosted, markdown, or diff module reached through a new
 * static edge fails here with the module and the reason it is excluded.
 */

export interface BundleBudgetViolation {
  readonly closure: string;
  readonly message: string;
}

export interface BundleClosureReport {
  readonly name: string;
  readonly chunk: string | null;
  readonly beyondBoot: boolean;
  readonly size: ClosureSize | null;
  readonly maxGzipBytes: number | null;
}

export interface BundleBudgetReport {
  readonly closures: readonly BundleClosureReport[];
  readonly violations: readonly BundleBudgetViolation[];
}

export function checkBundleBudgets(
  distDir: string,
  policy: BundleBudgetPolicy,
): BundleBudgetReport {
  const assetsDir = path.join(distDir, "assets");
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
    throw new Error(
      `Missing web assets at ${assetsDir}.\nRun: RYCO_WEB_SOURCEMAP=hidden bun run --cwd apps/web build`,
    );
  }
  if (existsSync(path.join(distDir, "service-worker.js"))) {
    throw new Error(
      "This is a hosted-hub build (it ships the PWA service worker). Bundle budgets describe the standard build.",
    );
  }

  const graph = readBundleGraph(assetsDir);
  if (![...graph.keys()].some((file) => existsSync(path.join(assetsDir, `${file}.map`)))) {
    throw new Error(
      `${assetsDir} has no sourcemaps; build with RYCO_WEB_SOURCEMAP=hidden so forbidden-module rules can run.`,
    );
  }
  const bootChunk = findChunk(graph, policy.bootChunk);
  if (!bootChunk) throw new Error(`No '${policy.bootChunk}-*.js' boot chunk in ${assetsDir}.`);
  const boot = staticClosure(graph, bootChunk);
  const sourceCache = new Map<string, ReadonlyArray<string> | null>();
  const sourcesOf = (file: string) => {
    if (!sourceCache.has(file)) sourceCache.set(file, readChunkSources(assetsDir, file));
    return sourceCache.get(file) ?? null;
  };

  const closures: BundleClosureReport[] = [];
  const violations: BundleBudgetViolation[] = [];
  for (const budget of policy.closures) {
    const chunk = findChunk(graph, budget.chunk);
    if (!chunk) {
      closures.push(emptyReport(budget));
      violations.push({
        closure: budget.name,
        message: `No '${budget.chunk}-*.js' chunk was emitted; update the bundle budget policy if it was renamed or merged.`,
      });
      continue;
    }
    const closure = staticClosure(graph, chunk);
    const measured = budget.beyondBoot ? [...closure].filter((file) => !boot.has(file)) : closure;
    const size = closureSize(graph, measured);
    closures.push({
      name: budget.name,
      chunk,
      beyondBoot: budget.beyondBoot,
      size,
      maxGzipBytes: budget.maxGzipBytes,
    });

    if (budget.maxGzipBytes !== null && size.gzipBytes > budget.maxGzipBytes) {
      violations.push({
        closure: budget.name,
        message: `${formatKib(size.gzipBytes)} gzip${budget.beyondBoot ? " beyond boot" : ""} exceeds the ${formatKib(budget.maxGzipBytes)} budget.`,
      });
    }

    if (budget.maxFiles !== undefined && size.files > budget.maxFiles) {
      violations.push({
        closure: budget.name,
        message: `${size.files} JS files${budget.beyondBoot ? " beyond boot" : ""} exceed the ${budget.maxFiles}-file budget; merge or defer the new chunks.`,
      });
    }

    if (budget.forbiddenSources.length === 0) continue;
    // One violation per rule: the first offending module names the edge to
    // cut, the count says how much came with it.
    const hits = new Map<ForbiddenBundleSource, { first: string; chunk: string; count: number }>();
    for (const file of [...closure].toSorted()) {
      // Generated chunks (the bundler runtime, prebuilt vendor chunks) ship
      // without a map; they carry no application modules.
      for (const source of sourcesOf(file) ?? []) {
        const rule = budget.forbiddenSources.find((candidate) => candidate.pattern.test(source));
        if (!rule) continue;
        const hit = hits.get(rule);
        if (hit) hit.count += 1;
        else hits.set(rule, { first: source, chunk: file, count: 1 });
      }
    }
    for (const [rule, hit] of hits) {
      const more = hit.count > 1 ? ` and ${hit.count - 1} more module(s)` : "";
      violations.push({
        closure: budget.name,
        message: `${rule.reason}: ${hit.first}${more} statically reachable (first in ${hit.chunk}).`,
      });
    }
  }
  for (const rule of policy.chunks ?? []) {
    violations.push(...checkChunkRule(graph, assetsDir, rule));
  }
  // Every route, shell and dialog chunk must load in one round: its import()
  // preloads the whole static closure, so no level is discovered late.
  const preloadCoverage = checkPreloadCoverage(graph, assetsDir);
  if (preloadCoverage.hasPreloadMaps && preloadCoverage.checkedImports === 0) {
    violations.push({
      closure: "preload depth",
      message:
        "The build has Vite preload maps but no import() the check can read; update scripts/perf/preloadCoverage.ts for the new output format.",
    });
  }
  for (const unreadable of preloadCoverage.unreadable) {
    violations.push({
      closure: "preload depth",
      message: `import() of ${unreadable.target} from ${unreadable.host} has no preload map the check can read; update scripts/perf/preloadCoverage.ts for the new wrapper shape.`,
    });
  }
  for (const uncovered of preloadCoverage.uncovered) {
    violations.push({
      closure: "preload depth",
      message: `import() of ${uncovered.target} from ${uncovered.host} does not preload ${uncovered.missing.length} static dependency file(s) (first: ${uncovered.missing[0]}); they load one level at a time.`,
    });
  }
  return { closures, violations };
}

function checkChunkRule(
  graph: BundleGraph,
  assetsDir: string,
  rule: BundleChunkRule,
): BundleBudgetViolation[] {
  const matches = findChunks(graph, rule.chunk);
  if (matches.length === 0) {
    return [
      {
        closure: rule.name,
        message: `No '${rule.chunk}-*.js' chunk was emitted; update the bundle budget policy if it was renamed or merged.`,
      },
    ];
  }
  if (matches.length > 1) {
    return [
      {
        closure: rule.name,
        message: `${matches.length} chunks match '${rule.chunk}-*.js' (${matches.join(", ")}); give the rule's chunk a name only one of them carries.`,
      },
    ];
  }
  const chunk = matches[0]!;
  // The chunk's static imports load with it, so a worker that imports a large
  // shared chunk pays for it on every start just as if it were inlined.
  const closure = [...staticClosure(graph, chunk)];
  const violations: BundleBudgetViolation[] = [];
  const { rawBytes } = closureSize(graph, closure);
  if (rule.maxRawBytes !== null && rawBytes > rule.maxRawBytes) {
    violations.push({
      closure: rule.name,
      message: `${chunk} loads ${formatKib(rawBytes)} raw with its static imports (${closure.length} files), over the ${formatKib(rule.maxRawBytes)} budget.`,
    });
  }
  for (const content of rule.forbiddenContent) {
    const carrier = closure.find((file) =>
      content.pattern.test(readFileSync(path.join(assetsDir, file), "utf8")),
    );
    if (carrier === undefined) continue;
    violations.push({
      closure: rule.name,
      message:
        carrier === chunk
          ? `${chunk} carries ${content.reason}.`
          : `${chunk} statically imports ${carrier}, which carries ${content.reason}.`,
    });
  }
  return violations;
}

function emptyReport(budget: BundleClosureBudget): BundleClosureReport {
  return {
    name: budget.name,
    chunk: null,
    beyondBoot: budget.beyondBoot,
    size: null,
    maxGzipBytes: budget.maxGzipBytes,
  };
}

function formatKib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatBundleBudgetReport(report: BundleBudgetReport): string {
  const lines = [
    "# Web bundle budgets",
    "",
    "| Closure | Chunk | Files | Raw | Gzip | Budget |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const closure of report.closures) {
    const scope = closure.beyondBoot ? " (beyond boot)" : "";
    lines.push(
      `| ${closure.name}${scope} | ${closure.chunk ? `\`${closure.chunk}\`` : "missing"} | ${closure.size?.files ?? "-"} | ${closure.size ? formatKib(closure.size.rawBytes) : "-"} | ${closure.size ? formatKib(closure.size.gzipBytes) : "-"} | ${closure.maxGzipBytes === null ? "-" : formatKib(closure.maxGzipBytes)} |`,
    );
  }
  lines.push("");
  if (report.violations.length === 0) {
    lines.push("All budgets and forbidden-module rules pass.");
  } else {
    lines.push(`## ${report.violations.length} violation(s)`, "");
    for (const violation of report.violations) {
      lines.push(`- **${violation.closure}**: ${violation.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
