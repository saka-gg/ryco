/**
 * The device tabs of a thread's workspace panel: one tab per device the thread
 * watches, plus at most one picker tab ("Device") that has not chosen yet.
 *
 * Tabs are the client's own record, kept across reloads, so a tab the user
 * closed stays closed even while the device keeps running. The server's
 * attachments say what each tab streams; they never create tabs by
 * themselves, except when an agent opens a device and the user chose tabs
 * over the floating window.
 *
 * Pure transitions: each returns its input unchanged when nothing changes.
 */

export interface DeviceTab {
  readonly id: string;
  /** Null while the tab is still the picker. */
  readonly udid: string | null;
  /** A name the user gave the tab; null shows the device's own name. */
  readonly title: string | null;
}

export interface ThreadDeviceTabs {
  readonly tabs: readonly DeviceTab[];
  readonly activeId: string | null;
}

export const EMPTY_THREAD_DEVICE_TABS: ThreadDeviceTabs = Object.freeze({
  tabs: Object.freeze([]) as readonly DeviceTab[],
  activeId: null,
});

/** Tab names are labels, not documents. */
export const DEVICE_TAB_TITLE_MAX_LENGTH = 64;

let nextTabId = 0;
/** Unique within a page and unlikely to collide with ids restored from storage. */
export function createDeviceTabId(): string {
  nextTabId += 1;
  return `${Date.now().toString(36)}${nextTabId.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function activeDeviceTab(state: ThreadDeviceTabs): DeviceTab | null {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0] ?? null;
}

/**
 * Open a device in its tab: the tab already showing it, or a new one at the
 * end. `activate: false` adds it without taking the user's focus.
 */
export function openDeviceTab(
  state: ThreadDeviceTabs,
  udid: string,
  options: { readonly activate?: boolean; readonly id?: string } = {},
): ThreadDeviceTabs {
  const activate = options.activate ?? true;
  const existing = state.tabs.find((tab) => tab.udid === udid);
  if (existing) {
    return !activate || state.activeId === existing.id
      ? state
      : { ...state, activeId: existing.id };
  }
  const tab: DeviceTab = { id: options.id ?? createDeviceTabId(), udid, title: null };
  return {
    tabs: [...state.tabs, tab],
    activeId: activate || state.activeId === null ? tab.id : state.activeId,
  };
}

/** Show the picker: the open picker tab, or a new one. */
export function openPickerTab(
  state: ThreadDeviceTabs,
  id: string = createDeviceTabId(),
): ThreadDeviceTabs {
  const picker = state.tabs.find((tab) => tab.udid === null);
  if (picker) return state.activeId === picker.id ? state : { ...state, activeId: picker.id };
  return { tabs: [...state.tabs, { id, udid: null, title: null }], activeId: id };
}

/**
 * The picker tab chose a device. A device another tab already shows is not
 * opened twice: the picker closes and that tab comes forward.
 */
export function chooseTabDevice(
  state: ThreadDeviceTabs,
  tabId: string,
  udid: string,
): ThreadDeviceTabs {
  const target = state.tabs.find((tab) => tab.id === tabId);
  if (!target) return openDeviceTab(state, udid);
  if (target.udid === udid) return state.activeId === tabId ? state : { ...state, activeId: tabId };
  const other = state.tabs.find((tab) => tab.udid === udid);
  if (other) {
    return {
      tabs: state.tabs.filter((tab) => tab.id !== tabId),
      activeId: other.id,
    };
  }
  return {
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, udid } : tab)),
    activeId: tabId,
  };
}

export function renameDeviceTab(
  state: ThreadDeviceTabs,
  tabId: string,
  title: string | null,
): ThreadDeviceTabs {
  const trimmed = title?.trim().slice(0, DEVICE_TAB_TITLE_MAX_LENGTH) ?? "";
  const next = trimmed.length > 0 ? trimmed : null;
  const target = state.tabs.find((tab) => tab.id === tabId);
  if (!target || target.title === next) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: next } : tab)),
  };
}

export function activateDeviceTab(state: ThreadDeviceTabs, tabId: string): ThreadDeviceTabs {
  if (state.activeId === tabId || !state.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, activeId: tabId };
}

/** Close a tab; closing the active one brings forward the tab after it, else the one before. */
export function closeDeviceTab(state: ThreadDeviceTabs, tabId: string): ThreadDeviceTabs {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeId !== tabId) return { tabs, activeId: state.activeId };
  return { tabs, activeId: (tabs[index] ?? tabs[index - 1])?.id ?? null };
}

/** Close the tab showing a device, if one does. */
export function closeDeviceTabForUdid(state: ThreadDeviceTabs, udid: string): ThreadDeviceTabs {
  const tab = state.tabs.find((candidate) => candidate.udid === udid);
  return tab ? closeDeviceTab(state, tab.id) : state;
}
