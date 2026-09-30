import { describe, expect, it } from "vite-plus/test";

import type { UsageRecord } from "./usageRecord.ts";
import {
  anonymizeUsageRecord,
  decodeUsageScanCache,
  deduplicateUsageRecordsWithinFile,
  encodeUsageScanCache,
  pruneUsageScanCache,
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

describe("usage scan cache", () => {
  it("hashes provider identities before durable storage", () => {
    const anonymized = anonymizeUsageRecord(record());
    expect(anonymized.sessionId).not.toContain("private");
    expect(anonymized.dedupeKey).not.toContain("private");
    expect(anonymized.sessionId).toHaveLength(64);
    expect(anonymized.dedupeKey).toHaveLength(64);
  });

  it("round-trips compact cached rows and preserves totals", () => {
    const fileKey = usageCacheFileKey("claude", "/transcripts/a.jsonl");
    const rootKey = usageCacheRootKey("claude", "/transcripts");
    const cache: UsageScanCache = new Map([
      [fileKey, { rootKey, size: 42, mtimeMs: 1000, provider: "claude", records: [record()] }],
    ]);
    const encoded = JSON.stringify(encodeUsageScanCache(cache));
    expect(encoded).not.toContain("/transcripts");
    const decoded = decodeUsageScanCache(JSON.parse(encoded));
    expect(decoded.get(fileKey)?.records).toEqual([record()]);
  });

  it("rejects an entire file entry when any row is corrupt", () => {
    const document = encodeUsageScanCache(
      new Map([
        [
          "file-a",
          { rootKey: "root-a", size: 1, mtimeMs: 1, provider: "claude", records: [record()] },
        ],
      ]),
    ) as unknown as { files: Record<string, { r: unknown[][] }> };
    document.files["file-a"]?.r.push(["bad"]);
    expect(decodeUsageScanCache(document).size).toBe(0);
  });

  it("deduplicates repeated responses within one file", () => {
    expect(deduplicateUsageRecordsWithinFile([record(), record(), record()])).toHaveLength(1);
    expect(
      deduplicateUsageRecordsWithinFile([record({ dedupeKey: null }), record({ dedupeKey: null })]),
    ).toHaveLength(2);
  });

  it("prunes only aged entries and missing files under roots that were walked", () => {
    const cache: UsageScanCache = new Map([
      ["live", { rootKey: "walked", size: 1, mtimeMs: 900, provider: "claude", records: [] }],
      ["deleted", { rootKey: "walked", size: 1, mtimeMs: 900, provider: "claude", records: [] }],
      ["keep", { rootKey: "unavailable", size: 1, mtimeMs: 900, provider: "codex", records: [] }],
      ["old", { rootKey: "walked", size: 1, mtimeMs: 10, provider: "claude", records: [] }],
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

it("preserves authoritative totals and unavailable reasoning in new provider caches, while reading v2", () => {
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
  const document = encodeUsageScanCache(
    new Map([
      [
        "new",
        {
          rootKey: "root",
          size: 1,
          mtimeMs: 1,
          fingerprint: "inode",
          provider: "opencode",
          records: [cached],
        },
      ],
    ]),
  );
  expect(decodeUsageScanCache(document).get("new")?.records[0]?.totals).toEqual(cached.totals);
  const old = encodeUsageScanCache(
    new Map([
      ["old", { rootKey: "root", size: 1, mtimeMs: 1, provider: "claude", records: [record()] }],
    ]),
  ) as unknown as { version: number; files: Record<string, { r: unknown[][] }> };
  old.version = 2;
  old.files.old!.r[0]!.splice(10);
  expect(decodeUsageScanCache(old).get("old")?.records[0]?.totals.totalTokens).toBe(10);
});
