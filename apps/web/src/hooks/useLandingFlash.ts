import { useCallback, useEffect, useState } from "react";

import { readMotionDurationMs } from "../lib/perf/motion";

/**
 * The deep-link landing highlight, shared by every surface a link can land
 * on (a Checks job, a commit, an Agents workflow): bring the target into view,
 * then flash it once. Styles are the `landing-flash` classes in `index.css`.
 */

export type LandingFlashMode = "motion" | "static";

export interface LandingFlash {
  readonly key: string;
  readonly mode: LandingFlashMode;
  /** Bumps on every trigger, so landing on the same target again re-flashes. */
  readonly token: number;
}

const LANDING_FLASH_MS = 1600;

/**
 * Class for an element that is the target of a deep link. Successive triggers
 * alternate the keyframes (`landing-flash-replay`), so landing on a target
 * that is still flashing restarts the pass instead of leaving it be.
 */
export function landingFlashClass(flash: LandingFlash | null, key: string): string | undefined {
  if (flash?.key !== key) return undefined;
  if (flash.mode === "static") return "landing-flash-static";
  return flash.token % 2 === 0 ? "landing-flash landing-flash-replay" : "landing-flash";
}

/**
 * One `overview-jump-flash` pass, or a static ring for the same time when
 * motion is reduced. The flash clears itself after 1.6s.
 */
export function useLandingFlash() {
  const [flash, setFlash] = useState<LandingFlash | null>(null);
  useEffect(() => {
    if (flash === null) return;
    const timer = window.setTimeout(() => setFlash(null), LANDING_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const trigger = useCallback((key: string) => {
    const mode: LandingFlashMode =
      readMotionDurationMs("--app-motion-duration-pop", 200) === 0 ? "static" : "motion";
    setFlash((current) => ({ key, mode, token: (current?.token ?? 0) + 1 }));
  }, []);
  return { flash, trigger };
}

/** Scrolls an element to the top of its pane, smoothly unless motion is reduced. */
export function scrollRowIntoView(element: HTMLElement) {
  const smooth = readMotionDurationMs("--app-motion-duration-pane", 360) > 0;
  element.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
}
