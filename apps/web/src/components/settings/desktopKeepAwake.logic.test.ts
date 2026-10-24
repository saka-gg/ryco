import { describe, expect, it } from "vitest";
import type { DesktopKeepAwakeState } from "@ryco/contracts";

import {
  DESKTOP_KEEP_AWAKE_MODE_OPTIONS,
  describeDesktopKeepAwake,
  desktopDeviceNoun,
} from "./desktopKeepAwake.logic";

const state = (overrides: Partial<DesktopKeepAwakeState> = {}): DesktopKeepAwakeState => ({
  mode: "reachable-or-working",
  reachable: true,
  agentWorking: false,
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

describe("DESKTOP_KEEP_AWAKE_MODE_OPTIONS", () => {
  it("offers every mode once", () => {
    expect(DESKTOP_KEEP_AWAKE_MODE_OPTIONS.map((option) => option.value)).toEqual([
      "off",
      "reachable",
      "reachable-or-working",
    ]);
  });
});

describe("describeDesktopKeepAwake", () => {
  it("explains each state of the hold", () => {
    expect(describeDesktopKeepAwake(null, "this Mac")).toBe("Loading…");
    expect(describeDesktopKeepAwake(state({ mode: "off", active: false }), "this Mac")).toBe(
      "This Mac may sleep when idle. Running chats pause and devices that reach it lose access until it wakes.",
    );
    expect(
      describeDesktopKeepAwake(
        state({ mode: "reachable", reachable: false, agentWorking: true, active: false }),
        "this computer",
      ),
    ).toBe(
      "Turns on once other devices can reach this computer through the Hub, the network, or Tailscale.",
    );
    expect(
      describeDesktopKeepAwake(state({ reachable: false, active: false }), "this computer"),
    ).toBe(
      "Turns on while agents work, or once other devices can reach this computer through the Hub, the network, or Tailscale.",
    );
    expect(describeDesktopKeepAwake(state({ onBattery: true, active: false }), "this Mac")).toMatch(
      /^Paused on battery power/,
    );
    expect(
      describeDesktopKeepAwake(
        state({ reachable: false, agentWorking: true, onBattery: true, active: false }),
        "this Mac",
      ),
    ).toMatch(/^Paused on battery power/);
    expect(describeDesktopKeepAwake(state(), "this Mac")).toBe(
      "Ryco keeps this Mac awake so other devices can reach it. The display can still sleep.",
    );
    expect(
      describeDesktopKeepAwake(state({ reachable: false, agentWorking: true }), "this Mac"),
    ).toBe("Ryco keeps this Mac awake while agents work. The display can still sleep.");
    expect(describeDesktopKeepAwake(state({ active: false }), "this Mac")).toBe(
      "Ryco keeps this Mac awake while it is plugged in.",
    );
  });
});
