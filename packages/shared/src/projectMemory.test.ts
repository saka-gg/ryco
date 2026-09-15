import { expect, it } from "vite-plus/test";
import {
  projectMemoryBytes,
  projectMemoryNeedsReview,
  projectMemoryTextProblem,
} from "./projectMemory.ts";
it("counts Unicode code points and UTF-8 bytes, rejecting malformed text", () => {
  expect(projectMemoryTextProblem("😀".repeat(500))).toBeNull();
  expect(projectMemoryBytes("😀".repeat(500))).toBe(2000);
  expect(projectMemoryTextProblem("😀".repeat(501))).toBe("invalid");
  expect(projectMemoryTextProblem("\ud800")).toBe("invalid");
});
it("recognized secret patterns are rejected, including private Hub and operational URLs", () => {
  for (const value of [
    "token=sample",
    "Bearer sample",
    "private Hub deployment",
    "https://example.test/path",
    "-----BEGIN PRIVATE KEY-----abc",
  ])
    expect(projectMemoryTextProblem(value)).toBe("sensitive");
  expect(projectMemoryTextProblem("Unit tests cover parser boundaries.")).toBeNull();
});
it("90 days is the exact review boundary and pinned entries never expire", () => {
  const affirmedAt = "2026-01-01T00:00:00Z",
    now = Date.parse(affirmedAt) + 90 * 86400000;
  expect(projectMemoryNeedsReview({ affirmedAt, pinned: false }, now - 1)).toBe(false);
  expect(projectMemoryNeedsReview({ affirmedAt, pinned: false }, now)).toBe(true);
  expect(projectMemoryNeedsReview({ affirmedAt, pinned: true }, now)).toBe(false);
});
