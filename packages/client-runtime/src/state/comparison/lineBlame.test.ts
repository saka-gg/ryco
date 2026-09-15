import { describe, expect, it, vi } from "vitest";
import { createLineBlameReader, displayedBlameTarget } from "./lineBlame.ts";
import type { GitReadLineBlameResult } from "@ryco/contracts";
const file = {
  name: "new.ts",
  prevName: "old.ts",
  hunks: [
    {
      deletionStart: 20,
      additionStart: 30,
      hunkContent: [
        { type: "context" as const, lines: 2 },
        { type: "change" as const, deletions: 1, additions: 3 },
        { type: "context" as const, lines: 1 },
      ],
    },
  ],
};
const source = {
  repositoryPath: "/repo/.git",
  worktreePath: "/work",
  revision: "r1",
  refOid: "c".repeat(40),
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};
const result: GitReadLineBlameResult = {
  kind: "committed",
  oid: "c".repeat(40),
  author: "Ada",
  summary: "Change",
  authorTime: null,
};
describe("displayed blame policy", () => {
  it("uses old/new paths and actual side line numbers after shifts", () => {
    expect(displayedBlameTarget(file, "base", 22)).toEqual({
      side: "base",
      filePath: "old.ts",
      line: 22,
    });
    expect(displayedBlameTarget(file, "head", 35)).toEqual({
      side: "head",
      filePath: "new.ts",
      line: 35,
    });
    expect(displayedBlameTarget(file, "base", 23)?.line).toBe(23);
  });
  it("rejects additions, gaps, nonlines and empty diffs", () => {
    for (const line of [0, 1.5, 19, 32, 33, 34, 36])
      expect(displayedBlameTarget(file, "head", line)).toBeNull();
    expect(displayedBlameTarget({ ...file, hunks: [] }, "base", 1)).toBeNull();
  });
});
describe("blame reader", () => {
  it("uses frozen endpoints and deduplicates exact line requests", async () => {
    const read = vi.fn().mockResolvedValue(result);
    const reader = createLineBlameReader({ environmentId: "one", source, read });
    const target = { side: "base" as const, filePath: "old.ts", line: 22 };
    await Promise.all([reader.read(target), reader.read(target)]);
    expect(read).toHaveBeenCalledExactlyOnceWith({
      cwd: "/work",
      oid: source.baseOid,
      filePath: "old.ts",
      line: 22,
    });
    await reader.read({ ...target, side: "head" });
    expect(read.mock.calls[1]?.[0].oid).toBe(source.headOid);
  });
  it("rejects late responses after disposal", async () => {
    let resolve!: (value: GitReadLineBlameResult) => void;
    const reader = createLineBlameReader({
      environmentId: "one",
      source,
      read: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const pending = reader.read({ side: "base", filePath: "old.ts", line: 22 });
    await Promise.resolve();
    reader.dispose();
    resolve(result);
    await expect(pending).rejects.toThrow("Comparison changed");
    await expect(reader.read({ side: "base", filePath: "old.ts", line: 22 })).rejects.toThrow(
      "Comparison changed",
    );
  });
  it("bounds cache and retries failed requests", async () => {
    const read = vi.fn().mockResolvedValue(result);
    const reader = createLineBlameReader({ environmentId: "one", source, read });
    for (let line = 1; line <= 33; line++)
      await reader.read({ side: "base", filePath: "old.ts", line });
    await reader.read({ side: "base", filePath: "old.ts", line: 1 });
    expect(read).toHaveBeenCalledTimes(34);
    read.mockRejectedValueOnce(new Error("offline"));
    const target = { side: "head" as const, filePath: "old.ts", line: 1 };
    await expect(reader.read(target)).rejects.toThrow("offline");
    await expect(reader.read(target)).resolves.toEqual(result);
  });
});
