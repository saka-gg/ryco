import { vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

// The published CDPSession type is an empty interface; the playwright
// provider's session exposes `send` at runtime.
interface CdpInputSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

export function cdpSession(): CdpInputSession {
  return cdp() as unknown as CdpInputSession;
}

/**
 * Pins whether one media query matches for code that reads it through
 * `window.matchMedia` (such as `useMediaQuery`); every other query stays live.
 * Pointer and hover media follow the runner's input devices (see
 * `resetPointerEmulation`), so a test whose behavior depends on them pins
 * them. Call the returned function to restore.
 */
export function pinMediaQueryMatches(query: string, matches: boolean): () => void {
  const matchMedia = window.matchMedia.bind(window);
  const spy = vi.spyOn(window, "matchMedia").mockImplementation((candidate: string) => {
    const list = matchMedia(candidate);
    if (candidate === query) {
      Object.defineProperty(list, "matches", { value: matches });
    }
    return list;
  });
  return () => spy.mockRestore();
}

/**
 * Emulates (or reverts) a touch primary pointer so `pointer-coarse:` styles
 * and `(pointer: coarse)` media queries apply. Callers must revert before the
 * test ends so later tests keep the fine-pointer default.
 */
export async function setCoarsePointerEmulation(enabled: boolean): Promise<void> {
  await cdpSession().send("Emulation.setTouchEmulationEnabled", {
    enabled,
    ...(enabled ? { maxTouchPoints: 1 } : {}),
  });
}

/**
 * Moves the real input pointer to fixed page coordinates. The browser suite
 * shares one pointer across test files, so parking it deterministically
 * protects hover-sensitive assertions from wherever an earlier file left it.
 */
export async function parkPointer(x: number, y: number): Promise<void> {
  await cdpSession().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

/** Moves the input pointer to CDP coordinates and resolves with where the page saw it. */
async function probeClientPosition(x: number, y: number): Promise<{ x: number; y: number }> {
  const position = new Promise<{ x: number; y: number }>((resolve) => {
    const onMove = (event: PointerEvent) => {
      window.removeEventListener("pointermove", onMove, true);
      resolve({ x: event.clientX, y: event.clientY });
    };
    window.addEventListener("pointermove", onMove, true);
  });
  await cdpSession().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  return position;
}

/**
 * Maps client coordinates of the test page to CDP input coordinates. The
 * browser runner scales the emulated viewport, so the two do not coincide;
 * probing two points recovers the affine mapping instead of assuming one.
 */
export async function calibratePointerInput(): Promise<
  (clientX: number, clientY: number) => { x: number; y: number }
> {
  const first = await probeClientPosition(60, 60);
  const second = await probeClientPosition(240, 240);
  const scaleX = (second.x - first.x) / 180;
  const scaleY = (second.y - first.y) / 180;
  if (!(scaleX > 0) || !(scaleY > 0)) {
    throw new Error(`Pointer calibration failed: scale ${scaleX} × ${scaleY}.`);
  }
  const offsetX = first.x - 60 * scaleX;
  const offsetY = first.y - 60 * scaleY;
  return (clientX, clientY) => ({
    x: (clientX - offsetX) / scaleX,
    y: (clientY - offsetY) / scaleY,
  });
}

/**
 * Defensive per-test reset: reverts any touch emulation left by an earlier
 * test or file and waits until `(pointer: coarse)` no longer matches. Note
 * that disabling touch emulation restores the PLATFORM capabilities: Linux
 * headless CI has no input devices and then reports `pointer: none` and
 * `hover: none`, so callers must not assume a hover-capable pointer here —
 * gate hover-media-dependent assertions on `(hover: hover)` instead.
 */
export async function resetPointerEmulation(): Promise<void> {
  // Only revert an actual coarse leak: the disable itself recomputes the
  // capabilities from the platform, which would needlessly downgrade pristine
  // pages on device-less CI runners.
  if (!window.matchMedia("(pointer: coarse)").matches) {
    return;
  }
  await setCoarsePointerEmulation(false);
  const deadline = Date.now() + 10_000;
  while (window.matchMedia("(pointer: coarse)").matches) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the coarse-pointer emulation to revert.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
