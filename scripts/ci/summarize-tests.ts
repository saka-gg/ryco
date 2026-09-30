import { appendFileSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TestReport {
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly testResults: readonly {
    readonly name: string;
    readonly startTime: number;
    readonly endTime: number;
  }[];
}

function escapeCell(value: string): string {
  return value.replace(/[|\r\n`]/gu, " ");
}

export function summarizeTests(reports: readonly TestReport[], root: string): string {
  if (reports.length === 0) return "No test reports were produced.\n";
  const total = reports.reduce(
    (counts, report) => ({
      passed: counts.passed + report.numPassedTests,
      failed: counts.failed + report.numFailedTests,
      skipped: counts.skipped + report.numPendingTests,
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );
  const files = reports
    .flatMap((report) => report.testResults)
    .toSorted((left, right) => right.endTime - right.startTime - (left.endTime - left.startTime));
  return [
    "### Test results",
    "",
    `${total.passed} passed · ${total.failed} failed · ${total.skipped} skipped`,
    "",
    "Slowest files by execution time (excludes runner startup and module imports):",
    "",
    "| File | Seconds |",
    "| --- | ---: |",
    ...files.slice(0, 10).map((file) => {
      const name = file.name.startsWith(`${root}/`) ? file.name.slice(root.length + 1) : file.name;
      return `| ${escapeCell(name)} | ${(Math.max(0, file.endTime - file.startTime) / 1000).toFixed(2)} |`;
    }),
    "",
    "Full JSON and JUnit reports are available in the job artifacts.",
    "",
  ].join("\n");
}

function main(): void {
  const files = globSync(
    [
      "apps/**/test-results/results.json",
      "packages/**/test-results/results.json",
      "scripts/test-results/results.json",
    ],
    { exclude: ["**/node_modules/**", "**/dist/**"] },
  );
  const reports = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as TestReport);
  const summary = summarizeTests(reports, process.cwd());
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
