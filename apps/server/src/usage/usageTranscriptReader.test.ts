// @effect-diagnostics nodeBuiltinImport:off
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createUsageTranscriptReader,
  listUsageTranscriptFiles,
  readUsageTranscript,
  USAGE_TRANSCRIPT_LIMITS,
} from "./usageTranscriptReader.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ryco-transcript-fixture-"));
  roots.push(root);
  return root;
}
const claude = JSON.stringify({
  type: "assistant",
  timestamp: "2026-08-07T04:05:13.944Z",
  sessionId: "fixture",
  message: {
    role: "assistant",
    id: "fixture-response",
    model: "claude-sonnet-4-5",
    usage: { input_tokens: 2, output_tokens: 3 },
  },
});

describe("bounded transcript scans", () => {
  it("keeps Claude results and diagnoses oversized/partial lines without swallowing following records", async () => {
    const root = await setup(),
      path = join(root, "fixture.jsonl");
    await writeFile(
      path,
      '"usage"' + "x".repeat(USAGE_TRANSCRIPT_LIMITS.lineBytes) + "\n" + claude + '\n{"usage":',
    );
    const read = await readUsageTranscript(path, "claude");
    expect(read).toMatchObject({ limited: true, malformedLineCount: 1 });
    expect(read?.records[0]?.totals.totalTokens).toBe(5);
  });
  it("refuses Cursor CLI records as a token history ledger", async () => {
    const root = await setup(),
      path = join(root, "fixture.jsonl");
    await writeFile(
      path,
      await readFile(new URL("./fixtures/cursor-result.json", import.meta.url)),
    );
    expect(await readUsageTranscript(path, "cursor")).toBeNull();
  });
  it("does not follow files, nested directories, or root directory links", async () => {
    const root = await setup(),
      other = await setup();
    await writeFile(join(other, "fixture.jsonl"), claude);
    await symlink(join(other, "fixture.jsonl"), join(root, "file.jsonl"));
    await symlink(other, join(root, "directory"));
    const listing = await listUsageTranscriptFiles(root, 0);
    expect(listing.files).toEqual([]);
    expect(listing.errorCount).toBe(2);
    expect(await readUsageTranscript(join(root, "file.jsonl"), "claude")).toBeNull();
    expect((await listUsageTranscriptFiles(join(root, "directory"), 0)).errorCount).toBe(1);
  });
  it("bounds depth and responds to cancellation while discovering sources", async () => {
    const root = await setup();
    await mkdir(
      join(root, ...Array.from({ length: USAGE_TRANSCRIPT_LIMITS.depth + 2 }, () => "nested")),
      { recursive: true },
    );
    expect((await listUsageTranscriptFiles(root, 0)).errorCount).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(listUsageTranscriptFiles(root, 0, controller.signal)).rejects.toThrow();
    await expect(
      readUsageTranscript(join(root, "missing.jsonl"), "claude", controller.signal),
    ).rejects.toThrow();
  });
});

describe("incremental transcript parsing", () => {
  it("reuses only verified complete lines and matches full parsing after appends", async () => {
    const root = await setup(),
      path = join(root, "fixture.jsonl");
    const reader = createUsageTranscriptReader();
    await writeFile(path, `${claude}\n`);
    expect((await reader(path, "claude"))?.reusedLineCount).toBe(0);
    await appendFile(path, `${claude.replace("fixture-response", "second-response")}\n`);
    const appended = await reader(path, "claude");
    expect(appended?.reusedLineCount).toBe(1);
    expect(appended?.records).toEqual((await readUsageTranscript(path, "claude"))?.records);
    expect(appended?.records).toHaveLength(2);
  });

  it("re-reads partial UTF-8 and JSON tails without losing or double-counting the final row", async () => {
    const root = await setup(),
      path = join(root, "fixture.jsonl");
    const reader = createUsageTranscriptReader();
    const second = Buffer.from(
      claude.replace("fixture-response", "second-response").replace("fixture", "fixture-🌍"),
    );
    const split = second.indexOf(Buffer.from("🌍")) + 2;
    await writeFile(path, Buffer.concat([Buffer.from(`${claude}\n`), second.subarray(0, split)]));
    const first = await reader(path, "claude");
    expect(first?.records).toHaveLength(1);
    await appendFile(path, second.subarray(split));
    const resumed = await reader(path, "claude");
    expect(resumed?.reusedLineCount).toBe(1);
    expect(resumed?.records).toHaveLength(2);
    expect(resumed?.records[1]?.sessionId).toBe("fixture-🌍");
    await appendFile(path, "\n");
    const completed = await reader(path, "claude");
    expect(completed?.records).toHaveLength(2);
    expect(completed?.records).toEqual((await readUsageTranscript(path, "claude"))?.records);
  });

  it("carries Codex context and usage deduplication across reads", async () => {
    const root = await setup(),
      path = join(root, "fixture.jsonl");
    const reader = createUsageTranscriptReader();
    const context = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } });
    const usage = (tokens: number) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-07T04:05:13.944Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: tokens, output_tokens: 3 } },
        },
      });
    await writeFile(path, `${context}\n${usage(2)}\n`);
    await reader(path, "codex");
    await appendFile(path, `${usage(2)}\n${usage(5)}\n`);
    const appended = await reader(path, "codex");
    expect(appended?.reusedLineCount).toBe(2);
    expect(appended?.records).toHaveLength(2);
    expect(appended?.records).toEqual((await readUsageTranscript(path, "codex"))?.records);
  });

  it("falls back on truncation, replacement, or an edit anywhere in the old prefix", async () => {
    const root = await setup(),
      path = join(root, "fixture.jsonl");
    const reader = createUsageTranscriptReader();
    await writeFile(path, `${claude}\n${claude}\n`);
    await reader(path, "claude");
    await writeFile(path, `${claude}\n`);
    expect((await reader(path, "claude"))?.reusedLineCount).toBe(0);
    const before = await stat(path);
    await writeFile(path, `${claude.replace('"input_tokens":2', '"input_tokens":7')}\n${claude}\n`);
    await utimes(path, before.atime, before.mtime);
    const edited = await reader(path, "claude");
    expect(edited?.reusedLineCount).toBe(0);
    expect(edited?.records[0]?.totals.totalTokens).toBe(10);
    await writeFile(`${path}.new`, `${claude}\n`);
    await rename(`${path}.new`, path);
    const replaced = await reader(path, "claude");
    expect(replaced?.reusedLineCount).toBe(0);
    expect(replaced?.records[0]?.totals.totalTokens).toBe(5);
  });

  it("reuses a verified prefix after metadata-only changes", async () => {
    const root = await setup(),
      path = join(root, "fixture.jsonl");
    const reader = createUsageTranscriptReader();
    await writeFile(path, `${claude}\n`);
    await reader(path, "claude");
    await utimes(path, 1000, 1000);
    const read = await reader(path, "claude");
    expect(read?.reusedLineCount).toBe(1);
    expect(read?.records).toHaveLength(1);
  });

  it("evicts the oldest checkpoint when the file budget is reached", async () => {
    const root = await setup();
    const reader = createUsageTranscriptReader();
    for (let i = 0; i < 129; i++) {
      const path = join(root, `${i}.jsonl`);
      await writeFile(path, `${claude}\n`);
      await reader(path, "claude");
    }
    expect((await reader(join(root, "128.jsonl"), "claude"))?.reusedLineCount).toBe(1);
    expect((await reader(join(root, "0.jsonl"), "claude"))?.reusedLineCount).toBe(0);
  });
});
