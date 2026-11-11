import { APP_ICON_VARIANT_SPECS, type AppIconVariant } from "@ryco/shared/appIcon";

/** The platforms whose running app icon Desktop can change. */
export type DesktopAppIconPlatform = "darwin" | "win32" | "linux";

export function isDesktopAppIconPlatform(
  platform: NodeJS.Platform,
): platform is DesktopAppIconPlatform {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

const FILE_SUFFIX: Readonly<Record<DesktopAppIconPlatform, string>> = {
  darwin: "macos.png",
  win32: "windows.ico",
  linux: "linux.png",
};

/**
 * The generated icon file for a variant under the desktop resources (`resources/app-icons`), or
 * null for the app's own icon, which each flavor and build ships itself.
 */
export function desktopAppIconResourceName(
  variant: AppIconVariant,
  platform: DesktopAppIconPlatform,
): string | null {
  const asset = APP_ICON_VARIANT_SPECS[variant].asset;
  return asset === null ? null : `app-icons/${asset}-${FILE_SUFFIX[platform]}`;
}

/** What the Dock needs to show a variant: a picture, the bundle's own icon back, or nothing. */
export type MacDockIconAction =
  | { readonly kind: "set"; readonly path: string }
  | { readonly kind: "restore" }
  | null;

/**
 * What showing a variant needs on macOS, where the Dock draws the running app's icon.
 *
 * A packaged app's own icon is its bundle's Liquid Glass icon (`Assets.car`), which the system
 * lights and themes itself; the Dock can only be handed a picture, so the other variants are
 * renderings of theirs. The default sets nothing at launch (sparing a synchronous image decode on
 * every start) and, once this run changed the icon, gives the Dock the bundle's icon back. A
 * development build's bare Electron bundle has none, so it sets its own artwork instead.
 */
export function macDockIconAction(input: {
  readonly variantPath: string | null;
  readonly defaultIconPath: string | null;
  readonly isPackaged: boolean;
  readonly changedThisRun: boolean;
}): MacDockIconAction {
  if (input.variantPath !== null) return { kind: "set", path: input.variantPath };
  if (input.isPackaged) return input.changedThisRun ? { kind: "restore" } : null;
  return input.defaultIconPath === null ? null : { kind: "set", path: input.defaultIconPath };
}
