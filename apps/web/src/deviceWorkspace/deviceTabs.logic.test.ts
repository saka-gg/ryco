import { describe, expect, it } from "vite-plus/test";

import {
  activeDeviceTab,
  chooseTabDevice,
  closeDeviceTab,
  EMPTY_THREAD_DEVICE_TABS,
  openDeviceTab,
  openPickerTab,
  renameDeviceTab,
  type ThreadDeviceTabs,
} from "./deviceTabs.logic";

const two: ThreadDeviceTabs = {
  tabs: [
    { id: "a", udid: "A", title: null },
    { id: "b", udid: "B", title: null },
  ],
  activeId: "a",
};

describe("device tabs", () => {
  it("opens a device in a new tab and brings it forward", () => {
    const next = openDeviceTab(EMPTY_THREAD_DEVICE_TABS, "A", { id: "a" });
    expect(next).toEqual({ tabs: [{ id: "a", udid: "A", title: null }], activeId: "a" });
  });

  it("reuses the tab already showing a device", () => {
    const next = openDeviceTab(two, "B");
    expect(next.tabs).toHaveLength(2);
    expect(next.activeId).toBe("b");
    expect(openDeviceTab(two, "A")).toBe(two);
  });

  it("adds a tab in the background when asked not to activate it", () => {
    const next = openDeviceTab(two, "C", { activate: false, id: "c" });
    expect(next.tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
    expect(next.activeId).toBe("a");
  });

  it("keeps a single picker tab", () => {
    const withPicker = openPickerTab(two, "p");
    expect(withPicker.activeId).toBe("p");
    const again = openPickerTab({ ...withPicker, activeId: "a" }, "q");
    expect(again.tabs.map((tab) => tab.id)).toEqual(["a", "b", "p"]);
    expect(again.activeId).toBe("p");
  });

  it("turns the picker into the chosen device's tab", () => {
    const withPicker = openPickerTab(two, "p");
    const next = chooseTabDevice(withPicker, "p", "C");
    expect(next.tabs.at(-1)).toEqual({ id: "p", udid: "C", title: null });
    expect(next.activeId).toBe("p");
  });

  it("closes the picker when its device already has a tab", () => {
    const withPicker = openPickerTab(two, "p");
    const next = chooseTabDevice(withPicker, "p", "B");
    expect(next.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(next.activeId).toBe("b");
  });

  it("renames a tab, and an empty name restores the device's own", () => {
    const renamed = renameDeviceTab(two, "a", "  Checkout flow  ");
    expect(renamed.tabs[0]?.title).toBe("Checkout flow");
    expect(renameDeviceTab(renamed, "a", " ").tabs[0]?.title).toBeNull();
    expect(renameDeviceTab(renamed, "a", "x".repeat(100)).tabs[0]?.title).toHaveLength(64);
    expect(renameDeviceTab(two, "missing", "x")).toBe(two);
  });

  it("brings forward the next tab, else the previous, when the active one closes", () => {
    const three = openDeviceTab(two, "C", { activate: false, id: "c" });
    expect(closeDeviceTab({ ...three, activeId: "b" }, "b").activeId).toBe("c");
    expect(closeDeviceTab({ ...three, activeId: "c" }, "c").activeId).toBe("b");
    expect(closeDeviceTab(three, "b").activeId).toBe("a");
    expect(closeDeviceTab({ tabs: [two.tabs[0]!], activeId: "a" }, "a")).toEqual({
      tabs: [],
      activeId: null,
    });
  });

  it("falls back to the first tab when the active id is stale", () => {
    expect(activeDeviceTab({ ...two, activeId: "gone" })?.id).toBe("a");
    expect(activeDeviceTab(EMPTY_THREAD_DEVICE_TABS)).toBeNull();
  });
});
