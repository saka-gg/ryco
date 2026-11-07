// Adapted from pingdotgg/t3code commit 6577c6b6
// (`packages/client-runtime/src/device/phoneInteraction.ts` and
// `apps/web/src/components/device/phoneTrackpad.ts`, MIT); see THIRD_PARTY_NOTICES.md.

/*
 * Trackpad gestures on the 3D view: a two-finger scroll orbits the device,
 * and a pinch (Ctrl-wheel in Chromium and Firefox, gesture events in Safari)
 * zooms. Plain DOM events, no three.js.
 */

export type DeviceNavigation =
  | { readonly type: "orbit"; readonly x: number; readonly y: number }
  | { readonly type: "zoom"; readonly delta: number };

/** One wheel event as an orbit (fractions of the canvas) or a zoom (log scale). Wheel units vary by device. */
export function deviceWheelNavigation(input: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly width: number;
  readonly height: number;
}): DeviceNavigation | null {
  const { deltaX, deltaY, deltaMode, ctrlKey, width, height } = input;
  if (![deltaX, deltaY, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    return null;
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1;
  const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
  if (ctrlKey) return { type: "zoom", delta: clamp(-deltaY * unit * 0.005, 0.2) };
  return {
    type: "orbit",
    x: clamp((-deltaX * unit) / width, 0.25),
    y: clamp((-deltaY * unit) / height, 0.25),
  };
}

/** How long after the last scroll the orbit counts as released and the device settles. */
export const TRACKPAD_ORBIT_RELEASE_MS = 220;

export function bindDeviceTrackpad(
  element: Pick<HTMLElement, "addEventListener" | "removeEventListener" | "getBoundingClientRect">,
  handlers: {
    /** False while a pointer gesture owns the device: the camera must not move under a finger. */
    readonly canNavigate: () => boolean;
    readonly orbit: (deltaX: number, deltaY: number) => void;
    readonly orbitEnd: () => void;
    readonly zoomBy: (logDelta: number) => void;
  },
) {
  let gestureScale: number | null = null;
  let orbiting = false;
  let orbitTimer: ReturnType<typeof setTimeout> | null = null;

  const endOrbit = () => {
    if (orbitTimer) clearTimeout(orbitTimer);
    orbitTimer = null;
    if (!orbiting) return;
    orbiting = false;
    handlers.orbitEnd();
  };
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const wheel = (event: WheelEvent) => {
    consume(event);
    if (gestureScale !== null || !handlers.canNavigate()) return;
    const rect = element.getBoundingClientRect();
    const navigation = deviceWheelNavigation({
      width: rect.width,
      height: rect.height,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
    });
    if (!navigation) return;
    if (navigation.type === "zoom") {
      endOrbit();
      handlers.zoomBy(navigation.delta);
      return;
    }
    orbiting = true;
    handlers.orbit(navigation.x, navigation.y);
    if (orbitTimer) clearTimeout(orbitTimer);
    orbitTimer = setTimeout(endOrbit, TRACKPAD_ORBIT_RELEASE_MS);
  };
  const scaleOf = (event: Event) => {
    if (!("scale" in event) || typeof event.scale !== "number") return null;
    return Number.isFinite(event.scale) && event.scale > 0 ? event.scale : null;
  };
  // Safari reports a pinch as cumulative gesture scale instead of Ctrl-wheel.
  const gestureStart = (event: Event) => {
    consume(event);
    endOrbit();
    gestureScale = scaleOf(event) ?? 1;
  };
  const gestureChange = (event: Event) => {
    consume(event);
    const next = scaleOf(event);
    if (gestureScale === null || next === null) return;
    if (handlers.canNavigate()) handlers.zoomBy(Math.log(next / gestureScale));
    gestureScale = next;
  };
  const gestureEnd = (event: Event) => {
    consume(event);
    gestureScale = null;
  };
  element.addEventListener("wheel", wheel, { passive: false });
  element.addEventListener("gesturestart", gestureStart, { passive: false });
  element.addEventListener("gesturechange", gestureChange, { passive: false });
  element.addEventListener("gestureend", gestureEnd, { passive: false });
  return {
    cancel() {
      endOrbit();
      gestureScale = null;
    },
    dispose() {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", gestureStart);
      element.removeEventListener("gesturechange", gestureChange);
      element.removeEventListener("gestureend", gestureEnd);
      endOrbit();
      gestureScale = null;
    },
  };
}
