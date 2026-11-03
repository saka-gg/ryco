import { describe, expect, it } from "vite-plus/test";

import { isBrowserUploadId, newBrowserUploadId } from "./browserUpload.ts";

describe("browser upload ids", () => {
  it("creates fresh ids that the desktop accepts", () => {
    const ids = new Set(Array.from({ length: 64 }, () => newBrowserUploadId()));
    expect(ids.size).toBe(64);
    for (const id of ids) {
      expect(id).toMatch(/^u-[0-9a-f]{16}$/u);
      expect(isBrowserUploadId(id)).toBe(true);
    }
  });

  it("accepts nothing else", () => {
    for (const value of [
      "u-0123456789abcde",
      "u-0123456789abcdef0",
      "u-0123456789ABCDEF",
      "u-abcdef",
      "../u-0123456789abcdef",
      "u-0123456789abcdef/",
      "",
      undefined,
      7,
    ])
      expect(isBrowserUploadId(value)).toBe(false);
  });
});
