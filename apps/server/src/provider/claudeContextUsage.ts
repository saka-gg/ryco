import type { ThreadTokenUsageSnapshot } from "@ryco/contracts";

function knownContextWindow(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * `compact_boundary.compact_metadata.post_tokens` as a context gauge; undefined when absent or
 * invalid. Compaction invalidated the cache evidence, so the gauge never carries `claudeCache`.
 */
export function claudePostCompactionUsage(
  compactMetadata: unknown,
  contextWindow: number | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (compactMetadata === null || typeof compactMetadata !== "object") {
    return undefined;
  }
  const postTokens = (compactMetadata as { readonly post_tokens?: unknown }).post_tokens;
  if (typeof postTokens !== "number" || !Number.isFinite(postTokens)) {
    return undefined;
  }
  const rounded = Math.round(postTokens);
  if (rounded <= 0) {
    return undefined;
  }
  const maxTokens = knownContextWindow(contextWindow);
  return {
    usedTokens: maxTokens !== undefined ? Math.min(rounded, maxTokens) : rounded,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

/**
 * The gauge a Claude result publishes. `result.usage` is cumulative across every API call of the
 * turn, so the last main-loop gauge wins and the cumulative figure only rides along as
 * `totalProcessedTokens`. Without a gauge the cumulative snapshot is a fallback, but never for a
 * turn that crossed a compaction boundary: its cumulative input is the pre-compaction size.
 */
export function selectClaudeResultUsageGauge(input: {
  readonly lastGauge: ThreadTokenUsageSnapshot | undefined;
  /** `normalizeClaudeTokenUsage(result.usage)`, clamped to the context window. */
  readonly cumulative: ThreadTokenUsageSnapshot | undefined;
  readonly maxTokens: number | undefined;
  /** False when the result's turn spans a compaction boundary. */
  readonly cumulativeIsGauge: boolean;
}): ThreadTokenUsageSnapshot | undefined {
  const { lastGauge, cumulative, maxTokens } = input;
  if (lastGauge === undefined) {
    return input.cumulativeIsGauge ? cumulative : undefined;
  }
  const cumulativeTotal = cumulative?.totalProcessedTokens ?? cumulative?.usedTokens;
  return {
    ...lastGauge,
    ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
      ? { maxTokens }
      : {}),
    ...(typeof cumulativeTotal === "number" &&
    Number.isFinite(cumulativeTotal) &&
    cumulativeTotal > lastGauge.usedTokens
      ? { totalProcessedTokens: cumulativeTotal }
      : {}),
  };
}
