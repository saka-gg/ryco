// The chat's context window in its context sheet (web's composer meter, without a new bar on the
// phone): how full it is, against what limit, and whether the provider compacts on its own. The
// usage itself comes from the shared `deriveContextWindowUsage`.
import type { ContextWindowUsage } from "@ryco/client-runtime/state/session/contextWindow";
import { formatTokenCount } from "@ryco/shared/tokenCount";

export interface ContextWindowSummary {
  /** "42% used" or "12.3k tokens used". */
  readonly label: string;
  /** "84k of 200k" when the limit is known. */
  readonly detail: string | null;
  /** 0–1 for the bar; null without a known limit. */
  readonly fraction: number | null;
  /** The provider compacts the conversation itself as it fills. */
  readonly compactsAutomatically: boolean;
  /** Tokens processed over the whole conversation, when they exceed what the window holds. */
  readonly totalProcessed: string | null;
}

/** Null until the provider reported any usage for the chat. */
export function summarizeContextWindow(usage: ContextWindowUsage): ContextWindowSummary | null {
  if (usage.usedTokens <= 0) return null;
  const percent =
    usage.usedPercentage === null ? null : Math.min(100, Math.max(0, usage.usedPercentage));
  const total = usage.totalProcessedTokens ?? null;
  return {
    label:
      percent === null
        ? `${formatTokenCount(usage.usedTokens)} tokens used`
        : `${Math.round(percent)}% used`,
    detail:
      usage.maxTokens == null
        ? null
        : `${formatTokenCount(usage.usedTokens)} of ${formatTokenCount(usage.maxTokens)}`,
    fraction: percent === null ? null : percent / 100,
    compactsAutomatically: usage.compactsAutomatically === true,
    totalProcessed:
      total !== null && total > usage.usedTokens ? `${formatTokenCount(total)} processed` : null,
  };
}
