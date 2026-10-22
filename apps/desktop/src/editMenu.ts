import type { BaseWindow, MenuItemConstructorOptions } from "electron";

export const PASTE_AS_TEXT_CHANNEL = "desktop:paste-as-text";

/** The menu action the app answers with `pasteAsText` once it is ready for the paste. */
export const PASTE_AS_TEXT_MENU_ACTION = "paste-as-text";

/**
 * Electron's default Edit menu with Paste as Text, which takes the place of macOS's Paste and
 * Match Style. A large paste into the composer becomes an attachment; this one stays text. It
 * runs through the app (`onPasteAsText` sends the menu action, the app asks for the paste) so the
 * composer knows the paste that follows is meant as text. A shortcut's own paste, where Chromium
 * makes one for the keypress, is left to stand: the app adds none after it.
 */
export function buildEditMenu(input: {
  readonly mac: boolean;
  readonly onPasteAsText: (window: BaseWindow | undefined) => void;
}): MenuItemConstructorOptions {
  const pasteAsText: MenuItemConstructorOptions = {
    label: "Paste as Text",
    accelerator: "CmdOrCtrl+Shift+V",
    click: (_item, window) => input.onPasteAsText(window),
  };
  return {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      pasteAsText,
      ...(input.mac
        ? [
            // Paste and Match Style's chord does the same.
            { ...pasteAsText, accelerator: "Cmd+Alt+Shift+V", visible: false },
            { role: "delete" as const },
            { role: "selectAll" as const },
            { type: "separator" as const },
            {
              label: "Speech",
              submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }],
            },
          ]
        : [
            { role: "delete" as const },
            { type: "separator" as const },
            { role: "selectAll" as const },
          ]),
    ],
  };
}
