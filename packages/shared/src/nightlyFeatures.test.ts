import { describe, expect, it } from "vite-plus/test";

import { isNightlyFeatureEnabled, NIGHTLY_ONLY_FEATURES } from "./nightlyFeatures.ts";

describe("isNightlyFeatureEnabled", () => {
  it("turns a listed feature off on a stable node and on on a nightly one", () => {
    const listed = ["tab-strip"];
    expect(isNightlyFeatureEnabled("tab-strip", "0.1.37", listed)).toBe(false);
    expect(isNightlyFeatureEnabled("tab-strip", "0.1.38-nightly.20261101.4", listed)).toBe(true);
  });

  it("keeps every unlisted feature on everywhere", () => {
    expect(isNightlyFeatureEnabled("anything", "0.1.37", ["tab-strip"])).toBe(true);
    expect(NIGHTLY_ONLY_FEATURES.every((feature) => typeof feature === "string")).toBe(true);
  });
});
