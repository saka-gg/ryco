import type { DesktopWindowMaterial } from "@ryco/contracts/window-material";

/**
 * The translucent window: the desktop shows through the app, blurred.
 *
 * The desktop host owns the native half: a clear window with the desktop
 * blurred behind it by the window server, at the chosen radius (see
 * `apps/desktop/src/windowTranslucency.ts`). This module owns the document
 * half. It stamps `data-window-translucency` on the root, which switches
 * `index.css` to the glass shell, and keeps the native window in step.
 *
 * - `window`: body paints ONE translucent coat for the whole window and the
 *   layout surfaces above it go clear. Raised surfaces (composer, cards,
 *   floating overlays) take a denser pane of glass; overlays get the page cut
 *   out from under them (`lib/glassOverlayCutout.ts`) so they show the glass
 *   rather than the text they cover.
 * - `sidebar`: only the sidebar paints the coat; the content stays opaque.
 */
export type WindowTranslucencyScope = "none" | "window" | "sidebar";

export const WINDOW_TRANSLUCENCY_ATTRIBUTE = "data-window-translucency";
/** Dispatched on `window` when the host reports whether the custom blur took effect. */
export const WINDOW_MATERIAL_CHANGE_EVENT = "ryco:window-material-change";

/** Whether the host window can let the desktop show through (macOS desktop). */
export function isWindowTranslucencySupported(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.desktopBridge;
  return (
    bridge?.windowTranslucencySupported === true && typeof bridge.setWindowMaterial === "function"
  );
}

/** The scope the document is currently painted for. */
export function getDocumentWindowTranslucencyScope(): WindowTranslucencyScope {
  if (typeof document === "undefined") return "none";
  const value = document.documentElement?.getAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE);
  return value === "window" || value === "sidebar" ? value : "none";
}

let lastRequestedMaterialKey: string | null = null;
let desktopBlurUnavailable = false;

/**
 * Whether the window server refused the custom blur for the current request,
 * so the window shows the system vibrancy material instead (settings say so).
 */
export function isDesktopBlurUnavailable(): boolean {
  return desktopBlurUnavailable;
}

/**
 * Paints the document for `scope` and asks the host for the matching window.
 * Unsupported hosts always stay opaque. The native request is sent once per
 * change, and again on the first apply of a document so a reload re-syncs the
 * window with this document's preference.
 */
export function applyWindowTranslucencyToDocument(input: {
  readonly scope: WindowTranslucencyScope;
  readonly blurRadius: number;
}): void {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  if (!root) return;
  const supported = isWindowTranslucencySupported();
  const scope = supported ? input.scope : "none";
  if (getDocumentWindowTranslucencyScope() !== scope) {
    if (scope === "none") {
      root.removeAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE);
    } else {
      root.setAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE, scope);
      // `syncBrowserChromeTheme` pins an opaque inline fill on html/body for the
      // browser chrome; it would cover the glass.
      root.style.removeProperty("background-color");
      document.body?.style.removeProperty("background-color");
    }
  }
  if (!supported) return;
  syncDesktopWindowMaterial({
    material: scope === "none" ? "opaque" : "translucent",
    blurRadius: input.blurRadius,
  });
}

function syncDesktopWindowMaterial(material: DesktopWindowMaterial): void {
  const setWindowMaterial = window.desktopBridge?.setWindowMaterial;
  const key = material.material === "opaque" ? "opaque" : `translucent:${material.blurRadius}`;
  if (!setWindowMaterial || lastRequestedMaterialKey === key) return;
  lastRequestedMaterialKey = key;
  void setWindowMaterial(material).then(
    (applied) => {
      // Opaque always applies; only the custom blur can be refused.
      const unavailable = material.material === "translucent" && !applied;
      if (lastRequestedMaterialKey !== key || desktopBlurUnavailable === unavailable) return;
      desktopBlurUnavailable = unavailable;
      window.dispatchEvent(new Event(WINDOW_MATERIAL_CHANGE_EVENT));
    },
    () => {
      if (lastRequestedMaterialKey === key) lastRequestedMaterialKey = null;
    },
  );
}

export function __resetWindowTranslucencyForTests(): void {
  lastRequestedMaterialKey = null;
  desktopBlurUnavailable = false;
  if (typeof document !== "undefined") {
    document.documentElement?.removeAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE);
  }
}
