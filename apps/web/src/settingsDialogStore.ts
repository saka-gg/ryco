import { settingsSectionScope } from "./components/settings/settingsSections.logic";
import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

export type SettingsSectionId =
  | "account"
  | "general"
  | "inbox"
  | "providers"
  | "opinionated-plugins"
  | "mcp-servers"
  | "integrations"
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
  editingScope: "client" | "node";
  setTargetEnvironmentId: (environmentId: EnvironmentId) => void;
  setEditingScope: (scope: "client" | "node") => void;
  openSettings: (section?: SettingsSectionId, environmentId?: EnvironmentId | null) => void;
  closeSettings: () => void;
  setSection: (section: SettingsSectionId) => void;
}

export const useSettingsDialogStore = create<SettingsDialogStore>((set) => ({
  open: false,
  section: "general",
  targetEnvironmentId: null,
  editingScope: "client",
  setTargetEnvironmentId: (targetEnvironmentId) =>
    set({ targetEnvironmentId, editingScope: "node", section: "general" }),
  setEditingScope: (editingScope) => set({ editingScope, section: "general" }),
  openSettings: (section, environmentId) =>
    set((state) => ({
      open: true,
      section: section ?? (environmentId ? "general" : state.section),
      editingScope:
        environmentId || (section && settingsSectionScope(section) === "node")
          ? "node"
          : section
            ? "client"
            : state.editingScope,
      targetEnvironmentId: environmentId ?? null,
    })),
  closeSettings: () => set({ open: false, targetEnvironmentId: null }),
  setSection: (section) => set({ section }),
}));
