import { describe, expect, it } from "vitest";

import { DeviceManager } from "./DeviceManager.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";

const STABLE_DIR = "/Applications/Xcode.app/Contents/Developer";
const DEVICE_LIST_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: "AAAA-1111", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true },
    ],
  },
});

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, signal: null, timedOut: false });

function makeBackend(
  options: {
    readonly licenseAccepted?: () => boolean;
    readonly developerDir?: () => string;
  } = {},
) {
  const calls: string[] = [];
  const run = (async (command: string, args: readonly string[]) => {
    calls.push(command === "xcrun" ? `xcrun ${args.slice(1, 3).join(" ")}` : command);
    if (command === "xcode-select") return ok(`${options.developerDir?.() ?? STABLE_DIR}\n`);
    if (command === "xcodebuild") {
      return options.licenseAccepted?.() === false
        ? { ...ok(""), code: 69 }
        : ok("Xcode 26.3\nBuild version 17D1\n");
    }
    if (command === "xcrun" && args[1] === "list" && args[2] === "devices") {
      return ok(DEVICE_LIST_JSON);
    }
    return ok("");
  }) as never;
  const backend = new IosSimulatorBackend({ platform: "darwin", processEnv: {}, run });
  const count = (command: string) => calls.filter((call) => call === command).length;
  return { backend, calls, count };
}

describe("iOS simulator probe caching", () => {
  it("lists devices with one simctl run and one toolchain probe", async () => {
    const { backend, count } = makeBackend();
    const manager = new DeviceManager({ backend });

    const listed = await manager.list({ includeShutdown: true });

    expect(listed.devices.map((device) => device.udid)).toEqual(["AAAA-1111"]);
    // availability() and discovery used to run simctl twice and xcode-select
    // once per toolchain lookup.
    expect(count("xcrun list devices")).toBe(1);
    expect(count("xcode-select")).toBe(1);
    expect(count("xcodebuild")).toBe(1);
  });

  it("reuses the toolchain answers across inventory reads", async () => {
    const { backend, count } = makeBackend();
    const manager = new DeviceManager({ backend });

    await manager.list({ includeShutdown: true });
    await manager.list({ includeShutdown: true });

    expect(count("xcode-select")).toBe(1);
    expect(count("xcodebuild")).toBe(1);
  });

  it("re-reads an unaccepted license so the setup checklist sees it change", async () => {
    let accepted = false;
    const { backend, count } = makeBackend({ licenseAccepted: () => accepted });

    expect((await backend.availability()).kind).toBe("setup-required");
    accepted = true;
    await backend.availability();

    expect(count("xcodebuild")).toBe(2);
  });

  it("re-reads tools not yet pointed at Xcode so the setup checklist sees the fix", async () => {
    let developerDir = "/Library/Developer/CommandLineTools";
    const { backend, count } = makeBackend({ developerDir: () => developerDir });

    expect((await backend.availability()).kind).toBe("setup-required");
    developerDir = STABLE_DIR;
    const fixed = await backend.availability();

    expect(count("xcode-select")).toBe(2);
    expect(fixed.kind === "setup-required" ? fixed.steps[0]?.done : true).toBe(true);
  });

  it("reads a fresh listing after booting a device", async () => {
    const { backend, count } = makeBackend();

    await backend.listDevices({ includeShutdown: true });
    await backend.boot("AAAA-1111").catch(() => undefined);

    expect(count("xcrun list devices")).toBe(2);
  });
});
