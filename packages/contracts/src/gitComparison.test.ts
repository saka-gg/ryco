import { describe, expect, it } from "vite-plus/test";
import { Option, Schema } from "effect";
import { GitReadComparisonInput } from "./git.ts";
const decode = (ref: string, mode = "direct") =>
  Schema.decodeUnknownOption(GitReadComparisonInput)({
    cwd: "/repo",
    selection: { ref, mode },
    ignoreWhitespace: false,
  });
describe("comparison schema", () => {
  it("accepts literal refs and commit IDs", () => {
    for (const ref of ["main", "origin/feature/topic", "refs/tags/v1.0", "a".repeat(64)])
      expect(Option.isSome(decode(ref))).toBe(true);
  });
  it("rejects options, ranges, expressions, controls, and oversized input", () => {
    for (const ref of [
      "",
      "-x",
      "main..HEAD",
      "HEAD~1",
      "HEAD^",
      "main:file",
      "a\nb",
      "a\0b",
      "a".repeat(257),
    ])
      expect(Option.isNone(decode(ref))).toBe(true);
    expect(Option.isNone(decode("main", "worktree"))).toBe(true);
  });
});
