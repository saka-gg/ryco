import { globSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { TestReport } from "./summarize-tests.ts";

// Regenerates the per-file costs the browser shard sequencer balances on
// (apps/web/test/browserShardSequencer.ts) from a few recent main runs:
//
//   gh run download <run-id> --pattern 'browser-test-results-*' --dir <dir>/<run-id>
//   bun scripts/ci/browser-durations.ts <dir>
//
// Stale numbers only unbalance the shards; every file still runs exactly once.

const OUTPUT = fileURLToPath(
  new URL("../../apps/web/test/browserTestDurations.json", import.meta.url),
);

type FileResult = TestReport["testResults"][number] & {
  readonly assertionResults: readonly { readonly status: string }[];
};

export interface BrowserTestReport {
  readonly testResults: readonly FileResult[];
}

/** `src/...` relative to `apps/web`, the root the sequencer resolves files against. */
function webRelativePath(name: string): string | undefined {
  const path = name.replaceAll("\\", "/");
  const marker = path.lastIndexOf("/apps/web/");
  if (marker === -1 || !path.endsWith(".browser.tsx")) return undefined;
  return path.slice(marker + "/apps/web/".length);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Seconds each file occupies its shard, averaged over every report that ran
 * it. The JSON reporter's file times span only its first to last test, so each
 * file also takes the gap since the previous file ended: mostly its own module
 * import, collection, and setup, which differ by seconds between files.
 */
export function browserTestDurations(
  reports: readonly BrowserTestReport[],
): Record<string, number> {
  const samples = new Map<string, number[]>();
  for (const report of reports) {
    // Files that failed to import or skipped every test carry no timing.
    const ran = report.testResults
      .flatMap((result) => {
        const file = webRelativePath(result.name);
        const executed = result.assertionResults.some(
          (test) => test.status === "passed" || test.status === "failed",
        );
        return file && executed ? [{ file, result }] : [];
      })
      .toSorted((left, right) => left.result.startTime - right.result.startTime);
    const gaps = ran
      .slice(1)
      .map(({ result }, index) => Math.max(0, result.startTime - ran[index]!.result.endTime));
    // The first file's lead-in is browser startup, so it gets a typical gap.
    const typicalGap = gaps.length === 0 ? 0 : mean(gaps);
    ran.forEach(({ file, result }, index) => {
      const gap = index === 0 ? typicalGap : gaps[index - 1]!;
      const seconds = (result.endTime - result.startTime + gap) / 1000;
      samples.set(file, [...(samples.get(file) ?? []), seconds]);
    });
  }
  return Object.fromEntries(
    [...samples]
      .map(([file, values]) => [file, Math.round(mean(values) * 100) / 100] as const)
      // Code-unit order keeps the committed file's diffs stable.
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function main(): void {
  const directories = process.argv.slice(2);
  if (directories.length === 0) {
    console.error("Usage: bun scripts/ci/browser-durations.ts <artifact-dir>...");
    process.exit(1);
  }
  const files = directories.flatMap((directory) =>
    globSync("**/results.json", { cwd: directory }).map((file) => resolve(directory, file)),
  );
  const reports = files.map((file) => {
    const report: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray((report as Partial<BrowserTestReport> | null)?.testResults)) {
      throw new Error(`${file} is not a Vitest JSON report.`);
    }
    return report as BrowserTestReport;
  });
  const durations = browserTestDurations(reports);
  const count = Object.keys(durations).length;
  if (count === 0) {
    console.error(`No browser test timings found under ${directories.join(", ")}.`);
    process.exit(1);
  }
  writeFileSync(OUTPUT, `${JSON.stringify(durations, null, 2)}\n`);
  console.log(
    `Wrote ${count} file durations from ${reports.length} reports to ${relative(process.cwd(), OUTPUT)}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
