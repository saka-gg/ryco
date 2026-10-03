import { useEffect, type RefObject } from "react";

import { readMotionDurationMs } from "../../../lib/perf/motion";

/**
 * Focus a field once the disclosure revealing it has finished opening, so the
 * caret never lands in a box that is still growing (and the page never scrolls
 * to a half-open target). Listens for the shell's `grid-template-rows`
 * transition (or its grow-in animation) with a timeout fallback; under reduced
 * motion the tokens are zero and focus is immediate.
 */
export function useFocusAfterReveal(input: {
  readonly open: boolean;
  readonly shellRef: RefObject<HTMLElement | null>;
  readonly targetRef: RefObject<HTMLElement | null>;
}): void {
  const { open, shellRef, targetRef } = input;
  useEffect(() => {
    if (!open) return;
    const focus = () => {
      const target = targetRef.current;
      if (!target || target.contains(document.activeElement)) return;
      target.focus({ preventScroll: true });
    };
    const duration = readMotionDurationMs("--app-motion-duration-stack", 260);
    if (duration === 0) {
      focus();
      return;
    }
    const shell = shellRef.current;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      focus();
    };
    const onEnd = (event: Event) => {
      if (event.target !== shell) return;
      if (event instanceof TransitionEvent && event.propertyName !== "grid-template-rows") return;
      finish();
    };
    shell?.addEventListener("transitionend", onEnd);
    shell?.addEventListener("animationend", onEnd);
    const timer = window.setTimeout(finish, duration + 80);
    return () => {
      shell?.removeEventListener("transitionend", onEnd);
      shell?.removeEventListener("animationend", onEnd);
      window.clearTimeout(timer);
    };
  }, [open, shellRef, targetRef]);
}
