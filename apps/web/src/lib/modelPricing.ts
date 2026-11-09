import { MODEL_SLUG_ALIASES_BY_PROVIDER } from "@ryco/contracts";

/**
 * Per-token pricing used to estimate spend on the Statistics dashboard.
 *
 * ⚠️ Expressed in USD per 1,000,000 tokens and needs occasional upkeep as
 * providers change rates. A model with no entry (unknown, or a flat-rate
 * subscription where per-token cost is meaningless) renders as "—" rather than
 * a misleading $0.
 */
export interface ModelPrice {
  readonly inputPer1M: number;
  readonly cachedInputPer1M: number;
  readonly outputPer1M: number;
}

// Flatten the per-provider alias maps into a single alias→canonical lookup so we
// can canonicalize a model slug even when the provider isn't known at the call
// site (the dashboard groups by the thread's stored model slug).
//
// Aliases that resolve to DIFFERENT canonical slugs across providers (e.g. "5.4"
// is gpt-5.4 for Codex but gpt-5 for Copilot) are ambiguous without provider
// context, so we drop them rather than resolve by arbitrary insertion order —
// the flattened fallback only covers globally-unambiguous aliases.
const FLAT_ALIASES: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const ambiguous = new Set<string>();
  for (const map of Object.values(MODEL_SLUG_ALIASES_BY_PROVIDER)) {
    if (!map) continue;
    for (const [alias, canonical] of Object.entries(map)) {
      const existing = out[alias];
      if (existing !== undefined && existing !== canonical) {
        ambiguous.add(alias);
      } else {
        out[alias] = canonical;
      }
    }
  }
  for (const alias of ambiguous) {
    delete out[alias];
  }
  return out;
})();

/**
 * USD per 1,000,000 tokens, keyed by canonical model slug.
 *
 * `cachedInputPer1M` is the cache-READ (hit) rate, which is what the dashboard's
 * `cachedInputTokens` represents. For Anthropic that is 0.1× the base input
 * rate; for OpenAI it is the published cached-input rate.
 *
 * Verified July 2026 against official pricing pages:
 *  - Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
 *  - OpenAI     https://developers.openai.com/api/docs/pricing
 *  - Google     https://ai.google.dev/gemini-api/docs/pricing
 *  - DeepSeek   https://api-docs.deepseek.com/quick_start/pricing
 *  - xAI        https://docs.x.ai/developers/models
 *  - Cursor     https://cursor.com/docs/models-and-pricing
 *
 * Tiered models (Gemini/GPT) use the standard short-context rate when the
 * dashboard lacks enough per-request detail to choose another tier. Entries
 * marked "approx" are best-effort for models with less stable public pricing.
 * Update here when providers change rates.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ── OpenAI / Codex ──
  "gpt-5.6-sol": { inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 30 },
  "gpt-5.6-terra": { inputPer1M: 2.5, cachedInputPer1M: 0.25, outputPer1M: 15 },
  "gpt-5.6-luna": { inputPer1M: 1, cachedInputPer1M: 0.1, outputPer1M: 6 },
  "gpt-5.5": { inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 30 },
  "gpt-5.4": { inputPer1M: 2.5, cachedInputPer1M: 0.25, outputPer1M: 15 },
  "gpt-5.4-mini": { inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 4.5 },
  "gpt-5.4-nano": { inputPer1M: 0.2, cachedInputPer1M: 0.02, outputPer1M: 1.25 },
  "gpt-5.3-codex": { inputPer1M: 1.75, cachedInputPer1M: 0.175, outputPer1M: 14 },
  "gpt-5.3-codex-spark": { inputPer1M: 1.75, cachedInputPer1M: 0.175, outputPer1M: 14 }, // approx (codex sibling)
  // Prior GPT-5 generation (still used by Copilot / OpenCode routing).
  "gpt-5": { inputPer1M: 1.25, cachedInputPer1M: 0.125, outputPer1M: 10 },
  "gpt-5-mini": { inputPer1M: 0.25, cachedInputPer1M: 0.025, outputPer1M: 2 },
  "gpt-5-codex": { inputPer1M: 1.25, cachedInputPer1M: 0.125, outputPer1M: 10 },
  // ── Anthropic / Claude (Opus 4.5+ is $5/$25; 4.1 and earlier were $15/$75) ──
  "claude-opus-4-8": { inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 25 },
  "claude-opus-4-7": { inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 25 },
  "claude-opus-4-6": { inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 25 },
  "claude-opus-4-5": { inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 25 },
  "claude-sonnet-5": { inputPer1M: 2, cachedInputPer1M: 0.2, outputPer1M: 10 }, // intro through 2026-08-31
  "claude-sonnet-4-6": { inputPer1M: 3, cachedInputPer1M: 0.3, outputPer1M: 15 },
  "claude-sonnet-4-5": { inputPer1M: 3, cachedInputPer1M: 0.3, outputPer1M: 15 },
  "claude-haiku-4-5": { inputPer1M: 1, cachedInputPer1M: 0.1, outputPer1M: 5 },
  "claude-fable-5-2": { inputPer1M: 8, cachedInputPer1M: 0.2, outputPer1M: 40 },
  "claude-fable-5": { inputPer1M: 10, cachedInputPer1M: 1, outputPer1M: 50 },
  "claude-mythos-5": { inputPer1M: 10, cachedInputPer1M: 1, outputPer1M: 50 },
  // ── Google Gemini (tiered models use the <200k tier) ──
  "gemini-3-pro": { inputPer1M: 2, cachedInputPer1M: 0.2, outputPer1M: 12 },
  "gemini-3.1-pro": { inputPer1M: 2, cachedInputPer1M: 0.2, outputPer1M: 12 },
  "gemini-3.5-flash": { inputPer1M: 1.5, cachedInputPer1M: 0.15, outputPer1M: 9 },
  "gemini-3-flash": { inputPer1M: 0.5, cachedInputPer1M: 0.05, outputPer1M: 3 },
  "gemini-3.1-flash-lite": { inputPer1M: 0.25, cachedInputPer1M: 0.025, outputPer1M: 1.5 },
  "gemini-2.5-pro": { inputPer1M: 1.25, cachedInputPer1M: 0.125, outputPer1M: 10 },
  "gemini-2.5-flash": { inputPer1M: 0.3, cachedInputPer1M: 0.03, outputPer1M: 2.5 },
  "gemini-2.5-flash-lite": { inputPer1M: 0.1, cachedInputPer1M: 0.01, outputPer1M: 0.4 },
  // ── DeepSeek (deepseek-chat / -reasoner map to v4-flash) ──
  "deepseek-chat": { inputPer1M: 0.14, cachedInputPer1M: 0.0028, outputPer1M: 0.28 },
  "deepseek-reasoner": { inputPer1M: 0.14, cachedInputPer1M: 0.0028, outputPer1M: 0.28 },
  "deepseek-v4-flash": { inputPer1M: 0.14, cachedInputPer1M: 0.0028, outputPer1M: 0.28 },
  "deepseek-v4-pro": { inputPer1M: 0.435, cachedInputPer1M: 0.003625, outputPer1M: 0.87 },
  // ── xAI Grok (cache rate for 4.x estimated at 0.25× input) ──
  "grok-4.3": { inputPer1M: 1.25, cachedInputPer1M: 0.3125, outputPer1M: 2.5 },
  "grok-build-0.1": { inputPer1M: 1, cachedInputPer1M: 0.25, outputPer1M: 2 }, // cache approx
  "grok-4": { inputPer1M: 3, cachedInputPer1M: 0.75, outputPer1M: 15 },
  "grok-4-fast": { inputPer1M: 0.2, cachedInputPer1M: 0.05, outputPer1M: 0.5 },
  "grok-code-fast-1": { inputPer1M: 0.2, cachedInputPer1M: 0.02, outputPer1M: 1.5 },
  // ── Cursor Composer ──
  "composer-2.5": { inputPer1M: 0.5, cachedInputPer1M: 0.2, outputPer1M: 2.5 },
  "composer-2": { inputPer1M: 0.5, cachedInputPer1M: 0.2, outputPer1M: 2.5 },
  "composer-1.5": { inputPer1M: 3.5, cachedInputPer1M: 0.35, outputPer1M: 17.5 },
  "composer-1": { inputPer1M: 1.25, cachedInputPer1M: 0.125, outputPer1M: 10 },
  // ── Other current SOTA coding models (approx; cache estimated) ──
  "kimi-k2": { inputPer1M: 0.6, cachedInputPer1M: 0.15, outputPer1M: 2.5 },
  "kimi-k2.6": { inputPer1M: 0.6, cachedInputPer1M: 0.15, outputPer1M: 2.5 },
  "glm-4.6": { inputPer1M: 0.6, cachedInputPer1M: 0.11, outputPer1M: 2 },
  "glm-4.7": { inputPer1M: 0.6, cachedInputPer1M: 0.11, outputPer1M: 2.2 },
  "glm-5": { inputPer1M: 1, cachedInputPer1M: 0.2, outputPer1M: 3.2 },
  "glm-5.1": { inputPer1M: 1.4, cachedInputPer1M: 0.28, outputPer1M: 4.4 },
  "qwen3-coder": { inputPer1M: 0.4, cachedInputPer1M: 0.04, outputPer1M: 2.4 },
  "qwen3-max": { inputPer1M: 1.2, cachedInputPer1M: 0.12, outputPer1M: 6 },
};

// Slugs that are themselves canonical: every priced model plus every alias
// TARGET. A canonical slug must never be rewritten by a colliding alias KEY from
// another provider — e.g. the Copilot map aliases "gpt-5.4" → "gpt-5", but
// "gpt-5.4" is the canonical (and default) Codex model and must stay itself.
const CANONICAL_SLUGS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(MODEL_PRICES),
  ...Object.values(MODEL_SLUG_ALIASES_BY_PROVIDER).flatMap((map) =>
    map ? Object.values(map) : [],
  ),
]);

function aliasesForProvider(provider: string | undefined): Record<string, string> | undefined {
  if (!provider) {
    return undefined;
  }
  return (MODEL_SLUG_ALIASES_BY_PROVIDER as Partial<Record<string, Record<string, string>>>)[
    provider
  ];
}

export function canonicalizeModel(model: string, provider?: string | undefined): string {
  const trimmed = model.trim();
  // Strip a provider prefix like "openai/gpt-5" → "gpt-5".
  const stripped = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const providerAliases = aliasesForProvider(provider);
  const providerCanonical = providerAliases?.[trimmed] ?? providerAliases?.[stripped];
  if (providerCanonical) return providerCanonical;
  if (CANONICAL_SLUGS.has(trimmed)) return trimmed;
  if (CANONICAL_SLUGS.has(stripped)) return stripped;
  return FLAT_ALIASES[trimmed] ?? FLAT_ALIASES[stripped] ?? stripped;
}

export function getModelPrice(model: string, provider?: string | undefined): ModelPrice | null {
  const canonical = canonicalizeModel(model, provider);
  const direct = MODEL_PRICES[canonical];
  if (direct) {
    return direct;
  }
  // Fallback for router/dated slugs (e.g. "gemini-3-pro-preview",
  // "claude-opus-4-8-20260101"): strip non-pricing suffixes and date stamps.
  // Pricing-relevant suffixes (-mini, -fast, -pro, -lite, -flash, -codex, -nano)
  // are intentionally preserved.
  let base = canonical;
  let previous = "";
  while (base !== previous) {
    previous = base;
    base = base.replace(/[-_](preview|latest|exp|experimental)$/i, "").replace(/[-_]\d{6,8}$/, "");
  }
  return (base === canonical ? undefined : MODEL_PRICES[base]) ?? null;
}

export interface TokenTotals {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
}

function tokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function unpricedTokenRemainder(tokens: TokenTotals): number {
  const totalTokens = tokenCount(tokens.totalTokens);
  if (totalTokens <= 0) {
    return 0;
  }
  return Math.max(
    0,
    totalTokens -
      tokenCount(tokens.inputTokens) -
      tokenCount(tokens.outputTokens) -
      tokenCount(tokens.cachedInputTokens),
  );
}

/**
 * Estimate spend for one model's token totals. `cachedInputTokens` is treated
 * as the discounted subset of `inputTokens`, matching Codex and the normalized
 * provider usage snapshots. Legacy buckets where cached reads were stored as a
 * separate input bucket are detected via `totalTokens` and still billed.
 * Returns `null` when the model has no known per-token price.
 */
export function estimateCostUsd(
  tokens: TokenTotals,
  model: string,
  provider?: string | undefined,
): number | null {
  const price = getModelPrice(model, provider);
  if (!price) {
    return null;
  }
  const inputTokens = tokenCount(tokens.inputTokens);
  const cachedInputTokens = tokenCount(tokens.cachedInputTokens);
  const outputTokens = tokenCount(tokens.outputTokens);
  const totalTokens = tokenCount(tokens.totalTokens);
  const hasBreakdown = inputTokens > 0 || cachedInputTokens > 0 || outputTokens > 0;
  if (!hasBreakdown && totalTokens > 0) {
    return null;
  }
  const extraBeyondInputOutput = Math.max(0, totalTokens - inputTokens - outputTokens);
  const overflowCachedInputTokens = Math.max(0, cachedInputTokens - inputTokens);
  const separateCachedInputTokens = Math.min(
    cachedInputTokens,
    Math.max(extraBeyondInputOutput, overflowCachedInputTokens),
  );
  const subsetCachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, cachedInputTokens - separateCachedInputTokens),
  );
  const uncachedInputTokens = Math.max(0, inputTokens - subsetCachedInputTokens);
  return (
    (uncachedInputTokens * price.inputPer1M +
      (subsetCachedInputTokens + separateCachedInputTokens) * price.cachedInputPer1M +
      outputTokens * price.outputPer1M) /
    1_000_000
  );
}

export interface AggregateCost {
  /** Total estimated spend across all priced models, in USD. */
  readonly usd: number;
  /** True when at least one model contributing tokens has no known price. */
  readonly hasUnpriced: boolean;
}

/** Sum estimated spend across many per-model token totals. */
export function estimateAggregateCost(
  rows: ReadonlyArray<
    TokenTotals & { readonly model: string; readonly provider?: string | undefined }
  >,
): AggregateCost {
  let usd = 0;
  let hasUnpriced = false;
  for (const row of rows) {
    const cost = estimateCostUsd(row, row.model, row.provider);
    if (cost === null) {
      if (
        row.inputTokens > 0 ||
        row.outputTokens > 0 ||
        row.cachedInputTokens > 0 ||
        (row.totalTokens ?? 0) > 0
      ) {
        hasUnpriced = true;
      }
      continue;
    }
    usd += cost;
    if (unpricedTokenRemainder(row) > 0) {
      hasUnpriced = true;
    }
  }
  return { usd, hasUnpriced };
}

export function formatUsd(amount: number): string {
  if (amount <= 0) {
    return "$0.00";
  }
  if (amount < 0.01) {
    return "<$0.01";
  }
  if (amount < 1000) {
    return `$${amount.toFixed(2)}`;
  }
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}
