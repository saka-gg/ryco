import { assert, describe, it } from "@effect/vitest";

import { compareBenchmarks } from "./comparison.ts";
import {
  EXTERNAL_PERF_SCHEMA_VERSION,
  type BenchmarkResult,
  type ComparisonPolicy,
} from "./model.ts";

function benchmark(input: {
  readonly label: string;
  readonly serverReadyMs?: number;
  readonly foregroundIdleRequests?: number;
  readonly hiddenIdleRequests?: number;
}): BenchmarkResult {
  const metric = (value: number) => ({
    count: 1,
    median: value,
    p95: value,
    maximum: value,
    minimum: value,
  });
  const aggregates: BenchmarkResult["aggregates"] = {
    ...(input.serverReadyMs !== undefined ? { serverReadyMs: metric(input.serverReadyMs) } : {}),
    ...(input.foregroundIdleRequests !== undefined
      ? { foregroundIdleRequests: metric(input.foregroundIdleRequests) }
      : {}),
    ...(input.hiddenIdleRequests !== undefined
      ? { hiddenIdleRequests: metric(input.hiddenIdleRequests) }
      : {}),
  };
  return {
    schemaVersion: EXTERNAL_PERF_SCHEMA_VERSION,
    label: input.label,
    revision: input.label,
    scenario: {
      profile: "shell",
      iterations: 0,
      idleMs: 1,
      hiddenIdleMs: 1,
      offlineMs: 1,
      reconnectTimeoutMs: 1,
      readySelector: "#root",
      targetPath: null,
      fixtureHome: null,
      sourceControlDiscoveryTimeoutMs: 1,
      sourceControlActiveMs: 1,
      sourceControlHiddenMs: 1,
      sourceControlSettledMs: 1,
      sourceControlStatusRows: 1,
      cpuProfileDir: null,
    },
    metadata: {
      generatedAt: "2026-08-15T00:00:00.000Z",
      platform: process.platform,
      architecture: process.arch,
      bunVersion: "1.3.14",
      nodeVersion: "24.13.1",
      cpuModel: "fixture",
      cpuCount: 1,
      totalMemoryBytes: 1,
    },
    build: null,
    bundle: null,
    samples: [],
    aggregates,
    errors: [],
  };
}

const policy: ComparisonPolicy = {
  metrics: { serverReadyMs: { relativePercent: 15, absolute: 50 } },
  idleRequestAllowance: 1,
  failOnSampleErrors: false,
};

describe("external benchmark comparison", () => {
  it("requires both the relative and absolute regression floors", () => {
    assert.isTrue(
      compareBenchmarks(
        benchmark({ label: "base", serverReadyMs: 1_000 }),
        benchmark({ label: "candidate", serverReadyMs: 1_120 }),
        policy,
      ).passed,
    );
    assert.isFalse(
      compareBenchmarks(
        benchmark({ label: "base", serverReadyMs: 1_000 }),
        benchmark({ label: "candidate", serverReadyMs: 1_200 }),
        policy,
      ).passed,
    );
  });

  it("fails when hidden or foreground polling exceeds the allowance", () => {
    const result = compareBenchmarks(
      benchmark({ label: "base", foregroundIdleRequests: 0, hiddenIdleRequests: 0 }),
      benchmark({ label: "candidate", foregroundIdleRequests: 1, hiddenIdleRequests: 2 }),
      policy,
    );
    assert.isFalse(result.passed);
    assert.match(result.failures.join("\n"), /hiddenIdleRequests/u);
    assert.notMatch(result.failures.join("\n"), /foregroundIdleRequests/u);
  });

  it("treats a missing candidate measurement as a regression", () => {
    const result = compareBenchmarks(
      benchmark({ label: "base", serverReadyMs: 100 }),
      benchmark({ label: "candidate" }),
      policy,
    );
    assert.isFalse(result.passed);
    assert.match(result.failures.join("\n"), /candidate measurement is missing/u);
  });
});
