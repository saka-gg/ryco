import { describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import {
  bundleForPid,
  isSpringBoard,
  parseSimSettingsStatus,
  permissionStates,
  readIosDeviceDetail,
  type IosDetailIo,
} from "./iosDeviceDetail.ts";
import { planIosTestingAction } from "./iosTestingActions.ts";

const UDID = "2844B282-5F03-44D4-AFEC-134C52A0A11F";
const ok = (stdout: string): ProcessRunResult =>
  ({ code: 0, stdout, stderr: "", timedOut: false }) as ProcessRunResult;

describe("ryco-sim-settings status", () => {
  it("reads every switch, the color filter and Liquid Glass", () => {
    expect(
      parseSimSettingsStatus(
        '{"reduce-motion":"on","reduce-transparency":"off","show-borders":"on","voiceover":"off","color-filter":"grayscale","liquid-glass":"tinted"}\n',
      ),
    ).toEqual({
      reduceMotion: true,
      reduceTransparency: false,
      showBorders: true,
      voiceOver: false,
      colorFilter: "grayscale",
      liquidGlass: "tinted",
    });
  });

  it("drops what a runtime does not support and survives garbage", () => {
    expect(
      parseSimSettingsStatus('{"reduce-motion":null,"color-filter":null,"liquid-glass":"clear"}'),
    ).toEqual({
      liquidGlass: "clear",
    });
    expect(parseSimSettingsStatus("not json")).toEqual({});
  });
});

describe("foreground app", () => {
  const list = [
    "PID\tStatus\tLabel",
    "83806\t0\tUIKitApplication:com.apple.Preferences[3a6d][rb-legacy]",
    "56505\t0\tUIKitApplication:com.apple.Spotlight[05a6][rb-legacy]",
    "123\t0\tcom.apple.SpringBoard",
  ].join("\n");

  it("names the app whose process is in front", () => {
    expect(bundleForPid(list, 83806)).toBe("com.apple.Preferences");
    expect(bundleForPid(list, 123)).toBeNull();
    expect(bundleForPid(list, 999)).toBeNull();
    expect(isSpringBoard(list, 123)).toBe(true);
    expect(isSpringBoard(list, 83806)).toBe(false);
  });
});

describe("permission states from TCC", () => {
  it("maps auth values and reports services with no row as not determined", () => {
    const states = permissionStates([
      { service: "kTCCServicePhotos", auth_value: 2 },
      { service: "kTCCServiceMicrophone", auth_value: 0 },
      { service: "kTCCServiceAddressBook", auth_value: 3 },
    ]);
    expect(states).toContainEqual({ service: "photos", state: "granted" });
    expect(states).toContainEqual({ service: "microphone", state: "denied" });
    expect(states).toContainEqual({ service: "contacts", state: "limited" });
    expect(states).toContainEqual({ service: "calendar", state: "not-determined" });
    // Location is not in TCC, and contacts is reported once.
    expect(states.map((entry) => entry.service)).not.toContain("location");
    expect(states.map((entry) => entry.service)).not.toContain("contacts-limited");
  });
});

describe("readIosDeviceDetail", () => {
  const io = (overrides: Partial<IosDetailIo> = {}): IosDetailIo => ({
    simctl: async (args) => {
      if (args[0] === "ui") {
        return ok(
          {
            appearance: "dark\n",
            content_size: "accessibility-large\n",
            increase_contrast: "enabled\n",
          }[args[2]!] ?? "",
        );
      }
      if (args.includes("launchctl")) return ok("1\t0\tUIKitApplication:com.example.app[1][rb]\n");
      if (args.includes("status")) return ok('{"reduce-motion":"on","liquid-glass":"clear"}');
      return ok("");
    },
    simSettingsTool: async () => "/cache/ryco-sim-settings",
    foregroundPid: async () => ({ pid: 1, label: "Example" }),
    appliedLocation: { latitude: 1.5, longitude: 2.5 },
    dataDirectory: "/sims/data",
    run: (async () =>
      ok('[{"service":"kTCCServicePhotos","auth_value":2}]')) as unknown as IosDetailIo["run"],
    ...overrides,
  });

  it("reads settings, the app in front and its permissions from the device", async () => {
    const detail = await readIosDeviceDetail(io(), UDID, undefined);
    expect(detail.foregroundApp).toEqual({ bundleId: "com.example.app", name: "Example" });
    expect(detail.settings).toMatchObject({
      appearance: "dark",
      textSize: "accessibility-large",
      increaseContrast: true,
      reduceMotion: true,
      liquidGlass: "clear",
      location: { latitude: 1.5, longitude: 2.5, source: "applied" },
    });
    expect(detail.permissions?.bundleId).toBe("com.example.app");
    expect(detail.permissions?.states).toContainEqual({ service: "photos", state: "granted" });
    expect(detail.controls).toContain("liquid-glass");
  });

  it("leaves the app in front unknown without a helper, and fills nothing in", async () => {
    const detail = await readIosDeviceDetail(
      io({
        foregroundPid: async () => null,
        simSettingsTool: async () => {
          throw new Error("not built");
        },
        appliedLocation: undefined,
      }),
      UDID,
      undefined,
    );
    expect("foregroundApp" in detail).toBe(false);
    expect(detail.settings.reduceMotion).toBeUndefined();
    expect(detail.settings.location).toBeUndefined();
    expect(detail.permissions).toBeUndefined();
  });

  it("reads a named app's permissions and refuses an id that is not a bundle id", async () => {
    const detail = await readIosDeviceDetail(io(), UDID, "com.other.app");
    expect(detail.permissions?.bundleId).toBe("com.other.app");
    const injected = await readIosDeviceDetail(io(), UDID, "x' or 1=1 --");
    expect(injected.permissions).toBeUndefined();
  });
});

describe("iOS testing plans for the Tools drawer", () => {
  const plan = (action: Parameters<typeof planIosTestingAction>[0]["action"]) =>
    planIosTestingAction({ udid: UDID, action });

  it("uses simctl for Increase Contrast and Ryco's tool for the other switches", () => {
    expect(plan({ type: "accessibility", setting: "increase-contrast", value: true })).toEqual([
      { label: "increase_contrast", args: ["ui", UDID, "increase_contrast", "enabled"] },
    ]);
    expect(plan({ type: "accessibility", setting: "voiceover", value: false })).toEqual([
      { label: "voiceover", args: ["set", "voiceover", "off"], simSettings: true },
    ]);
    expect(plan({ type: "liquid-glass", value: "tinted" })[0]).toMatchObject({
      args: ["set", "liquid-glass", "tinted"],
      simSettings: true,
    });
    expect(plan({ type: "color-filter", value: "blue-yellow" })[0]?.args).toEqual([
      "set",
      "color-filter",
      "blue-yellow",
    ]);
  });

  it("terminates an app by bundle id", () => {
    expect(plan({ type: "terminate-app", bundleId: "com.example.app" })).toEqual([
      { label: "terminate", args: ["terminate", UDID, "com.example.app"] },
    ]);
  });
});
