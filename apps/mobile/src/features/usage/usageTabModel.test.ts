import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { InboxEnvironment } from "../inbox/inboxModel";
import {
  ALL_DEVICES,
  LIMITS_AUTO_REFRESH_INTERVAL_MS,
  limitsFocusRefresh,
  scopeUsageEnvironments,
  usageContentState,
  usageDeviceMenu,
  usageViewHasRange,
  linkedUsageViewToOpen,
} from "./usageTabModel";

function device(
  id: string,
  connectionState: InboxEnvironment["connectionState"] = "connected",
): InboxEnvironment {
  return { environmentId: EnvironmentId.make(id), label: id.toUpperCase(), connectionState };
}

const mac = device("mac");
const mini = device("mini");
const offline = device("old", "offline");
const readOnly = device("ro", "read-only");

describe("scopeUsageEnvironments", () => {
  it("asks every readable device when no device is picked", () => {
    const scope = scopeUsageEnvironments([mac, offline, readOnly], ALL_DEVICES, "limits");
    expect(scope.scoped.map((environment) => environment.environmentId)).toEqual(["mac", "ro"]);
    expect(scope.device).toBe(ALL_DEVICES);
  });

  it("reads Activity from one device, the first connected one", () => {
    const scope = scopeUsageEnvironments([readOnly, mini, mac], ALL_DEVICES, "activity");
    expect(scope.scoped).toEqual([mini]);
    expect(scope.activityDevice).toBe(mini);
  });

  it("falls back to a read-only device for Activity when none is connected", () => {
    const scope = scopeUsageEnvironments([offline, readOnly], ALL_DEVICES, "activity");
    expect(scope.scoped).toEqual([readOnly]);
  });

  it("asks a picked device even while it is offline, so its error shows", () => {
    const scope = scopeUsageEnvironments([mac, offline], "old", "usage");
    expect(scope.scoped).toEqual([offline]);
    expect(scope.device).toBe("old");
  });

  it("falls back to every device when the picked one went away", () => {
    const scope = scopeUsageEnvironments([mac, mini], "gone", "usage");
    expect(scope.device).toBe(ALL_DEVICES);
    expect(scope.scoped).toEqual([mac, mini]);
  });
});

describe("usageDeviceMenu", () => {
  it("names all devices, then each device, and marks a narrowed filter", () => {
    const all = usageDeviceMenu(
      [mac, mini],
      scopeUsageEnvironments([mac, mini], "all", "usage"),
      "usage",
    );
    expect(all.options.map((option) => option.label)).toEqual([
      "All connected devices",
      "MAC",
      "MINI",
    ]);
    expect(all).toMatchObject({
      value: ALL_DEVICES,
      label: "All connected devices",
      filtered: false,
    });

    const picked = usageDeviceMenu(
      [mac, mini],
      scopeUsageEnvironments([mac, mini], "mini", "limits"),
      "limits",
    );
    expect(picked).toMatchObject({ value: "mini", label: "MINI", filtered: true });
  });

  it("names Activity's device for the unfiltered choice", () => {
    const menu = usageDeviceMenu(
      [mini, mac],
      scopeUsageEnvironments([mini, mac], ALL_DEVICES, "activity"),
      "activity",
    );
    expect(menu.label).toBe("MINI");
  });
});

describe("limitsFocusRefresh", () => {
  it("lets the first visit load on its own", () => {
    expect(limitsFocusRefresh(null, 1_000)).toBe("first");
  });

  it("keeps recent limits and asks again once the interval passed", () => {
    const askedAt = 10_000;
    expect(limitsFocusRefresh(askedAt, askedAt + LIMITS_AUTO_REFRESH_INTERVAL_MS - 1)).toBe("skip");
    expect(limitsFocusRefresh(askedAt, askedAt + LIMITS_AUTO_REFRESH_INTERVAL_MS)).toBe("reload");
  });
});

describe("usageViewHasRange", () => {
  it("gives Usage and Activity a date window, not Limits", () => {
    expect(usageViewHasRange("usage")).toBe(true);
    expect(usageViewHasRange("activity")).toBe(true);
    expect(usageViewHasRange("limits")).toBe(false);
  });
});

describe("usageContentState", () => {
  const base = {
    view: "limits" as const,
    environmentCount: 2,
    scopedCount: 2,
    loading: false,
    hasContent: false,
    nodes: [],
  };

  it("shows an empty state without devices to ask", () => {
    expect(usageContentState({ ...base, environmentCount: 0, scopedCount: 0 })).toMatchObject({
      kind: "no-devices",
      title: "No devices yet",
    });
    expect(usageContentState({ ...base, scopedCount: 0 })).toMatchObject({
      kind: "no-devices",
      title: "No device connected",
    });
  });

  it("shows a loading line until the first answer", () => {
    expect(usageContentState({ ...base, view: "usage", loading: true })).toEqual({
      kind: "loading",
      label: "Scanning provider transcripts…",
    });
  });

  it("keeps the content on screen while it reloads, with a notice per failed device", () => {
    const state = usageContentState({
      ...base,
      loading: true,
      hasContent: true,
      nodes: [
        { environmentId: "mac", label: "Mac" },
        { environmentId: "mini", label: "Mini", error: "Connect this device." },
      ],
    });
    expect(state).toEqual({
      kind: "ready",
      notices: [{ key: "mini", label: "Mini", message: "Connect this device." }],
    });
  });

  it("reports every device's error when none could answer", () => {
    const state = usageContentState({
      ...base,
      nodes: [{ environmentId: "mac", label: "Mac", error: "Owner access needed." }],
    });
    expect(state).toEqual({
      kind: "failed",
      notices: [{ key: "mac", label: "Mac", message: "Owner access needed." }],
    });
  });

  it("says so when the devices answered with nothing", () => {
    expect(
      usageContentState({ ...base, nodes: [{ environmentId: "mac", label: "Mac" }] }),
    ).toMatchObject({ kind: "empty", title: "No limits yet" });
  });
});

describe("linkedUsageViewToOpen", () => {
  it("follows each link navigation once, also when it names the same view again", () => {
    const first = { tab: "limits" };
    expect(linkedUsageViewToOpen(undefined, first)).toBe("limits");
    // A re-render keeps the params object: the person's own switch stays.
    expect(linkedUsageViewToOpen(first, first)).toBeNull();
    // The same link tapped again is a new navigation with a new params object.
    expect(linkedUsageViewToOpen(first, { tab: "limits" })).toBe("limits");
  });

  it("ignores a navigation that names no known view", () => {
    expect(linkedUsageViewToOpen(undefined, { tab: "billing" })).toBeNull();
    expect(linkedUsageViewToOpen({ tab: "limits" }, undefined)).toBeNull();
  });
});
