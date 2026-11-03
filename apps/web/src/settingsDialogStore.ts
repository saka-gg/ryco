import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

import type { SettingsSectionId } from "./components/settings/settingsRegistry";

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
  /** Show another device's values without leaving the section. */
  setTargetEnvironmentId: (environmentId: EnvironmentId) => void;
  /**
   * Open settings on a section. With a device and no section, open that
   * device's page; with both, the section shows that device's values.
   */
  openSettings: (section?: SettingsSectionId, environmentId?: EnvironmentId | null) => void;
  closeSettings: () => void;
  setSection: (section: SettingsSectionId) => void;
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
  setTargetEnvironmentId: (targetEnvironmentId) => set({ targetEnvironmentId }),
  openSettings: (section, environmentId) =>
    set((state) => ({
      open: true,
      section: section ?? (environmentId ? "device" : state.section),
      targetEnvironmentId: environmentId ?? null,
    })),
  closeSettings: () => set({ open: false, targetEnvironmentId: null }),
  setSection: (section) => set({ section }),
  markOpen: () => set({ open: true }),
}));
