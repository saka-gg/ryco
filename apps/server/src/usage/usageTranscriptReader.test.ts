// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
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
