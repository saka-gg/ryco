import type { EnvironmentId } from "@ryco/contracts";
import type { ShareableServerSettingKey } from "@ryco/shared/settingsSharing";
import { createContext, useContext } from "react";
import { create } from "zustand";

import type { SharedSettingsMode } from "./sharedSettingRow.logic";

/**
 * The device bar's choice for shared rows: "All devices" shows every device's value, a device
 * pill shows that device's own. `showDevice` switches to one device (an editor too large for
 * the device list edits there).
 */
export interface SharedSettingsModeValue {
  readonly mode: SharedSettingsMode;
  readonly showDevice: ((environmentId: EnvironmentId) => void) | null;
  /**
   * While "All devices" shows: the device the section's other device rows (not shared) still
   * show, for their mark. Null otherwise.
   */
  readonly targetLabel: string | null;
  /** When an offline device was last seen (ms), for its read-only value in a device list. */
  readonly lastSeenAt?: (environmentId: EnvironmentId) => number | null;
}

const ALL_DEVICES: SharedSettingsModeValue = {
  mode: { kind: "all" },
  showDevice: null,
  targetLabel: null,
};
const SharedSettingsModeContext = createContext<SharedSettingsModeValue>(ALL_DEVICES);
export const SharedSettingsModeProvider = SharedSettingsModeContext.Provider;

export function useSharedSettingsMode(): SharedSettingsModeValue {
  return useContext(SharedSettingsModeContext);
}

/**
 * A shared row to open with its device list once it mounts: the compare table and "Where this
 * device differs" ask for it before its section shows.
 */
export const useSharedRowOpenRequest = create<{ readonly key: ShareableServerSettingKey | null }>(
  () => ({ key: null }),
);

export function requestSharedRowOpen(key: ShareableServerSettingKey): void {
  useSharedRowOpenRequest.setState({ key });
}

export function takeSharedRowOpen(key: ShareableServerSettingKey): boolean {
  if (useSharedRowOpenRequest.getState().key !== key) return false;
  useSharedRowOpenRequest.setState({ key: null });
  return true;
}

/**
 * The device bar's choice on the settings page, kept while settings stay open: "All devices",
 * or the device chosen with its pill.
 */
export const useSettingsDeviceView = create<{ readonly view: "all" | "device" }>(() => ({
  view: "all",
}));

export function setSettingsDeviceView(view: "all" | "device"): void {
  useSettingsDeviceView.setState({ view });
}
