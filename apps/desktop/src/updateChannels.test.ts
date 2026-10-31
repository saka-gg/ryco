import { describe, expect, it } from "vite-plus/test";

import { doesVersionMatchDesktopUpdateChannel, isNightlyDesktopVersion } from "./updateChannels.ts";

describe("isNightlyDesktopVersion", () => {
  it("detects packaged nightly versions", () => {
    expect(isNightlyDesktopVersion("0.0.17-nightly.20260415.1")).toBe(true);
  });

  it("does not flag stable versions as nightly", () => {
    expect(isNightlyDesktopVersion("0.0.17")).toBe(false);
  });
});

describe("doesVersionMatchDesktopUpdateChannel", () => {
  it("accepts nightly releases on the nightly channel", () => {
    expect(doesVersionMatchDesktopUpdateChannel("0.0.17-nightly.20260416.1", "nightly")).toBe(true);
  });

  it("rejects stable releases on the nightly channel", () => {
    expect(doesVersionMatchDesktopUpdateChannel("0.0.17", "nightly")).toBe(false);
  });

  it("rejects nightly releases on the stable channel", () => {
    expect(doesVersionMatchDesktopUpdateChannel("0.0.17-nightly.20260416.1", "latest")).toBe(false);
  });
});
