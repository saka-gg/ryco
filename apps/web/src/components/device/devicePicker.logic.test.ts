import type { DeviceDescriptor } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { devicePickerStatus, groupPickerDevices, startingBannerText } from "./devicePicker.logic";

function device(overrides: Partial<DeviceDescriptor> & { udid: string }): DeviceDescriptor {
  return {
    platform: "ios-simulator",
    name: overrides.udid,
    runtime: "iOS 27.0",
    state: "shutdown",
    bootSource: "user",
    ...overrides,
  } as DeviceDescriptor;
}

describe("device picker", () => {
  it("groups by platform, iOS first, running devices first", () => {
    const groups = groupPickerDevices([
      device({ udid: "pixel", name: "Pixel", platform: "android-emulator" }),
      device({ udid: "b", name: "iPhone B" }),
      device({ udid: "a", name: "iPhone A", state: "booted" }),
      device({ udid: "c", name: "iPhone C", state: "booting" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["iOS Simulators", "Android Emulators"]);
    expect(groups[0]?.devices.map((entry) => entry.udid)).toEqual(["a", "c", "b"]);
  });

  it("splits groups per host once an SSH host is configured", () => {
    const local = { id: "local", name: "This Mac", transport: "local" as const };
    const remote = { id: "mini", name: "Mac mini", transport: "ssh" as const };
    const groups = groupPickerDevices(
      [device({ udid: "r", host: remote }), device({ udid: "l", host: local })],
      { hosts: [local, remote] },
    );
    expect(groups.map((group) => group.label)).toEqual([
      "iOS Simulators · This Mac",
      "iOS Simulators · Mac mini",
    ]);
  });

  it("treats a device booting for the thread as starting", () => {
    const stopped = device({ udid: "a" });
    expect(devicePickerStatus(stopped)).toBe("stopped");
    expect(devicePickerStatus(stopped, new Set(["a"]))).toBe("starting");
    expect(devicePickerStatus({ ...stopped, state: "booted" })).toBe("running");
  });

  it("names one starting device, and counts several", () => {
    expect(startingBannerText([])).toBeNull();
    expect(startingBannerText(["iPhone 17"])).toBe("Starting iPhone 17… this can take a minute.");
    expect(startingBannerText(["a", "b"])).toBe("Starting 2 devices… this can take a minute.");
  });
});
