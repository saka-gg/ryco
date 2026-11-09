import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RuntimeSessionId } from "@ryco/contracts/base-schemas";
import type { ClaudeCacheObservation } from "@ryco/contracts/claude-cache";
import { ProviderInstanceId } from "@ryco/contracts/provider-instance";

import { buildClaudeCacheDetail, claudeCacheSummaryLabel } from "./claudeCacheSummary";

const observation: ClaudeCacheObservation = {
  source: "assistant-usage",
  observedAt: "2026-09-27T10:00:00.000Z",
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "sonnet",
  messageId: "request-1",
  directInputTokens: 1_200,
  cacheReadInputTokens: 128_400,
  cacheWriteInputTokens: 4_120,
};

describe("claude cache summary", () => {
  afterEach(() => vi.useRealTimers());

  it("reads the last request's cache in one short line", () => {
    expect(claudeCacheSummaryLabel(observation)).toBe("128k read · 4.1k written");
  });

  it("details the request, its age and lifetime, and the session's totals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-27T10:03:10.000Z"));
    const detail = buildClaudeCacheDetail({
      ...observation,
      observedTtlSeconds: 300,
      mainLoopTotals: {
        source: "result-usage",
        observedAt: "2026-09-27T10:00:00.000Z",
        directInputTokens: 5_000,
        cacheReadInputTokens: 400_000,
        cacheWriteInputTokens: 20_000,
        outputTokens: 9_000,
      },
    });
    expect(detail.headline).toBe("128k read · 4.1k written · 1.2k uncached");
    expect(detail.lastRequest).toBe("Last request 3m ago · 5m write lifetime");
    expect(detail.totals).toBe(
      "This session so far: 400k read, 20k written, 5k uncached, 9k output.",
    );
  });

  it("says just now for a fresh request without a reported lifetime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-27T10:00:20.000Z"));
    const detail = buildClaudeCacheDetail(observation);
    expect(detail.lastRequest).toBe("Last request just now");
    expect(detail.totals).toBeNull();
  });
});
