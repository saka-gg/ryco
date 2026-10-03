// FILE: dialogMorph.ts
// Purpose: Container-transform entrance and exit for base-ui dialog popups.
//          The dialog grows out of the control that opened it and, as it
//          closes, folds into wherever its result now lives (or back into
//          that control when dismissed).
// Layer: Web UI motion primitive, consumed by `ui/dialog.tsx` and
//        `ui/alert-dialog.tsx` through their `morph` prop.
// Why: base-ui keeps a closing popup mounted until every animation on it has
//      finished (it re-reads `getAnimations()` one frame after setting
//      `data-ending-style`). Owning the popup's opacity with one Web Animation
//      for the whole fold therefore keeps the popup — and the viewport the
//      ghost lives in — mounted exactly as long as the fold needs, with no
//      timers racing the unmount.

import { type Ref, useCallback } from "react";

import {
  type GhostTravel,
  type MotionCurve,
  cornerRadiusOf,
  createSurfaceGhost,
  isMorphable,
  readSurfacePaint,
  springCurve,
  toSurfaceRect,
  travelGhost,
} from "~/lib/containerTransform";
import { getPresentationTier } from "~/lib/presentationTier";
import { useEvent } from "~/hooks/useEvent";
import { isReducedMotionEffective } from "~/themes/appearancePreferences";

export interface DialogMorph {
  /** The control the dialog grows out of; hidden while the dialog is open. Read on mount. */
  readonly origin: () => HTMLElement | null;
  /**
   * Where the dialog folds into as it closes; defaults to `origin`. Read once
   * the content has faded, so a result that renders in that window — a
   * just-saved item — can be the landing spot. `null` dissolves in place.
   */
  readonly target?: () => HTMLElement | null;
}

/** The grow: a damped spring (ζ≈0.9) — a hair of settle, no visible bounce. */
const GROW_CURVE = springCurve({ stiffness: 300, damping: 31 });
/** The fold is decisive: the house ease-out, no spring tail. */
const FOLD_CURVE: MotionCurve = { easing: "cubic-bezier(0.16, 1, 0.3, 1)", durationMs: 340 };
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const CONTENT_FADE_OUT_MS = 90;
const CONTENT_FADE_IN_MS = 160;
const CONTENT_RISE_MS = 260;
const CONTENT_STAGGER_MS = 36;
/** Content starts to appear once the ghost has covered most of its travel. */
const CONTENT_REVEAL_AT = 0.4;
/** The ghost hands off to the landing control over the last stretch of the fold. */
const FOLD_FADE_FROM = 0.6;
/**
 * Set on the popup while a ghost carries its surface: the popup then paints
 * only its content (see `index.css`). Without it the two translucent plates,
 * frosts and shadows stack while they overlap, and the dialog visibly turns
 * see-through the moment the ghost is removed.
 */
const SURFACE_HANDOFF_ATTRIBUTE = "data-dialog-morphing";

/**
 * Pins a morphing popup's own scale/translate entrance and exit: the ghost
 * carries the geometry. Opacity is left to the morph's Web Animations, which
 * outrank the CSS transition. The phone tier keeps its bottom-sheet motion.
 */
export const DIALOG_MORPH_POPUP_CLASS_NAME =
  "not-phone:data-starting-style:translate-y-0! not-phone:data-starting-style:scale-100! not-phone:data-ending-style:translate-y-0! not-phone:data-ending-style:scale-100!";

function isMorphSuppressed(): boolean {
  return (
    isReducedMotionEffective() ||
    getPresentationTier() === "phone" ||
    typeof HTMLElement.prototype.animate !== "function"
  );
}

/** Runs the grow now and arms the fold for when base-ui starts the close. */
export function attachDialogMorph(popup: HTMLElement, morph: DialogMorph): () => void {
  const viewport = popup.parentElement;
  if (!viewport || isMorphSuppressed()) return () => {};

  const surfaceRadius = cornerRadiusOf(popup, 16);
  // Snapshotted before the popup hands its painting to a ghost.
  const surfacePaint = readSurfacePaint(popup);
  const origin = morph.origin();
  const content: Animation[] = [];
  let originHidden: Animation | null = null;
  let grow: GhostTravel | null = null;
  let growGhost: HTMLElement | null = null;
  let foldTimer: number | null = null;
  let folding = false;

  const end = popup.getBoundingClientRect();
  if (isMorphable(origin) && end.width > 0) {
    const start = origin.getBoundingClientRect();
    const originRadius = cornerRadiusOf(origin, 8);
    const ghost = createSurfaceGhost({
      paint: surfacePaint,
      rect: start,
      radius: originRadius,
      parent: viewport,
      before: popup,
    });
    popup.setAttribute(SURFACE_HANDOFF_ATTRIBUTE, "");
    growGhost = ghost;
    grow = travelGhost(ghost, {
      from: toSurfaceRect(start),
      to: toSurfaceRect(end),
      fromRadius: originRadius,
      toRadius: surfaceRadius,
      curve: GROW_CURVE,
    });
    void grow.finished.then(() => {
      if (growGhost !== ghost) return;
      // Same task, same frame: the popup takes its surface back exactly
      // where the ghost stands, so nothing visibly changes.
      popup.removeAttribute(SURFACE_HANDOFF_ATTRIBUTE);
      ghost.remove();
      growGhost = null;
    });
    originHidden = origin.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: CONTENT_FADE_OUT_MS,
      fill: "forwards",
    });
    const revealAt = GROW_CURVE.durationMs * CONTENT_REVEAL_AT;
    content.push(
      popup.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: CONTENT_FADE_IN_MS,
        delay: revealAt,
        easing: "linear",
        fill: "backwards",
      }),
    );
    Array.from(popup.children).forEach((child, index) => {
      content.push(
        child.animate(
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: CONTENT_RISE_MS,
            delay: revealAt + index * CONTENT_STAGGER_MS,
            easing: EASE_OUT,
            fill: "backwards",
          },
        ),
      );
    });
  } else {
    content.push(
      popup.animate(
        [
          { opacity: 0, transform: "scale(0.97)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 200, easing: EASE_OUT, fill: "backwards" },
      ),
    );
  }

  /** Brings the origin back in as the ghost lands, instead of popping it. */
  const revealOrigin = (delayMs: number) => {
    originHidden?.cancel();
    originHidden = null;
    if (!origin?.isConnected) return;
    origin.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 160,
      delay: delayMs,
      fill: "backwards",
    });
  };

  /**
   * Stops the grow. The ghost is forgotten before the cancel so the grow's
   * completion handler (which runs on cancel too) cannot hand the surface
   * back — under StrictMode's double attach it would otherwise strip the
   * live attach's hand-off attribute from the shared popup.
   */
  const stopGrow = () => {
    const ghost = growGhost;
    growGhost = null;
    grow?.cancel();
    ghost?.remove();
  };

  const fold = () => {
    if (folding) return;
    folding = true;
    stopGrow();
    for (const animation of content) animation.cancel();

    const from = toSurfaceRect(popup.getBoundingClientRect());
    if (from.width === 0) {
      revealOrigin(0);
      return;
    }
    const total = CONTENT_FADE_OUT_MS + FOLD_CURVE.durationMs;
    // One animation owns the popup's opacity for the whole fold, which is
    // what keeps base-ui from unmounting it until the ghost has landed.
    popup.animate(
      [{ opacity: 1 }, { opacity: 0, offset: CONTENT_FADE_OUT_MS / total }, { opacity: 0 }],
      { duration: total, fill: "forwards" },
    );
    const ghost = createSurfaceGhost({
      paint: surfacePaint,
      rect: from,
      radius: surfaceRadius,
      parent: viewport,
      before: popup,
    });
    // The ghost takes the surface over at once; only the content fades.
    popup.setAttribute(SURFACE_HANDOFF_ATTRIBUTE, "");
    foldTimer = window.setTimeout(() => {
      foldTimer = null;
      const resolved = morph.target ? morph.target() : origin;
      const landing = isMorphable(resolved) ? resolved : null;
      if (!landing) {
        ghost.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "scale(0.98)" },
          ],
          { duration: 180, easing: EASE_OUT, fill: "forwards" },
        );
        revealOrigin(0);
        return;
      }
      travelGhost(ghost, {
        from,
        to: toSurfaceRect(landing.getBoundingClientRect()),
        fromRadius: surfaceRadius,
        toRadius: cornerRadiusOf(landing, 8),
        curve: FOLD_CURVE,
        fadeOutFrom: FOLD_FADE_FROM,
      });
      revealOrigin(FOLD_CURVE.durationMs * FOLD_FADE_FROM);
      // The landing control takes the hit: a short receive pulse.
      landing.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }],
        { duration: 260, delay: FOLD_CURVE.durationMs * 0.78, easing: EASE_OUT },
      );
    }, CONTENT_FADE_OUT_MS);
  };

  const observer = new MutationObserver(() => {
    if (popup.hasAttribute("data-ending-style")) fold();
  });
  observer.observe(popup, { attributes: true, attributeFilter: ["data-ending-style"] });

  return () => {
    observer.disconnect();
    if (foldTimer !== null) window.clearTimeout(foldTimer);
    stopGrow();
    // Detached before any close (a remount, or dev StrictMode's double
    // attach): undo the entrance so a re-attach starts from a clean popup.
    if (!folding) {
      popup.removeAttribute(SURFACE_HANDOFF_ATTRIBUTE);
      originHidden?.cancel();
      for (const animation of content) animation.cancel();
    }
  };
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * The popup ref for a dialog that may morph. Without `morph` it only forwards
 * the ref, so the dialog keeps its regular scale/fade motion.
 */
export function useDialogMorphRef(
  morph: DialogMorph | undefined,
  forwardedRef: Ref<HTMLDivElement> | undefined,
): (node: HTMLDivElement | null) => () => void {
  const enabled = morph !== undefined;
  const resolveOrigin = useEvent(() => morph?.origin() ?? null);
  const resolveTarget = useEvent(() => (morph?.target ?? morph?.origin)?.() ?? null);
  return useCallback(
    (node: HTMLDivElement | null) => {
      assignRef(forwardedRef, node);
      const detach =
        node && enabled
          ? attachDialogMorph(node, { origin: resolveOrigin, target: resolveTarget })
          : () => {};
      return () => {
        detach();
        assignRef(forwardedRef, null);
      };
    },
    [enabled, forwardedRef, resolveOrigin, resolveTarget],
  );
}
