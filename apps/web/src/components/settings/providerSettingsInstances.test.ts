import { describe, expect, it } from "vite-plus/test";

import { resolveProviderSettingsListNavigationIndex } from "./providerSettingsInstances";

describe("provider settings instance list", () => {
  it("supports wrapping arrow navigation and direct first/last navigation", () => {
    expect(resolveProviderSettingsListNavigationIndex(0, "ArrowUp", 4)).toBe(3);
    expect(resolveProviderSettingsListNavigationIndex(3, "ArrowDown", 4)).toBe(0);
    expect(resolveProviderSettingsListNavigationIndex(2, "Home", 4)).toBe(0);
    expect(resolveProviderSettingsListNavigationIndex(1, "End", 4)).toBe(3);
  });
});
