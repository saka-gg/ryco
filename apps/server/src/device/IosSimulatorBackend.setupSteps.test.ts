import { describe, expect, it } from "vitest";

import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { DeviceManager } from "./DeviceManager.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";
import { PlatformDeviceBackend } from "./PlatformDeviceBackend.ts";

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, signal: null, timedOut: false });

function backend(listing: { devices: object; runtimes: object }) {
  const run = (async (command: string, args: readonly string[]) => {
    if (command === "xcode-select") return ok("/Applications/Xcode.app/Contents/Developer\n");
    if (command === "xcodebuild") return ok("Xcode 27.1\nBuild version 27A9275\n");
    if (command === "xcrun" && args[1] === "list" && args[2] === "devices")
      return ok(JSON.stringify(listing.devices));
    if (command === "xcrun" && args[1] === "list" && args[2] === "runtimes")
      return ok(JSON.stringify(listing.runtimes));
    return ok("");
  }) as never;
  return new IosSimulatorBackend({ platform: "darwin", processEnv: {}, run });
}

const steps = async (ios: IosSimulatorBackend) => {
  const availability = await ios.availability();
  return availability.kind === "setup-required"
    ? availability.steps.filter((step) => !step.done).map((step) => step.id)
    : [];
};

describe("iOS setup steps", () => {
  it("asks for a simulator, not a runtime, when a runtime has none", async () => {
    const ios = backend({
      devices: { devices: {} },
      runtimes: { runtimes: [{ platform: "iOS", name: "iOS 27.0", isAvailable: true }] },
    });
    expect(await steps(ios)).toEqual(["create-ios-simulator", "build-device-helper"]);
  });

  it("asks for a runtime when none is installed", async () => {
    const ios = backend({ devices: { devices: {} }, runtimes: { runtimes: [] } });
    expect(await steps(ios)).toEqual(["install-ios-runtime", "build-device-helper"]);
  });
});

describe("each platform on its own", () => {
  it("reports iOS and Android separately, so a working one hides nothing of the other", async () => {
    const ios = new FakeDeviceBackend();
    const android = new FakeDeviceBackend({
      availability: {
        kind: "setup-required",
        steps: [
          { id: "create-android-avd", label: "Create an Android virtual device", done: false },
        ],
      },
    });
    const manager = new DeviceManager({ backend: new PlatformDeviceBackend(ios, android) });
    const listed = await manager.list({ includeShutdown: true });
    expect(listed.availability.kind).toBe("available");
    expect(listed.platforms).toEqual([
      { platform: "ios-simulator", availability: { kind: "available" } },
      {
        platform: "android-emulator",
        availability: expect.objectContaining({ kind: "setup-required" }),
      },
    ]);
  });
});

describe("device detail", () => {
  it("adds identity, time and an iOS simulator's orientation to the backend's read", async () => {
    const fake = new FakeDeviceBackend();
    const backend = Object.assign(fake, {
      detail: async () => ({
        foregroundApp: null,
        settings: { appearance: "dark" as const },
        controls: ["appearance" as const],
      }),
    });
    const manager = new DeviceManager({ backend, now: () => Date.UTC(2026, 10, 6) });
    const [device] = await fake.listDevices({ includeShutdown: true });
    const detail = await manager.detail(device!.udid);
    expect(detail).toMatchObject({
      udid: device!.udid,
      platform: "ios-simulator",
      capturedAt: "2026-11-06T00:00:00.000Z",
      settings: { appearance: "dark", orientation: "portrait" },
    });
  });

  it("refuses a backend that cannot read settings", async () => {
    const manager = new DeviceManager({ backend: new FakeDeviceBackend() });
    await expect(manager.detail("FAKE-0001")).rejects.toThrow(/cannot read device settings/);
  });
});
