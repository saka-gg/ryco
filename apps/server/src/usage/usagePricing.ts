import type { UsageTokenTotals } from "@ryco/contracts";

import type { UsageRecordPrice } from "./usageAggregation.ts";
import type { UsageRecord } from "./usageRecord.ts";

interface UsageTokenRate {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number | null;
  readonly cacheCreationCostPerToken: number | null;
}

export interface UsageModelRate extends UsageTokenRate {
  readonly fast?: UsageTokenRate | null;
  readonly ultrafast?: UsageTokenRate | null;
}

export type UsageRateTable = ReadonlyMap<string, UsageModelRate>;

type LiteLlmEntry = Readonly<Record<string, unknown>>;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeUsageModelName(model: string): string {
  const normalized = model.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function readTokenRate(
  entry: LiteLlmEntry,
  suffix = "",
  standard?: UsageTokenRate,
): UsageTokenRate | null {
  const input = finiteNonNegative(entry[`input_cost_per_token${suffix}`]);
  const output = finiteNonNegative(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;
  const cacheRate = (key: string, field: "cacheReadCostPerToken" | "cacheCreationCostPerToken") =>
    finiteNonNegative(entry[`${key}${suffix}`]) ??
    (standard && standard.inputCostPerToken > 0
      ? ((standard[field] ?? standard.inputCostPerToken) / standard.inputCostPerToken) * input
      : null);
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: cacheRate("cache_read_input_token_cost", "cacheReadCostPerToken"),
    cacheCreationCostPerToken: cacheRate(
      "cache_creation_input_token_cost",
      "cacheCreationCostPerToken",
    ),
  };
}

function sameRate(left: UsageModelRate, right: UsageModelRate): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseUsageRateTable(document: unknown): UsageRateTable {
  const rates = new Map<string, UsageModelRate>();
  if (typeof document !== "object" || document === null) return rates;
  for (const [model, rawEntry] of Object.entries(document)) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as LiteLlmEntry;
    const standard = readTokenRate(entry);
    const key = model.trim().toLowerCase();
    if (standard === null || key.length === 0) continue;
    const specific = entry.provider_specific_entry;
    const multiple =
      typeof specific === "object" && specific !== null
        ? finiteNonNegative((specific as Record<string, unknown>).fast)
        : null;
    const scaled = (value: number | null) => (value === null ? null : value * multiple!);
    rates.set(key, {
      ...standard,
      fast:
        multiple !== null && multiple > 0
          ? {
              inputCostPerToken: standard.inputCostPerToken * multiple,
              outputCostPerToken: standard.outputCostPerToken * multiple,
              cacheReadCostPerToken: scaled(standard.cacheReadCostPerToken),
              cacheCreationCostPerToken: scaled(standard.cacheCreationCostPerToken),
            }
          : readTokenRate(entry, "_priority", standard),
      ultrafast: readTokenRate(entry, "_ultrafast", standard),
    });
  }
  // Keep qualified rates intact. Only unambiguous entries can supply a bare alias.
  const aliases = new Map<string, UsageModelRate | null>();
  for (const [key, rate] of rates) {
    const bare = normalizeUsageModelName(key);
    if (bare === key || rates.has(bare)) continue;
    const previous = aliases.get(bare);
    if (previous === undefined) aliases.set(bare, rate);
    else if (previous !== null && !sameRate(previous, rate)) aliases.set(bare, null);
  }
  for (const [key, rate] of aliases) if (rate !== null) rates.set(key, rate);
  return rates;
}

/** Serialize validated standard and speed rates without collapsing provider keys. */
export function encodeUsageRateTable(rates: UsageRateTable): Readonly<Record<string, unknown>> {
  const fields = (rate: UsageTokenRate, suffix = "") => ({
    [`input_cost_per_token${suffix}`]: rate.inputCostPerToken,
    [`output_cost_per_token${suffix}`]: rate.outputCostPerToken,
    ...(rate.cacheReadCostPerToken === null
      ? {}
      : { [`cache_read_input_token_cost${suffix}`]: rate.cacheReadCostPerToken }),
    ...(rate.cacheCreationCostPerToken === null
      ? {}
      : { [`cache_creation_input_token_cost${suffix}`]: rate.cacheCreationCostPerToken }),
  });
  return Object.fromEntries(
    [...rates].map(([model, rate]) => [
      model,
      {
        ...fields(rate),
        ...(rate.fast ? fields(rate.fast, "_priority") : {}),
        ...(rate.ultrafast ? fields(rate.ultrafast, "_ultrafast") : {}),
      },
    ]),
  );
}

const UNPRICEABLE_MODEL_NAMES = new Set([
  "",
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

export function lookupUsageModelRate(rates: UsageRateTable, model: string): UsageModelRate | null {
  const key = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "");
  const bare = normalizeUsageModelName(key);
  if (UNPRICEABLE_MODEL_NAMES.has(bare)) return null;
  // Native provider prefixes describe the same API model. Arbitrary gateways
  // retain their own rates and must never fall back to a different provider.
  return (
    rates.get(key) ?? (/^(openai|anthropic)\//.test(key) ? rates.get(bare) : undefined) ?? null
  );
}

export function estimateUsageCost(rate: UsageTokenRate, totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * (rate.cacheReadCostPerToken ?? rate.inputCostPerToken) +
    totals.cacheCreationInputTokens * (rate.cacheCreationCostPerToken ?? rate.inputCostPerToken) +
    totals.outputTokens * rate.outputCostPerToken
  );
}

export function estimateUsageCacheSavings(
  rate: UsageTokenRate,
  totals: UsageTokenTotals,
): number | null {
  if (totals.cachedInputTokens > 0 && rate.cacheReadCostPerToken === null) return null;
  // Cache writes are a premium, not savings; a missing write price must not
  // erase known read savings.
  return Math.max(
    0,
    totals.cachedInputTokens *
      (rate.inputCostPerToken - (rate.cacheReadCostPerToken ?? rate.inputCostPerToken)),
  );
}

export function priceUsageRecord(rates: UsageRateTable, record: UsageRecord): UsageRecordPrice {
  const standard = lookupUsageModelRate(rates, record.model);
  const rate =
    standard === null
      ? null
      : ((record.speed === "fast"
          ? standard.fast
          : record.speed === "ultrafast"
            ? standard.ultrafast
            : null) ?? standard);
  if (record.reportedCostUsd !== null) {
    return {
      estimatedCostUsd: record.reportedCostUsd,
      estimatedCacheSavingsUsd:
        rate === null ? null : estimateUsageCacheSavings(rate, record.totals),
      pricedTokenCount: record.totals.totalTokens,
      unpricedTokenCount: 0,
      costSource: "provider-reported",
    };
  }
  if (rate === null) {
    return {
      estimatedCostUsd: null,
      estimatedCacheSavingsUsd: null,
      pricedTokenCount: 0,
      unpricedTokenCount: record.totals.totalTokens,
      costSource: "unpriced",
    };
  }
  return {
    estimatedCostUsd: estimateUsageCost(rate, record.totals),
    estimatedCacheSavingsUsd: estimateUsageCacheSavings(rate, record.totals),
    pricedTokenCount: record.totals.totalTokens,
    unpricedTokenCount: 0,
    costSource: "litellm",
  };
}
