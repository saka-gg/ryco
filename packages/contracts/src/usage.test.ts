import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  USAGE_CONTRACT_VERSION,
  UsageDailyBucket,
  UsageSummary,
  UsageSummaryRequest,
} from "./usage.ts";

const tokens = {
  uncachedInputTokens: 120,
  cachedInputTokens: 80,
  cacheCreationInputTokens: 20,
  outputTokens: 45,
  reasoningTokens: 15,
  totalTokens: 265,
};

describe("Usage contracts", () => {
  it("decodes a valid summary request", () => {
    const decoded = Schema.decodeUnknownSync(UsageSummaryRequest)({
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      timeZone: "Europe/Berlin",
      contractVersion: USAGE_CONTRACT_VERSION,
    });

    expect(decoded.timeZone).toBe("Europe/Berlin");
  });

  it("rejects malformed dates and contract versions", () => {
    expect(() =>
      Schema.decodeUnknownSync(UsageSummaryRequest)({
        startDate: "08/01/2026",
        endDate: "2026-08-10",
        timeZone: "UTC",
        contractVersion: USAGE_CONTRACT_VERSION,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(UsageSummaryRequest)({
        endDate: "2026-08-10",
        timeZone: "UTC",
        contractVersion: -1,
      }),
    ).toThrow();
  });

  it("rejects negative and non-finite usage values", () => {
    const base = {
      sourceId: "source-1",
      date: "2026-08-10",
      provider: "codex",
      model: "gpt-5.4",
      tokens,
      responseCount: 1,
      sessionCount: 1,
      estimatedCostUsd: 0.42,
      estimatedCacheSavingsUsd: 0.11,
      pricedTokenCount: 265,
      unpricedTokenCount: 0,
      costSource: "litellm",
    } as const;

    expect(() =>
      Schema.decodeUnknownSync(UsageDailyBucket)({ ...base, pricedTokenCount: -1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(UsageDailyBucket)({ ...base, estimatedCostUsd: Number.NaN }),
    ).toThrow();
  });

  it("decodes an aggregate-only summary", () => {
    const decoded = Schema.decodeUnknownSync(UsageSummary)({
      contractVersion: USAGE_CONTRACT_VERSION,
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      timeZone: "UTC",
      generatedAt: "2026-08-10T12:00:00.000Z",
      scanDurationMs: 18,
      buckets: [
        {
          sourceId: "source-1",
          date: "2026-08-10",
          provider: "claude",
          model: "claude-opus-4-1",
          tokens,
          responseCount: 1,
          sessionCount: 1,
          pricedTokenCount: 265,
          unpricedTokenCount: 0,
          costSource: "provider-reported",
          estimatedCostUsd: 0.23,
        },
      ],
      sources: [
        {
          sourceId: "source-1",
          provider: "claude",
          deduplicationKind: "physical",
          status: "complete",
          transcriptFileCount: 1,
          reusedCacheFileCount: 0,
          parsedFileCount: 1,
          skippedLineCount: 2,
          malformedLineCount: 0,
          distinctSessionCount: 1,
          distinctResponseCount: 1,
          scanStartedAt: "2026-08-10T11:59:59.982Z",
          scanFinishedAt: "2026-08-10T12:00:00.000Z",
          scanDurationMs: 18,
        },
      ],
      pricing: {
        state: "live",
        fetchedAt: "2026-08-10T11:00:00.000Z",
        cacheAgeMs: 3_600_000,
        recognizedModelCount: 1,
        unrecognizedModelCount: 0,
      },
    });

    expect(decoded.buckets[0]?.tokens.reasoningTokens).toBe(15);
    expect(decoded.sources[0]?.distinctSessionCount).toBe(1);
  });
});

it("accepts anonymous export buckets and keeps unavailable reasoning absent", () => {
  const decoded = Schema.decodeUnknownSync(UsageDailyBucket)({
    sourceId: "hash",
    exportRecordId: "event-hash",
    exportSessionId: "session-hash",
    date: "2026-08-10",
    provider: "cursor",
    model: "unknown",
    tokens: {
      uncachedInputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 1,
      totalTokens: 2,
    },
    responseCount: 1,
    sessionCount: 1,
    pricedTokenCount: 0,
    unpricedTokenCount: 2,
    costSource: "unpriced",
  });
  expect(decoded.tokens.reasoningTokens).toBeUndefined();
  expect(decoded.exportRecordId).toBe("event-hash");
});
