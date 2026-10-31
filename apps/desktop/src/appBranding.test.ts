import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopAppBranding, resolveDesktopAppStageLabel } from "./appBranding.ts";

describe("resolveDesktopAppStageLabel", () => {
  it("uses Dev in desktop development", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: true,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toBe("Dev");
  });

  it("uses Nightly for packaged nightly builds", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toBe("Nightly");
  });

  it("uses Beta for packaged stable builds", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.17",
      }),
    ).toBe("Beta");
  });
});

describe("resolveDesktopAppBranding", () => {
  it("returns a complete desktop branding payload", () => {
    expect(
      resolveDesktopAppBranding({
        isDevelopment: false,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toEqual({
      baseName: "Ryco",
      stageLabel: "Nightly",
      displayName: "Ryco (Nightly)",
    });
  });
});

describe("Ryco Nightly branding", () => {
  it("names the separate app like its bundle", () => {
    expect(
      resolveDesktopAppBranding({
        isDevelopment: false,
        appVersion: "0.1.38-nightly.20261101.4",
        flavor: "nightly",
      }),
    ).toEqual({ baseName: "Ryco", stageLabel: "Nightly", displayName: "Ryco Nightly" });
    // The in-place nightly keeps its old name until it moves to stable.
    expect(
      resolveDesktopAppBranding({
        isDevelopment: false,
        appVersion: "0.1.37-nightly.20261031.2",
        flavor: "stable",
      }).displayName,
    ).toBe("Ryco (Nightly)");
  });
});
