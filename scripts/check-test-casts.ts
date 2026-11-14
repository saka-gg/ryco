/**
 * Ratchet for type-bypassing casts in test code: `as never` and `as unknown as`.
 *
 * Tests that cast fakes and ids this way keep compiling when a service shape or contract changes,
 * so they fail at run time or pass against fakes that no longer match. Each package's count may
 * only fall: this check fails when a package has more than its baseline in
 * `scripts/test-cast-baseline.json`. Prefer brand constructors (`ThreadId.make("thread-1")`) and
 * typed fake builders.
 *
 *   node scripts/check-test-casts.ts            fail if any package grew
 *   node scripts/check-test-casts.ts --update   lower baselines to the current counts (never raises)
 *   node scripts/check-test-casts.ts --reset    write the current counts, raises included
 *
 * Raising a baseline shows up in review as a diff of that file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BASELINE_PATH = "scripts/test-cast-baseline.json";

const TEST_FILE =
  /(?:\.(?:test|spec|browser)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:test|tests|integration|__tests__)\/.*\.[cm]?[jt]sx?$)/u;
const CAST = /\bas\s+never\b|\bas\s+unknown\s+as\b/gu;

export type CastCounts = Readonly<Record<string, number>>;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) && !path.startsWith(".docs/");
}

/** `apps/server/src/x.test.ts` → `apps/server`; a root folder such as `scripts` stands alone. */
export function packageOf(path: string): string {
  const [first, second] = path.split("/");
  return (first === "apps" || first === "packages" || first === "evals") && second
    ? `${first}/${second}`
    : (first ?? path);
}

export function countCasts(source: string): number {
  return source.match(CAST)?.length ?? 0;
}

export function countByPackage(files: ReadonlyArray<{ path: string; source: string }>): CastCounts {
  const counts: Record<string, number> = {};
  for (const { path, source } of files) {
    const count = countCasts(source);
    if (count === 0) continue;
    const pkg = packageOf(path);
    counts[pkg] = (counts[pkg] ?? 0) + count;
  }
  return Object.fromEntries(Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)));
}

export interface RatchetResult {
  readonly grown: ReadonlyArray<{ pkg: string; count: number; baseline: number }>;
  readonly shrunk: ReadonlyArray<{ pkg: string; count: number; baseline: number }>;
}

export function compareToBaseline(counts: CastCounts, baseline: CastCounts): RatchetResult {
  const grown = [];
  const shrunk = [];
  for (const pkg of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const count = counts[pkg] ?? 0;
    const allowed = baseline[pkg] ?? 0;
    if (count > allowed) grown.push({ pkg, count, baseline: allowed });
    else if (count < allowed) shrunk.push({ pkg, count, baseline: allowed });
  }
  return { grown, shrunk };
}

/** Baselines lowered to the current counts; a package that grew keeps its old value. */
export function loweredBaseline(counts: CastCounts, baseline: CastCounts): CastCounts {
  const next: Record<string, number> = {};
  for (const [pkg, allowed] of Object.entries(baseline)) {
    const count = Math.min(counts[pkg] ?? 0, allowed);
    if (count > 0) next[pkg] = count;
  }
  return next;
}

function readTestFiles(root: string): Array<{ path: string; source: string }> {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return listing
    .split("\0")
    .filter((path) => path.length > 0 && isTestFile(path))
    .flatMap((path) => {
      try {
        return [{ path, source: readFileSync(join(root, path), "utf8") }];
      } catch {
        // Listed but deleted in the working tree.
        return [];
      }
    });
}

function main(): void {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const baselinePath = join(root, BASELINE_PATH);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as CastCounts;
  const counts = countByPackage(readTestFiles(root));
  const { grown, shrunk } = compareToBaseline(counts, baseline);

  if (process.argv.includes("--reset")) {
    writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
    process.stdout.write(`test casts: wrote the current counts to ${BASELINE_PATH}\n`);
    return;
  }
  if (process.argv.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify(loweredBaseline(counts, baseline), null, 2)}\n`);
    process.stdout.write(`test casts: lowered ${shrunk.length} baseline(s) in ${BASELINE_PATH}\n`);
    return;
  }
  if (grown.length > 0) {
    process.stderr.write(
      [
        "test casts: `as never` / `as unknown as` grew in test code:",
        ...grown.map(({ pkg, count, baseline }) => `  ${pkg}: ${count} (baseline ${baseline})`),
        'Use brand constructors (ThreadId.make("…")) or a typed fake instead.',
        `Only if a cast is unavoidable, raise the package's number in ${BASELINE_PATH}.`,
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  if (shrunk.length > 0) {
    process.stdout.write(
      `test casts: ${shrunk.length} package(s) below baseline; \`node scripts/check-test-casts.ts --update\` locks that in\n`,
    );
  }
}

if (import.meta.main) main();
