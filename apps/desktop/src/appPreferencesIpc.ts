import * as Path from "node:path";

import { isAppIconVariant } from "@ryco/shared/appIcon";
import { BrowserWindow } from "electron";

import { appSenderWindow, handleAppInvoke } from "./appInvoke.ts";
import { readAppKeybindings, writeAppKeybindings } from "./clientPersistence.ts";
import type { DesktopSettings } from "./desktopSettings.ts";
import {
  APP_KEYBINDINGS_CHANGED_CHANNEL,
  APP_ICON_GET_CHANNEL,
  APP_ICON_SET_CHANNEL,
  QUIT_SHORTCUT_GET_CHANNEL,
  QUIT_SHORTCUT_SET_CHANNEL,
  APP_KEYBINDINGS_READ_CHANNEL,
  APP_KEYBINDINGS_WRITE_CHANNEL,
} from "./desktopIpcChannels.ts";

/** What the app icon, quit shortcut and app keybindings channels need from main. */
export interface AppPreferencesIpcDeps {
  readonly desktopSettings: () => DesktopSettings;
  /** Writes the settings file, then publishes `next` as main's current settings. */
  readonly commitDesktopSettings: (next: DesktopSettings) => void;
  readonly applyDockIcon: () => void;
  readonly applyWindowIcons: () => void;
  readonly quitShortcutGuards: () => Iterable<{ reset(): void }>;
  /** The keybindings file sits beside the client settings file. */
  readonly clientSettingsPath: string;
}

/** App icon, quit shortcut and app keybindings, kept by main for every window. */
export function registerAppPreferencesIpc(deps: AppPreferencesIpcDeps): void {
  handleAppInvoke(APP_ICON_GET_CHANNEL, () => deps.desktopSettings().appIconVariant, {
    requireMainFrame: false,
  });
  handleAppInvoke(
    APP_ICON_SET_CHANNEL,
    (_event, variant: unknown) => {
      if (!isAppIconVariant(variant)) throw new Error("Invalid app icon.");
      if (variant === deps.desktopSettings().appIconVariant) return;
      const next: DesktopSettings = { ...deps.desktopSettings(), appIconVariant: variant };
      deps.commitDesktopSettings(next);
      deps.applyDockIcon();
      deps.applyWindowIcons();
    },
    { requireMainFrame: true },
  );
  handleAppInvoke(QUIT_SHORTCUT_GET_CHANNEL, () => deps.desktopSettings().quitShortcutMode, {
    requireMainFrame: false,
  });
  handleAppInvoke(
    QUIT_SHORTCUT_SET_CHANNEL,
    (_event, mode: unknown) => {
      if (mode !== "press-twice" && mode !== "hold" && mode !== "immediately")
        throw new Error("Invalid quit shortcut mode.");
      const next: DesktopSettings = { ...deps.desktopSettings(), quitShortcutMode: mode };
      deps.commitDesktopSettings(next);
      for (const guard of deps.quitShortcutGuards()) guard.reset();
    },
    { requireMainFrame: true },
  );

  const appKeybindingsPath = Path.join(
    Path.dirname(deps.clientSettingsPath),
    "app-keybindings.json",
  );
  handleAppInvoke(APP_KEYBINDINGS_READ_CHANNEL, () => readAppKeybindings(appKeybindingsPath), {
    requireMainFrame: false,
  });
  handleAppInvoke(
    APP_KEYBINDINGS_WRITE_CHANNEL,
    (event, document: unknown) => {
      const owner = appSenderWindow(event);
      if (typeof document !== "string" || document.length > 1024 * 1024) {
        throw new Error("Invalid app keybindings write.");
      }
      writeAppKeybindings(appKeybindingsPath, document);
      for (const window of BrowserWindow.getAllWindows()) {
        if (window !== owner) window.webContents.send(APP_KEYBINDINGS_CHANGED_CHANNEL);
      }
    },
    { requireMainFrame: true },
  );
}
