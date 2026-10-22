#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkBundleBudgets, formatBundleBudgetReport } from "./bundleBudget.ts";
import { compareBenchmarks } from "./comparison.ts";
import { startDelayProxy } from "./delayProxy.ts";
import { compareGitRefs } from "./gitComparison.ts";
import {
  DEFAULT_HUB_EVENT,
  DEFAULT_HUB_ROUTE,
  discoverNodeDirs,
  formatCorrelationTable,
  runHostedCorrelate,
  type HostedCorrelateOptions,
} from "./hostedCorrelate.ts";
import { runHostedFixture, type HostedFixtureOptions } from "./hostedFixture.ts";
import {
  formatComparisonTable,
  runHostedColdLoad,
  runHostedCompare,
  runHostedSwitch,
  type HostedColdLoadOptions,
  type HostedProbeBaseOptions,
  type HostedSwitchOptions,
} from "./hostedProbe.ts";
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
  "hub-url",
  "cookie-file",
  "send",
  "visited",
  "nodes",
  "projects",
  "threads",
  "base-dir",
  "approve-command",
  "thread-cache",
  "listen-port",
  "target-port",
  "delay-ms",
  "baseline",
  "targets",
  "probe",
  "hub-log",
  "hub-event",
  "hub-route",
  "node-dir",
  "port-base",
  "interleave",
  "help",
]);
/** Options that take no value. */
const FLAG_OPTIONS = new Set(["help", "send", "visited", "thread-cache", "interleave"]);
const BASE_COMMANDS = ["smoke", "run", "compare-refs", "bundle-budget"] as const;
const HOSTED_COMMANDS = [
  "hosted-switch",
  "hosted-cold-load",
  "hosted-compare",
  "hosted-fixture",
  "hosted-correlate",
  "delay-proxy",
] as const;
type Command = (typeof BASE_COMMANDS)[number] | (typeof HOSTED_COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (BASE_COMMANDS as readonly string[]).includes(value) || isHostedCommand(value);
}

function isHostedCommand(value: string): value is (typeof HOSTED_COMMANDS)[number] {
  return (HOSTED_COMMANDS as readonly string[]).includes(value);
}

interface ParsedArgs {
  readonly command: Command;
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
  bun scripts/perf/cli.ts hosted-switch --hub-url <url> --cookie-file <json> [options]
  bun scripts/perf/cli.ts hosted-cold-load --hub-url <url> --cookie-file <json> [options]
  bun scripts/perf/cli.ts hosted-compare --baseline <json> --candidate <json> [--targets <json>]
  bun scripts/perf/cli.ts hosted-fixture --hub-url <url> --base-dir <directory> [options]
  bun scripts/perf/cli.ts hosted-correlate --probe <json> (--node-dir <dirs> | --base-dir <directory>) [options]
  bun scripts/perf/cli.ts delay-proxy --listen-port <port> --target-port <port> [--delay-ms <ms>]

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
                               hosted-switch: dist whose assets/ source maps
                               name the frames of --cpu-profile.
  --help                       Show this help.

Hosted node switch and cold load (see docs/performance-testing.md):
  --hub-url <url>              Compatible Hub serving the hosted web app (the
                               baseline Hub with --interleave).
  --cookie-file <json>         {"cookieName": "...", "cookieValue": "..."} for the Hub host.
  --iterations <count>         Cross-node switches (plus 3 same-node controls) or
                               cold loads. Default: 7
  --interleave                 Alternate --hub-url (baseline) and --candidate
                               (a second Hub URL) in every iteration.
  --send                       hosted-switch: send a marker message after each
                               switch and time its acceptance (mutates threads).
  --cpu-profile <directory>    hosted-switch: CPU profile of the second cross-node
                               and second same-node switch.
  --target-path <path>         hosted-cold-load: route to load. Default: the first
                               online node's first thread.
  --visited                    hosted-cold-load: measure a reload in a context that
                               already loaded the app.
  --output <directory>         Writes hosted-*.json here.
  --baseline <json>            hosted-compare: baseline result.
  --candidate <json>           hosted-compare: candidate result.
  --targets <json>             hosted-compare: {"<metric>": <max median ms>}; exit 1
                               when a candidate median is above its target.

Hosted fixture (local nodes enrolled with a Hub; runs until interrupted):
  --hub-url <url>              Origin the nodes enroll with.
  --base-dir <directory>       Node homes, logs and fixture.json are written here.
  --nodes <count>              Default: 2
  --projects <count>           Projects per node. Default: 4
  --threads <count>            Threads per node. Default: 120
  --port-base <port>           First node port. Default: 3200
  --approve-command <command>  Run with each enrollment file path appended; then
                               wait for the node to come online.
  --thread-cache               Start nodes with the Hub thread cache enabled.

Correlation and delay proxy:
  --probe <json>               hosted-correlate: a hosted-switch result.
  --node-dir <directories>     hosted-correlate: comma-separated node homes.
  --base-dir <directory>       hosted-correlate: fixture directory holding node<n> homes.
  --hub-log <file>             hosted-correlate: JSON-lines Hub log.
  --hub-event <name>           Default: ${DEFAULT_HUB_EVENT}
  --hub-route <route>          Hub log route to count. Default: ${DEFAULT_HUB_ROUTE}
  --listen-port <port>         delay-proxy: port to listen on.
  --target-port <port>         delay-proxy: port to forward to.
  --delay-ms <ms>              delay-proxy: one-way delay per chunk. Default: 0
`;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const first = argv[0] ?? "run";
  if (first === "--help" || first === "-h") {
    return { command: "run", values: new Map(), flags: new Set(["help"]) };
  }
  if (!isCommand(first)) {
    throw new Error(`Unknown command '${first}'.\n\n${usage()}`);
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument '${argument}'.`);
    const key = argument.slice(2);
    if (!KNOWN_OPTIONS.has(key)) throw new Error(`Unknown option '--${key}'.`);
    if (FLAG_OPTIONS.has(key)) {
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

function nonNegativeInteger(
  values: ReadonlyMap<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${key} must be a non-negative integer.`);
  }
  return parsed;
}

function requiredValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`--${key} is required.`);
  return value;
}

const DEFAULT_HOSTED_ITERATIONS = 7;

export function hostedProbeBaseOptions(parsed: ParsedArgs): HostedProbeBaseOptions {
  const candidate = parsed.values.get("candidate") ?? null;
  const interleave = parsed.flags.has("interleave");
  if (interleave && candidate === null) {
    throw new Error("--interleave needs --candidate <hub url> to alternate with --hub-url.");
  }
  if (!interleave && candidate !== null) {
    throw new Error("--candidate is a Hub URL for hosted probes and needs --interleave.");
  }
  return {
    repoRoot,
    hubUrl: requiredValue(parsed.values, "hub-url"),
    candidateHubUrl: candidate,
    cookieFile: path.resolve(requiredValue(parsed.values, "cookie-file")),
    iterations: positiveInteger(parsed.values, "iterations", DEFAULT_HOSTED_ITERATIONS),
    outputDir: outputDirectory(parsed.values),
  };
}

export function hostedSwitchOptions(parsed: ParsedArgs): HostedSwitchOptions {
  const cpuProfileDir = parsed.values.get("cpu-profile");
  const distDir = parsed.values.get("dist");
  return {
    ...hostedProbeBaseOptions(parsed),
    send: parsed.flags.has("send"),
    cpuProfileDir: cpuProfileDir ? path.resolve(cpuProfileDir) : null,
    distDir: distDir ? path.resolve(distDir) : null,
  };
}

export function hostedColdLoadOptions(parsed: ParsedArgs): HostedColdLoadOptions {
  return {
    ...hostedProbeBaseOptions(parsed),
    targetPath: parsed.values.get("target-path") ?? null,
    visited: parsed.flags.has("visited"),
  };
}

export function hostedFixtureOptions(parsed: ParsedArgs): HostedFixtureOptions {
  const approveCommand = parsed.values.get("approve-command");
  return {
    repoRoot,
    hubOrigin: new URL(requiredValue(parsed.values, "hub-url")).origin,
    baseDir: path.resolve(requiredValue(parsed.values, "base-dir")),
    nodes: positiveInteger(parsed.values, "nodes", 2),
    projects: positiveInteger(parsed.values, "projects", 4),
    threads: positiveInteger(parsed.values, "threads", 120),
    portBase: positiveInteger(parsed.values, "port-base", 3200),
    approveCommand: approveCommand ?? null,
    threadCache: parsed.flags.has("thread-cache"),
  };
}

export function hostedCorrelateOptions(parsed: ParsedArgs): HostedCorrelateOptions {
  const nodeDirs = parsed.values.get("node-dir");
  const baseDir = parsed.values.get("base-dir");
  if (nodeDirs === undefined && baseDir === undefined) {
    throw new Error("hosted-correlate needs --node-dir <directories> or --base-dir <directory>.");
  }
  const hubLog = parsed.values.get("hub-log");
  return {
    probeFile: path.resolve(requiredValue(parsed.values, "probe")),
    nodeDirs:
      nodeDirs !== undefined
        ? nodeDirs
            .split(",")
            .filter((directory) => directory.length > 0)
            .map((directory) => path.resolve(directory))
        : discoverNodeDirs(path.resolve(baseDir!)),
    hubLog: hubLog ? path.resolve(hubLog) : null,
    hubEvent: parsed.values.get("hub-event") ?? DEFAULT_HUB_EVENT,
    hubRoute: parsed.values.get("hub-route") ?? DEFAULT_HUB_ROUTE,
  };
}

async function runHostedCommand(parsed: ParsedArgs): Promise<void> {
  switch (parsed.command) {
    case "hosted-switch":
      await runHostedSwitch(hostedSwitchOptions(parsed));
      return;
    case "hosted-cold-load":
      await runHostedColdLoad(hostedColdLoadOptions(parsed));
      return;
    case "hosted-compare": {
      const targetsFile = parsed.values.get("targets");
      const result = runHostedCompare({
        baselineFile: path.resolve(requiredValue(parsed.values, "baseline")),
        candidateFile: path.resolve(requiredValue(parsed.values, "candidate")),
        targetsFile: targetsFile ? path.resolve(targetsFile) : null,
      });
      console.log(formatComparisonTable(result.rows));
      console.log(`Hosted comparison: ${result.passed ? "PASS" : "FAIL"}`);
      if (!result.passed) process.exitCode = 1;
      return;
    }
    case "hosted-fixture":
      await runHostedFixture(hostedFixtureOptions(parsed));
      return;
    case "hosted-correlate": {
      const rows = await runHostedCorrelate(hostedCorrelateOptions(parsed));
      const outputDir = outputDirectory(parsed.values);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(
        path.join(outputDir, "hosted-correlate.json"),
        `${JSON.stringify(rows, null, 2)}\n`,
      );
      console.log(formatCorrelationTable(rows));
      console.log(`Result: ${path.join(outputDir, "hosted-correlate.json")}`);
      return;
    }
    case "delay-proxy": {
      requiredValue(parsed.values, "listen-port");
      requiredValue(parsed.values, "target-port");
      const targetPort = positiveInteger(parsed.values, "target-port", 0);
      const delayMs = nonNegativeInteger(parsed.values, "delay-ms", 0);
      const proxy = await startDelayProxy({
        listenPort: positiveInteger(parsed.values, "listen-port", 0),
        targetPort,
        delayMs,
      });
      console.log(
        `Delay proxy 127.0.0.1:${proxy.port} -> 127.0.0.1:${targetPort}, one-way ${delayMs} ms. Press Ctrl+C to stop.`,
      );
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await proxy.close();
      return;
    }
    default:
      throw new Error(`'${parsed.command}' is not a hosted command.`);
  }
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
  if (isHostedCommand(parsed.command)) {
    await runHostedCommand(parsed);
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
