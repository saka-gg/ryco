import { EnvironmentId, type UsageProviderKind, type UsageSourceStatus } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MergedUsageBucket, MergedUsageSource, MergedUsageSummary } from "./merge.ts";
import { buildUsageModelDetail } from "./modelDetail.ts";
import { filterUsageBuckets } from "./selectors.ts";

const OPUS = { provider: "claude", model: "claude-opus-4-1" } as const;

function source(
  provider: UsageProviderKind,
  status: UsageSourceStatus = "complete",
): MergedUsageSource {
  return {
    sourceId: `${provider}-home`,
    environmentId: EnvironmentId.make("environment-a"),
    environmentLabel: "Local",
    provider,
    deduplicationKind: "physical",
    status,
    transcriptFileCount: 1,
    reusedCacheFileCount: 0,
    parsedFileCount: 1,
    skippedLineCount: 0,
    malformedLineCount: 0,
    distinctSessionCount: 1,
    distinctResponseCount: 1,
    scanStartedAt: "2026-08-10T10:00:00.000Z",
    scanFinishedAt: "2026-08-10T10:00:01.000Z",
    scanDurationMs: 1000,
    included: true,
  };
}

/** One million tokens of the model, 600k of them cache reads, $3 split by type. */
function bucket(date: string, overrides: Partial<MergedUsageBucket> = {}): MergedUsageBucket {
  return {
    sourceIds: [`${overrides.provider ?? "claude"}-home`],
    date,
    provider: "claude",
    model: "claude-opus-4-1",
    tokens: {
      uncachedInputTokens: 100_000,
      cachedInputTokens: 600_000,
      cacheCreationInputTokens: 100_000,
      outputTokens: 200_000,
      totalTokens: 1_000_000,
    },
    responseCount: 10,
    sessionCount: 2,
    estimatedCostUsd: 3,
    costBreakdown: {
      inputUsd: 0.5,
      cacheReadUsd: 0.3,
      cacheWriteUsd: 0.2,
      outputUsd: 2,
      speedPremiumUsd: 0.4,
    },
    pricedTokenCount: 1_000_000,
    unpricedTokenCount: 0,
    costSource: "litellm",
    ...overrides,
  };
}

function unsplit(priced: MergedUsageBucket): MergedUsageBucket {
  const { costBreakdown: _split, ...fields } = priced;
  return fields;
}

function unpriced(date: string, overrides: Partial<MergedUsageBucket> = {}): MergedUsageBucket {
  const { estimatedCostUsd: _cost, ...fields } = unsplit(bucket(date, overrides));
  return { ...fields, pricedTokenCount: 0, unpricedTokenCount: 1_000_000, costSource: "unpriced" };
}

function summary(
  buckets: readonly MergedUsageBucket[],
  overrides: Partial<MergedUsageSummary> = {},
): MergedUsageSummary {
  return {
    startDate: "2026-08-07",
    endDate: "2026-08-10",
    timeZone: "UTC",
    buckets,
    sources: [source("claude"), source("codex"), source("opencode")],
    environments: [],
    duplicateSourceCount: 0,
    environmentOnlyDeduplicationWarning: false,
    ...overrides,
  };
}

describe("buildUsageModelDetail", () => {
  it("sums one provider's model with its cost per million priced tokens and cache-read share", () => {
    const merged = summary([
      bucket("2026-08-08"),
      // Half priced, and without a split (an older node).
      unsplit(
        bucket("2026-08-10", {
          estimatedCostUsd: 1.5,
          pricedTokenCount: 500_000,
          unpricedTokenCount: 500_000,
          costSource: "mixed",
        }),
      ),
      bucket("2026-08-09", { model: "claude-sonnet-4-5", estimatedCostUsd: 2 }),
      // The same model ID through another provider is another row.
      bucket("2026-08-09", { provider: "opencode", estimatedCostUsd: 1 }),
    ]);

    const detail = buildUsageModelDetail(merged, merged.buckets, OPUS);

    expect(detail).toMatchObject({
      provider: "claude",
      model: "claude-opus-4-1",
      totalTokens: 2_000_000,
      pricedTokenCount: 1_500_000,
      unpricedTokenCount: 500_000,
      responseCount: 20,
      tokenShare: 0.5,
      cacheReadShare: 0.75,
    });
    expect(detail?.costUsd).toBeCloseTo(4.5);
    expect(detail?.costShare).toBeCloseTo(0.6);
    // $4.50 over the 1.5M priced tokens, not over all 2M.
    expect(detail?.costPerMillionPricedTokensUsd).toBeCloseTo(3);
    expect(detail?.breakdown).toMatchObject({
      inputUsd: 0.5,
      cacheReadUsd: 0.3,
      cacheWriteUsd: 0.2,
      outputUsd: 2,
      speedPremiumUsd: 0.4,
      unsplitBucketCount: 1,
    });
    expect(detail?.breakdown?.totalUsd).toBeCloseTo(4.5);
    expect(detail?.breakdown?.otherUsd).toBeCloseTo(1.5);
  });

  it("fills every day of the window, with zeros only where coverage is complete", () => {
    const merged = summary(
      [
        bucket("2026-08-08"),
        bucket("2026-08-09", { model: "claude-sonnet-4-5" }),
        unpriced("2026-08-10"),
        unpriced("2026-08-09", { provider: "codex", model: "gpt-preview" }),
        // Untrusted provider timestamps past the window stay out of the trend.
        bucket("2026-08-11"),
      ],
      { sources: [source("claude"), source("codex", "partial")] },
    );

    expect(buildUsageModelDetail(merged, merged.buckets, OPUS)?.days).toEqual([
      { date: "2026-08-07", costUsd: 0, tokens: 0 },
      { date: "2026-08-08", costUsd: 3, tokens: 1_000_000 },
      { date: "2026-08-09", costUsd: 0, tokens: 0 },
      // Unpriced usage is an unknown cost, not a free day.
      { date: "2026-08-10", costUsd: null, tokens: 1_000_000 },
    ]);
    // A partly scanned provider cannot assert a quiet day.
    expect(
      buildUsageModelDetail(merged, merged.buckets, { provider: "codex", model: "gpt-preview" })
        ?.days,
    ).toEqual([
      { date: "2026-08-07", costUsd: null, tokens: null },
      { date: "2026-08-08", costUsd: null, tokens: null },
      { date: "2026-08-09", costUsd: null, tokens: 1_000_000 },
      { date: "2026-08-10", costUsd: null, tokens: null },
    ]);
  });

  it("starts an open window at the model's first day", () => {
    const { startDate: _allTime, ...merged } = summary([
      bucket("2026-08-02", { model: "claude-sonnet-4-5" }),
      bucket("2026-08-09"),
    ]);

    expect(
      buildUsageModelDetail(merged, merged.buckets, OPUS)?.days.map((day) => day.date),
    ).toEqual(["2026-08-09", "2026-08-10"]);
  });

  it("leaves an unpriced model without cost, rate or split", () => {
    const merged = summary([
      bucket("2026-08-08"),
      unpriced("2026-08-09", { provider: "codex", model: "gpt-preview" }),
    ]);

    expect(
      buildUsageModelDetail(merged, merged.buckets, { provider: "codex", model: "gpt-preview" }),
    ).toMatchObject({
      costUsd: null,
      costShare: null,
      costPerMillionPricedTokensUsd: null,
      breakdown: null,
      tokenShare: 0.5,
      unpricedTokenCount: 1_000_000,
    });
  });

  it("is null when the selection has none of the model's buckets", () => {
    const merged = summary([bucket("2026-08-08"), unpriced("2026-08-09", { provider: "codex" })]);

    expect(buildUsageModelDetail(merged, filterUsageBuckets(merged, ["codex"]), OPUS)).toBeNull();
    expect(
      buildUsageModelDetail(merged, merged.buckets, { provider: "claude", model: "claude-x" }),
    ).toBeNull();
  });
});
