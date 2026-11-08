import { describe, expect, it } from "vite-plus/test";

import { formatBytes } from "./byteSize.ts";

describe("formatBytes", () => {
  it("states sizes in binary units with one decimal below ten", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
    expect(formatBytes(1.4 * 1024 ** 3)).toBe("1.4 GB");
  });
});
