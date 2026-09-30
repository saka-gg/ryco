import type { MergedUsageSummary } from "@ryco/client-runtime/usage";
import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildUsageBreakdown, buildUsageDaySeries, sumUsageTotals } from "./selectors.ts";

const summary: MergedUsageSummary = {
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
    expect(sumUsageTotals(summary, summary.buckets)).toMatchObject({
      totalTokens: 1460,
      reasoningTokens: 40,
      distinctSessionCount: 2,
      estimatedCostUsd: 0.5,
      pricedTokenCount: 1160,
      unpricedTokenCount: 300,
    });
  });

  it("fills missing calendar days for stable charts", () => {
    expect(buildUsageDaySeries(summary, summary.buckets).map((point) => point.date)).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
    ]);
  });

  it("sorts cost-aware model rows without hiding unpriced models", () => {
    const rows = buildUsageBreakdown(summary.buckets, "model");
    expect(rows.map((row) => row.label)).toEqual(["claude-sonnet-4-5", "unknown-model"]);
    expect(rows[1]?.costUsd).toBeNull();
  });
});
