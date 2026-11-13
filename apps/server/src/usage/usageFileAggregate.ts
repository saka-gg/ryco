/**
 * Usage of one transcript file folded into 15-minute slots, so the scan cache holds per-file
 * aggregates instead of every parsed response and a summary costs O(slots), not O(records).
 *
 * A slot is one (UTC 15-minute window, model, speed, session, provider-reported cost or not)
 * combination with summed token counts. Every current IANA offset and DST transition is a
 * multiple of 15 minutes, so a slot never straddles a local midnight and the per-day result
 * matches per-record bucketing in every time zone (only pre-1980 timestamps in zones with
 * irregular historical offsets could differ). Pricing is linear in tokens per (model, speed),
 * so a slot is priced once from its sums; USD totals and their split by token type (reported
 * cost is split per bucket, see `UsageCostBreakdownSum`) match per-record pricing up to
 * floating-point summation order.
 *
 * Responses with a cross-file identity (`dedupeKey`, which providers copy into other
 * transcripts) cannot be folded: a later file's copy must be dropped while the first is kept.
 * They are retained compactly (key, slot index and seven numbers in typed arrays), not as
 * record objects, and are added per summary only when their key is new.
 */
import type { UsageCalendarDate, UsageCostSource, UsageDailyBucket } from "@ryco/contracts";

import { makeUsageDayFormatter, UsageCostBreakdownSum } from "./usageAggregation.ts";
import {
  priceUsageSlot,
  resolveUsageModel,
  type UsagePricingPolicy,
  type UsageSlotTotals,
} from "./usagePricing.ts";
import type { UsageRecord, UsageSpeed } from "./usageRecord.ts";

export const USAGE_SLOT_MS = 15 * 60 * 1000;

/** Values per keyed response in {@link UsageFileAggregate.keyValues}. */
export const USAGE_KEY_VALUE_STRIDE = 7;
const UNCACHED = 0;
const CACHED = 1;
const CACHE_CREATION = 2;
const OUTPUT = 3;
const TOTAL = 4;
/** NaN when the response reported no reasoning count. */
const REASONING = 5;
/** NaN when the provider reported no cost. */
const REPORTED_COST = 6;

export interface UsageSlot extends UsageSlotTotals {
  readonly slotMs: number;
  readonly model: string;
  readonly speed: UsageSpeed | undefined;
  readonly sessionId: string;
  /** Responses whose cost the provider reported (priced as reported, not from rates). */
  readonly reported: boolean;
  /** The directory the session ran in; empty when unknown. */
  readonly cwd: string;
  /** Subagent work (see `UsageRecord.sidechain`). */
  readonly sidechain: boolean;
  /** The session that ran the work when it is not `sessionId`; empty otherwise. */
  readonly ownerSessionId: string;
  /** Ryco started the session (see `UsageRecord.rycoClient`). */
  readonly rycoClient: boolean;
}

export interface UsageFileAggregate {
  readonly recordCount: number;
  /** Slot dimensions with the sums of the file's keyless responses (zero when all are keyed). */
  readonly slots: readonly UsageSlot[];
  /** Keyed responses in file order. */
  readonly keys: readonly string[];
  readonly keySlots: Uint32Array;
  readonly keyValues: Float64Array;
}

/**
 * Rows a cached aggregate keeps resident, which is also what a summary walks:
 * its slots plus its keyed responses. Keyless responses fold into their slot,
 * so this is usually far below {@link UsageFileAggregate.recordCount}.
 */
export function usageFileAggregateRetainedRows(aggregate: UsageFileAggregate): number {
  return aggregate.slots.length + aggregate.keys.length;
}

export const EMPTY_USAGE_FILE_AGGREGATE: UsageFileAggregate = {
  recordCount: 0,
  slots: [],
  keys: [],
  keySlots: new Uint32Array(0),
  keyValues: new Float64Array(0),
};

type MutableSlot = { -readonly [K in keyof UsageSlot]: UsageSlot[K] };

export const emptySlotTotals = (): { -readonly [K in keyof UsageSlotTotals]: number } => ({
  count: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  reasoningMissingCount: 0,
  zeroCachedCount: 0,
  reportedCostUsd: 0,
});

function slotIdentity(slot: Omit<UsageSlot, keyof UsageSlotTotals>): string {
  return `${slot.slotMs}\0${slot.model}\0${slot.speed ?? ""}\0${slot.sessionId}\0${slot.reported ? 1 : 0}\0${slot.cwd}\0${slot.sidechain ? 1 : 0}\0${slot.ownerSessionId}\0${slot.rycoClient ? 1 : 0}`;
}

/** Folds one file's (within-file deduplicated) records. */
export function buildUsageFileAggregate(records: readonly UsageRecord[]): UsageFileAggregate {
  return appendUsageFileAggregate(EMPTY_USAGE_FILE_AGGREGATE, records);
}

/**
 * `base` with more of the same file's records folded in: the records an appended file gained
 * since `base` was built. A keyed record whose key `base` (or an earlier record) already has is
 * dropped, as within-file deduplication would have. `base` is not changed.
 */
export function appendUsageFileAggregate(
  base: UsageFileAggregate,
  records: readonly UsageRecord[],
): UsageFileAggregate {
  if (records.length === 0) return base;
  const slots: MutableSlot[] = base.slots.map((slot) => ({ ...slot }));
  const slotIndexes = new Map<string, number>();
  for (const [index, slot] of slots.entries()) slotIndexes.set(slotIdentity(slot), index);
  const keys: string[] = [...base.keys];
  const seenKeys = new Set(keys);
  const keySlots: number[] = Array.from(base.keySlots);
  const keyValues: number[] = Array.from(base.keyValues);
  let recordCount = base.recordCount;
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seenKeys.has(record.dedupeKey)) continue;
      seenKeys.add(record.dedupeKey);
    }
    recordCount += 1;
    const identity: Omit<UsageSlot, keyof UsageSlotTotals> = {
      slotMs: Math.floor(record.timestampMs / USAGE_SLOT_MS) * USAGE_SLOT_MS,
      model: record.model,
      speed: record.speed,
      sessionId: record.sessionId,
      reported: record.reportedCostUsd !== null,
      cwd: record.cwd ?? "",
      sidechain: record.sidechain === true,
      ownerSessionId: record.ownerSessionId ?? "",
      rycoClient: record.rycoClient === true,
    };
    const id = slotIdentity(identity);
    let index = slotIndexes.get(id);
    if (index === undefined) {
      index = slots.length;
      slotIndexes.set(id, index);
      slots.push({ ...identity, ...emptySlotTotals() });
    }
    const totals = record.totals;
    if (record.dedupeKey !== null) {
      keys.push(record.dedupeKey);
      keySlots.push(index);
      keyValues.push(
        totals.uncachedInputTokens,
        totals.cachedInputTokens,
        totals.cacheCreationInputTokens,
        totals.outputTokens,
        totals.totalTokens,
        totals.reasoningTokens ?? Number.NaN,
        record.reportedCostUsd ?? Number.NaN,
      );
      continue;
    }
    const slot = slots[index]!;
    slot.count += 1;
    slot.uncachedInputTokens += totals.uncachedInputTokens;
    slot.cachedInputTokens += totals.cachedInputTokens;
    slot.cacheCreationInputTokens += totals.cacheCreationInputTokens;
    slot.outputTokens += totals.outputTokens;
    slot.totalTokens += totals.totalTokens;
    if (totals.reasoningTokens === undefined) slot.reasoningMissingCount += 1;
    else slot.reasoningTokens += totals.reasoningTokens;
    if (totals.cachedInputTokens === 0) slot.zeroCachedCount += 1;
    if (record.reportedCostUsd !== null) slot.reportedCostUsd += record.reportedCostUsd;
  }
  return {
    recordCount,
    slots,
    keys,
    keySlots: Uint32Array.from(keySlots),
    keyValues: Float64Array.from(keyValues),
  };
}

/** Adds the keyed response at `offset` of `values` (a `keyValues` array) to `slot`. */
export function addKeyedValues(
  slot: { -readonly [K in keyof UsageSlotTotals]: number },
  values: Float64Array,
  offset: number,
): void {
  const cached = values[offset + CACHED]!;
  const reasoning = values[offset + REASONING]!;
  const reportedCost = values[offset + REPORTED_COST]!;
  slot.count += 1;
  slot.uncachedInputTokens += values[offset + UNCACHED]!;
  slot.cachedInputTokens += cached;
  slot.cacheCreationInputTokens += values[offset + CACHE_CREATION]!;
  slot.outputTokens += values[offset + OUTPUT]!;
  slot.totalTokens += values[offset + TOTAL]!;
  if (Number.isNaN(reasoning)) slot.reasoningMissingCount += 1;
  else slot.reasoningTokens += reasoning;
  if (cached === 0) slot.zeroCachedCount += 1;
  if (!Number.isNaN(reportedCost)) slot.reportedCostUsd += reportedCost;
}

export interface UsageSlotAggregationOptions {
  readonly sourceId: string;
  readonly provider: UsageDailyBucket["provider"];
  readonly timeZone: string;
  readonly startDate?: UsageCalendarDate;
  readonly endDate: UsageCalendarDate;
  readonly pricing: UsagePricingPolicy;
}

export interface UsageSlotAggregationResult {
  readonly buckets: readonly UsageDailyBucket[];
  readonly duplicatesDropped: number;
  readonly acceptedRecords: number;
  readonly sessionIds: ReadonlySet<string>;
  /** Models as reported (mapped model IDs), by whether they have a price. */
  readonly recognizedModels: ReadonlySet<string>;
  readonly unrecognizedModels: ReadonlySet<string>;
}

interface MutableBucket {
  readonly date: UsageCalendarDate;
  readonly model: string;
  tokens: {
    uncachedInputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  reasoningMissing: boolean;
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

/**
 * Daily buckets of one source's file aggregates, equal to feeding every record of the files,
 * in order, to `UsageAggregator`: a keyed response whose key an earlier response (in any file,
 * in or out of the window) already had is dropped.
 */
export class UsageSlotAggregator {
  readonly #options: UsageSlotAggregationOptions;
  readonly #toDay: (timestampMs: number) => string;
  readonly #dayBySlot = new Map<number, string>();
  readonly #seenKeys = new Set<string>();
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #sessionIds = new Set<string>();
  readonly #recognizedModels = new Set<string>();
  readonly #unrecognizedModels = new Set<string>();
  #duplicatesDropped = 0;
  #acceptedRecords = 0;

  constructor(options: UsageSlotAggregationOptions) {
    this.#options = options;
    this.#toDay = makeUsageDayFormatter(options.timeZone);
  }

  #day(slotMs: number): string {
    let day = this.#dayBySlot.get(slotMs);
    if (day === undefined) {
      day = this.#toDay(slotMs);
      this.#dayBySlot.set(slotMs, day);
    }
    return day;
  }

  addFile(file: UsageFileAggregate): void {
    // Keyless sums are shared with the cache; keyed responses are added to per-call copies.
    let keyed: Map<number, ReturnType<typeof emptySlotTotals>> | undefined;
    for (let index = 0; index < file.keys.length; index++) {
      const key = file.keys[index]!;
      if (this.#seenKeys.has(key)) {
        this.#duplicatesDropped += 1;
        continue;
      }
      this.#seenKeys.add(key);
      const slotIndex = file.keySlots[index]!;
      keyed ??= new Map();
      let totals = keyed.get(slotIndex);
      if (totals === undefined) {
        totals = emptySlotTotals();
        keyed.set(slotIndex, totals);
      }
      addKeyedValues(totals, file.keyValues, index * USAGE_KEY_VALUE_STRIDE);
    }
    for (let index = 0; index < file.slots.length; index++) {
      const slot = file.slots[index]!;
      const extra = keyed?.get(index);
      if (slot.count > 0) this.#addSlot(slot, slot);
      if (extra !== undefined) this.#addSlot(slot, extra);
    }
  }

  #addSlot(slot: UsageSlot, totals: UsageSlotTotals): void {
    const date = this.#day(slot.slotMs);
    const { startDate, endDate, pricing } = this.#options;
    if ((startDate !== undefined && date < startDate) || date > endDate) return;
    // Usage of a mapped model ID counts under its target, priced like it.
    const resolution = resolveUsageModel(pricing, slot.model);
    const key = `${date}\0${resolution.model}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        date: date as UsageCalendarDate,
        model: resolution.model,
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
        reasoningMissing: false,
        responseCount: 0,
        sessions: new Set(),
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
    const price = priceUsageSlot(resolution, slot, totals);
    bucket.tokens.uncachedInputTokens += totals.uncachedInputTokens;
    bucket.tokens.cachedInputTokens += totals.cachedInputTokens;
    bucket.tokens.cacheCreationInputTokens += totals.cacheCreationInputTokens;
    bucket.tokens.outputTokens += totals.outputTokens;
    bucket.tokens.totalTokens += totals.totalTokens;
    bucket.tokens.reasoningTokens += totals.reasoningTokens;
    if (totals.reasoningMissingCount > 0) bucket.reasoningMissing = true;
    bucket.responseCount += totals.count;
    if (slot.sessionId.length > 0) {
      bucket.sessions.add(slot.sessionId);
      this.#sessionIds.add(slot.sessionId);
    }
    if (price.estimatedCostUsd !== null) {
      bucket.estimatedCostUsd += price.estimatedCostUsd;
      bucket.hasCost = true;
    }
    if (price.estimatedCacheSavingsUsd !== null) {
      bucket.estimatedCacheSavingsUsd += price.estimatedCacheSavingsUsd;
      bucket.hasCacheSavings = true;
    }
    bucket.costBreakdown.add(price);
    bucket.pricedTokenCount += price.pricedTokenCount;
    bucket.unpricedTokenCount += price.unpricedTokenCount;
    bucket.customPricedTokenCount += price.customPricedTokenCount;
    bucket.costSources.add(price.costSource);
    this.#acceptedRecords += totals.count;
    const recognized = slot.reported || resolution.rate !== null;
    (recognized ? this.#recognizedModels : this.#unrecognizedModels).add(resolution.model);
  }

  finish(): UsageSlotAggregationResult {
    const buckets: UsageDailyBucket[] = [];
    for (const bucket of this.#buckets.values()) {
      const { reasoningTokens, ...tokens } = bucket.tokens;
      const costBreakdown = bucket.costBreakdown.finish();
      buckets.push({
        sourceId: this.#options.sourceId,
        date: bucket.date,
        provider: this.#options.provider,
        model: bucket.model,
        tokens: bucket.reasoningMissing ? tokens : { ...tokens, reasoningTokens },
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
        costSource:
          bucket.costSources.size === 1
            ? (bucket.costSources.values().next().value ?? "unpriced")
            : "mixed",
      });
    }
    buckets.sort(
      (left, right) => left.date.localeCompare(right.date) || left.model.localeCompare(right.model),
    );
    return {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      acceptedRecords: this.#acceptedRecords,
      sessionIds: this.#sessionIds,
      recognizedModels: this.#recognizedModels,
      unrecognizedModels: this.#unrecognizedModels,
    };
  }
}
