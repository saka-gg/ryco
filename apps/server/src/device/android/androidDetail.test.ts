import { describe, expect, it } from "vitest";

import {
  defaultDisplayRotation,
  parseAndroidPermissions,
  parseAndroidSettings,
  parseForegroundPackage,
  textSizeForFontScale,
  type AndroidDetailOutputs,
} from "./androidDetail.ts";
import { planAndroidTestingAction } from "./androidTesting.ts";

const outputs = (overrides: Partial<AndroidDetailOutputs> = {}): AndroidDetailOutputs => ({
  night: "Night mode: yes",
  fontScale: "1.15",
  animator: "0.0",
  wifi: "0",
  contrast: "1",
  daltonizerEnabled: "1",
  daltonizer: "0",
  displays: "  Display: mDisplayId=0 (organized)\n    mRotation=1 mDeferredRotationPauseCount=0\n",
  window: null,
  location: "      last location=null",
  ...overrides,
});

describe("Android settings read-back", () => {
  it("reads each setting as the emulator reports it", () => {
    expect(parseAndroidSettings(outputs(), undefined)).toEqual({
      appearance: "dark",
      fontScale: 1.15,
      textSize: "extra-large",
      reduceMotion: true,
      network: "off",
      increaseContrast: true,
      colorFilter: "grayscale",
      orientation: "landscape-left",
    });
  });

  it("treats unset animation and filter settings as their defaults", () => {
    const settings = parseAndroidSettings(
      outputs({ animator: "null", daltonizerEnabled: "null", wifi: "1", contrast: "null" }),
      undefined,
    );
    expect(settings).toMatchObject({
      reduceMotion: false,
      colorFilter: "none",
      network: "on",
      increaseContrast: false,
    });
  });

  it("prefers a location the device reports, else the one Ryco applied", () => {
    expect(
      parseAndroidSettings(
        outputs({ location: "last location=Location[gps 37.422,-122.084 hAcc=5]" }),
        {
          latitude: 1,
          longitude: 2,
        },
      ).location,
    ).toEqual({ latitude: 37.422, longitude: -122.084, source: "device" });
    expect(parseAndroidSettings(outputs(), { latitude: 1, longitude: 2 }).location).toEqual({
      latitude: 1,
      longitude: 2,
      source: "applied",
    });
  });

  it("reads the built-in display's rotation, not a virtual display's listed first", () => {
    const dump = [
      "  Display: mDisplayId=3",
      "    mRotation=0 mDeferredRotationPauseCount=0",
      "  Display: mDisplayId=0 (organized)",
      "    mRotation=3 mDeferredRotationPauseCount=0",
    ].join("\n");
    expect(defaultDisplayRotation(dump)).toBe("3");
    expect(defaultDisplayRotation("    mRotation=2")).toBe("2");
    expect(defaultDisplayRotation(null)).toBeUndefined();
  });

  it("maps a font scale to the nearest content size", () => {
    expect(textSizeForFontScale(1)).toBe("large");
    expect(textSizeForFontScale(1.7)).toBe("accessibility-large");
  });

  it("finds the focused package", () => {
    expect(
      parseForegroundPackage(
        "  mCurrentFocus=Window{408f62c u0 com.android.settings/com.android.settings.Settings}",
      ),
    ).toBe("com.android.settings");
    expect(parseForegroundPackage("nothing focused")).toBeNull();
  });

  it("reports runtime permission states for the services an app asked for", () => {
    const dump = [
      "    runtime permissions:",
      "      android.permission.ACCESS_FINE_LOCATION: granted=true, flags=[ USER_SET ]",
      "      android.permission.ACCESS_COARSE_LOCATION: granted=false, flags=[ ]",
      "      android.permission.CAMERA: granted=false, flags=[ USER_SET|USER_SENSITIVE_WHEN_GRANTED ]",
      "      android.permission.RECORD_AUDIO: granted=false, flags=[ USER_FIXED ]",
      "      android.permission.READ_CONTACTS: granted=false, flags=[ ]",
      "    disabledComponents:",
      "      android.permission.READ_CALENDAR: granted=true",
    ].join("\n");
    const states = parseAndroidPermissions(dump, 34);
    expect(states).toEqual([
      { service: "contacts", state: "not-determined" },
      { service: "location", state: "granted" },
      { service: "microphone", state: "denied" },
    ]);
  });
});

describe("Android testing plans for the Tools drawer", () => {
  const plan = (action: Parameters<typeof planAndroidTestingAction>[0]["action"]) =>
    planAndroidTestingAction({ udid: "android:Pixel", action }, 34);

  it("zeroes the animation scales for Reduce Motion and uses high contrast text", () => {
    expect(plan({ type: "accessibility", setting: "reduce-motion", value: true })).toEqual(
      ["animator_duration_scale", "transition_animation_scale", "window_animation_scale"].map(
        (key) => ({ kind: "shell", args: ["settings", "put", "global", key, "0"] }),
      ),
    );
    expect(plan({ type: "accessibility", setting: "increase-contrast", value: false })).toEqual([
      { kind: "shell", args: ["settings", "put", "secure", "high_text_contrast_enabled", "0"] },
    ]);
    expect(() => plan({ type: "accessibility", setting: "voiceover", value: true })).toThrow();
    expect(() => plan({ type: "liquid-glass", value: "clear" })).toThrow(/iOS/);
  });

  it("turns color correction on with a mode, and off", () => {
    expect(plan({ type: "color-filter", value: "blue-yellow" })).toEqual([
      {
        kind: "shell",
        args: ["settings", "put", "secure", "accessibility_display_daltonizer", "13"],
      },
      {
        kind: "shell",
        args: ["settings", "put", "secure", "accessibility_display_daltonizer_enabled", "1"],
      },
    ]);
    expect(plan({ type: "color-filter", value: "none" })).toHaveLength(1);
  });

  it("force-stops an app", () => {
    expect(plan({ type: "terminate-app", bundleId: "com.example.app" })).toEqual([
      { kind: "shell", args: ["am", "force-stop", "com.example.app"] },
    ]);
  });
});
