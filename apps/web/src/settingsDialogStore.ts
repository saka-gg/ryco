import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

import type {
  SettingsDevicePartId,
  SettingsSectionId,
} from "./components/settings/settingsRegistry";

export type { SettingsSectionId } from "./components/settings/settingsRegistry";

interface SettingsDialogStore {
  open: boolean;
  /**
   * The section asked for. Old ids stay as asked: the page redirects them to
   * their new home (`resolveSettingsPageSection`) and the frozen phone tier to
   * its own (`resolvePhoneSettingsSection`).
   */
  section: SettingsSectionId;
  /**
   * The device whose stored values the page shows: the device bar's choice and
   * the device page's device. Null follows the thread being viewed, else the
   * active device, else this app's own (`useSettingsPageTarget`).
   */
  targetEnvironmentId: EnvironmentId | null;
  /**
   * The device page's tab asked for. Null opens the tab an old section id names
   * (`security`), else Overview (`resolveSettingsDeviceTab`).
   */
  deviceTab: SettingsDevicePartId | null;
  /**
   * The device bar's view where it offers "All devices": every device's value, or
   * the target's own. Opening with a device shows that device's; settings
   * otherwise open and close on "All devices".
   */
  deviceView: "all" | "device";
  /** Show another device's values without leaving the section. */
  setTargetEnvironmentId: (environmentId: EnvironmentId) => void;
  /**
   * Open settings on a section. With a device and no section, open that
   * device's page; with both, the section shows that device's values. A device
   * page opens on `deviceTab`. Named a device, sections show its own values.
   */
  openSettings: (
    section?: SettingsSectionId,
    environmentId?: EnvironmentId | null,
    deviceTab?: SettingsDevicePartId | null,
  ) => void;
  closeSettings: () => void;
  /** Show a section; a device page on `deviceTab`. */
  setSection: (section: SettingsSectionId, deviceTab?: SettingsDevicePartId | null) => void;
  setDeviceTab: (deviceTab: SettingsDevicePartId) => void;
  setDeviceView: (deviceView: "all" | "device") => void;
  /**
   * Mark settings open without changing where they point. The desktop settings
   * page calls this when it is reached by URL, Back, or Forward rather than by
   * `openSettings`.
   */
  markOpen: () => void;
}

export const useSettingsDialogStore = create<SettingsDialogStore>((set) => ({
  open: false,
  section: "general",
  targetEnvironmentId: null,
  deviceTab: null,
  deviceView: "all",
  setTargetEnvironmentId: (targetEnvironmentId) => set({ targetEnvironmentId }),
  openSettings: (section, environmentId, deviceTab) =>
    set((state) => ({
      open: true,
      section: section ?? (environmentId ? "device" : state.section),
      targetEnvironmentId: environmentId ?? null,
      deviceTab: section || environmentId ? (deviceTab ?? null) : state.deviceTab,
      deviceView: environmentId ? "device" : "all",
    })),
  closeSettings: () => set({ open: false, targetEnvironmentId: null, deviceView: "all" }),
  setSection: (section, deviceTab = null) => set({ section, deviceTab }),
  setDeviceTab: (deviceTab) => set({ deviceTab }),
  setDeviceView: (deviceView) => set({ deviceView }),
  markOpen: () => set({ open: true }),
}));
