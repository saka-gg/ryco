import {
  DESKTOP_WINDOW_BLUR_RADIUS_MAX,
  DESKTOP_WINDOW_BLUR_RADIUS_MIN,
  type DesktopWindowMaterial,
} from "@ryco/contracts";
import type { BrowserWindow } from "electron";

/**
 * The native half of the translucent window (Settings → Appearance).
 *
 * macOS only. A translucent window gets a clear backing and the window server
 * blurs the desktop behind it at the chosen radius, through the
 * `ryco-window-material` addon (native/macos/RycoWindowMaterial.m). There is no
 * vibrancy material in between, so the desktop shows through untinted; the
 * renderer paints the one translucent coat over it (themes/windowTranslucency.ts).
 * When the addon is missing or the window server refuses the call, the window
 * falls back to the `under-window` vibrancy material, which still reads as
 * frosted glass. Windows and Linux keep the opaque window.
 */
export const WINDOW_TRANSLUCENCY_FALLBACK_VIBRANCY = "under-window";

const TRANSPARENT_BACKGROUND_COLOR = "#00000000";

export interface WindowMaterialAddon {
  setBackgroundBlurRadius: (nativeWindowHandle: Buffer, radius: number) => boolean;
}

export function isWindowTranslucencySupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

export function parseDesktopWindowMaterial(raw: unknown): DesktopWindowMaterial | null {
  if (!raw || typeof raw !== "object") return null;
  const { material, blurRadius } = raw as Record<string, unknown>;
  if (material !== "opaque" && material !== "translucent") return null;
  if (typeof blurRadius !== "number" || !Number.isFinite(blurRadius)) return null;
  return {
    material,
    blurRadius: Math.round(
      Math.min(
        DESKTOP_WINDOW_BLUR_RADIUS_MAX,
        Math.max(DESKTOP_WINDOW_BLUR_RADIUS_MIN, blurRadius),
      ),
    ),
  };
}

type MaterialWindow = Pick<
  BrowserWindow,
  "getNativeWindowHandle" | "isDestroyed" | "setBackgroundColor" | "setVibrancy"
>;

interface TranslucentState {
  readonly blurRadius: number;
  /** The addon's blur took effect; otherwise the vibrancy fallback is showing. */
  readonly customBlur: boolean;
}

/**
 * Applies the renderer's window material and remembers it per window, so
 * appearance syncs that repaint the native background (light/dark flips) keep
 * the clear backing and blur instead of restoring an opaque fill under them.
 * The addon is loaded on the first translucent request.
 */
export function createWindowTranslucencyController(input: {
  readonly platform: NodeJS.Platform;
  readonly opaqueBackgroundColor: () => string;
  readonly loadAddon: () => WindowMaterialAddon | null;
}) {
  const supported = isWindowTranslucencySupported(input.platform);
  const translucentWindows = new WeakMap<MaterialWindow, TranslucentState>();
  let addon: WindowMaterialAddon | null | undefined;

  const backgroundColorFor = (window: MaterialWindow): string =>
    translucentWindows.has(window) ? TRANSPARENT_BACKGROUND_COLOR : input.opaqueBackgroundColor();

  const setBlur = (window: MaterialWindow, radius: number): boolean =>
    addon?.setBackgroundBlurRadius(window.getNativeWindowHandle(), radius) ?? false;

  return {
    supported,
    backgroundColorFor,
    /**
     * Applies `material`; resolves whether it took effect as asked. `false` for
     * a translucent request means the vibrancy fallback is showing instead of the
     * chosen blur.
     */
    apply(window: MaterialWindow, material: DesktopWindowMaterial): boolean {
      if (window.isDestroyed()) return false;
      const previous = translucentWindows.get(window);
      if (!supported || material.material === "opaque") {
        if (previous) {
          translucentWindows.delete(window);
          if (previous.customBlur) setBlur(window, 0);
          else window.setVibrancy(null);
          window.setBackgroundColor(input.opaqueBackgroundColor());
        }
        return material.material === "opaque";
      }
      if (previous?.customBlur && previous.blurRadius === material.blurRadius) return true;

      if (addon === undefined) addon = input.loadAddon();
      if (previous && !previous.customBlur) window.setVibrancy(null);
      // Before the blur call: Electron's background write would replace the
      // near-clear backing the addon installs.
      window.setBackgroundColor(TRANSPARENT_BACKGROUND_COLOR);
      if (setBlur(window, material.blurRadius)) {
        translucentWindows.set(window, { blurRadius: material.blurRadius, customBlur: true });
        return true;
      }
      window.setVibrancy(WINDOW_TRANSLUCENCY_FALLBACK_VIBRANCY);
      translucentWindows.set(window, { blurRadius: material.blurRadius, customBlur: false });
      return false;
    },
    /** Repaints the native background for the current material (after a theme flip). */
    syncBackground(window: MaterialWindow): void {
      if (window.isDestroyed()) return;
      window.setBackgroundColor(backgroundColorFor(window));
      const state = translucentWindows.get(window);
      if (state?.customBlur) setBlur(window, state.blurRadius);
    },
  };
}
