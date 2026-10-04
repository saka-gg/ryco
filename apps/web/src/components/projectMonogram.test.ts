import { describe, expect, it } from "vite-plus/test";

import { deriveProjectMonogram } from "./projectMonogram";

describe("deriveProjectMonogram", () => {
  it("uses one letter for a single word and two for more", () => {
    expect(deriveProjectMonogram("ryco").initials).toBe("R");
    expect(deriveProjectMonogram("RYCO").initials).toBe("R");
    expect(deriveProjectMonogram("ryco-hub").initials).toBe("RH");
    expect(deriveProjectMonogram("cs2 inspect web").initials).toBe("CI");
    expect(deriveProjectMonogram("weaponPaints").initials).toBe("WP");
    expect(deriveProjectMonogram("my_app.v2").initials).toBe("MA");
  });

  it("falls back to a mark when the name has no letters or digits", () => {
    expect(deriveProjectMonogram("").initials).toBe("#");
    expect(deriveProjectMonogram("--").initials).toBe("#");
  });

  it("keys the color on the name, ignoring case and padding", () => {
    expect(deriveProjectMonogram("Ryco").color).toBe(deriveProjectMonogram(" ryco ").color);
    expect(deriveProjectMonogram("ryco").color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
