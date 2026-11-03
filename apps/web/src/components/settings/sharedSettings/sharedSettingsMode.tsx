import type { EnvironmentId } from "@ryco/contracts";
import type { ShareableServerSettingKey } from "@ryco/shared/settingsSharing";
import { createContext, useContext } from "react";
import { create } from "zustand";

import { useSettingsDialogStore } from "../../../settingsDialogStore";
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
 * How long a request to open a row waits for it to mount: its section loading. A row that never
 * mounts (a section the reader cannot open) must not open later, when the reader gets there on
 * their own.
 */
export const SHARED_ROW_OPEN_TTL_MS = 10_000;

/**
 * A shared row to open with its device list once it mounts: the compare table and "Where this
 * device differs" ask for it before its section shows.
 */
export const useSharedRowOpenRequest = create<{
  readonly key: ShareableServerSettingKey | null;
  /** When the request stops being honored (ms since the epoch). */
  readonly expiresAt?: number;
}>(() => ({ key: null }));

export function requestSharedRowOpen(key: ShareableServerSettingKey, nowMs = Date.now()): void {
  useSharedRowOpenRequest.setState({ key, expiresAt: nowMs + SHARED_ROW_OPEN_TTL_MS });
}

export function takeSharedRowOpen(key: ShareableServerSettingKey, nowMs = Date.now()): boolean {
  const { key: requested, expiresAt } = useSharedRowOpenRequest.getState();
  if (requested === null) return false;
  if (expiresAt !== undefined && nowMs >= expiresAt) {
    useSharedRowOpenRequest.setState({ key: null });
    return false;
  }
  if (requested !== key) return false;
  useSharedRowOpenRequest.setState({ key: null });
  return true;
}

/**
 * The device bar's choice on the settings page: "All devices", or the device chosen with its
 * pill. The settings store keeps it (`deviceView`), so `openSettings` with a device and the
 * page's address set it too.
 */
export function useSettingsDeviceView(): "all" | "device" {
  return useSettingsDialogStore((state) => state.deviceView);
}

export function setSettingsDeviceView(view: "all" | "device"): void {
  useSettingsDialogStore.getState().setDeviceView(view);
}
