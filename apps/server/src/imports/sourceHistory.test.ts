import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverFiles,
  parseHistory,
  readSource,
  sourceCwd,
  IMPORT_LIMITS,
} from "./sourceHistory.ts";
import { id, codexFixture, claudeFixture } from "./sourceHistory.fixtures.ts";
const roots: string[] = [];
const root = async () => {
  const value = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-import-")));
  roots.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe("source history projection", () => {
  it("projects final Codex display text only, preserving source order and timestamps", () => {
    const history = parseHistory("codex", codexFixture());
    expect(history.messages.map((m) => m.text)).toEqual([
      "Please explain this fixture.",
      "A safe answer.",
    ]);
    expect(history.cwd).toBe("C:\\old\\project");
    expect(history.messages[1]?.createdAt).toBe("2026-01-01T00:01:00.000Z");
  });
  it("follows Claude's selected parent chain through non-display and compaction records", () => {
    expect(parseHistory("claudeAgent", claudeFixture()).messages.map((m) => m.text)).toEqual([
      "Question",
      "Visible answer",
    ]);
  });
  it("fails truncated history, missing parents, cycles and unfinished turns explicitly", () => {
    expect(() => parseHistory("codex", codexFixture() + '\n{"type":')).toThrow(/malformed/);
    expect(() =>
      parseHistory(
        "claudeAgent",
        claudeFixture().replace('"parentUuid":"compact"', '"parentUuid":"missing"'),
      ),
    ).toThrow(/incomplete/);
    expect(() =>
      parseHistory(
        "claudeAgent",
        claudeFixture().replace('"parentUuid":"compact"', '"parentUuid":"answer"'),
      ),
    ).toThrow(/cyclic/);
    expect(() =>
      parseHistory("claudeAgent", claudeFixture().replaceAll('"end_turn"', '"tool_use"')),
    ).toThrow(/completed/);
  });
  it("recognizes cross-platform absolute paths without accepting relative or control-character paths", () => {
    expect(sourceCwd("C:\\moved\\repo")).toBe("C:\\moved\\repo");
    expect(sourceCwd("\\\\server\\share\\repo")).toBe("\\\\server\\share\\repo");
    expect(sourceCwd("../../etc")).toBe("");
    expect(sourceCwd("/repo\0secret")).toBe("");
  });
  it("bounds non-display records without materializing every line", () => {
    expect(() => parseHistory("codex", "{}\n".repeat(IMPORT_LIMITS.records + 1))).toThrow(
      /record limit/,
    );
  });
  it("rejects oversized records and redacts recognizable credentials in display text", () => {
    expect(() =>
      parseHistory("codex", codexFixture() + "\n" + "x".repeat(IMPORT_LIMITS.lineBytes + 1)),
    ).toThrow(/size limit/);
    expect(
      JSON.stringify(
        parseHistory(
          "codex",
          codexFixture().replace("A safe answer.", "sk-abcdefghijklmnopqrstuvwxyz123456"),
        ),
      ),
    ).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});
describe("read-only bounded filesystem discovery", () => {
  it("includes archives only when requested, skips subagents and symlinks", async () => {
    const dir = await root();
    await mkdir(path.join(dir, "sessions"));
    await mkdir(path.join(dir, "archived_sessions"));
    await writeFile(path.join(dir, "sessions", `rollout-${id}.jsonl`), codexFixture());
    await writeFile(path.join(dir, "archived_sessions", `rollout-${id}.jsonl`), codexFixture());
    await symlink(path.join(dir, "sessions"), path.join(dir, "sessions", "escape"));
    expect((await discoverFiles("codex", dir, false)).files).toHaveLength(1);
    expect((await discoverFiles("codex", dir, true)).files).toHaveLength(2);
    await mkdir(path.join(dir, "projects", "encoded", id, "subagents"), { recursive: true });
    await writeFile(path.join(dir, "projects", "encoded", `${id}.jsonl`), claudeFixture());
    await writeFile(
      path.join(dir, "projects", "encoded", id, "subagents", `${id}.jsonl`),
      claudeFixture(),
    );
    expect((await discoverFiles("claudeAgent", dir, false)).files).toHaveLength(1);
  });
  it("rejects malformed UTF-8 and links outside the source root", async () => {
    const dir = await root();
    const file = path.join(dir, "bad.jsonl");
    await writeFile(file, Buffer.from([0xc3, 0x28]));
    await expect(readSource(dir, file)).rejects.toThrow(/UTF-8/);
    const other = await root();
    const outside = path.join(other, "source");
    await writeFile(outside, "{}");
    await symlink(outside, path.join(dir, "link"));
    await expect(readSource(dir, path.join(dir, "link"))).rejects.toThrow(/regular files/);
  });
});
