// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { parseOpenCodeUsageMessage, readOpenCodeUsage } from "./opencodeUsageReader.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { priceUsageRecord } from "./usagePricing.ts";
import {
  encodeUsageScanCache,
  decodeUsageScanCache,
  type UsageScanCache,
} from "./usageScanCache.ts";

const afterYield = vi.hoisted(() => ({ hook: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:timers/promises", async (original) => {
  const timers = await original<typeof import("node:timers/promises")>();
  return {
    ...timers,
    setImmediate: async (...args: Parameters<typeof timers.setImmediate>) => {
      await timers.setImmediate(...args);
      const hook = afterYield.hook;
      afterYield.hook = undefined;
      await hook?.();
    },
  };
});
const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const roots: string[] = [];
afterEach(async () => {
  afterYield.hook = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ryco-usage-fixture-"));
  roots.push(root);
  return { root, databasePath: join(root, "opencode.db"), cache: new Map() as UsageScanCache };
}
function database(path: string, table = "session_message") {
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE ${table} (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, type TEXT, data TEXT)`,
  );
  return db;
}
function insert(
  db: DatabaseSync,
  table: string,
  id: string,
  value: unknown,
  session = "ses_fixture",
) {
  if (table === "session_message" && typeof value === "object" && value !== null) {
    const { id: _id, type: _type, ...data } = value as Record<string, unknown>;
    value = data;
  }
  db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, 'assistant', ?)`).run(
    id,
    session,
    1786060800000,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

describe("OpenCode provider-native usage", () => {
  it("preserves v1 authoritative total through cache and aggregation and leaves unknown prices unavailable", async () => {
    const message = await fixture("opencode-v1");
    const result = parseOpenCodeUsageMessage(message);
    expect(result.kind).toBe("record");
    if (result.kind !== "record") throw new Error("fixture");
    expect(result.record.totals).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 10,
      outputTokens: 25,
      reasoningTokens: 5,
      totalTokens: 1001,
    });
    expect(priceUsageRecord(new Map(), result.record)).toMatchObject({
      estimatedCostUsd: null,
      unpricedTokenCount: 1001,
    });
    const input = await setup();
    const db = database(input.databasePath, "message");
    insert(db, "message", message.id, message);
    db.close();
    const scanned = await readOpenCodeUsage(input);
    const restored = decodeUsageScanCache(encodeUsageScanCache(input.cache));
    expect([...restored.values()][0]?.records[0]?.totals.totalTokens).toBe(1001);
    const aggregator = new UsageAggregator({
      sourceId: "fixture",
      timeZone: "UTC",
      endDate: "2026-09-30",
    });
    scanned.records.forEach((record) => aggregator.add(record));
    scanned.records.forEach((record) => aggregator.add(record));
    expect(aggregator.finish()).toMatchObject({ acceptedRecords: 1, duplicatesDropped: 1 });
    expect(aggregator.finish().buckets[0]?.tokens.totalTokens).toBe(1001);
  });

  it("reads current v2 metadata without retaining transcripts and reuses unchanged DB cache", async () => {
    const input = await setup(),
      db = database(input.databasePath);
    insert(db, "session_message", "msg_v2", await fixture("opencode-v2"));
    db.close();
    const first = await readOpenCodeUsage(input);
    expect(first).toMatchObject({
      status: "complete",
      parsedFileCount: 1,
      reusedCacheFileCount: 0,
    });
    expect(first.records[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      reportedCostUsd: 0.012,
      totals: { totalTokens: 185 },
    });
    expect(JSON.stringify(encodeUsageScanCache(input.cache))).not.toContain(
      "PRIVATE_FIXTURE_CONTENT",
    );
    expect(JSON.stringify(first)).not.toContain("ses_fixture");
    expect(await readOpenCodeUsage(input)).toMatchObject({
      status: "complete",
      reusedCacheFileCount: 1,
    });
  });

  it("deduplicates migrated table records and does not count legacy JSON again", async () => {
    const input = await setup(),
      db = database(input.databasePath);
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, type TEXT, data TEXT)",
    );
    const message = await fixture("opencode-v2");
    insert(db, "session_message", "msg_v2", message);
    insert(db, "message", "msg_v2", message);
    db.close();
    await mkdir(join(input.root, "storage/message/ses_fixture"), { recursive: true });
    await writeFile(
      join(input.root, "storage/message/ses_fixture/msg_other.json"),
      JSON.stringify(await fixture("opencode-v1")),
    );
    expect((await readOpenCodeUsage(input)).records).toHaveLength(1);
  });

  it("invalidates WAL writes even before checkpoint and detects restored mtime edits", async () => {
    const input = await setup(),
      db = database(input.databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    const message = await fixture("opencode-v2");
    insert(db, "session_message", "msg_v2", message);
    expect((await readOpenCodeUsage(input)).records).toHaveLength(1);
    insert(db, "session_message", "msg_new", message);
    expect(await readOpenCodeUsage(input)).toMatchObject({
      reusedCacheFileCount: 0,
      records: expect.any(Array),
    });
    expect((await readOpenCodeUsage(input)).records).toHaveLength(2);
    db.close();
    const before = await stat(input.databasePath);
    const edited = new DatabaseSync(input.databasePath);
    edited
      .prepare("UPDATE session_message SET data = ? WHERE id = 'msg_new'")
      .run(JSON.stringify({ ...message, tokens: { ...message.tokens, output: 40 } }));
    edited.close();
    await utimes(input.databasePath, before.atime, before.mtime);
    expect(
      (await readOpenCodeUsage(input)).records.reduce(
        (sum, record) => sum + record.totals.totalTokens,
        0,
      ),
    ).toBe(390);
  });

  it("reports corrupt, missing-telemetry, and oversized records without zeroes or cache suppression", async () => {
    const input = await setup(),
      db = database(input.databasePath);
    insert(db, "session_message", "msg_good", await fixture("opencode-v2"));
    insert(db, "session_message", "msg_missing", { type: "assistant" });
    insert(db, "session_message", "msg_broken", "{");
    insert(db, "session_message", "msg_large", " ".repeat(2000));
    db.close();
    const options = { ...input, limits: { recordBytes: 1024 } };
    const read = await readOpenCodeUsage(options);
    expect(read).toMatchObject({ status: "partial", malformedCount: 2, skippedCount: 1 });
    expect(read.records).toHaveLength(1);
    expect(input.cache.size).toBe(0);
    expect((await readOpenCodeUsage(options)).status).toBe("partial");
  });

  it("uses unsupported coverage for unknown schemas and never falls back from a corrupt database", async () => {
    const input = await setup();
    const db = new DatabaseSync(input.databasePath);
    db.exec("CREATE TABLE session_message (unknown TEXT)");
    db.close();
    expect(await readOpenCodeUsage(input)).toMatchObject({
      status: "unsupported",
      diagnosticCode: "history-format-unsupported",
      records: [],
    });
    await writeFile(input.databasePath, "not sqlite");
    expect(await readOpenCodeUsage(input)).toMatchObject({ status: "failed", records: [] });
  });

  it("bounds database, record, row, time and traversal work and honors cancellation", async () => {
    const input = await setup(),
      db = database(input.databasePath);
    for (let i = 0; i < 8; i++)
      insert(db, "session_message", `msg_${i}`, await fixture("opencode-v2"));
    db.close();
    expect(
      await readOpenCodeUsage({ ...input, limits: { entries: 3, pageSize: 2 } }),
    ).toMatchObject({
      status: "partial",
      diagnosticCode: "history-scan-limit",
      records: expect.any(Array),
    });
    expect(await readOpenCodeUsage({ ...input, limits: { databaseBytes: 1 } })).toMatchObject({
      status: "failed",
    });
    expect(await readOpenCodeUsage({ ...input, limits: { durationMs: 0 } })).toMatchObject({
      status: "unsupported",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(readOpenCodeUsage({ ...input, signal: controller.signal })).rejects.toThrow();
  });

  it("reads legacy JSON only in scoped message directories, diagnoses partial files and refuses links", async () => {
    const input = await setup();
    expect(await readOpenCodeUsage(input)).toMatchObject({ status: "not-found" });
    const directory = join(input.root, "storage/message/ses_personal");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "msg_v1.json"), JSON.stringify(await fixture("opencode-v1")));
    await writeFile(join(directory, "msg_partial.json"), "{");
    await writeFile(join(input.root, "auth.json"), "CREDENTIAL_SENTINEL");
    await symlink(join(input.root, "auth.json"), join(directory, "msg_link.json"));
    const read = await readOpenCodeUsage(input);
    expect(read).toMatchObject({ status: "partial", malformedCount: 1 });
    expect(read.records).toHaveLength(1);
    expect(JSON.stringify(read)).not.toContain("CREDENTIAL_SENTINEL");
    expect(await readOpenCodeUsage({ ...input, allowLegacy: false })).toMatchObject({
      status: "not-found",
      records: [],
    });
  });

  it("rejects database and WAL symlinks without reading their targets", async () => {
    const input = await setup(),
      other = await setup();
    const db = database(other.databasePath);
    insert(db, "session_message", "msg_v2", await fixture("opencode-v2"));
    db.close();
    await symlink(other.databasePath, input.databasePath);
    expect(await readOpenCodeUsage(input)).toMatchObject({ status: "failed", records: [] });
    await rm(input.databasePath);
    await writeFile(input.databasePath, await readFile(other.databasePath));
    await symlink(other.databasePath, input.databasePath + "-wal");
    expect(await readOpenCodeUsage(input)).toMatchObject({ status: "failed", records: [] });
  });
});

it.each(["delete", "symlink"] as const)(
  "discards rows and invalidates cache if the database is %s after page yield",
  async (kind) => {
    const input = await setup(),
      db = database(input.databasePath);
    insert(db, "session_message", "msg_a", await fixture("opencode-v2"));
    db.close();
    expect((await readOpenCodeUsage(input)).status).toBe("complete");
    const cachedSize = (await stat(input.databasePath)).size;
    const edit = new DatabaseSync(input.databasePath);
    // Grow the real store so this read must scan even when both writes share
    // one filesystem timestamp tick. The old cache entry must remain present
    // until the final identity check rejects and invalidates it.
    insert(edit, "session_message", "msg_b", {
      ...(await fixture("opencode-v2")),
      fixturePadding: "x".repeat(16 * 1024),
    });
    edit.close();
    expect((await stat(input.databasePath)).size).toBeGreaterThan(cachedSize);
    expect(input.cache.size).toBe(1);
    const changeDatabase = vi.fn(async () => {
      await rm(input.databasePath);
      if (kind === "symlink") {
        const target = join(input.root, "replacement.db");
        await writeFile(target, "synthetic");
        await symlink(target, input.databasePath);
      }
    });
    afterYield.hook = changeDatabase;
    const result = await readOpenCodeUsage(input);
    expect(changeDatabase).toHaveBeenCalledExactlyOnceWith();
    expect(result).toMatchObject({
      status: "failed",
      records: [],
      diagnosticCode: "history-changed-during-scan",
      parsedFileCount: 1,
      reusedCacheFileCount: 0,
    });
    expect(input.cache.size).toBe(0);
  },
);
