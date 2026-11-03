import { describe, expect, it, vi } from "vitest";

import { macPrivacySettingsUrl, resolveMacAppBundle } from "./macAppBundle.ts";

describe("macOS app bundle helpers", () => {
  it("links each privacy pane in System Settings", () => {
    expect(macPrivacySettingsUrl("accessibility")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
    expect(macPrivacySettingsUrl("screen-recording")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    expect(macPrivacySettingsUrl("input-monitoring")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
    );
  });

  it("finds the running bundle and its identifier", () => {
    const readIdentifier = vi.fn(() => "com.laurinfrank.ryco.dev");
    expect(
      resolveMacAppBundle(
        "/Applications/Ryco Dev.app/Contents/MacOS/Ryco",
        "darwin",
        readIdentifier,
      ),
    ).toEqual({
      bundlePath: "/Applications/Ryco Dev.app",
      bundleId: "com.laurinfrank.ryco.dev",
    });
    expect(readIdentifier).toHaveBeenCalledWith("/Applications/Ryco Dev.app/Contents/Info.plist");
    expect(resolveMacAppBundle("/usr/local/bin/electron", "darwin", readIdentifier)).toEqual({
      bundlePath: undefined,
      bundleId: "com.laurinfrank.ryco",
    });
  });
});
