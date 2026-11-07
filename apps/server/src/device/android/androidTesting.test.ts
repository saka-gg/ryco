import { describe, expect, it } from "vitest";

import {
  androidPermissions,
  permissionCommand,
  planAndroidTestingAction,
} from "./androidTesting.ts";

const UDID = "android:Pixel";
const plan = (action: Parameters<typeof planAndroidTestingAction>[0]["action"], api = 34) =>
  planAndroidTestingAction({ udid: UDID, action }, api);

describe("Android testing actions", () => {
  it("plans appearance, font scale, location, orientation and network as adb steps", () => {
    expect(plan({ type: "appearance", value: "dark" })).toEqual([
      { kind: "shell", args: ["cmd", "uimode", "night", "yes"] },
    ]);
    expect(plan({ type: "text-size", value: "accessibility-large" })).toEqual([
      { kind: "shell", args: ["settings", "put", "system", "font_scale", "1.7"] },
    ]);
    expect(plan({ type: "location", latitude: 52.52, longitude: 13.405 })).toEqual([
      { kind: "emu", args: ["geo", "fix", "13.405", "52.52"] },
    ]);
    expect(plan({ type: "orientation", value: "landscape-right" })).toEqual([
      { kind: "shell", args: ["settings", "put", "system", "accelerometer_rotation", "0"] },
      { kind: "shell", args: ["settings", "put", "system", "user_rotation", "3"] },
    ]);
    expect(plan({ type: "network", value: "off" })).toEqual([
      { kind: "shell", args: ["svc", "wifi", "disable"] },
      { kind: "shell", args: ["svc", "data", "disable"] },
    ]);
    expect(plan({ type: "preset", value: "standard" })).toEqual([
      { kind: "shell", args: ["cmd", "uimode", "night", "no"] },
      { kind: "shell", args: ["settings", "put", "system", "font_scale", "1.0"] },
    ]);
  });

  it("maps permission services per API level and refuses what Android lacks", () => {
    expect(androidPermissions("photos", 34)).toEqual([
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
    ]);
    expect(androidPermissions("photos", 30)).toEqual(["android.permission.READ_EXTERNAL_STORAGE"]);
    expect(androidPermissions("location-always", 34)).toContain(
      "android.permission.ACCESS_BACKGROUND_LOCATION",
    );
    expect(() => androidPermissions("siri", 34)).toThrow("no siri permission");
    expect(permissionCommand("com.example.app", "reset", "android.permission.CAMERA")).toEqual([
      ["pm", "revoke", "com.example.app", "android.permission.CAMERA"],
      [
        "pm",
        "clear-permission-flags",
        "com.example.app",
        "android.permission.CAMERA",
        "user-set",
        "user-fixed",
      ],
    ]);
    expect(() => plan({ type: "push", bundleId: "com.example.app", payload: "{}" })).toThrow(
      "Firebase",
    );
    expect(() => plan({ type: "clear-location" })).toThrow("keeps its last location");
  });
});
