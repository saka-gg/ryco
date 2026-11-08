import type {
  DeviceAvailability,
  DeviceDescriptor,
  ServerConfig,
  ThreadDeviceState,
} from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  devicePickerStatus,
  devicePlatformSummary,
  deviceSetupBlocked,
  devicesNeedSetupPoll,
  groupPickerDevices,
  nodeDeviceSettingsGate,
  startingBannerText,
  threadAttachments,
} from "./picker.ts";

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

  it("reads one attachment from a server that reports only the latest", () => {
    const state = {
      attachedDeviceUdid: "a",
      attachPhase: "booting",
      lastError: null,
    } as unknown as ThreadDeviceState;
    expect(threadAttachments(state)).toEqual([
      { udid: "a", source: "user", attachPhase: "booting", lastError: null },
    ]);
    expect(threadAttachments({ ...state, attachedDeviceUdid: null })).toEqual([]);
    expect(threadAttachments(null)).toEqual([]);
  });
});

describe("device setup", () => {
  const steps = (entries: ReadonlyArray<{ id: string; done: boolean }>): DeviceAvailability =>
    ({
      kind: "setup-required",
      steps: entries.map((entry) => ({ ...entry, label: entry.id })),
    }) as DeviceAvailability;

  it("blocks the picker until only the helper build is left", () => {
    expect(deviceSetupBlocked(null)).toBe(true);
    expect(deviceSetupBlocked({ kind: "unsupported-platform", platform: "linux" })).toBe(true);
    expect(deviceSetupBlocked({ kind: "helper-unavailable", message: "No Xcode" })).toBe(true);
    expect(deviceSetupBlocked(steps([{ id: "install-xcode", done: false }]))).toBe(true);
    expect(deviceSetupBlocked(steps([{ id: "build-device-helper", done: false }]))).toBe(false);
    expect(deviceSetupBlocked({ kind: "available" })).toBe(false);
  });

  it("polls only while setup is underway", () => {
    expect(devicesNeedSetupPoll(steps([]))).toBe(true);
    expect(devicesNeedSetupPoll({ kind: "helper-unavailable", message: "x" })).toBe(true);
    expect(devicesNeedSetupPoll({ kind: "available" })).toBe(false);
    expect(devicesNeedSetupPoll(null)).toBe(false);
  });

  it("summarises one platform", () => {
    expect(devicePlatformSummary({ kind: "available" })).toEqual({
      tone: "ready",
      summary: "Ready",
    });
    expect(devicePlatformSummary(steps([{ id: "install-xcode", done: false }]))).toEqual({
      tone: "warn",
      summary: "1 step left",
    });
    expect(devicePlatformSummary(steps([{ id: "build-device-helper", done: false }])).tone).toBe(
      "ready",
    );
    expect(devicePlatformSummary({ kind: "unsupported-platform", platform: "linux" })).toEqual({
      tone: "off",
      summary: "Not available on linux",
    });
  });

  it("gates on the node's onboarding and Use simulators", () => {
    const config = (settings: Record<string, boolean> | undefined, deviceSetup = true) =>
      ({
        environment: { capabilities: { deviceSetup } },
        settings,
      }) as unknown as ServerConfig;
    expect(nodeDeviceSettingsGate(config({ deviceOnboardingCompleted: false }))).toEqual({
      showSetup: true,
      devicesOff: false,
    });
    expect(nodeDeviceSettingsGate(config({ deviceOnboardingCompleted: false }), true)).toEqual({
      showSetup: false,
      devicesOff: false,
    });
    expect(
      nodeDeviceSettingsGate(config({ deviceOnboardingCompleted: true, devicesEnabled: false })),
    ).toEqual({ showSetup: false, devicesOff: true });
    expect(nodeDeviceSettingsGate(config({ deviceOnboardingCompleted: false }, false))).toEqual({
      showSetup: false,
      devicesOff: false,
    });
    expect(nodeDeviceSettingsGate(null)).toEqual({ showSetup: false, devicesOff: false });
  });
});
