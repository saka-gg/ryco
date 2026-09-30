// @effect-diagnostics globalDate:off
import type {
  UsageCalendarDate,
  UsageCostSource,
  UsageDailyBucket,
  UsageTokenTotals,
} from "@ryco/contracts";

import { addUsageTokenTotals, EMPTY_USAGE_TOKEN_TOTALS, type UsageRecord } from "./usageRecord.ts";

export interface UsageRecordPrice {
  readonly estimatedCostUsd: number | null;
  readonly estimatedCacheSavingsUsd: number | null;
  readonly pricedTokenCount: number;
  readonly unpricedTokenCount: number;
  readonly costSource: Exclude<UsageCostSource, "mixed">;
}

export type UsageRecordPricer = (record: UsageRecord) => UsageRecordPrice;

export interface UsageAggregationOptions {
  readonly sourceId: string;
  readonly timeZone: string;
  readonly startDate?: UsageCalendarDate;
  readonly endDate: UsageCalendarDate;
  readonly price?: UsageRecordPricer;
  readonly retainExportIdentity?: boolean;
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
  pricedTokenCount: number;
  unpricedTokenCount: number;
  costSources: Set<Exclude<UsageCostSource, "mixed">>;
}

export function makeUsageDayFormatter(timeZone: string): (timestampMs: number) => string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (timestampMs) => formatter.format(new Date(timestampMs));
}

function defaultPrice(record: UsageRecord): UsageRecordPrice {
  if (record.reportedCostUsd !== null) {
    return {
      estimatedCostUsd: record.reportedCostUsd,
      estimatedCacheSavingsUsd: null,
      pricedTokenCount: record.totals.totalTokens,
      unpricedTokenCount: 0,
      costSource: "provider-reported",
    };
  }
  return {
    estimatedCostUsd: null,
    estimatedCacheSavingsUsd: null,
    pricedTokenCount: 0,
    unpricedTokenCount: record.totals.totalTokens,
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

    const exportRecordId =
      this.#options.retainExportIdentity && record.provider === "cursor" ? record.dedupeKey : null;
    const key = `${date}\0${record.provider}\0${record.model}${exportRecordId === null ? "" : `\0${exportRecordId}`}`;
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
        pricedTokenCount: 0,
        unpricedTokenCount: 0,
        costSources: new Set(),
      };
      this.#buckets.set(key, bucket);
    }

    const pricing = (this.#options.price ?? defaultPrice)(record);
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
    bucket.pricedTokenCount += pricing.pricedTokenCount;
    bucket.unpricedTokenCount += pricing.unpricedTokenCount;
    bucket.costSources.add(pricing.costSource);
    this.#acceptedRecords += 1;
    return true;
  }

  finish(): UsageAggregationResult {
    const buckets: UsageDailyBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [date = "", provider = "", model = ""] = key.split("\0");
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
        pricedTokenCount: bucket.pricedTokenCount,
        unpricedTokenCount: bucket.unpricedTokenCount,
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
