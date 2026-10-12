import { describe, expect, it } from "vite-plus/test";

import { buildUsageFileAggregate } from "./usageFileAggregate.ts";
import type { UsageRecord } from "./usageRecord.ts";
import {
  anonymizeScanCachedUsageRecord,
  anonymizeUsageRecord,
  capUsageScanCache,
  decodeUsageScanCache,
  deduplicateUsageRecordsWithinFile,
  encodeUsageScanCache,
  pruneUsageScanCache,
  type CachedUsageFile,
  type UsageScanCache,
  usageCacheFileKey,
  usageCacheRootKey,
} from "./usageScanCache.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1000,
    model: "claude-sonnet-4-5-20250929",
    sessionId: "private-session-id",
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 2,
      cacheCreationInputTokens: 3,
      outputTokens: 4,
      reasoningTokens: 2,
      totalTokens: 10,
    },
    dedupeKey: "private-message-id:private-request-id",
    reportedCostUsd: null,
    ...overrides,
  };
}

/** A cache entry holding `records`, folded as a fresh parse would fold them. */
function entryOf(
  records: readonly UsageRecord[],
  overrides: Partial<Omit<CachedUsageFile, "aggregate">> = {},
): CachedUsageFile {
  return {
    rootKey: "root",
    size: 1,
    mtimeMs: 1,
    provider: records[0]?.provider ?? "claude",
    aggregate: buildUsageFileAggregate(records),
    ...overrides,
  };
}

/** A record-format (v2-v5) document, as earlier versions wrote it. */
function legacyDocument(
  version: number,
  files: Record<string, { readonly provider: string; readonly records: readonly UsageRecord[] }>,
) {
  const models: string[] = [];
  const sessions: string[] = [];
  const intern = (values: string[], value: string) => {
    const index = values.indexOf(value);
    return index === -1 ? values.push(value) - 1 : index;
  };
  return {
    version,
    models,
    sessions,
    files: Object.fromEntries(
      Object.entries(files).map(([key, file]) => [
        key,
        {
          o: "root",
          s: 1,
          m: 1,
          p: file.provider,
          r: file.records.map((record) => [
            record.timestampMs,
            intern(models, record.model),
            intern(sessions, record.sessionId),
            record.totals.uncachedInputTokens,
            record.totals.cachedInputTokens,
            record.totals.cacheCreationInputTokens,
            record.totals.outputTokens,
            record.totals.reasoningTokens ?? null,
            record.dedupeKey,
            record.reportedCostUsd,
            record.totals.totalTokens,
            record.speed ?? null,
          ]),
        },
      ]),
    ),
  };
}

describe("usage scan cache", () => {
  it("hashes provider identities before durable storage", () => {
    const anonymized = anonymizeUsageRecord(record());
    expect(anonymized.sessionId).not.toContain("private");
    expect(anonymized.dedupeKey).not.toContain("private");
    expect(anonymized.sessionId).toHaveLength(64);
    expect(anonymized.dedupeKey).toHaveLength(64);
  });

  it("round-trips file aggregates without paths", () => {
    const fileKey = usageCacheFileKey("claude", "/transcripts/a.jsonl");
    const rootKey = usageCacheRootKey("claude", "/transcripts");
    const records = [
      record(),
      record({ dedupeKey: null, timestampMs: 2_000_000, reportedCostUsd: 0.25 }),
      record({
        dedupeKey: "other",
        speed: "fast",
        totals: { ...record().totals, reasoningTokens: undefined },
      }),
    ];
    const cache: UsageScanCache = new Map([
      [fileKey, entryOf(records, { rootKey, size: 42, mtimeMs: 1000 })],
    ]);
    const encoded = JSON.stringify(encodeUsageScanCache(cache));
    expect(encoded).not.toContain("/transcripts");
    const decoded = decodeUsageScanCache(JSON.parse(encoded));
    expect(decoded.get(fileKey)).toEqual(cache.get(fileKey));
  });

  it("rejects an entire file entry when any slot or keyed row is corrupt", () => {
    for (const corrupt of [
      (file: { a: unknown[][]; k: unknown[][] }) => file.a.push(["bad"]),
      (file: { a: unknown[][]; k: unknown[][] }) => file.k.push(["bad"]),
      (file: { a: unknown[][]; k: unknown[][] }) => (file.k[0]![1] = 99),
      (file: { a: unknown[][]; k: unknown[][] }) => (file.a[0]![5] = -1),
    ]) {
      const document = encodeUsageScanCache(
        new Map([["file-a", entryOf([record(), record({ dedupeKey: null })])]]),
      ) as unknown as { files: Record<string, { a: unknown[][]; k: unknown[][] }> };
      corrupt(document.files["file-a"]!);
      expect(decodeUsageScanCache(document).size).toBe(0);
    }
    const legacy = legacyDocument(5, { "file-a": { provider: "claude", records: [record()] } });
    legacy.files["file-a"]!.r.push(["bad"] as never);
    expect(decodeUsageScanCache(legacy).size).toBe(0);
  });

  it("folds record caches written by earlier versions", () => {
    const records = [record(), record({ dedupeKey: null, timestampMs: 5_000_000 })];
    const decoded = decodeUsageScanCache(
      legacyDocument(5, { file: { provider: "claude", records } }),
    );
    expect(decoded.get("file")?.aggregate).toEqual(buildUsageFileAggregate(records));
  });

  it("deduplicates repeated responses within one file", () => {
    expect(deduplicateUsageRecordsWithinFile([record(), record(), record()])).toHaveLength(1);
    expect(
      deduplicateUsageRecordsWithinFile([record({ dedupeKey: null }), record({ dedupeKey: null })]),
    ).toHaveLength(2);
  });

  it("prunes only aged entries and missing files under roots that were walked", () => {
    const cache: UsageScanCache = new Map([
      ["live", entryOf([], { rootKey: "walked", mtimeMs: 900 })],
      ["deleted", entryOf([], { rootKey: "walked", mtimeMs: 900 })],
      ["keep", entryOf([], { rootKey: "unavailable", mtimeMs: 900, provider: "codex" })],
      ["old", entryOf([], { rootKey: "walked", mtimeMs: 10 })],
    ]);
    expect(
      pruneUsageScanCache(cache, {
        liveFileKeys: new Set(["live"]),
        walkedRootKeys: new Set(["walked"]),
        windowStartMs: 500,
        retentionCutoffMs: 100,
      }),
    ).toBe(2);
    expect([...cache.keys()].toSorted()).toEqual(["keep", "live"]);
  });
});

it("preserves authoritative totals and unavailable reasoning, while retaining legacy non-transcript caches", () => {
  const cached = record({
    provider: "opencode",
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 2,
      cacheCreationInputTokens: 3,
      outputTokens: 4,
      totalTokens: 999,
    },
  });
  const entry = entryOf([cached], { fingerprint: "inode" });
  const decoded = decodeUsageScanCache(encodeUsageScanCache(new Map([["new", entry]])));
  expect(decoded.get("new")).toEqual(entry);
  // Reasoning stays unavailable (NaN), not zero.
  expect(Number.isNaN(decoded.get("new")!.aggregate.keyValues[5])).toBe(true);
  const old = legacyDocument(2, {
    old: { provider: "opencode", records: [record({ provider: "opencode" })] },
  });
  old.files.old!.r[0]!.splice(10);
  expect(decodeUsageScanCache(old).get("old")?.aggregate.keyValues[4]).toBe(10);
});

it("invalidates transcript caches without speed and round-trips recorded tiers", () => {
  const records = [record({ provider: "codex", speed: "fast" })];
  const encoded = encodeUsageScanCache(new Map([["file", entryOf(records)]]));
  expect(decodeUsageScanCache(encoded).get("file")?.aggregate.slots[0]?.speed).toBe("fast");
  const legacy = legacyDocument(5, { file: { provider: "codex", records } });
  expect(decodeUsageScanCache(legacy).get("file")?.aggregate.slots[0]?.speed).toBe("fast");
  for (const version of [2, 3]) expect(decodeUsageScanCache({ ...legacy, version }).size).toBe(0);
});

it("compacts identifiers of version 4 caches instead of rescanning them", () => {
  const full = anonymizeUsageRecord(record({ provider: "codex", speed: "standard" }));
  const decoded = decodeUsageScanCache(
    legacyDocument(4, { file: { provider: "codex", records: [full] } }),
  ).get("file")?.aggregate;
  // The compact form is the prefix of the full digest, so fresh parses deduplicate against it.
  expect(decoded?.keys[0]).toBe(
    anonymizeScanCachedUsageRecord(record({ provider: "codex" })).dedupeKey,
  );
  expect(decoded?.slots[0]?.sessionId).toBe(full.sessionId.slice(0, 16));
  expect(decoded?.keys[0]).toHaveLength(16);
});

it("decodes every file of a large cache and evicts the least recently modified first", () => {
  // One quarter hour apart: one slot per record, the worst case for the decoder.
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      record({ timestampMs: index * 15 * 60 * 1000, dedupeKey: null }),
    );
  const cache: UsageScanCache = new Map(
    [3, 1, 2].map((order) => [`file-${order}`, entryOf(rows(90_000), { mtimeMs: order * 1000 })]),
  );
  // 270k records: more than the old 250k cumulative decode cap, which silently
  // dropped the files inserted last.
  const decoded = decodeUsageScanCache(JSON.parse(JSON.stringify(encodeUsageScanCache(cache))));
  expect(decoded.size).toBe(3);
  expect(capUsageScanCache(decoded, 200_000)).toBe(1);
  expect([...decoded.keys()].toSorted()).toEqual(["file-2", "file-3"]);
  expect(capUsageScanCache(decoded, 200_000)).toBe(0);
});
