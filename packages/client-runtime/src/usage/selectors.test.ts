import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageDailyBucket,
  type UsageSourceCoverage,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { mergeUsageEnvironmentResults } from "./merge.ts";
import {
  buildUsageBreakdown,
  buildUsageDaySeries,
  filterUsageBuckets,
  filterUsageImports,
  sumUsageImports,
  sumUsageTotals,
} from "./selectors.ts";
import type { MergedUsageSummary } from "./merge.ts";

function summary() {
  const coverage = (
    provider: "cursor" | "opencode",
    status: UsageSourceCoverage["status"],
  ): UsageSourceCoverage => ({
    sourceId: provider,
    provider,
    status,
    deduplicationKind: provider === "cursor" ? "declared" : "physical",
    transcriptFileCount: 1,
    reusedCacheFileCount: 0,
    parsedFileCount: 1,
    skippedLineCount: 0,
    malformedLineCount: 0,
    distinctSessionCount: 1,
    distinctResponseCount: 1,
    scanStartedAt: "2026-08-10T12:00:00.000Z",
    scanFinishedAt: "2026-08-10T12:00:00.000Z",
    scanDurationMs: 0,
  });
  const bucket = (provider: "cursor" | "opencode"): UsageDailyBucket => ({
    sourceId: provider,
    date: "2026-08-10",
    provider,
    model: "unknown",
    ...(provider === "cursor" ? { exportRecordId: "hash", exportSessionId: "session-hash" } : {}),
    tokens: {
      uncachedInputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 2,
      totalTokens: 999,
    },
    responseCount: 1,
    sessionCount: 1,
    pricedTokenCount: 0,
    unpricedTokenCount: 999,
    costSource: "unpriced",
  });
  return mergeUsageEnvironmentResults([
    {
      environmentId: EnvironmentId.make("test"),
      label: "test",
      status: "partial",
      summary: {
        contractVersion: USAGE_CONTRACT_VERSION,
        startDate: "2026-08-09",
        endDate: "2026-08-11",
        timeZone: "UTC",
        generatedAt: "2026-08-10T12:00:00.000Z",
        scanDurationMs: 0,
        sources: [coverage("cursor", "partial"), coverage("opencode", "complete")],
        buckets: [bucket("cursor"), bucket("opencode")],
        imports: [
          {
            sourceId: "cursor",
            recordId: "billed",
            provider: "cursor",
            date: "2026-08-10",
            metric: "cost",
            value: 2,
            currency: "USD",
          },
        ],
        pricing: { state: "unavailable", recognizedModelCount: 0, unrecognizedModelCount: 1 },
      },
    },
  ])!;
}
describe("usage selectors", () => {
  it("shows gaps for partial/missing telemetry and unavailable price rather than zero", () => {
    const merged = summary(),
      days = buildUsageDaySeries(merged, merged.buckets);
    expect(days[0]).toMatchObject({
      cursorTokens: null,
      cursorCost: null,
      opencodeTokens: 0,
      opencodeCost: 0,
      claudeTokens: null,
    });
    expect(days[1]).toMatchObject({
      cursorTokens: 999,
      cursorCost: null,
      opencodeTokens: 999,
      opencodeCost: null,
    });
    const totals = sumUsageTotals(merged, merged.buckets);
    expect(totals).toMatchObject({
      totalTokens: 1998,
      reasoningTokens: null,
      estimatedCostUsd: null,
      distinctSessionCount: 2,
    });
  });
  it("filters native/export providers and preserves currency in the separate billed totals", () => {
    const merged = summary();
    expect(filterUsageBuckets(merged, ["cursor"])).toHaveLength(1);
    expect(filterUsageImports(merged, ["opencode"])).toHaveLength(0);
    expect(sumUsageImports(filterUsageImports(merged, ["cursor"]))).toEqual({
      requests: null,
      costs: [{ currency: "USD", value: 2 }],
    });
  });
});

const measuredSummary: MergedUsageSummary = {
  startDate: "2026-08-08",
  endDate: "2026-08-10",
  timeZone: "Europe/Berlin",
  buckets: [
    {
      sourceIds: ["source-a"],
      date: "2026-08-08",
      provider: "claude",
      model: "claude-sonnet-4-5",
      tokens: {
        uncachedInputTokens: 100,
        cachedInputTokens: 1000,
        cacheCreationInputTokens: 10,
        outputTokens: 50,
        reasoningTokens: 0,
        totalTokens: 1160,
      },
      responseCount: 2,
      sessionCount: 1,
      estimatedCostUsd: 0.5,
      estimatedCacheSavingsUsd: 0.75,
      pricedTokenCount: 1160,
      unpricedTokenCount: 0,
      costSource: "litellm",
    },
    {
      sourceIds: ["source-b"],
      date: "2026-08-10",
      provider: "codex",
      model: "unknown-model",
      tokens: {
        uncachedInputTokens: 200,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 100,
        reasoningTokens: 40,
        totalTokens: 300,
      },
      responseCount: 1,
      sessionCount: 1,
      pricedTokenCount: 0,
      unpricedTokenCount: 300,
      costSource: "unpriced",
    },
  ],
  sources: [
    {
      sourceId: "source-a",
      environmentId: EnvironmentId.make("environment-a"),
      environmentLabel: "Local",
      provider: "claude",
      deduplicationKind: "physical",
      status: "complete",
      transcriptFileCount: 1,
      reusedCacheFileCount: 0,
      parsedFileCount: 1,
      skippedLineCount: 0,
      malformedLineCount: 0,
      distinctSessionCount: 1,
      distinctResponseCount: 2,
      scanStartedAt: "2026-08-10T10:00:00Z",
      scanFinishedAt: "2026-08-10T10:00:01Z",
      scanDurationMs: 1000,
      included: true,
    },
    {
      sourceId: "source-b",
      environmentId: EnvironmentId.make("environment-a"),
      environmentLabel: "Local",
      provider: "codex",
      deduplicationKind: "physical",
      status: "complete",
      transcriptFileCount: 1,
      reusedCacheFileCount: 0,
      parsedFileCount: 1,
      skippedLineCount: 0,
      malformedLineCount: 0,
      distinctSessionCount: 1,
      distinctResponseCount: 1,
      scanStartedAt: "2026-08-10T10:00:00Z",
      scanFinishedAt: "2026-08-10T10:00:01Z",
      scanDurationMs: 1000,
      included: true,
    },
  ],
  environments: [],
  duplicateSourceCount: 0,
  environmentOnlyDeduplicationWarning: false,
};

describe("usage selectors", () => {
  it("sums measured tokens while preserving unpriced coverage", () => {
    expect(sumUsageTotals(measuredSummary, measuredSummary.buckets)).toMatchObject({
      totalTokens: 1460,
      reasoningTokens: 40,
      distinctSessionCount: 2,
      estimatedCostUsd: 0.5,
      pricedTokenCount: 1160,
      unpricedTokenCount: 300,
    });
  });

  it("fills missing calendar days for stable charts", () => {
    expect(
      buildUsageDaySeries(measuredSummary, measuredSummary.buckets).map((point) => point.date),
    ).toEqual(["2026-08-08", "2026-08-09", "2026-08-10"]);
  });

  it("sorts cost-aware model rows without hiding unpriced models", () => {
    const rows = buildUsageBreakdown(measuredSummary.buckets, "model");
    expect(rows.map((row) => row.label)).toEqual(["claude-sonnet-4-5", "unknown-model"]);
    expect(rows[1]?.costUsd).toBeNull();
  });
});
