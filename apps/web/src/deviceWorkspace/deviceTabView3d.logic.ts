import type { ThreadDeviceTabs } from "./deviceTabs.logic";

/**
 * Remember whether a tab shows its device in 3D. Kept apart from the other tab
 * transitions so it loads with the device panel, not with every thread.
 */
export function setDeviceTabView3d(
  state: ThreadDeviceTabs,
  tabId: string,
  on: boolean,
): ThreadDeviceTabs {
  const target = state.tabs.find((tab) => tab.id === tabId);
  if (!target || (target.view3d === true) === on) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      if (on) return { ...tab, view3d: true };
      const { view3d: _off, ...rest } = tab;
      return rest;
    }),
  };
}
