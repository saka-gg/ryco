import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { aggregateSamples } from "./statistics.ts";
import { measureWebBundle } from "./bundleMeasurement.ts";
import { runBrowserProbe, sanitizeDiagnostic } from "./browserProbe.ts";
import { ProcessTreeSampler } from "./processSampler.ts";
import {
  EXTERNAL_PERF_SCHEMA_VERSION,
  UNSUPPORTED_SOURCE_CONTROL_METRICS,
  type BenchmarkResult,
  type BuildMeasurement,
  type BundleMeasurement,
  type PerfSample,
  type PerfScenarioConfig,
  type ProcessTreeSummary,
} from "./model.ts";
import {
  launchProductionServer,
  prepareIterationHome,
  reserveLoopbackPort,
} from "./serverLifecycle.ts";
import {
  prepareActiveSourceControlFixture,
  type ActiveSourceControlFixture,
} from "./sourceControlFixture.ts";

const UNSAMPLED_PROCESS_TREE: ProcessTreeSummary = {
  supported: false,
  samples: 0,
  peakRssBytes: null,
  medianCpuPercent: null,
  peakCpuPercent: null,
  peakProcessCount: null,
  unavailableReason: "No launched process was supplied for this URL measurement.",
};

function benchmarkMetadata() {
  const cpus = os.cpus();
  const nodeVersion = execFileSync(process.env.RYCO_PERF_NODE_BINARY || "node", ["--version"], {
    encoding: "utf8",
  }).trim();
  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    bunVersion: process.versions.bun ?? "unknown",
    nodeVersion,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
  } as const;
}

export function defaultScenarioConfig(smoke = false): PerfScenarioConfig {
  return {
    profile: "shell",
    iterations: smoke ? 1 : 5,
    idleMs: smoke ? 2_000 : 5_000,
    hiddenIdleMs: smoke ? 1_000 : 5_000,
    offlineMs: 1_000,
    reconnectTimeoutMs: smoke ? 5_000 : 12_000,
    readySelector: "#root",
    targetPath: null,
    fixtureHome: null,
    sourceControlDiscoveryTimeoutMs: 18_000,
    sourceControlActiveMs: 35_000,
    sourceControlHiddenMs: 5_000,
    sourceControlSettledMs: 32_000,
    sourceControlStatusRows: 12,
    cpuProfileDir: null,
  };
}

function reportScenario(scenario: PerfScenarioConfig): PerfScenarioConfig {
  return {
    ...scenario,
    fixtureHome: scenario.fixtureHome ? "[provided]" : null,
    cpuProfileDir: scenario.cpuProfileDir ? "[provided]" : null,
  };
}

function bundleMeasurement(repoRoot: string): BundleMeasurement | null {
  const distDir = path.join(repoRoot, "apps/web/dist");
  return existsSync(distDir) ? measureWebBundle(distDir) : null;
}

export async function runCheckoutBenchmark(input: {
  readonly repoRoot: string;
  readonly label: string;
  readonly revision: string;
  readonly scenario: PerfScenarioConfig;
  readonly build?: BuildMeasurement | null;
  readonly externalUrl?: string;
}): Promise<BenchmarkResult> {
  const browser = await chromium.launch({ headless: true });
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "ryco-external-perf-"));
  const samples: PerfSample[] = [];
  const benchmarkErrors: string[] = [];

  try {
    for (let iteration = 1; iteration <= input.scenario.iterations; iteration += 1) {
      let serverReadyMs: number | null = null;
      let processTree = UNSAMPLED_PROCESS_TREE;
      let entryUrl = input.externalUrl ?? null;
      let launchedServer: Awaited<ReturnType<typeof launchProductionServer>> | null = null;
      let sourceControlFixture: ActiveSourceControlFixture | null = null;
      const samplerRef: { current: ProcessTreeSampler | null } = { current: null };
      const iterationErrors: string[] = [];

      try {
        if (!entryUrl) {
          const iterationHome = path.join(temporaryRoot, `home-${iteration}`);
          prepareIterationHome({
            destination: iterationHome,
            fixtureHome: input.scenario.fixtureHome,
          });
          if (input.scenario.profile === "active-source-control") {
            sourceControlFixture = prepareActiveSourceControlFixture({
              repoRoot: input.repoRoot,
              home: iterationHome,
              fixtureRoot: path.join(temporaryRoot, `source-control-${iteration}`),
            });
          }
          const port = await reserveLoopbackPort();
          launchedServer = await launchProductionServer({
            repoRoot: input.repoRoot,
            baseDir: iterationHome,
            port,
            onSpawn: (child) => {
              if (!child.pid) return;
              samplerRef.current = new ProcessTreeSampler(child.pid, 250);
              samplerRef.current.start();
            },
          });
          serverReadyMs = launchedServer.serverReadyMs;
          entryUrl = launchedServer.pairingUrl;
        }

        const browserResult = await runBrowserProbe({
          browser,
          entryUrl,
          scenario: input.scenario,
          sourceControlFixture,
          cpuProfile: input.scenario.cpuProfileDir
            ? {
                file: path.join(
                  input.scenario.cpuProfileDir,
                  `${input.label}-iteration-${iteration}.cpuprofile`,
                ),
                // A harness-built checkout profiles its own dist; hidden source
                // maps then name source files instead of chunks.
                assetsDir: input.externalUrl
                  ? null
                  : path.join(input.repoRoot, "apps/web/dist/assets"),
              }
            : null,
        });
        iterationErrors.push(...browserResult.errors);
        if (launchedServer && launchedServer.child.exitCode !== null) {
          iterationErrors.push(
            `server: exited unexpectedly with code ${launchedServer.child.exitCode}.`,
          );
        }
        if (samplerRef.current) processTree = await samplerRef.current.stop();
        samples.push({
          iteration,
          serverReadyMs,
          reconnectMs: browserResult.reconnectMs,
          foregroundTaskMs: browserResult.foregroundTaskMs,
          hiddenTaskMs: browserResult.hiddenTaskMs,
          heapBeforeIdleBytes: browserResult.heapBeforeIdleBytes,
          heapAfterIdleBytes: browserResult.heapAfterIdleBytes,
          vitals: browserResult.vitals,
          bootstrapNetwork: browserResult.bootstrapNetwork,
          foregroundIdleNetwork: browserResult.foregroundIdleNetwork,
          hiddenIdleNetwork: browserResult.hiddenIdleNetwork,
          reconnectNetwork: browserResult.reconnectNetwork,
          processTree,
          sourceControl: browserResult.sourceControl ?? UNSUPPORTED_SOURCE_CONTROL_METRICS,
          cpuProfile: browserResult.cpuProfile,
          themeRecalcMs: browserResult.themeRecalcMs,
          errors: iterationErrors,
        });
      } catch (error) {
        const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
        iterationErrors.push(`harness: ${message}`);
        benchmarkErrors.push(`iteration ${iteration}: ${message}`);
      } finally {
        if (samplerRef.current && processTree === UNSAMPLED_PROCESS_TREE) {
          processTree = await samplerRef.current.stop();
        }
        if (launchedServer) await launchedServer.stop();
      }
    }
  } finally {
    await browser.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  return {
    schemaVersion: EXTERNAL_PERF_SCHEMA_VERSION,
    label: input.label,
    revision: input.revision,
    scenario: reportScenario(input.scenario),
    metadata: benchmarkMetadata(),
    build: input.build ?? null,
    bundle: input.externalUrl ? null : bundleMeasurement(input.repoRoot),
    samples,
    aggregates: aggregateSamples(samples),
    errors: benchmarkErrors,
  };
}
