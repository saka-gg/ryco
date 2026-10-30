import { describe, expect, it } from "vite-plus/test";

import { parseWorktreeIncludePaths } from "./worktreeInclude.ts";

describe("parseWorktreeIncludePaths", () => {
  it("keeps paths inside the checkout, sorted and once each", () => {
    expect(
      parseWorktreeIncludePaths(
        ["config/local.json", ".env", "../outside", "/etc/passwd", "a//b", ".env", ""].join("\0"),
      ),
    ).toEqual([".env", "config/local.json"]);
  });
});
