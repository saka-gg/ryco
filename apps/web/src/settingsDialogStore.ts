import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

export type SettingsSectionId =
  | "account"
  | "general"
  | "inbox"
  | "providers"
  | "opinionated-plugins"
  | "mcp-servers"
  | "computer-use"
  | "appearance"
  | "keybindings"
  | "source-control"
  | "connections"
  | "security"
  | "diagnostics"
  | "statistics"
  | "archived";

interface SettingsDialogStore {
  open: boolean;
  section: SettingsSectionId;
  targetEnvironmentId: EnvironmentId | null;
  openSettings: (section?: SettingsSectionId, environmentId?: EnvironmentId | null) => void;
  closeSettings: () => void;
  setSection: (section: SettingsSectionId) => void;
}

export const useSettingsDialogStore = create<SettingsDialogStore>((set) => ({
  open: false,
  section: "general",
  targetEnvironmentId: null,
  openSettings: (section, environmentId) =>
    set((state) => ({
      open: true,
      section: section ?? state.section,
      targetEnvironmentId: environmentId ?? null,
    })),
  closeSettings: () => set({ open: false, targetEnvironmentId: null }),
  setSection: (section) => set({ section }),
}));
