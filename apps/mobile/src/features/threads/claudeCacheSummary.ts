import type { ClaudeCacheObservation } from "@ryco/contracts";
import { formatTokenCount } from "@ryco/shared/tokenCount";

import { relativeTime } from "../../lib/time";

/**
 * Claude's observed prompt cache, as the phone shows it: a short line in the thread's context
 * sheet and the details behind the ⓘ on the composer's model chip. Web's context meter shows
 * the same counters ("Prompt cache"). Observations only: never a claim about the next request.
 */
export function claudeCacheSummaryLabel(observation: ClaudeCacheObservation): string {
  return `${formatTokenCount(observation.cacheReadInputTokens)} read · ${formatTokenCount(
    observation.cacheWriteInputTokens,
  )} written`;
}

export interface ClaudeCacheDetailView {
  /** "128k read · 4.1k written · 2k uncached" */
  readonly headline: string;
  /** "Last request 3m ago · 5m write lifetime" */
  readonly lastRequest: string;
  /** Cumulative main-loop totals, a different scope from the request above. */
  readonly totals: string | null;
  readonly caveat: string;
}

export const CLAUDE_CACHE_UNKNOWN_DETAIL =
  "No cache usage was reported for this context yet. Cache availability for the next request is unknown.";

export function buildClaudeCacheDetail(observation: ClaudeCacheObservation): ClaudeCacheDetailView {
  const age = relativeTime(observation.observedAt);
  const lifetimeMinutes = observation.observedTtlSeconds
    ? Math.round(observation.observedTtlSeconds / 60)
    : null;
  const totals = observation.mainLoopTotals;
  return {
    headline: `${claudeCacheSummaryLabel(observation)} · ${formatTokenCount(
      observation.directInputTokens,
    )} uncached`,
    lastRequest: `Last request ${age === "<1m" ? "just now" : `${age} ago`}${
      lifetimeMinutes !== null ? ` · ${lifetimeMinutes}m write lifetime` : ""
    }`,
    totals: totals
      ? `This session so far: ${formatTokenCount(totals.cacheReadInputTokens)} read, ${formatTokenCount(
          totals.cacheWriteInputTokens,
        )} written, ${formatTokenCount(totals.directInputTokens)} uncached, ${formatTokenCount(
          totals.outputTokens,
        )} output.`
      : null,
    caveat:
      "Subagent usage is separate. Cache availability for the next request is unknown; these observations do not guarantee a cache hit or savings.",
  };
}
