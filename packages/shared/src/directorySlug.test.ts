import { describe, expect, it } from "vite-plus/test";

import { DIRECTORY_SLUG_MAX_LENGTH, directorySlug } from "./directorySlug.ts";

describe("directorySlug", () => {
  it.each([
    ["Plan a trip to Zürich", "plan-a-trip-to-zurich"],
    ["../../etc/passwd", "etc-passwd"],
    ["a/b\\c..d", "a-b-c-d"],
    ["  --Hello__World--  ", "hello-world"],
  ])("slugs %j as %j", (input, expected) => {
    expect(directorySlug(input, "chat")).toBe(expected);
  });

  it("never yields separators or traversal segments", () => {
    for (const input of ["..", "/", "\\", "../..", ". .", "a/../b"]) {
      const slug = directorySlug(input, "chat");
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("falls back when nothing portable remains", () => {
    expect(directorySlug("..", "chat")).toBe("chat");
    expect(directorySlug("日本語", "chat")).toBe("chat");
  });

  it("bounds the length without a trailing hyphen", () => {
    const slug = directorySlug(`${"a".repeat(DIRECTORY_SLUG_MAX_LENGTH - 1)} tail`, "chat");
    expect(slug.length).toBeLessThanOrEqual(DIRECTORY_SLUG_MAX_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });
});
