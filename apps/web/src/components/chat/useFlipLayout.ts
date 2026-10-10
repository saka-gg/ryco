import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

import { isReducedMotionEffective } from "~/themes/appearancePreferences";

const FLIP_DURATION_MS = 300;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * FLIP for a row of inline items (`[data-flip-id]` descendants of `ref`): when
 * `trigger` changes, every item that existed before glides from its old
 * position to its new one and every new item rises in, so a re-flowed line
 * moves as one motion instead of jumping and then easing piecemeal.
 *
 * Resting positions are recorded after each commit and whenever an item or the
 * row resizes (a child that loads a label, a window resize), so the "before"
 * frame is current even when the change comes from outside this component. An
 * item caught mid-glide starts the next glide from where it is on screen.
 */
export function useFlipLayout(ref: RefObject<HTMLElement | null>, trigger: unknown): void {
  const restingRef = useRef<Map<string, DOMRect>>(new Map());
  const triggerRef = useRef(trigger);

  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const items = flipItems(container);
    const changed = !Object.is(triggerRef.current, trigger);
    triggerRef.current = trigger;
    if (!changed) {
      recordResting(items, restingRef.current);
      return;
    }

    const before = new Map<string, DOMRect>();
    for (const item of items) {
      const id = item.dataset.flipId!;
      const animations = item.getAnimations();
      const rect =
        animations.length > 0 ? item.getBoundingClientRect() : restingRef.current.get(id);
      if (rect) before.set(id, rect);
      for (const animation of animations) animation.cancel();
    }
    const hadSnapshot = restingRef.current.size > 0;
    restingRef.current = new Map();
    recordResting(items, restingRef.current);
    if (!hadSnapshot || isReducedMotionEffective()) return;

    for (const item of items) {
      const id = item.dataset.flipId!;
      const from = before.get(id);
      const to = restingRef.current.get(id)!;
      if (!from) {
        item.animate(
          [
            { opacity: 0, transform: "translateY(40%)", filter: "blur(3px)" },
            { opacity: 1, transform: "none", filter: "blur(0)" },
          ],
          { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
        );
        continue;
      }
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: FLIP_DURATION_MS,
        easing: FLIP_EASING,
      });
    }
  });

  // Keeps the resting positions current between commits.
  useEffect(() => {
    const container = ref.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      recordResting(flipItems(container), restingRef.current);
    });
    observer.observe(container);
    for (const item of flipItems(container)) observer.observe(item);
    return () => observer.disconnect();
  });
}

function flipItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-flip-id]"));
}

/**
 * Records where idle items rest. An item that is still gliding keeps its last
 * resting entry, since its on-screen box includes the glide's transform.
 */
function recordResting(items: ReadonlyArray<HTMLElement>, into: Map<string, DOMRect>): void {
  const present = new Set<string>();
  for (const item of items) {
    const id = item.dataset.flipId!;
    present.add(id);
    if (item.getAnimations().length === 0 || !into.has(id)) {
      into.set(id, item.getBoundingClientRect());
    }
  }
  for (const id of into.keys()) if (!present.has(id)) into.delete(id);
}
