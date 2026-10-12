// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";

import type { UsageProviderKind } from "@ryco/contracts";

import {
  buildUsageFileAggregate,
  USAGE_KEY_VALUE_STRIDE,
  USAGE_SLOT_MS,
  type UsageFileAggregate,
  type UsageSlot,
} from "./usageFileAggregate.ts";
import type { UsageRecord, UsageSpeed } from "./usageRecord.ts";
import { withTokenTotal } from "./usageRecord.ts";

/**
 * v6: per-file aggregates (15-minute slots plus compact keyed responses) instead of records.
 * v5: session/response hashes are truncated to {@link SCAN_CACHE_IDENTIFIER_LENGTH}.
 */
export const USAGE_SCAN_CACHE_VERSION = 6 as const;

/**
 * Hex digits kept for anonymized session/response identifiers of scan-cached
 * records. 64 bits keep collisions negligible (~3e-8 at 10^6 records) and
 * shrink the cache by about a quarter versus full SHA-256 digests.
 */
export const SCAN_CACHE_IDENTIFIER_LENGTH = 16;

/** Upper bound on files and records decoded from one serialized cache document. */
const MAX_DECODED_FILES = 10_000;
const MAX_RECORDS_PER_FILE = 100_000;

export interface CachedUsageFile {
  readonly rootKey: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  readonly aggregate: UsageFileAggregate;
  readonly fingerprint?: string;
}

export type UsageScanCache = Map<string, CachedUsageFile>;

export function matchesUsageFileCache(
  cached: CachedUsageFile | undefined,
  file: { readonly size: number; readonly mtimeMs: number; readonly fingerprint?: string },
  provider: UsageProviderKind,
): cached is CachedUsageFile {
  return (
    cached !== undefined &&
    cached.provider === provider &&
    cached.size === file.size &&
    cached.mtimeMs === file.mtimeMs &&
    cached.fingerprint === file.fingerprint
  );
}

type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationInputTokens: number,
  outputTokens: number,
  reasoningTokens: number | null,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  authoritativeTotal?: number,
  speed?: "standard" | "fast" | "ultrafast" | null,
];

interface SerializedFile {
  readonly f?: string;
  readonly o: string;
  readonly s: number;
  readonly m: number;
  readonly p: UsageProviderKind;
  /** Records (v2-v5). */
  readonly r?: readonly SerializedRecord[];
  /** Record count (v6). */
  readonly n?: number;
  /** Slots (v6). */
  readonly a?: readonly SerializedSlot[];
  /** Keyed responses (v6). */
  readonly k?: readonly SerializedKeyed[];
}

type SerializedSlot = readonly [
  slotIndex: number,
  modelIndex: number,
  sessionIndex: number,
  speed: UsageSpeed | null,
  reported: 0 | 1,
  count: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationInputTokens: number,
  outputTokens: number,
  totalTokens: number,
  reasoningTokens: number,
  reasoningMissingCount: number,
  zeroCachedCount: number,
  reportedCostUsd: number,
];

type SerializedKeyed = readonly [
  dedupeKey: string,
  slot: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationInputTokens: number,
  outputTokens: number,
  totalTokens: number,
  reasoningTokens: number | null,
  reportedCostUsd: number | null,
];

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

function hashPrivateIdentifier(kind: string, value: string, length = 64): string {
  const digest = createHash("sha256").update(`${kind}\0${value}`).digest("hex");
  return length >= digest.length ? digest : digest.slice(0, length);
}

export function usageCacheFileKey(provider: UsageProviderKind, canonicalPath: string): string {
  return hashPrivateIdentifier(`${provider}:transcript-file`, canonicalPath);
}

export function usageCacheRootKey(provider: UsageProviderKind, canonicalRoot: string): string {
  return hashPrivateIdentifier(`${provider}:transcript-root`, canonicalRoot);
}

function anonymize(record: UsageRecord, identifierLength: number): UsageRecord {
  return {
    ...record,
    sessionId:
      record.sessionId.length === 0
        ? ""
        : hashPrivateIdentifier(`${record.provider}:session`, record.sessionId, identifierLength),
    dedupeKey:
      record.dedupeKey === null
        ? null
        : hashPrivateIdentifier(`${record.provider}:response`, record.dedupeKey, identifierLength),
  };
}

/** Remove provider session/message identifiers before a parsed row becomes durable. */
export function anonymizeUsageRecord(record: UsageRecord): UsageRecord {
  return anonymize(record, 64);
}

/**
 * {@link anonymizeUsageRecord} for records kept in the scan cache. Every record
 * of one source must use the same form: deduplication compares these keys.
 */
export function anonymizeScanCachedUsageRecord(record: UsageRecord): UsageRecord {
  return anonymize(record, SCAN_CACHE_IDENTIFIER_LENGTH);
}

export function deduplicateUsageRecordsWithinFile(
  records: readonly UsageRecord[],
): readonly UsageRecord[] {
  const seen = new Set<string>();
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}

export function encodeUsageScanCache(cache: UsageScanCache): SerializedCache {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndexes = new Map<string, number>();
  const sessionIndexes = new Map<string, number>();
  const intern = (values: string[], indexes: Map<string, number>, value: string): number => {
    const existing = indexes.get(value);
    if (existing !== undefined) return existing;
    const next = values.length;
    values.push(value);
    indexes.set(value, next);
    return next;
  };

  const files: Record<string, SerializedFile> = {};
  const nullable = (value: number) => (Number.isNaN(value) ? null : value);
  for (const [fileKey, entry] of cache) {
    const { aggregate } = entry;
    const keyed: SerializedKeyed[] = [];
    for (let index = 0; index < aggregate.keys.length; index++) {
      const offset = index * USAGE_KEY_VALUE_STRIDE;
      const values = aggregate.keyValues;
      keyed.push([
        aggregate.keys[index]!,
        aggregate.keySlots[index]!,
        values[offset]!,
        values[offset + 1]!,
        values[offset + 2]!,
        values[offset + 3]!,
        values[offset + 4]!,
        nullable(values[offset + 5]!),
        nullable(values[offset + 6]!),
      ]);
    }
    files[fileKey] = {
      o: entry.rootKey,
      ...(entry.fingerprint === undefined ? {} : { f: entry.fingerprint }),
      s: entry.size,
      m: entry.mtimeMs,
      p: entry.provider,
      n: aggregate.recordCount,
      a: aggregate.slots.map((slot) => [
        slot.slotMs / USAGE_SLOT_MS,
        intern(models, modelIndexes, slot.model),
        intern(sessions, sessionIndexes, slot.sessionId),
        slot.speed ?? null,
        slot.reported ? 1 : 0,
        slot.count,
        slot.uncachedInputTokens,
        slot.cachedInputTokens,
        slot.cacheCreationInputTokens,
        slot.outputTokens,
        slot.totalTokens,
        slot.reasoningTokens,
        slot.reasoningMissingCount,
        slot.zeroCachedCount,
        slot.reportedCostUsd,
      ]),
      k: keyed,
    };
  }
  return { version: USAGE_SCAN_CACHE_VERSION, models, sessions, files };
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function decodeUsageScanCache(document: unknown): UsageScanCache {
  const cache: UsageScanCache = new Map();
  if (typeof document !== "object" || document === null) return cache;
  const root = document as Partial<SerializedCache>;
  if (
    (root.version !== USAGE_SCAN_CACHE_VERSION &&
      root.version !== 2 &&
      root.version !== 3 &&
      root.version !== 4 &&
      root.version !== 5) ||
    !isArray(root.models) ||
    !root.models.every((value) => typeof value === "string") ||
    !isArray(root.sessions) ||
    !root.sessions.every((value) => typeof value === "string") ||
    typeof root.files !== "object" ||
    root.files === null
  ) {
    return cache;
  }

  if (
    root.models.length > 50_000 ||
    root.sessions.length > 250_000 ||
    Object.keys(root.files).length > MAX_DECODED_FILES
  )
    return cache;
  const models = root.models as readonly string[];
  // Before v5 identifiers were full SHA-256 digests; their prefix is the compact form.
  const compact = (value: string) =>
    root.version === USAGE_SCAN_CACHE_VERSION || root.version === 5
      ? value
      : value.slice(0, SCAN_CACHE_IDENTIFIER_LENGTH);
  const sessions = (root.sessions as readonly string[]).map(compact);
  for (const [fileKey, rawEntry] of Object.entries(root.files as Record<string, unknown>)) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Partial<SerializedFile>;
    // Old transcript rows did not retain speed; rescan them rather than price as standard.
    if ((root.version === 2 || root.version === 3) && (entry.p === "codex" || entry.p === "claude"))
      continue;
    if (
      typeof entry.o !== "string" ||
      entry.o.length === 0 ||
      typeof entry.s !== "number" ||
      !Number.isFinite(entry.s) ||
      typeof entry.m !== "number" ||
      !Number.isFinite(entry.m) ||
      !["claude", "codex", "cursor", "opencode"].includes(entry.p ?? "")
    ) {
      continue;
    }
    const header = {
      rootKey: entry.o,
      ...(typeof entry.f === "string" ? { fingerprint: entry.f } : {}),
      size: entry.s,
      mtimeMs: entry.m,
      provider: entry.p as UsageProviderKind,
    };
    if (root.version === USAGE_SCAN_CACHE_VERSION) {
      const aggregate = decodeSerializedAggregate(entry, models, sessions);
      if (aggregate !== null) cache.set(fileKey, { ...header, aggregate });
      continue;
    }
    if (!isArray(entry.r) || entry.r.length > MAX_RECORDS_PER_FILE) continue;
    const records: UsageRecord[] = [];
    let corrupt = false;
    for (const rawRow of entry.r) {
      if (!isArray(rawRow) || rawRow.length < 10) {
        corrupt = true;
        break;
      }
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        authoritativeTotal,
        rawSpeed,
      ] = rawRow as SerializedRecord;
      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      const sessionId = typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined;
      const tokens = [uncached, cached, cacheCreation, output];
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        timestampMs < 0 ||
        timestampMs > 8.64e15 ||
        (authoritativeTotal !== undefined &&
          (typeof authoritativeTotal !== "number" ||
            !Number.isFinite(authoritativeTotal) ||
            authoritativeTotal < 0)) ||
        model === undefined ||
        sessionId === undefined ||
        (reasoning !== null &&
          (typeof reasoning !== "number" || !Number.isFinite(reasoning) || reasoning < 0)) ||
        tokens.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
        (dedupeKey !== null && typeof dedupeKey !== "string") ||
        (reportedCostUsd !== null &&
          (typeof reportedCostUsd !== "number" ||
            !Number.isFinite(reportedCostUsd) ||
            reportedCostUsd < 0))
      ) {
        corrupt = true;
        break;
      }

      const speed = rawSpeed ?? undefined;
      if (
        speed !== undefined &&
        speed !== "standard" &&
        speed !== "fast" &&
        speed !== "ultrafast"
      ) {
        corrupt = true;
        break;
      }
      records.push({
        ...(speed === undefined ? {} : { speed }),
        provider: entry.p as UsageProviderKind,
        timestampMs,
        model,
        sessionId,
        totals: {
          ...withTokenTotal({
            uncachedInputTokens: uncached,
            cachedInputTokens: cached,
            cacheCreationInputTokens: cacheCreation,
            outputTokens: output,
            ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
          }),
          ...(authoritativeTotal === undefined ? {} : { totalTokens: authoritativeTotal }),
        },
        dedupeKey: dedupeKey === null ? null : compact(dedupeKey),
        reportedCostUsd,
      });
    }
    if (!corrupt) cache.set(fileKey, { ...header, aggregate: buildUsageFileAggregate(records) });
  }
  return cache;
}

const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function decodeSerializedAggregate(
  entry: Partial<SerializedFile>,
  models: readonly string[],
  sessions: readonly string[],
): UsageFileAggregate | null {
  const { n: recordCount, a: rawSlots, k: rawKeyed } = entry;
  if (
    !nonNegative(recordCount) ||
    !Number.isInteger(recordCount) ||
    recordCount > MAX_RECORDS_PER_FILE ||
    !isArray(rawSlots) ||
    !isArray(rawKeyed) ||
    rawSlots.length > recordCount ||
    rawKeyed.length > recordCount
  )
    return null;
  const slots: UsageSlot[] = [];
  let slotCount = 0;
  for (const rawSlot of rawSlots) {
    if (!isArray(rawSlot) || rawSlot.length !== 15) return null;
    const [slotIndex, modelIndex, sessionIndex, speed, reported, ...numbers] =
      rawSlot as SerializedSlot;
    const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
    const sessionId = typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined;
    if (
      !nonNegative(slotIndex) ||
      !Number.isInteger(slotIndex) ||
      slotIndex * USAGE_SLOT_MS > 8.64e15 ||
      model === undefined ||
      sessionId === undefined ||
      (speed !== null && speed !== "standard" && speed !== "fast" && speed !== "ultrafast") ||
      (reported !== 0 && reported !== 1) ||
      !numbers.every(nonNegative)
    )
      return null;
    const [
      count,
      uncachedInputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens,
      reasoningMissingCount,
      zeroCachedCount,
      reportedCostUsd,
    ] = numbers;
    slotCount += count;
    slots.push({
      slotMs: slotIndex * USAGE_SLOT_MS,
      model,
      speed: speed ?? undefined,
      sessionId,
      reported: reported === 1,
      count,
      uncachedInputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens,
      reasoningMissingCount,
      zeroCachedCount,
      reportedCostUsd,
    });
  }
  const keys: string[] = [];
  const keySlots = new Uint32Array(rawKeyed.length);
  const keyValues = new Float64Array(rawKeyed.length * USAGE_KEY_VALUE_STRIDE);
  for (const [index, rawRow] of rawKeyed.entries()) {
    if (!isArray(rawRow) || rawRow.length !== 9) return null;
    const [key, slot, ...values] = rawRow as SerializedKeyed;
    const [uncached, cached, creation, output, total, reasoning, reportedCost] = values;
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      typeof slot !== "number" ||
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= slots.length ||
      ![uncached, cached, creation, output, total].every(nonNegative) ||
      (reasoning !== null && !nonNegative(reasoning)) ||
      (reportedCost !== null && !nonNegative(reportedCost)) ||
      // A keyed response's cost kind is part of its slot.
      (reportedCost !== null) !== slots[slot]!.reported
    )
      return null;
    keys.push(key);
    keySlots[index] = slot;
    keyValues.set(
      [
        uncached,
        cached,
        creation,
        output,
        total,
        reasoning ?? Number.NaN,
        reportedCost ?? Number.NaN,
      ],
      index * USAGE_KEY_VALUE_STRIDE,
    );
  }
  if (slotCount + keys.length !== recordCount) return null;
  return { recordCount, slots, keys, keySlots, keyValues };
}

/**
 * Bound the records held in memory. Evicts the least recently modified files
 * first, so the files most likely to be requested (and to still change) stay.
 * Returns the number of evicted files.
 */
export function capUsageScanCache(cache: UsageScanCache, maxRecords: number): number {
  let total = 0;
  for (const entry of cache.values()) total += entry.aggregate.recordCount;
  if (total <= maxRecords) return 0;
  const oldestFirst = [...cache].toSorted(([, left], [, right]) => left.mtimeMs - right.mtimeMs);
  let removed = 0;
  for (const [fileKey, entry] of oldestFirst) {
    if (total <= maxRecords) break;
    cache.delete(fileKey);
    total -= entry.aggregate.recordCount;
    removed += 1;
  }
  return removed;
}

export interface PruneUsageScanCacheOptions {
  readonly liveFileKeys: ReadonlySet<string>;
  readonly walkedRootKeys: ReadonlySet<string>;
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
}

export function pruneUsageScanCache(
  cache: UsageScanCache,
  options: PruneUsageScanCacheOptions,
): number {
  let removed = 0;
  for (const [fileKey, entry] of cache) {
    const agedOut = entry.mtimeMs < options.retentionCutoffMs;
    const underWalkedRoot = options.walkedRootKeys.has(entry.rootKey);
    const deleted =
      underWalkedRoot &&
      entry.mtimeMs >= options.windowStartMs &&
      !options.liveFileKeys.has(fileKey);
    if (agedOut || deleted) {
      cache.delete(fileKey);
      removed += 1;
    }
  }
  return removed;
}
