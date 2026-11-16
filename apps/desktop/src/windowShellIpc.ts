import * as OS from "node:os";
import * as Path from "node:path";

import type { ContextMenuItem, DesktopTheme } from "@ryco/contracts";
import {
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from "electron";

import { handleAppInvoke } from "./appInvoke.ts";
import { PASTE_AS_TEXT_CHANNEL } from "./editMenu.ts";
import { showDesktopConfirmDialog } from "./confirmDialog.ts";
import {
  parseDesktopWindowMaterial,
  type createWindowTranslucencyController,
} from "./windowTranslucency.ts";
import {
  PICK_FOLDER_CHANNEL,
  CONFIRM_CHANNEL,
  SET_THEME_CHANNEL,
  SET_WINDOW_MATERIAL_CHANNEL,
  CONTEXT_MENU_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
} from "./desktopIpcChannels.ts";

/** What the folder picker, dialog, theme, material, menu, paste and link channels need from main. */
export interface WindowShellIpcDeps {
  readonly mainWindow: () => BrowserWindow | null;
  readonly windowTranslucency: () => Pick<
    ReturnType<typeof createWindowTranslucencyController>,
    "apply"
  >;
  readonly getSafeExternalUrl: (rawUrl: unknown) => string | null;
}

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;

function resolvePickFolderDefaultPath(rawOptions: unknown): string | undefined {
  if (typeof rawOptions !== "object" || rawOptions === null) {
    return undefined;
  }

  const { initialPath } = rawOptions as { initialPath?: unknown };
  if (typeof initialPath !== "string") {
    return undefined;
  }

  const trimmedPath = initialPath.trim();
  if (trimmedPath.length === 0) {
    return undefined;
  }

  if (trimmedPath === "~") {
    return OS.homedir();
  }

  if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
    return Path.join(OS.homedir(), trimmedPath.slice(2));
  }

  return Path.resolve(trimmedPath);
}

function normalizeContextMenuItems(source: readonly ContextMenuItem[]): ContextMenuItem[] {
  const normalizedItems: ContextMenuItem[] = [];

  for (const sourceItem of source) {
    if (typeof sourceItem.id !== "string" || typeof sourceItem.label !== "string") {
      continue;
    }

    const normalizedItem: ContextMenuItem = {
      id: sourceItem.id,
      label: sourceItem.label,
      destructive: sourceItem.destructive === true,
      disabled: sourceItem.disabled === true,
    };

    if (sourceItem.children) {
      const normalizedChildren = normalizeContextMenuItems(sourceItem.children);
      if (normalizedChildren.length === 0) {
        continue;
      }
      normalizedItem.children = normalizedChildren;
    }

    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}

/** Native folder picker, confirm dialog, theme, window material, context menu, paste as text and external links. */
export function registerWindowShellIpc(deps: WindowShellIpcDeps): void {
  handleAppInvoke(
    PICK_FOLDER_CHANNEL,
    async (_event, rawOptions: unknown) => {
      const owner = BrowserWindow.getFocusedWindow() ?? deps.mainWindow();
      const defaultPath = resolvePickFolderDefaultPath(rawOptions);
      const openDialogOptions: OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
        ...(defaultPath ? { defaultPath } : {}),
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, openDialogOptions)
        : await dialog.showOpenDialog(openDialogOptions);
      if (result.canceled) return null;
      return result.filePaths[0] ?? null;
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    CONFIRM_CHANNEL,
    async (_event, message: unknown) => {
      if (typeof message !== "string") {
        return false;
      }

      const owner = BrowserWindow.getFocusedWindow() ?? deps.mainWindow();
      return showDesktopConfirmDialog(message, owner);
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    SET_THEME_CHANNEL,
    async (_event, rawTheme: unknown) => {
      const theme = getSafeTheme(rawTheme);
      if (!theme) {
        return;
      }

      nativeTheme.themeSource = theme;
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    SET_WINDOW_MATERIAL_CHANNEL,
    async (event, rawMaterial: unknown) => {
      const material = parseDesktopWindowMaterial(rawMaterial);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!material || !window) {
        return false;
      }

      return deps.windowTranslucency().apply(window, material);
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = normalizeContextMenuItems(items);
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? deps.mainWindow();
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const buildTemplate = (
          entries: readonly ContextMenuItem[],
        ): MenuItemConstructorOptions[] => {
          const template: MenuItemConstructorOptions[] = [];
          let hasInsertedDestructiveSeparator = false;
          for (const item of entries) {
            if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
              template.push({ type: "separator" });
              hasInsertedDestructiveSeparator = true;
            }
            const itemOption: MenuItemConstructorOptions = {
              label: item.label,
              enabled: !item.disabled,
            };
            if (item.children && item.children.length > 0) {
              itemOption.submenu = buildTemplate(item.children);
            } else {
              itemOption.click = () => resolve(item.id);
            }
            if (item.destructive && (!item.children || item.children.length === 0)) {
              const destructiveIcon = getDestructiveMenuIcon();
              if (destructiveIcon) {
                itemOption.icon = destructiveIcon;
              }
            }
            template.push(itemOption);
          }
          return template;
        };

        const menu = Menu.buildFromTemplate(buildTemplate(normalizedItems));
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    PASTE_AS_TEXT_CHANNEL,
    async (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed() || event.sender.isDestroyed()) return;
      event.sender.pasteAndMatchStyle();
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    OPEN_EXTERNAL_CHANNEL,
    async (_event, rawUrl: unknown) => {
      const externalUrl = deps.getSafeExternalUrl(rawUrl);
      if (externalUrl) {
        try {
          await shell.openExternal(externalUrl);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },
    { requireMainFrame: false },
  );
}
