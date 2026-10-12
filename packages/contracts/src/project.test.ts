import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import {
  ProjectReadFileResult,
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
