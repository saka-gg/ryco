import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import {
  ProjectReadFileResult,
  ProjectSearchContentError,
  ProjectSearchContentInput,
  ProjectSearchContentResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";

describe("workspace file editing contracts", () => {
  it("decodes editable file metadata", () => {
    const decoded = Schema.decodeUnknownSync(ProjectReadFileResult)({
      relativePath: "src/app.ts",
      contents: "export {};\n",
      version: `sha256:${"a".repeat(64)}`,
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });

    expect(decoded).toEqual({
      relativePath: "src/app.ts",
      contents: "export {};\n",
      version: `sha256:${"a".repeat(64)}`,
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
  });

  it("keeps legacy unguarded writes valid", () => {
    expect(
      Schema.decodeUnknownSync(ProjectWriteFileInput)({
        cwd: "/repo",
        relativePath: "notes.md",
        contents: "# Notes\n",
      }),
    ).toEqual({
      cwd: "/repo",
      relativePath: "notes.md",
      contents: "# Notes\n",
    });
  });

  it("decodes guarded writes and versioned results", () => {
    const expectedVersion = `sha256:${"b".repeat(64)}`;
    expect(
      Schema.decodeUnknownSync(ProjectWriteFileInput)({
        cwd: "/repo",
        relativePath: "src/app.ts",
        contents: "export const value = 1;\n",
        expectedVersion,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    ).toEqual({
      cwd: "/repo",
      relativePath: "src/app.ts",
      contents: "export const value = 1;\n",
      expectedVersion,
      encoding: "utf8",
      lineEnding: "lf",
    });
    expect(
      Schema.decodeUnknownSync(ProjectWriteFileResult)({
        relativePath: "src/app.ts",
        version: expectedVersion,
      }),
    ).toEqual({ relativePath: "src/app.ts", version: expectedVersion });
  });

  it("carries a typed guarded-write failure reason", () => {
    const error = Schema.decodeUnknownSync(ProjectWriteFileError)({
      _tag: "ProjectWriteFileError",
      message: "Workspace file changed after it was opened.",
      reason: "conflict",
    });

    expect(error._tag).toBe("ProjectWriteFileError");
    expect(error.reason).toBe("conflict");
  });
});

describe("workspace entry search contracts", () => {
  const decodeSearchInput = Schema.decodeUnknownSync(ProjectSearchEntriesInput);
  const decodeSearchResult = Schema.decodeUnknownSync(ProjectSearchEntriesResult);

  it("accepts an empty query (top-level listing and index warm-up)", () => {
    expect(decodeSearchInput({ cwd: "/repo", query: "", limit: 80 }).query).toBe("");
    expect(decodeSearchInput({ cwd: "/repo", query: "  src  ", limit: 80 }).query).toBe("src");
  });

  it("still bounds the query length", () => {
    expect(() => decodeSearchInput({ cwd: "/repo", query: "x".repeat(257), limit: 80 })).toThrow();
  });

  it("keeps the partial and refreshing flags optional", () => {
    expect(decodeSearchResult({ entries: [], truncated: false })).toEqual({
      entries: [],
      truncated: false,
    });
    expect(
      decodeSearchResult({ entries: [], truncated: true, partial: true, refreshing: true }),
    ).toEqual({ entries: [], truncated: true, partial: true, refreshing: true });
  });
});

describe("workspace content search contracts", () => {
  const decodeSearchInput = Schema.decodeUnknownSync(ProjectSearchContentInput);
  const decodeSearchResult = Schema.decodeUnknownSync(ProjectSearchContentResult);

  it("keeps the query as typed and leaves the toggles optional", () => {
    expect(decodeSearchInput({ cwd: "/repo", query: "  needle ", limit: 200 })).toEqual({
      cwd: "/repo",
      query: "  needle ",
      limit: 200,
    });
    expect(
      decodeSearchInput({
        cwd: "/repo",
        query: "needle",
        limit: 200,
        caseSensitive: true,
        wholeWord: true,
        cursor: "v1:src/a.ts",
      }),
    ).toMatchObject({ caseSensitive: true, wholeWord: true, cursor: "v1:src/a.ts" });
  });

  it.each([
    ["an empty query", { query: "" }],
    ["a query over 256 characters", { query: "x".repeat(257) }],
    ["a newline", { query: "two\nlines" }],
    ["a carriage return", { query: "two\rlines" }],
    ["a NUL", { query: "nee\0dle" }],
    ["limit 0", { limit: 0 }],
    ["limit 501", { limit: 501 }],
    ["an empty cursor", { cursor: "" }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      decodeSearchInput({ cwd: "/repo", query: "needle", limit: 200, ...override }),
    ).toThrow();
  });

  it("decodes pages and ignores keys from newer nodes", () => {
    const match = { path: "src/a.ts", lineNumber: 3, preview: "a needle", ranges: [] };
    expect(decodeSearchResult({ matches: [match], extra: true })).toEqual({ matches: [match] });
    expect(
      decodeSearchResult({ matches: [], nextCursor: "v1:src/a.ts", timedOut: true, partial: true }),
    ).toEqual({ matches: [], nextCursor: "v1:src/a.ts", timedOut: true, partial: true });
  });

  it("carries an optional failure reason", () => {
    const error = Schema.decodeUnknownSync(ProjectSearchContentError)({
      _tag: "ProjectSearchContentError",
      message: "This search can't continue. Search again.",
      reason: "cursor",
    });
    expect(error.reason).toBe("cursor");
    expect(
      Schema.decodeUnknownSync(ProjectSearchContentError)({
        _tag: "ProjectSearchContentError",
        message: "Failed to search workspace contents.",
      }).reason,
    ).toBeUndefined();
  });
});
