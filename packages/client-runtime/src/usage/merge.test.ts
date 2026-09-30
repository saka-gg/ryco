import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageDailyBucket,
  type UsageSourceCoverage,
  type UsageSummary,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeUsageEnvironmentResults,
  UsageRequestGeneration,
  type UsageEnvironmentResult,
} from "./merge.ts";

function source(
  sourceId: string,
  overrides: Partial<UsageSourceCoverage> = {},
): UsageSourceCoverage {
  return {
    sourceId,
    provider: "claude",
    deduplicationKind: "physical",
    status: "complete",
    transcriptFileCount: 1,
    reusedCacheFileCount: 0,
    parsedFileCount: 1,
    skippedLineCount: 0,
    malformedLineCount: 0,
    distinctSessionCount: 1,
    distinctResponseCount: 1,
    scanStartedAt: "2026-08-10T12:00:00.000Z",
    scanFinishedAt: "2026-08-10T12:00:01.000Z",
    scanDurationMs: 1000,
    ...overrides,
  };
}

function bucket(sourceId: string, overrides: Partial<UsageDailyBucket> = {}): UsageDailyBucket {
  return {
    sourceId,
    date: "2026-08-10",
    provider: "claude",
    model: "claude-sonnet-4-5-20250929",
    tokens: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationInputTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
      totalTokens: 1160,
    },
    responseCount: 1,
    sessionCount: 1,
    estimatedCostUsd: 0.5,
    estimatedCacheSavingsUsd: 0.75,
    pricedTokenCount: 1160,
    unpricedTokenCount: 0,
    costSource: "litellm",
    ...overrides,
  };
}

function environment(
  id: string,
  sources: readonly UsageSourceCoverage[],
  buckets: readonly UsageDailyBucket[],
  overrides: Partial<UsageSummary> = {},
): UsageEnvironmentResult {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    status: "complete",
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      timeZone: "Europe/Berlin",
      generatedAt: "2026-08-10T12:00:02.000Z",
      scanDurationMs: 1000,
      sources,
      buckets,
      pricing: {
        state: "live",
        recognizedModelCount: 1,
        unrecognizedModelCount: 0,
      },
      ...overrides,
    },
  };
}

describe("mergeUsageEnvironmentResults", () => {
  it("counts a shared physical source once and prefers the more complete scan", () => {
    const partial = environment(
      "environment-a",
      [source("shared", { status: "partial" })],
      [bucket("shared", { tokens: { ...bucket("shared").tokens, totalTokens: 100 } })],
    );
    const complete = environment(
      "environment-b",
      [source("shared", { status: "complete" })],
      [bucket("shared")],
    );
    const merged = mergeUsageEnvironmentResults([partial, complete]);

    expect(merged?.duplicateSourceCount).toBe(1);
    expect(merged?.buckets).toHaveLength(1);
    expect(merged?.buckets[0]?.tokens.totalTokens).toBe(1160);
    expect(merged?.sources.find((item) => item.environmentId === "environment-b")?.included).toBe(
      true,
    );
  });

  it("adds distinct sources and keeps partial pricing explicit", () => {
    const first = environment("environment-a", [source("source-a")], [bucket("source-a")]);
    const second = environment(
      "environment-b",
      [source("source-b", { provider: "codex" })],
      [
        bucket("source-b", {
          provider: "codex",
          estimatedCostUsd: undefined,
          estimatedCacheSavingsUsd: undefined,
          pricedTokenCount: 0,
          unpricedTokenCount: 1160,
          costSource: "unpriced",
        } as Partial<UsageDailyBucket>),
      ],
    );
    const merged = mergeUsageEnvironmentResults([first, second]);

    expect(merged?.buckets).toHaveLength(2);
    expect(merged?.buckets.reduce((sum, item) => sum + item.tokens.totalTokens, 0)).toBe(2320);
  });

  it("does not deduplicate environment-only sources and raises a warning", () => {
    const first = environment(
      "environment-a",
      [source("fallback", { deduplicationKind: "environment-only" })],
      [bucket("fallback")],
    );
    const second = environment(
      "environment-b",
      [source("fallback", { deduplicationKind: "environment-only" })],
      [bucket("fallback")],
    );
    const merged = mergeUsageEnvironmentResults([first, second]);

    expect(merged?.duplicateSourceCount).toBe(0);
    expect(merged?.environmentOnlyDeduplicationWarning).toBe(true);
    expect(merged?.buckets[0]?.tokens.totalTokens).toBe(2320);
  });

  it("ignores failed and stale-contract environments without hiding them", () => {
    const failed: UsageEnvironmentResult = {
      environmentId: EnvironmentId.make("environment-failed"),
      label: "Failed",
      status: "failed",
      message: "offline",
    };
    const merged = mergeUsageEnvironmentResults([
      environment("environment-a", [source("source-a")], [bucket("source-a")]),
      failed,
    ]);
    expect(merged?.environments).toHaveLength(2);
    expect(merged?.buckets).toHaveLength(1);
  });
});

describe("UsageRequestGeneration", () => {
  it("rejects results from a superseded request", () => {
    const generations = new UsageRequestGeneration();
    const first = generations.next();
    const second = generations.next();
    expect(generations.isCurrent(first)).toBe(false);
    expect(generations.isCurrent(second)).toBe(true);
  });
});

describe("Cursor export merging", () => {
  const cursorSource = (id: string) =>
    source(id, { provider: "cursor", status: "partial", deduplicationKind: "declared" });
  const event = (id: string, recordId: string, sessionId = "anonymous-session") =>
    bucket(id, {
      provider: "cursor",
      exportRecordId: recordId,
      exportSessionId: sessionId,
      tokens: {
        uncachedInputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        totalTokens: 777,
      },
    });
  it("unions partially overlapping exports across instances/environments without losing unique events", () => {
    const merged = mergeUsageEnvironmentResults([
      environment(
        "a",
        [cursorSource("account")],
        [event("account", "event-a"), event("account", "shared")],
      ),
      environment(
        "b",
        [cursorSource("account")],
        [event("account", "shared"), event("account", "event-b")],
      ),
    ]);
    expect(merged?.buckets[0]?.tokens.totalTokens).toBe(2331);
    expect(merged?.buckets[0]?.tokens.reasoningTokens).toBeUndefined();
    expect(merged?.buckets[0]?.responseCount).toBe(3);
    expect(merged?.buckets[0]?.sessionCount).toBe(1);
    expect(merged?.environmentOnlyDeduplicationWarning).toBe(false);
  });
  it("isolates account scopes and deduplicates billed/request metadata without fabricating tokens", () => {
    const row = {
      sourceId: "account-a",
      recordId: "event:billed",
      provider: "cursor" as const,
      date: "2026-08-10",
      model: "unknown",
      metric: "cost" as const,
      value: 0.25,
      currency: "USD",
    };
    const merged = mergeUsageEnvironmentResults([
      environment("a", [cursorSource("account-a")], [], { imports: [row] }),
      environment("b", [cursorSource("account-a"), cursorSource("account-b")], [], {
        imports: [row, { ...row, sourceId: "account-b" }],
      }),
    ]);
    expect(merged?.imports).toHaveLength(2);
    expect(merged?.buckets).toHaveLength(0);
  });
});

it("counts an OpenCode store once across implicit/explicit configurations and environments", () => {
  const store = "same-physical-opencode-database";
  const merged = mergeUsageEnvironmentResults([
    environment(
      "implicit",
      [source(store, { provider: "opencode" })],
      [bucket(store, { provider: "opencode" })],
    ),
    environment(
      "explicit",
      [source(store, { provider: "opencode" })],
      [bucket(store, { provider: "opencode" })],
    ),
  ]);
  expect(merged?.duplicateSourceCount).toBe(1);
  expect(merged?.buckets[0]?.tokens.totalTokens).toBe(1160);
});
