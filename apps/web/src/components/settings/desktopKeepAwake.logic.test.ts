import { describe, expect, it } from "vitest";
import type { DesktopKeepAwakeState } from "@ryco/contracts";

import { describeDesktopKeepAwake, desktopDeviceNoun } from "./desktopKeepAwake.logic";

const state = (overrides: Partial<DesktopKeepAwakeState> = {}): DesktopKeepAwakeState => ({
  enabled: true,
  reachable: true,
  onBattery: false,
  active: true,
  ...overrides,
});

describe("desktopDeviceNoun", () => {
  it("names the machine without assuming a Mac", () => {
    expect(desktopDeviceNoun("MacIntel")).toBe("this Mac");
    expect(desktopDeviceNoun("Linux x86_64")).toBe("this computer");
    expect(desktopDeviceNoun("Win32")).toBe("this computer");
  });
});

describe("describeDesktopKeepAwake", () => {
  it("explains each state of the hold", () => {
    expect(describeDesktopKeepAwake(null, "this Mac")).toBe("Loading…");
    expect(describeDesktopKeepAwake(state(), "this Mac")).toMatch(/keeps this Mac awake/);
    expect(describeDesktopKeepAwake(state({ onBattery: true, active: false }), "this Mac")).toMatch(
      /^Paused on battery power/,
    );
    expect(
      describeDesktopKeepAwake(state({ reachable: false, active: false }), "this computer"),
    ).toMatch(/^Turns on once other devices can reach this computer/);
    expect(describeDesktopKeepAwake(state({ enabled: false, active: false }), "this Mac")).toMatch(
      /^This Mac may sleep when idle/,
    );
  });
});
