// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  readCursorExportUsage,
  cursorExportSourceId,
  CURSOR_EXPORT_LIMITS,
  type CursorExportSource,
} from "./cursorExportUsageReader.ts";
import { priceUsageRecord } from "./usagePricing.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () =>
  JSON.parse(await readFile(new URL("./fixtures/cursor-usage-page.json", import.meta.url), "utf8"));
async function source(): Promise<CursorExportSource> {
  const root = await mkdtemp(join(tmpdir(), "ryco-export-fixture-"));
  roots.push(root);
  const path = join(root, "usage.json");
  await writeFile(path, JSON.stringify(await fixture()));
  return { path, accountKey: "fixture-team", userEmail: "personal@example.invalid" };
}
describe("saved public Cursor Admin API exports", () => {
  it("extracts actual documented records while isolating account, model cost and billed cost", async () => {
    const result = await readCursorExportUsage(await source());
    expect(result.status).toBe("partial");
    expect(result.diagnosticCode).toContain("cursor-export-token-fields-missing");
    expect(result.diagnosticCode).toContain("cursor-export-event-identity-ambiguous");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.totals).toEqual({
      uncachedInputTokens: 126,
      outputTokens: 450,
      cacheCreationInputTokens: 6112,
      cachedInputTokens: 11964,
      totalTokens: 18652,
    });
    expect(result.records[0]?.reportedCostUsd).toBeCloseTo(0.2018232);
    expect(priceUsageRecord(new Map(), result.records[0]!)).toMatchObject({
      costSource: "provider-reported",
      estimatedCostUsd: 0.2018232,
    });
    expect(result.imports.filter((row) => row.metric === "cost").map((row) => row.value)).toEqual([
      0.2136232, 0.08,
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /@example|fixture-conversation|fixture-work|cursorTokenFee|tokenUsage/,
    );
  });
  it("deduplicates overlapping pages and files, but isolates declared accounts", async () => {
    const input = await source(),
      directory = join(roots[0]!, "exports");
    await mkdir(directory);
    const page = await fixture();
    page.usageEvents.push(page.usageEvents[0]);
    await writeFile(join(directory, "usage-a.json"), JSON.stringify(page));
    await writeFile(join(directory, "usage-b.json"), JSON.stringify(page));
    const result = await readCursorExportUsage({ ...input, path: directory });
    expect(result.records).toHaveLength(1);
    expect(result.imports).toHaveLength(4);
    const copy = await source();
    expect((await readCursorExportUsage(copy)).records).toEqual(result.records);
    expect(cursorExportSourceId(input)).not.toBe(
      cursorExportSourceId({ ...input, accountKey: "another-team" }),
    );
    expect(cursorExportSourceId(input)).not.toBe(
      cursorExportSourceId({ ...input, userEmail: "work@example.invalid" }),
    );
  });
  it("reports incomplete pages and resolves complete page sets honestly", async () => {
    const input = await source(),
      page = await fixture();
    page.pagination = { ...page.pagination, numPages: 2, hasNextPage: true };
    await writeFile(input.path, JSON.stringify(page));
    expect((await readCursorExportUsage(input)).diagnosticCode).toContain(
      "cursor-export-pages-incomplete",
    );
    const second = {
      ...page,
      pagination: { ...page.pagination, currentPage: 2, hasNextPage: false },
    };
    await writeFile(join(roots[0]!, "usage-page2.json"), JSON.stringify(second));
    const result = await readCursorExportUsage({ ...input, path: roots[0]! });
    expect(result.diagnosticCode).not.toContain("cursor-export-pages-incomplete");
    expect(result.status).toBe("partial");
  });
  it("does not turn missing/corrupt/unsupported token data into zero and preserves unknown models", async () => {
    const input = await source(),
      page = await fixture();
    page.usageEvents[0].tokenUsage.inputTokens = -1;
    page.usageEvents[2].userEmail = input.userEmail;
    delete page.usageEvents[2].tokenUsage.totalCents;
    await writeFile(input.path, JSON.stringify(page));
    const result = await readCursorExportUsage(input);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.model).toBe("unknown-model");
    expect(priceUsageRecord(new Map(), result.records[0]!)).toMatchObject({
      estimatedCostUsd: null,
      unpricedTokenCount: 1000,
    });
    await writeFile(input.path, '{"usageEvents":');
    expect((await readCursorExportUsage(input)).status).toBe("failed");
    await writeFile(input.path, '{"unsupported":[]}');
    expect((await readCursorExportUsage(input)).status).toBe("unsupported");
  });
  it("re-reads changed exports instead of serving stale cached records", async () => {
    const input = await source(),
      first = await readCursorExportUsage(input),
      page = await fixture();
    page.usageEvents[0].tokenUsage.outputTokens = 500;
    await writeFile(input.path, JSON.stringify(page));
    const second = await readCursorExportUsage(input);
    expect(second.records[0]?.totals.totalTokens).toBe(first.records[0]!.totals.totalTokens + 50);
    // No event ID means changed metadata is a different fingerprint, explicitly partial.
    expect(second.records[0]?.dedupeKey).not.toBe(first.records[0]?.dedupeKey);
  });
  it("discloses changed-value overlap rather than claiming it is a stable event correction", async () => {
    const input = await source(),
      page = await fixture();
    page.usageEvents[0].tokenUsage.outputTokens += 50;
    await writeFile(join(roots[0]!, "corrected.json"), JSON.stringify(page));
    const result = await readCursorExportUsage({ ...input, path: roots[0]! });
    expect(result.records).toHaveLength(2);
    expect(result.imports).toHaveLength(6);
    expect(result.status).toBe("partial");
    expect(result.diagnosticCode).toContain("identity-ambiguous");
  });
  it.skipIf(process.platform === "win32")(
    "rejects an explicitly configured FIFO JSON file before open",
    async () => {
      const input = await source(),
        fifo = join(roots[0]!, "fifo.json");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      expect(await readCursorExportUsage({ ...input, path: fifo })).toMatchObject({
        status: "failed",
        records: [],
        diagnosticCode: "cursor-export-path-rejected",
      });
    },
    1000,
  );
  it("bounds file/directory sizes, refuses symlinks and credentials, and honors cancellation", async () => {
    const input = await source(),
      link = join(roots[0]!, "link.json");
    await symlink(input.path, link);
    expect(await readCursorExportUsage({ ...input, path: link })).toMatchObject({
      status: "failed",
      records: [],
    });
    await writeFile(input.path, "x".repeat(CURSOR_EXPORT_LIMITS.fileBytes + 1));
    expect(await readCursorExportUsage(input)).toMatchObject({ status: "failed", records: [] });
    const auth = join(roots[0]!, "auth.json");
    await writeFile(auth, "CREDENTIAL_SENTINEL");
    expect(await readCursorExportUsage({ ...input, path: auth })).toMatchObject({
      status: "failed",
      malformedCount: 0,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(readCursorExportUsage(input, controller.signal)).rejects.toThrow();
  });
});
