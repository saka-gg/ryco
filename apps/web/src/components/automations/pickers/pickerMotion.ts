import { isReducedMotionEffective } from "~/themes/appearancePreferences";

const EASE_TOKEN = "--app-motion-ease";
/** The token's value before appearance preferences apply (index.css declares it too). */
const EASE_FALLBACK = "cubic-bezier(0.16, 1, 0.3, 1)";

/**
 * The pickers' curve: the house ease token (fast out, long settle), so the
 * pickers move like every other surface. Read it once per animation batch.
 */
export function pickerEase(): string {
  if (typeof document === "undefined") return EASE_FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue(EASE_TOKEN).trim();
  return value || EASE_FALLBACK;
}

/** Whether parts may move (slides, rises). Short opacity fades run regardless. */
export function pickerMotionOn(): boolean {
  return !isReducedMotionEffective();
}

/** An opacity-only fade: these survive reduced motion (they stay ≤ 120 ms). */
export function fadeOpacity(element: Element, from: number, to: number, durationMs = 100) {
  return element.animate([{ opacity: from }, { opacity: to }], {
    duration: durationMs,
    fill: "forwards",
  });
}

/** Runs `done` once an animation ends, whether it finished or was cancelled. */
export function onAnimationSettled(animation: Animation, done: () => void): void {
  animation.finished.then(done, done);
}
