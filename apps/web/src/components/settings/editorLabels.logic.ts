import { EDITORS, type EditorId } from "@ryco/contracts";

import { isMacPlatform, isWindowsPlatform } from "../../lib/utils";

/**
 * Display label of an editor target. Icon-free so menus that only print a label
 * (thread and project context menus in the shell) do not carry every editor
 * logo; `SettingsPanels.editor` pairs it with the icons.
 */
export function getEditorLabel(editor: EditorId, platform: string): string {
  if (editor === "terminal" && isWindowsPlatform(platform)) return "Windows Terminal";
  if (editor === "file-manager") {
    if (isMacPlatform(platform)) return "Finder";
    if (isWindowsPlatform(platform)) return "Explorer";
    return "Files";
  }
  return EDITORS.find((e) => e.id === editor)?.label ?? editor;
}
