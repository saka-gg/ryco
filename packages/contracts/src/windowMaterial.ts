// Dependency-free so the web appearance module can share these bounds without
// loading the contracts barrel (subpath `@ryco/contracts/window-material`).

/** Largest desktop blur radius a translucent window accepts, in points. */
export const DESKTOP_WINDOW_BLUR_RADIUS_MAX = 64;
/** Smallest one: an unblurred desktop behind a clear window reads as a hole, not as glass. */
export const DESKTOP_WINDOW_BLUR_RADIUS_MIN = 1;

/**
 * The window backing the renderer asks for. `translucent` gives the window a clear
 * backing with the desktop blurred behind it at `blurRadius`; `opaque` restores the
 * solid window and ignores `blurRadius`.
 */
export interface DesktopWindowMaterial {
  readonly material: "opaque" | "translucent";
  readonly blurRadius: number;
}
