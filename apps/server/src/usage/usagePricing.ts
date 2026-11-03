import type {
  UsageCostBreakdown,
  UsageModelPrice,
  UsagePriceOverrides,
  UsageTokenTotals,
} from "@ryco/contracts";
import {
  indexUsagePriceOverrides,
  isSyntheticUsageModel,
  matchUsageModelKey,
  normalizeUsageModelKey,
  resolveUsageModelMappings,
  usageModelBaseKey,
} from "@ryco/shared/usagePriceOverrides";

import type { UsageRecordPrice } from "./usageAggregation.ts";
import type { UsageRecord, UsageSpeed } from "./usageRecord.ts";

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

/** Model families without a generation: no published rate can be assumed for them. */
const AMBIGUOUS_MODEL_NAMES = new Set(["", "opus", "sonnet", "haiku", "fable"]);

export function lookupUsageModelRate(rates: UsageRateTable, model: string): UsageModelRate | null {
  const key = usageModelBaseKey(model);
  const bare = normalizeUsageModelName(key);
  if (AMBIGUOUS_MODEL_NAMES.has(bare) || isSyntheticUsageModel(bare)) return null;
  // Native provider prefixes describe the same API model. Arbitrary gateways
  // retain their own rates and must never fall back to a different provider.
  return (
    rates.get(key) ?? (/^(openai|anthropic)\//.test(key) ? rates.get(bare) : undefined) ?? null
  );
}

/** A custom price as a rate at every speed: no fast tier, so no speed premium. */
function customUsageModelRate(price: UsageModelPrice): UsageModelRate {
  const input = price.inputUsdPerMillion / 1e6;
  return {
    inputCostPerToken: input,
    outputCostPerToken: price.outputUsdPerMillion / 1e6,
    cacheReadCostPerToken: (price.cacheReadUsdPerMillion ?? price.inputUsdPerMillion) / 1e6,
    cacheCreationCostPerToken: (price.cacheWriteUsdPerMillion ?? price.inputUsdPerMillion) / 1e6,
    fast: null,
    ultrafast: null,
  };
}

/** The settings' custom prices and resolved mappings, by normalized model key. */
export interface UsagePriceOverrideTables {
  readonly prices: ReadonlyMap<string, UsageModelRate>;
  readonly mappings: ReadonlyMap<string, string>;
  /** The keys of both: a model's own entry of either kind shadows its base model's. */
  readonly keys: ReadonlySet<string>;
}

export function compileUsagePriceOverrides(
  overrides: UsagePriceOverrides,
): UsagePriceOverrideTables {
  const index = indexUsagePriceOverrides(Object.entries(overrides));
  const prices = new Map<string, UsageModelRate>();
  for (const [key, override] of index)
    if (override.price !== undefined) prices.set(key, customUsageModelRate(override.price));
  const mappings = resolveUsageModelMappings(index);
  return { prices, mappings, keys: new Set([...prices.keys(), ...mappings.keys()]) };
}

/** How a recorded model ID is reported and priced. */
export interface UsageModelResolution {
  /** The model the usage is reported under: a mapping's target as typed, else the recorded ID. */
  readonly model: string;
  readonly rate: UsageModelRate | null;
  /** The rate is a custom price: it replaces provider-reported cost. */
  readonly custom: boolean;
}

/** Rates and the node's overrides, captured once per summary so that every source prices alike. */
export interface UsagePricingPolicy extends UsagePriceOverrideTables {
  readonly rates: UsageRateTable;
  /** Resolutions by recorded model ID, filled on first use. */
  readonly resolved: Map<string, UsageModelResolution>;
}

export function makeUsagePricingPolicy(
  rates: UsageRateTable,
  overrides: UsagePriceOverrideTables = { prices: new Map(), mappings: new Map(), keys: new Set() },
): UsagePricingPolicy {
  return { ...overrides, rates, resolved: new Map() };
}

/**
 * The model's own entry applies, else that of its base model without a `[..]` context suffix:
 * a mapping prices the model like its target (the target's custom price, else its published
 * rate), a custom price replaces the published rate. Explicit entries also price model families
 * that published rates leave unpriced, but never synthetic placeholders.
 */
export function resolveUsageModel(
  policy: UsagePricingPolicy,
  recordedModel: string,
): UsageModelResolution {
  let resolution = policy.resolved.get(recordedModel);
  if (resolution === undefined) {
    const entryKey = (model: string) =>
      isSyntheticUsageModel(model) ? undefined : matchUsageModelKey(policy.keys, model);
    const own = entryKey(recordedModel);
    const mapTo = own === undefined ? undefined : policy.mappings.get(own);
    // Keys match without case, so a mapped model reports under its target's key: a target typed
    // in another case than history records shares that model's bucket instead of splitting it.
    const model = mapTo === undefined ? recordedModel : normalizeUsageModelKey(mapTo);
    // A mapping's target ends its chain: its entry, if any, is a custom price.
    const priceKey = mapTo === undefined ? own : entryKey(mapTo);
    const price = priceKey === undefined ? undefined : policy.prices.get(priceKey);
    resolution =
      price === undefined
        ? { model, rate: lookupUsageModelRate(policy.rates, model), custom: false }
        : { model, rate: price, custom: true };
    policy.resolved.set(recordedModel, resolution);
  }
  return resolution;
}

type UsageTokenCounts = Pick<
  UsageTokenTotals,
  "uncachedInputTokens" | "cachedInputTokens" | "cacheCreationInputTokens" | "outputTokens"
>;

type UsageCostParts = Omit<UsageCostBreakdown, "speedPremiumUsd">;

/** Cost per token type; cache tokens without a published rate cost the input rate. */
export function estimateUsageCostParts(
  rate: UsageTokenRate,
  totals: UsageTokenCounts,
): UsageCostParts {
  return {
    inputUsd: totals.uncachedInputTokens * rate.inputCostPerToken,
    cacheReadUsd: totals.cachedInputTokens * (rate.cacheReadCostPerToken ?? rate.inputCostPerToken),
    cacheWriteUsd:
      totals.cacheCreationInputTokens * (rate.cacheCreationCostPerToken ?? rate.inputCostPerToken),
    outputUsd: totals.outputTokens * rate.outputCostPerToken,
  };
}

function sumUsageCostParts(parts: UsageCostParts): number {
  return parts.inputUsd + parts.cacheReadUsd + parts.cacheWriteUsd + parts.outputUsd;
}

export function estimateUsageCost(rate: UsageTokenRate, totals: UsageTokenCounts): number {
  return sumUsageCostParts(estimateUsageCostParts(rate, totals));
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

/** Summed usage of responses sharing a model, speed and cost kind (see `usageFileAggregate`). */
export interface UsageSlotTotals {
  readonly count: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Sum over the responses that reported a reasoning count. */
  readonly reasoningTokens: number;
  readonly reasoningMissingCount: number;
  /** Responses without cached input: their cache savings are known (zero) at any rate. */
  readonly zeroCachedCount: number;
  /** Sum of provider-reported costs (only for `reported` slots). */
  readonly reportedCostUsd: number;
}

/** A speed without its own published tier is billed at standard rates. */
function resolveSpeedRate(standard: UsageModelRate, speed: UsageSpeed | undefined): UsageTokenRate {
  return (
    (speed === "fast" ? standard.fast : speed === "ultrafast" ? standard.ultrafast : null) ??
    standard
  );
}

/**
 * {@link estimateUsageCostParts} at the billed rate, with what a fast/ultrafast tier added over
 * the standard rates of the same tokens (absent at standard rates).
 */
function estimateUsageCostBreakdown(
  standard: UsageModelRate,
  billed: UsageTokenRate,
  totals: UsageTokenCounts,
): UsageCostBreakdown {
  const parts = estimateUsageCostParts(billed, totals);
  if (billed === standard) return parts;
  const premium = sumUsageCostParts(parts) - estimateUsageCost(standard, totals);
  return premium > 0 ? { ...parts, speedPremiumUsd: premium } : parts;
}

/** {@link estimateUsageCacheSavings} summed over a slot's responses (it is linear per response). */
function estimateSlotCacheSavings(rate: UsageTokenRate, totals: UsageSlotTotals): number | null {
  if (rate.cacheReadCostPerToken === null) {
    // Responses with cached input have unknown savings; the others save exactly nothing.
    return totals.zeroCachedCount > 0 ? 0 : null;
  }
  return Math.max(
    0,
    totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken),
  );
}

/**
 * Provider-reported cost takes precedence over published rates (a known rate still prices
 * savings and the split); a custom price replaces it.
 */
function priceUsageTokens<Totals extends UsageTokenCounts & { readonly totalTokens: number }>(
  resolution: UsageModelResolution,
  speed: UsageSpeed | undefined,
  totals: Totals,
  reported: number | null,
  cacheSavings: (rate: UsageTokenRate, totals: Totals) => number | null,
): UsageRecordPrice {
  const standard = resolution.rate;
  const reportedCostUsd = resolution.custom ? null : reported;
  if (standard === null) {
    return reportedCostUsd === null
      ? {
          estimatedCostUsd: null,
          estimatedCacheSavingsUsd: null,
          listCostBreakdown: null,
          pricedTokenCount: 0,
          unpricedTokenCount: totals.totalTokens,
          customPricedTokenCount: 0,
          costSource: "unpriced",
        }
      : {
          estimatedCostUsd: reportedCostUsd,
          estimatedCacheSavingsUsd: null,
          listCostBreakdown: null,
          pricedTokenCount: totals.totalTokens,
          unpricedTokenCount: 0,
          customPricedTokenCount: 0,
          costSource: "provider-reported",
        };
  }
  const rate = resolveSpeedRate(standard, speed);
  const listCostBreakdown = estimateUsageCostBreakdown(standard, rate, totals);
  return {
    estimatedCostUsd: reportedCostUsd ?? sumUsageCostParts(listCostBreakdown),
    estimatedCacheSavingsUsd: cacheSavings(rate, totals),
    listCostBreakdown,
    pricedTokenCount: totals.totalTokens,
    unpricedTokenCount: 0,
    customPricedTokenCount: resolution.custom ? totals.totalTokens : 0,
    // Custom prices are rate-based estimates too.
    costSource: reportedCostUsd === null ? "litellm" : "provider-reported",
  };
}

export function priceUsageRecord(
  resolution: UsageModelResolution,
  record: UsageRecord,
): UsageRecordPrice {
  return priceUsageTokens(
    resolution,
    record.speed,
    record.totals,
    record.reportedCostUsd,
    estimateUsageCacheSavings,
  );
}

/**
 * {@link priceUsageRecord} summed over the responses of one slot: every response of a slot has
 * the same model, speed and cost kind, and per-response pricing is linear in its tokens.
 */
export function priceUsageSlot(
  resolution: UsageModelResolution,
  slot: { readonly speed: UsageSpeed | undefined; readonly reported: boolean },
  totals: UsageSlotTotals,
): UsageRecordPrice {
  return priceUsageTokens(
    resolution,
    slot.speed,
    totals,
    slot.reported ? totals.reportedCostUsd : null,
    estimateSlotCacheSavings,
  );
}
