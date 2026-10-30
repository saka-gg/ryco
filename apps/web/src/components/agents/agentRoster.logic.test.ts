import { describe, expect, it } from "vite-plus/test";

import { monogramInkColor } from "./agentRoster.logic";

describe("monogramInkColor", () => {
  it("puts dark letters on light fills and white on dark ones", () => {
    expect(monogramInkColor("#eab308")).toBe("#111827");
    expect(monogramInkColor("#84cc16")).toBe("#111827");
    expect(monogramInkColor("#6366f1")).toBe("#ffffff");
    expect(monogramInkColor("#1e1b4b")).toBe("#ffffff");
  });
});
