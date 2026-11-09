import { describe, expect, it } from "vite-plus/test";

import { labelChipColors } from "./sourceControlLabelColors.ts";

describe("labelChipColors", () => {
  it("tints a bright label with its own color", () => {
    expect(labelChipColors("fbca04")).toEqual({
      backgroundColor: "rgba(251, 202, 4, 0.12)",
      borderColor: "rgba(251, 202, 4, 0.35)",
      color: "rgb(251, 202, 4)",
    });
  });

  it("lifts a dark label's text toward white", () => {
    const colors = labelChipColors("#000000");
    expect(colors?.color).toBe("rgb(163, 163, 163)");
  });

  it("has no tint for a missing or malformed color", () => {
    expect(labelChipColors(undefined)).toBeNull();
    expect(labelChipColors("red")).toBeNull();
  });
});
