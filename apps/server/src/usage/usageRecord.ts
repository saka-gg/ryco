import type { UsageProviderKind, UsageTokenTotals } from "@ryco/contracts";

export type UsageSpeed = "standard" | "fast" | "ultrafast";

export interface UsageRecord {
  readonly speed?: UsageSpeed;
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  /** Cross-file identity for records providers may copy into other transcripts. */
  readonly dedupeKey: string | null;
}

export const EMPTY_USAGE_TOKEN_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

export function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? null : timestampMs;
}

export function tokenTotal(
  totals: Omit<UsageTokenTotals, "totalTokens"> | UsageTokenTotals,
): number {
  // Reasoning tokens are already included in output tokens.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationInputTokens +
    totals.outputTokens
  );
}

export function withTokenTotal(totals: Omit<UsageTokenTotals, "totalTokens">): UsageTokenTotals {
  return { ...totals, totalTokens: tokenTotal(totals) };
}

export function addUsageTokenTotals(
  left: UsageTokenTotals,
  right: UsageTokenTotals,
): UsageTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(left.reasoningTokens === undefined || right.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: left.reasoningTokens + right.reasoningTokens }),
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  return provider === "claude" ? line.includes('"usage"') : line.includes('"token_count"');
}
