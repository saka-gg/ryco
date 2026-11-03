import { describe, expect, it } from "vite-plus/test";

import {
  readSettingsDeviceVersion,
  settingsDeviceStatusLine,
  settingsNodeStatus,
  splitDeviceBarChoices,
} from "./settingsDevices.logic";

describe("a device's version on its card", () => {
  it("reads the version and a ready update from the Updates plan", () => {
    expect(
      readSettingsDeviceVersion({
        kind: "one-click",
        fromVersion: "0.1.36",
        toVersion: "0.1.37",
      }),
    ).toEqual({ version: "0.1.36", updateTo: "0.1.37" });
    expect(
      readSettingsDeviceVersion({ kind: "this-app", fromVersion: "0.1.36", toVersion: "0.1.37" }),
    ).toEqual({ version: "0.1.36", updateTo: "0.1.37" });
    expect(
      readSettingsDeviceVersion({ kind: "manual", fromVersion: "0.1.30", toVersion: "0.1.37" }),
    ).toEqual({ version: "0.1.30", updateTo: "0.1.37" });
    expect(readSettingsDeviceVersion({ kind: "current", version: "0.1.37" })).toEqual({
      version: "0.1.37",
      updateTo: null,
    });
  });

  it("says nothing when the plan knows nothing", () => {
    expect(readSettingsDeviceVersion(undefined)).toBeNull();
    expect(readSettingsDeviceVersion({ kind: "unknown", version: null })).toBeNull();
    expect(
      readSettingsDeviceVersion({ kind: "manual", fromVersion: null, toVersion: null }),
    ).toBeNull();
  });
});

describe("a device's status line", () => {
  it("names offline devices with their last sighting when known", () => {
    expect(settingsDeviceStatusLine(null, null)).toBe("Online");
    expect(settingsDeviceStatusLine("connecting", "Last seen 2 h ago")).toBe("Connecting");
    expect(settingsDeviceStatusLine("offline", "Last seen 2 h ago")).toBe(
      "Offline · Last seen 2 h ago",
    );
    expect(settingsDeviceStatusLine("offline", null)).toBe("Offline");
  });

  it("keeps a connected device online", () => {
    expect(settingsNodeStatus({ connection: "connected" })).toBeNull();
    expect(settingsNodeStatus({ connection: "connected", online: false })).toBe("offline");
  });
});

describe("the device bar's pills and More", () => {
  const devices = Array.from({ length: 8 }, (_, index) => ({ environmentId: `d${index}` }));
  const ids = (list: ReadonlyArray<{ environmentId: string }>) =>
    list.map((device) => device.environmentId);

  it("shows every device as a pill up to five", () => {
    const { pills, more } = splitDeviceBarChoices(devices.slice(0, 5), "d0");
    expect(ids(pills)).toEqual(["d0", "d1", "d2", "d3", "d4"]);
    expect(more).toEqual([]);
  });

  it("lists the rest under More, in order", () => {
    const { pills, more } = splitDeviceBarChoices(devices, "d2");
    expect(ids(pills)).toEqual(["d0", "d1", "d2", "d3", "d4"]);
    expect(ids(more)).toEqual(["d5", "d6", "d7"]);
  });

  it("keeps the shown device among the pills", () => {
    const { pills, more } = splitDeviceBarChoices(devices, "d6");
    expect(ids(pills)).toEqual(["d0", "d1", "d2", "d3", "d6"]);
    expect(ids(more)).toEqual(["d4", "d5", "d7"]);
  });
});
