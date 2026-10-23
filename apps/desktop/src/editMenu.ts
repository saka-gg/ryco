import type { MenuItemConstructorOptions } from "electron";

export const PASTE_AS_TEXT_CHANNEL = "desktop:paste-as-text";

/**
 * Where a Paste as Text goes, by the page that has focus: the app's own page is told first so
 * the composer knows the paste that follows is meant as text (it then asks for the paste); any
 * other page, such as the browser panel's or a sign-in window's, pastes at once, as the Paste and
 * Match Style it replaced did. Off macOS, Chromium already pastes as text for the chord in a
 * page, so the chord's menu action adds no second paste there.
 */
export function resolvePasteAsTextTarget(input: {
  readonly focused: "app" | "page" | null;
  readonly triggeredByAccelerator: boolean;
  readonly mac: boolean;
}): "app" | "page" | null {
  if (input.focused === "page" && input.triggeredByAccelerator && !input.mac) return null;
  return input.focused;
}

/**
 * Electron's default Edit menu with Paste as Text, which takes the place of macOS's Paste and
 * Match Style. A large paste into the composer becomes an attachment; this one stays text. In
 * the app's page it runs through the app (`onPasteAsText` sends the menu action, the app asks for
 * the paste) so the composer knows the paste that follows is meant as text. A shortcut's own
 * paste, where Chromium makes one for the keypress, is left to stand: the app adds none after it.
 */
export function buildEditMenu(input: {
  readonly mac: boolean;
  readonly onPasteAsText: (click: { readonly triggeredByAccelerator: boolean }) => void;
}): MenuItemConstructorOptions {
  const pasteAsText: MenuItemConstructorOptions = {
    label: "Paste as Text",
    accelerator: "CmdOrCtrl+Shift+V",
    click: (_item, _window, event) =>
      input.onPasteAsText({ triggeredByAccelerator: event.triggeredByAccelerator === true }),
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
