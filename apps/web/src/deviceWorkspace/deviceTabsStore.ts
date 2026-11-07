import { create } from "zustand";

import { appLocalStorage } from "../hooks/useLocalStorage";
import {
  activateDeviceTab,
  chooseTabDevice,
  closeDeviceTab,
  DEVICE_TAB_TITLE_MAX_LENGTH,
  EMPTY_THREAD_DEVICE_TABS,
  openDeviceTab,
  openPickerTab,
  renameDeviceTab,
  type DeviceTab,
  type ThreadDeviceTabs,
} from "./deviceTabs.logic";

/*
 * Each thread's device tabs, keyed by scoped thread key. Kept across reloads in
 * the local UI storage (hosted mode keeps it in memory, through the same
 * adapter), so a closed tab stays closed. Bounded to the threads touched last.
 */

const STORAGE_KEY = "ryco:device-tabs:v1";
const MAX_THREADS = 100;
const MAX_TABS = 8;

type ByThreadKey = Readonly<Record<string, ThreadDeviceTabs>>;

function isTab(value: unknown): value is DeviceTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    tab.id.length > 0 &&
    tab.id.length <= 64 &&
    (tab.udid === null || (typeof tab.udid === "string" && tab.udid.length <= 255)) &&
    (tab.title === null ||
      (typeof tab.title === "string" && tab.title.length <= DEVICE_TAB_TITLE_MAX_LENGTH))
  );
}

function restore(): ByThreadKey {
  try {
    const raw = appLocalStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const restored: Record<string, ThreadDeviceTabs> = {};
    for (const [threadKey, value] of Object.entries(parsed).slice(-MAX_THREADS)) {
      const entry = value as { tabs?: unknown; activeId?: unknown };
      if (!Array.isArray(entry?.tabs)) continue;
      const tabs = entry.tabs.filter(isTab).slice(0, MAX_TABS);
      if (tabs.length === 0) continue;
      const activeId =
        typeof entry.activeId === "string" && tabs.some((tab) => tab.id === entry.activeId)
          ? entry.activeId
          : (tabs[0]?.id ?? null);
      restored[threadKey] = { tabs, activeId };
    }
    return restored;
  } catch {
    return {};
  }
}

function persist(byThreadKey: ByThreadKey): void {
  try {
    appLocalStorage.setItem(STORAGE_KEY, JSON.stringify(byThreadKey));
  } catch {
    /* storage unavailable: the tabs still work for this window */
  }
}

interface DeviceTabsState {
  readonly byThreadKey: ByThreadKey;
  readonly openDevice: (
    threadKey: string,
    udid: string,
    options?: { readonly activate?: boolean },
  ) => void;
  readonly openPicker: (threadKey: string) => void;
  readonly chooseDevice: (threadKey: string, tabId: string, udid: string) => void;
  readonly rename: (threadKey: string, tabId: string, title: string | null) => void;
  readonly activate: (threadKey: string, tabId: string) => void;
  readonly close: (threadKey: string, tabId: string) => void;
}

export const useDeviceTabsStore = create<DeviceTabsState>((set, get) => {
  const update = (threadKey: string, transition: (state: ThreadDeviceTabs) => ThreadDeviceTabs) => {
    const current = get().byThreadKey;
    const before = current[threadKey] ?? EMPTY_THREAD_DEVICE_TABS;
    const after = transition(before);
    if (after === before || after.tabs.length > MAX_TABS) return;
    // Re-inserted so the most recently touched threads are the ones kept.
    const { [threadKey]: _previous, ...rest } = current;
    const entries = Object.entries(rest);
    const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_THREADS + 1)));
    const next = after.tabs.length === 0 ? kept : { ...kept, [threadKey]: after };
    set({ byThreadKey: next });
    persist(next);
  };
  return {
    byThreadKey: restore(),
    openDevice: (threadKey, udid, options) =>
      update(threadKey, (state) => openDeviceTab(state, udid, options)),
    openPicker: (threadKey) => update(threadKey, (state) => openPickerTab(state)),
    chooseDevice: (threadKey, tabId, udid) =>
      update(threadKey, (state) => chooseTabDevice(state, tabId, udid)),
    rename: (threadKey, tabId, title) =>
      update(threadKey, (state) => renameDeviceTab(state, tabId, title)),
    activate: (threadKey, tabId) => update(threadKey, (state) => activateDeviceTab(state, tabId)),
    close: (threadKey, tabId) => update(threadKey, (state) => closeDeviceTab(state, tabId)),
  };
});

export function selectThreadDeviceTabs(
  byThreadKey: ByThreadKey,
  threadKey: string | null,
): ThreadDeviceTabs {
  return (threadKey ? byThreadKey[threadKey] : undefined) ?? EMPTY_THREAD_DEVICE_TABS;
}
