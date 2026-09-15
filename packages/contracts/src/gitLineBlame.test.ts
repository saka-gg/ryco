import { describe, expect, it } from "vite-plus/test";
import { Option, Schema } from "effect";
import { GitReadLineBlameInput } from "./git.ts";
const input = { cwd: "/repo", oid: "a".repeat(40), filePath: "src/file.ts", line: 1 };
const valid = (value: unknown) =>
  Option.isSome(Schema.decodeUnknownOption(GitReadLineBlameInput)(value));
describe("immutable line blame schema", () => {
  it("accepts SHA-1/SHA-256 and literal nested paths", () => {
    expect(valid(input)).toBe(true);
    expect(valid({ ...input, oid: "a".repeat(64), filePath: "a folder/é.txt" })).toBe(true);
  });
  it("rejects symbolic refs, expressions, zero/fractional lines and unsafe paths", () => {
    for (const oid of ["HEAD", "main", "-h", "a".repeat(41), `${input.oid}^`])
      expect(valid({ ...input, oid })).toBe(false);
    for (const line of [0, -1, 1.5, Infinity, 10_000_001])
      expect(valid({ ...input, line })).toBe(false);
    for (const filePath of [
      "",
      "/tmp/x",
      "../x",
      "a/../x",
      "a/./x",
      "./x",
      "C:/x",
      "a\\b",
      "a\0b",
      "a\nb",
    ])
      expect(valid({ ...input, filePath })).toBe(false);
  });
});
