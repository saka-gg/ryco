import type {
  UsageCalendarDate,
  UsageCostBreakdown,
  UsageCostSource,
  UsageDailyBucket,
  UsageTokenTotals,
} from "@ryco/contracts";

import { makeUsageDayFormatter } from "./usageDay.ts";
import { priceUsageRecord, resolveUsageModel, type UsagePricingPolicy } from "./usagePricing.ts";
import { addUsageTokenTotals, EMPTY_USAGE_TOKEN_TOTALS, type UsageRecord } from "./usageRecord.ts";

export { makeUsageDayFormatter };

export interface UsageRecordPrice {
  readonly estimatedCostUsd: number | null;
  readonly estimatedCacheSavingsUsd: number | null;
  /**
   * The tokens' cost at the billed speed's list rates by token type, or null without a rate:
   * the estimate itself, or the proportions a provider-reported cost is split in
   * ({@link UsageCostBreakdownSum}).
   */
  readonly listCostBreakdown: UsageCostBreakdown | null;
  readonly pricedTokenCount: number;
  readonly unpricedTokenCount: number;
  /** The part of `pricedTokenCount` priced from a custom price. */
  readonly customPricedTokenCount: number;
  readonly costSource: Exclude<UsageCostSource, "mixed">;
}

export interface UsageAggregationOptions {
  readonly sourceId: string;
  readonly timeZone: string;
  readonly startDate?: UsageCalendarDate;
  readonly endDate: UsageCalendarDate;
  /** Prices records and maps their model IDs; without it only provider-reported cost counts. */
  readonly pricing?: UsagePricingPolicy;
  readonly retainExportIdentity?: boolean;
}

type MutableCostBreakdown = { -readonly [K in keyof UsageCostBreakdown]-?: number };

const emptyCostBreakdown = (): MutableCostBreakdown => ({
  inputUsd: 0,
  cacheReadUsd: 0,
  cacheWriteUsd: 0,
  outputUsd: 0,
  speedPremiumUsd: 0,
});

function addCostBreakdown(target: MutableCostBreakdown, split: UsageCostBreakdown): void {
  target.inputUsd += split.inputUsd;
  target.cacheReadUsd += split.cacheReadUsd;
  target.cacheWriteUsd += split.cacheWriteUsd;
  target.outputUsd += split.outputUsd;
  target.speedPremiumUsd += split.speedPremiumUsd ?? 0;
}

/** Emitted splits are rounded to 1e-8 USD: full doubles print 17 digits in every bucket. */
const roundUsd = (value: number) => Math.round(value * 1e8) / 1e8;

/**
 * The cost split of one bucket's prices. Rate-based estimates add up as they are. A
 * provider-reported cost is split in proportion to the list-rate split of the same tokens,
 * pooled over the bucket: every sum is linear in tokens, so 15-minute slots split exactly like
 * their records. Reported cost without a rate (or without list cost) stays unsplit.
 */
export class UsageCostBreakdownSum {
  readonly #estimated = emptyCostBreakdown();
  readonly #listed = emptyCostBreakdown();
  #reportedUsd = 0;
  #hasEstimate = false;
  #hasReported = false;

  add(price: UsageRecordPrice): void {
    const split = price.listCostBreakdown;
    if (split === null || price.estimatedCostUsd === null) return;
    if (price.costSource === "provider-reported") {
      addCostBreakdown(this.#listed, split);
      this.#reportedUsd += price.estimatedCostUsd;
      this.#hasReported = true;
    } else {
      addCostBreakdown(this.#estimated, split);
      this.#hasEstimate = true;
    }
  }

  finish(): UsageCostBreakdown | undefined {
    const listed = this.#listed;
    const listUsd = listed.inputUsd + listed.cacheReadUsd + listed.cacheWriteUsd + listed.outputUsd;
    const scale = this.#hasReported && listUsd > 0 ? this.#reportedUsd / listUsd : null;
    if (!this.#hasEstimate && scale === null) return undefined;
    const part = (field: keyof MutableCostBreakdown) =>
      roundUsd(this.#estimated[field] + listed[field] * (scale ?? 0));
    const speedPremiumUsd = part("speedPremiumUsd");
    return {
      inputUsd: part("inputUsd"),
      cacheReadUsd: part("cacheReadUsd"),
      cacheWriteUsd: part("cacheWriteUsd"),
      outputUsd: part("outputUsd"),
      ...(speedPremiumUsd > 0 ? { speedPremiumUsd } : {}),
    };
  }
}

export interface UsageAggregationResult {
  readonly buckets: readonly UsageDailyBucket[];
  readonly duplicatesDropped: number;
  readonly outOfWindow: number;
  readonly acceptedRecords: number;
}

interface MutableBucket {
  exportRecordId?: string;
  exportSessionId?: string;
  tokens: UsageTokenTotals;
  responseCount: number;
  sessions: Set<string>;
  estimatedCostUsd: number;
  estimatedCacheSavingsUsd: number;
  hasCost: boolean;
  hasCacheSavings: boolean;
  costBreakdown: UsageCostBreakdownSum;
  pricedTokenCount: number;
  unpricedTokenCount: number;
  customPricedTokenCount: number;
  costSources: Set<Exclude<UsageCostSource, "mixed">>;
}

function defaultPrice(record: UsageRecord): UsageRecordPrice {
  if (record.reportedCostUsd !== null) {
    return {
      estimatedCostUsd: record.reportedCostUsd,
      estimatedCacheSavingsUsd: null,
      listCostBreakdown: null,
      pricedTokenCount: record.totals.totalTokens,
      unpricedTokenCount: 0,
      customPricedTokenCount: 0,
      costSource: "provider-reported",
    };
  }
  return {
    estimatedCostUsd: null,
    estimatedCacheSavingsUsd: null,
    listCostBreakdown: null,
    pricedTokenCount: 0,
    unpricedTokenCount: record.totals.totalTokens,
    customPricedTokenCount: 0,
    costSource: "unpriced",
  };
}

function resolveCostSource(
  sources: ReadonlySet<Exclude<UsageCostSource, "mixed">>,
): UsageCostSource {
  if (sources.size === 1) return sources.values().next().value ?? "unpriced";
  return "mixed";
}

export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #seenDedupeKeys = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #options: UsageAggregationOptions;
  #duplicatesDropped = 0;
  #outOfWindow = 0;
  #acceptedRecords = 0;

  constructor(options: UsageAggregationOptions) {
    this.#options = options;
    this.#toDay = makeUsageDayFormatter(options.timeZone);
  }

  add(record: UsageRecord): boolean {
    if (record.dedupeKey !== null) {
      if (this.#seenDedupeKeys.has(record.dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seenDedupeKeys.add(record.dedupeKey);
    }

    const date = this.#toDay(record.timestampMs);
    if (
      (this.#options.startDate !== undefined && date < this.#options.startDate) ||
      date > this.#options.endDate
    ) {
      this.#outOfWindow += 1;
      return false;
    }

    const { pricing: policy } = this.#options;
    const resolution = policy === undefined ? null : resolveUsageModel(policy, record.model);
    const model = resolution?.model ?? record.model;
    const exportRecordId =
      this.#options.retainExportIdentity && record.provider === "cursor" ? record.dedupeKey : null;
    const key = `${date}\0${record.provider}\0${model}${exportRecordId === null ? "" : `\0${exportRecordId}`}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        ...(exportRecordId === null
          ? {}
          : { exportRecordId, ...(record.sessionId ? { exportSessionId: record.sessionId } : {}) }),
        tokens: EMPTY_USAGE_TOKEN_TOTALS,
        responseCount: 0,
        sessions: new Set<string>(),
        estimatedCostUsd: 0,
        estimatedCacheSavingsUsd: 0,
        hasCost: false,
        hasCacheSavings: false,
        costBreakdown: new UsageCostBreakdownSum(),
        pricedTokenCount: 0,
        unpricedTokenCount: 0,
        customPricedTokenCount: 0,
        costSources: new Set(),
      };
      this.#buckets.set(key, bucket);
    }

    const pricing =
      resolution === null ? defaultPrice(record) : priceUsageRecord(resolution, record);
    bucket.tokens =
      bucket.responseCount === 0
        ? record.totals
        : addUsageTokenTotals(bucket.tokens, record.totals);
    bucket.responseCount += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    if (pricing.estimatedCostUsd !== null) {
      bucket.estimatedCostUsd += pricing.estimatedCostUsd;
      bucket.hasCost = true;
    }
    if (pricing.estimatedCacheSavingsUsd !== null) {
      bucket.estimatedCacheSavingsUsd += pricing.estimatedCacheSavingsUsd;
      bucket.hasCacheSavings = true;
    }
    bucket.costBreakdown.add(pricing);
    bucket.pricedTokenCount += pricing.pricedTokenCount;
    bucket.unpricedTokenCount += pricing.unpricedTokenCount;
    bucket.customPricedTokenCount += pricing.customPricedTokenCount;
    bucket.costSources.add(pricing.costSource);
    this.#acceptedRecords += 1;
    return true;
  }

  finish(): UsageAggregationResult {
    const buckets: UsageDailyBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [date = "", provider = "", model = ""] = key.split("\0");
      const costBreakdown = bucket.costBreakdown.finish();
      buckets.push({
        sourceId: this.#options.sourceId,
        ...(bucket.exportRecordId === undefined ? {} : { exportRecordId: bucket.exportRecordId }),
        ...(bucket.exportSessionId === undefined
          ? {}
          : { exportSessionId: bucket.exportSessionId }),
        date: date as UsageCalendarDate,
        provider: provider as UsageDailyBucket["provider"],
        model,
        tokens: bucket.tokens,
        responseCount: bucket.responseCount,
        sessionCount: bucket.sessions.size,
        ...(bucket.hasCost ? { estimatedCostUsd: bucket.estimatedCostUsd } : {}),
        ...(bucket.hasCacheSavings
          ? { estimatedCacheSavingsUsd: bucket.estimatedCacheSavingsUsd }
          : {}),
        ...(costBreakdown === undefined ? {} : { costBreakdown }),
        pricedTokenCount: bucket.pricedTokenCount,
        unpricedTokenCount: bucket.unpricedTokenCount,
        ...(bucket.customPricedTokenCount > 0
          ? { customPricedTokenCount: bucket.customPricedTokenCount }
          : {}),
        costSource: resolveCostSource(bucket.costSources),
      });
    }
    buckets.sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
    );
    return {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
      acceptedRecords: this.#acceptedRecords,
    };
  }
}
