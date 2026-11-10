import type { ProjectListEntriesResult, ProjectReadFileResult } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { listEntriesSince, readFileSince } from "./unchangedReads.ts";

const listing: ProjectListEntriesResult = {
  entries: [{ path: "src", kind: "directory" }],
  truncated: false,
  revision: "l1.a",
};
const file: ProjectReadFileResult = {
  relativePath: "src/a.ts",
  contents: "a",
  version: "sha256:a",
  encoding: "utf8",
  lineEnding: "lf",
};

describe("listEntriesSince", () => {
  it("sends the held revision and keeps the held listing on unchanged", async () => {
    const listEntries = vi.fn(async () => ({
      entries: [],
      truncated: false,
      revision: "l1.a",
      unchanged: true as const,
    }));
    expect(await listEntriesSince(listEntries, "/repo", listing)).toBe(listing);
    expect(listEntries).toHaveBeenCalledWith({ cwd: "/repo", knownRevision: "l1.a" });
  });

  it("asks without a revision when it holds none (an older node never sends one)", async () => {
    const legacy = { entries: listing.entries, truncated: false };
    const listEntries = vi.fn(async () => legacy);
    expect(await listEntriesSince(listEntries, "/repo", null)).toBe(legacy);
    expect(await listEntriesSince(listEntries, "/repo", legacy)).toBe(legacy);
    expect(listEntries.mock.calls).toEqual([[{ cwd: "/repo" }], [{ cwd: "/repo" }]]);
  });

  it("uses a full answer, and reads again when unchanged names another revision", async () => {
    const next = { ...listing, revision: "l1.b" };
    const listEntries = vi
      .fn()
      .mockResolvedValueOnce({ entries: [], truncated: false, revision: "l1.c", unchanged: true })
      .mockResolvedValueOnce(next);
    expect(await listEntriesSince(listEntries, "/repo", listing)).toBe(next);
    expect(listEntries.mock.calls[1]).toEqual([{ cwd: "/repo" }]);
  });
});

describe("readFileSince", () => {
  it("sends the held version and keeps the held file on unchanged", async () => {
    const readFile = vi.fn(async () => ({ ...file, contents: "", unchanged: true as const }));
    expect(await readFileSince(readFile, { cwd: "/repo", relativePath: "src/a.ts" }, file)).toBe(
      file,
    );
    expect(readFile).toHaveBeenCalledWith({
      cwd: "/repo",
      relativePath: "src/a.ts",
      knownVersion: "sha256:a",
    });
  });

  it("never sends another file's version, and takes an older node's full answer", async () => {
    const other = { ...file, relativePath: "src/b.ts", version: "sha256:b" };
    const readFile = vi.fn(async () => other);
    expect(await readFileSince(readFile, { cwd: "/repo", relativePath: "src/b.ts" }, file)).toBe(
      other,
    );
    expect(readFile).toHaveBeenCalledWith({ cwd: "/repo", relativePath: "src/b.ts" });
  });
});
