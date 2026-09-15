import { describe, expect, it } from "vite-plus/test";
import { Option, Schema } from "effect";
import { GitApplyIndexPatchInput } from "./git.ts";

describe("index patch selection", () => {
  const input = {
    cwd: "/repo",
    scope: "unstaged",
    expectedRevision: "a".repeat(64),
    fileId: "b".repeat(64),
  };
  const valid = (value: unknown) =>
    Option.isSome(Schema.decodeUnknownOption(GitApplyIndexPatchInput)(value));
  it("requires exact identities and a nonnegative integer hunk", () => {
    expect(valid(input)).toBe(true);
    expect(valid({ ...input, hunkIndex: 0 })).toBe(true);
    for (const hunkIndex of [-1, 0.5, Infinity]) expect(valid({ ...input, hunkIndex })).toBe(false);
    expect(valid({ ...input, expectedRevision: "" })).toBe(false);
    expect(valid({ ...input, fileId: "path.txt" })).toBe(false);
    expect(valid({ ...input, scope: "working-tree" })).toBe(false);
  });
});
