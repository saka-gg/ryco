import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageDailyBucket,
  type UsageSourceCoverage,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { mergeUsageEnvironmentResults } from "./merge.ts";
import {
  buildUsageDaySeries,
  filterUsageBuckets,
  filterUsageImports,
  sumUsageImports,
  sumUsageTotals,
} from "./selectors.ts";
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
