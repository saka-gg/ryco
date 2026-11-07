import { describe, expect, it } from "vite-plus/test";

import { openDeviceTab, EMPTY_THREAD_DEVICE_TABS } from "./deviceTabs.logic";
import { setDeviceTabView3d } from "./deviceTabView3d.logic";

describe("setDeviceTabView3d", () => {
  const state = openDeviceTab(EMPTY_THREAD_DEVICE_TABS, "phone", { id: "a" });

  it("remembers 3D per tab and forgets it when turned off", () => {
    const on = setDeviceTabView3d(state, "a", true);
    expect(on.tabs[0]).toEqual({ id: "a", udid: "phone", title: null, view3d: true });
    const off = setDeviceTabView3d(on, "a", false);
    expect(off.tabs[0]).toEqual({ id: "a", udid: "phone", title: null });
    expect("view3d" in off.tabs[0]!).toBe(false);
  });

  it("returns the same state when nothing changes", () => {
    expect(setDeviceTabView3d(state, "a", false)).toBe(state);
    expect(setDeviceTabView3d(state, "missing", true)).toBe(state);
    const on = setDeviceTabView3d(state, "a", true);
    expect(setDeviceTabView3d(on, "a", true)).toBe(on);
  });
});
