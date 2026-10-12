#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkBundleBudgets, formatBundleBudgetReport } from "./bundleBudget.ts";
import { compareBenchmarks } from "./comparison.ts";
import { compareGitRefs } from "./gitComparison.ts";
import {
  DEFAULT_BUNDLE_BUDGET_POLICY,
  DEFAULT_COMPARISON_POLICY,
  type ComparisonPolicy,
  type PerfScenarioConfig,
} from "./model.ts";
import { writeBenchmarkArtifacts } from "./report.ts";
import { defaultScenarioConfig, runCheckoutBenchmark } from "./runner.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const KNOWN_OPTIONS = new Set([
  "base",
  "candidate",
  "url",
  "profile",
  "iterations",
  "idle-ms",
  "hidden-idle-ms",
  "offline-ms",
  "reconnect-timeout-ms",
  "fixture-home",
  "cpu-profile",
  "target-path",
  "ready-selector",
  "source-control-discovery-timeout-ms",
  "source-control-active-ms",
  "source-control-hidden-ms",
  "source-control-settled-ms",
  "source-control-status-rows",
  "output",
  "policy",
  "dist",
  "help",
]);

interface ParsedArgs {
  readonly command: "smoke" | "run" | "compare-refs" | "bundle-budget";
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function usage(): string {
  return `Ryco external performance harness

Usage:
  bun scripts/perf/cli.ts smoke [options]
  bun scripts/perf/cli.ts run [options]
  bun scripts/perf/cli.ts compare-refs [options]
  bun scripts/perf/cli.ts bundle-budget [--dist <directory>]

Options:
  --base <ref>                 Baseline ref. Default: origin/main
  --candidate <ref>            Candidate ref. Default: HEAD
  --url <url>                  Measure an already-running application.
  --profile <name>             shell or active-source-control. Default: shell.
  --iterations <count>         Measured iterations. Default: 5 (smoke: 1)
  --idle-ms <ms>               Foreground idle window.
  --hidden-idle-ms <ms>        Background idle window.
  --offline-ms <ms>            Offline duration before recovery.
  --reconnect-timeout-ms <ms>  Recovery deadline.
  --fixture-home <path>        Stopped, sanitized Ryco home copied per iteration
                               (generate one with: bun run perf:fixture-home --out <path>).
  --cpu-profile <directory>    Write a boot CPU profile per iteration (navigation
                               to primary-shell-painted + 5 s) and summarize
                               main-thread self time by source file.
  --target-path <path>         Route opened after pairing.
  --ready-selector <selector>  Visible readiness selector. Default: #root
  --source-control-discovery-timeout-ms <ms>
                               Deadline for the 10s post-push discovery sample.
  --source-control-active-ms <ms>
                               Visible active-check observation window.
  --source-control-hidden-ms <ms>
                               Hidden-document observation window.
  --source-control-settled-ms <ms>
                               Settled-check observation window.
  --source-control-status-rows <count>
                               Continuously animated status rows. Default: 12.
  --output <directory>         Result directory. Default: .perf-results/<timestamp>
  --policy <json-file>         Comparison policy override.
  --dist <directory>           bundle-budget: standard web dist built with
                               RYCO_WEB_SOURCEMAP=hidden. Default: apps/web/dist
  --help                       Show this help.
`;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const first = argv[0] ?? "run";
  if (first === "--help" || first === "-h") {
    return { command: "run", values: new Map(), flags: new Set(["help"]) };
  }
  if (
    first !== "smoke" &&
    first !== "run" &&
    first !== "compare-refs" &&
    first !== "bundle-budget"
  ) {
    throw new Error(`Unknown command '${first}'.\n\n${usage()}`);
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument '${argument}'.`);
    const key = argument.slice(2);
    if (!KNOWN_OPTIONS.has(key)) throw new Error(`Unknown option '--${key}'.`);
    if (key === "help") {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value.`);
    values.set(key, value);
    index += 1;
  }
  return { command: first, values, flags };
}

function positiveInteger(
  values: ReadonlyMap<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive integer.`);
  }
  return parsed;
}

export function scenarioFromArgs(parsed: ParsedArgs): PerfScenarioConfig {
  const defaults = defaultScenarioConfig(parsed.command === "smoke");
  const fixtureHome = parsed.values.get("fixture-home");
  const cpuProfileDir = parsed.values.get("cpu-profile");
  const profile = parsed.values.get("profile") ?? defaults.profile;
  if (profile !== "shell" && profile !== "active-source-control") {
    throw new Error("--profile must be 'shell' or 'active-source-control'.");
  }
  return {
    profile,
    iterations: positiveInteger(parsed.values, "iterations", defaults.iterations),
    idleMs: positiveInteger(parsed.values, "idle-ms", defaults.idleMs),
    hiddenIdleMs: positiveInteger(parsed.values, "hidden-idle-ms", defaults.hiddenIdleMs),
    offlineMs: positiveInteger(parsed.values, "offline-ms", defaults.offlineMs),
    reconnectTimeoutMs: positiveInteger(
      parsed.values,
      "reconnect-timeout-ms",
      defaults.reconnectTimeoutMs,
    ),
    readySelector: parsed.values.get("ready-selector") ?? defaults.readySelector,
    targetPath: parsed.values.get("target-path") ?? defaults.targetPath,
    fixtureHome: fixtureHome ? path.resolve(fixtureHome) : defaults.fixtureHome,
    cpuProfileDir: cpuProfileDir ? path.resolve(cpuProfileDir) : defaults.cpuProfileDir,
    sourceControlDiscoveryTimeoutMs: positiveInteger(
      parsed.values,
      "source-control-discovery-timeout-ms",
      defaults.sourceControlDiscoveryTimeoutMs,
    ),
    sourceControlActiveMs: positiveInteger(
      parsed.values,
      "source-control-active-ms",
      defaults.sourceControlActiveMs,
    ),
    sourceControlHiddenMs: positiveInteger(
      parsed.values,
      "source-control-hidden-ms",
      defaults.sourceControlHiddenMs,
    ),
    sourceControlSettledMs: positiveInteger(
      parsed.values,
      "source-control-settled-ms",
      defaults.sourceControlSettledMs,
    ),
    sourceControlStatusRows: positiveInteger(
      parsed.values,
      "source-control-status-rows",
      defaults.sourceControlStatusRows,
    ),
  };
}

function outputDirectory(values: ReadonlyMap<string, string>): string {
  const configured = values.get("output");
  if (configured) return path.resolve(configured);
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".perf-results", timestamp);
}

function currentRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

function readPolicy(policyPath: string | undefined): ComparisonPolicy {
  if (!policyPath) return DEFAULT_COMPARISON_POLICY;
  const parsed = JSON.parse(
    readFileSync(path.resolve(policyPath), "utf8"),
  ) as Partial<ComparisonPolicy>;
  return {
    ...DEFAULT_COMPARISON_POLICY,
    ...parsed,
    metrics: { ...DEFAULT_COMPARISON_POLICY.metrics, ...parsed.metrics },
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.has("help")) {
    console.log(usage());
    return;
  }
  if (parsed.command === "bundle-budget") {
    const distDir = path.resolve(parsed.values.get("dist") ?? path.join(repoRoot, "apps/web/dist"));
    const report = checkBundleBudgets(distDir, DEFAULT_BUNDLE_BUDGET_POLICY);
    console.log(formatBundleBudgetReport(report));
    if (report.violations.length > 0) process.exitCode = 1;
    return;
  }
  const scenario = scenarioFromArgs(parsed);
  const outputDir = outputDirectory(parsed.values);

  if (parsed.command === "compare-refs") {
    const { baseline, candidate } = await compareGitRefs({
      repoRoot,
      baselineRef: parsed.values.get("base") ?? "origin/main",
      candidateRef: parsed.values.get("candidate") ?? "HEAD",
      scenario,
    });
    const comparison = compareBenchmarks(
      baseline,
      candidate,
      readPolicy(parsed.values.get("policy")),
    );
    writeBenchmarkArtifacts({ outputDir, baseline, candidate, comparison });
    console.log(`Performance comparison: ${comparison.passed ? "PASS" : "FAIL"}`);
    console.log(`Report: ${path.join(outputDir, "comparison.md")}`);
    if (!comparison.passed) process.exitCode = 1;
    return;
  }

  const externalUrl = parsed.values.get("url");
  const result = await runCheckoutBenchmark({
    repoRoot,
    label: parsed.command === "smoke" ? "local-smoke" : "local",
    revision: currentRevision(),
    scenario,
    ...(externalUrl ? { externalUrl } : {}),
  });
  writeBenchmarkArtifacts({ outputDir, candidate: result });
  console.log(`Samples: ${result.samples.length}/${scenario.iterations}`);
  console.log(`Result: ${path.join(outputDir, "result.json")}`);
  if (result.errors.length > 0 || result.samples.some((sample) => sample.errors.length > 0)) {
    process.exitCode = 1;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
