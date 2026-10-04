import { describe, expect, it } from "vitest";
import type { ThreadTokenUsageSnapshot } from "@ryco/contracts";

import { claudePostCompactionUsage, selectClaudeResultUsageGauge } from "./claudeContextUsage.ts";

describe("claudePostCompactionUsage", () => {
  it.each([
    ["missing metadata", undefined],
    ["null metadata", null],
    ["non-object metadata", "post_tokens"],
    ["missing post_tokens", { trigger: "manual", pre_tokens: 168_012 }],
    ["zero", { post_tokens: 0 }],
    ["negative", { post_tokens: -1 }],
    ["NaN", { post_tokens: Number.NaN }],
    ["Infinity", { post_tokens: Number.POSITIVE_INFINITY }],
    ["a numeric string", { post_tokens: "42000" }],
    ["a value that rounds to zero", { post_tokens: 0.4 }],
  ])("returns undefined for %s", (_label, metadata) => {
    expect(claudePostCompactionUsage(metadata, 200_000)).toBeUndefined();
  });

  it("rounds post_tokens and carries the known window without cache evidence", () => {
    expect(claudePostCompactionUsage({ post_tokens: 41_999.6 }, 200_000)).toEqual({
      usedTokens: 42_000,
      maxTokens: 200_000,
    });
  });

  it("clamps post_tokens to the known window", () => {
    expect(claudePostCompactionUsage({ post_tokens: 250_000 }, 200_000)).toEqual({
      usedTokens: 200_000,
      maxTokens: 200_000,
    });
  });

  it.each([undefined, 0, 1.5, Number.NaN])(
    "leaves out an unknown or invalid window: %s",
    (window) => {
      expect(claudePostCompactionUsage({ post_tokens: 250_000 }, window)).toEqual({
        usedTokens: 250_000,
      });
    },
  );
});

describe("selectClaudeResultUsageGauge", () => {
  const gauge: ThreadTokenUsageSnapshot = {
    usedTokens: 42_000,
    inputTokens: 42_000,
    cachedInputTokens: 40_000,
  };
  const cumulative: ThreadTokenUsageSnapshot = {
    usedTokens: 172_003,
    lastUsedTokens: 172_003,
    inputTokens: 168_003,
    outputTokens: 4_000,
    maxTokens: 200_000,
  };

  it("merges the gauge with a valid window only", () => {
    expect(
      selectClaudeResultUsageGauge({
        lastGauge: gauge,
        cumulative: undefined,
        maxTokens: 200_000,
        cumulativeIsGauge: true,
      }),
    ).toEqual({ ...gauge, maxTokens: 200_000 });
    for (const maxTokens of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        selectClaudeResultUsageGauge({
          lastGauge: gauge,
          cumulative: undefined,
          maxTokens,
          cumulativeIsGauge: true,
        }),
      ).toEqual(gauge);
    }
  });

  it("reports the cumulative total only when it exceeds the gauge", () => {
    expect(
      selectClaudeResultUsageGauge({
        lastGauge: gauge,
        cumulative,
        maxTokens: 200_000,
        cumulativeIsGauge: false,
      }),
    ).toEqual({ ...gauge, maxTokens: 200_000, totalProcessedTokens: 172_003 });
    expect(
      selectClaudeResultUsageGauge({
        lastGauge: gauge,
        cumulative: { usedTokens: 200_000, totalProcessedTokens: 535_000 },
        maxTokens: 200_000,
        cumulativeIsGauge: true,
      }),
    ).toEqual({ ...gauge, maxTokens: 200_000, totalProcessedTokens: 535_000 });
    expect(
      selectClaudeResultUsageGauge({
        lastGauge: gauge,
        cumulative: { usedTokens: 42_000 },
        maxTokens: 200_000,
        cumulativeIsGauge: true,
      }),
    ).toEqual({ ...gauge, maxTokens: 200_000 });
    expect(
      selectClaudeResultUsageGauge({
        lastGauge: gauge,
        cumulative: { usedTokens: 1_000 },
        maxTokens: 200_000,
        cumulativeIsGauge: true,
      }),
    ).toEqual({ ...gauge, maxTokens: 200_000 });
  });

  it("falls back to the cumulative snapshot without a gauge", () => {
    expect(
      selectClaudeResultUsageGauge({
        lastGauge: undefined,
        cumulative,
        maxTokens: 200_000,
        cumulativeIsGauge: true,
      }),
    ).toBe(cumulative);
  });

  it("never treats cumulative usage across a compaction boundary as the gauge", () => {
    expect(
      selectClaudeResultUsageGauge({
        lastGauge: undefined,
        cumulative,
        maxTokens: 200_000,
        cumulativeIsGauge: false,
      }),
    ).toBeUndefined();
  });
});
