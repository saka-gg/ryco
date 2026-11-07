import { describe, expect, it } from "vite-plus/test";

import {
  parseSettingsLocationSearch,
  resolveSettingsDeviceTab,
  SETTINGS_DEVICE_PARTS,
  settingsLocationKey,
} from "./settingsRegistry";

describe("a device page's tabs", () => {
  it("are Overview, Access, Security, Computer use, Simulators and Power, in that order", () => {
    expect(SETTINGS_DEVICE_PARTS.map((part) => part.title)).toEqual([
      "Overview",
      "Access",
      "Security",
      "Computer use",
      "Simulators",
      "Power",
    ]);
  });

  it("opens the tab asked for, the one an old id names, else Overview", () => {
    expect(resolveSettingsDeviceTab("device", "power")).toBe("power");
    expect(resolveSettingsDeviceTab("security", null)).toBe("security");
    expect(resolveSettingsDeviceTab("computer-use", null)).toBe("computer-use");
    expect(resolveSettingsDeviceTab("device", null)).toBe("overview");
    expect(resolveSettingsDeviceTab("security", "access")).toBe("access");
  });
});

describe("the settings address", () => {
  it("keeps a known section, tab and device", () => {
    expect(
      parseSettingsLocationSearch({ section: "device", tab: "security", device: "env-1" }),
    ).toEqual({ section: "device", tab: "security", device: "env-1" });
    expect(parseSettingsLocationSearch({ section: "connections" })).toEqual({
      section: "connections",
    });
  });

  it("keeps the All devices view only with a device", () => {
    expect(parseSettingsLocationSearch({ section: "usage", device: "env-1", view: "all" })).toEqual(
      { section: "usage", device: "env-1", view: "all" },
    );
    // A named device opens on its own values; no other view is spelled out.
    expect(
      parseSettingsLocationSearch({ section: "usage", device: "env-1", view: "device" }),
    ).toEqual({ section: "usage", device: "env-1" });
    expect(parseSettingsLocationSearch({ section: "usage", view: "all" })).toEqual({
      section: "usage",
    });
    expect(settingsLocationKey({ section: "usage", device: "env-1", view: "all" })).not.toBe(
      settingsLocationKey({ section: "usage", device: "env-1" }),
    );
  });

  it("drops what it does not know", () => {
    expect(
      parseSettingsLocationSearch({ section: "nope", tab: "identity", device: 3, extra: "x" }),
    ).toEqual({});
    expect(parseSettingsLocationSearch({ device: "x".repeat(300) })).toEqual({});
  });

  it("keys a place by its content", () => {
    expect(settingsLocationKey({ section: "device", tab: "power" })).toBe(
      settingsLocationKey({ tab: "power", section: "device" }),
    );
    expect(settingsLocationKey({ section: "device" })).not.toBe(
      settingsLocationKey({ section: "device", tab: "power" }),
    );
  });
});
