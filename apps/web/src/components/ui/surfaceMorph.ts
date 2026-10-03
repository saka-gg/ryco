// FILE: surfaceMorph.ts
// Purpose: Container-transform entrance and exit for base-ui popups (dialogs,
//          alert dialogs, popovers). A popup grows out of the control that
//          opened it and, as it closes, folds into wherever its result now
//          lives (or back into that control when dismissed).
// Layer: Web UI motion primitive, consumed by `ui/dialog.tsx`,
//        `ui/alert-dialog.tsx` and `ui/popover.tsx` through their `morph` prop.
// Why: base-ui keeps a closing popup mounted until every animation on it has
//      finished (it re-reads `getAnimations()` one frame after setting
//      `data-ending-style`). Owning the popup's opacity with one Web Animation
//      for the whole fold therefore keeps the popup — and the ghost's host —
//      mounted exactly as long as the fold needs, with no timers racing the
//      unmount.

import { type Ref, useCallback, useEffect } from "react";

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

export interface SurfaceMorph {
  /**
   * The control the popup grows out of. Read on mount. Omitted, it is the
   * control the user activated just before the popup opened (see
   * `recentActivation`); with none, the popup simply fades in.
   */
  readonly origin?: () => HTMLElement | null;
  /**
   * Where the popup folds into as it closes. Read once the content has faded,
   * so a result that renders in that window — a just-saved item — can be the
   * landing spot. Receives the resolved origin so callers can fall back to
   * it; `null` dissolves in place. Omitted, the popup folds back into its
   * origin, or — when the origin was a menu item whose menu has since closed
   * — into that menu's trigger.
   */
  readonly target?: (origin: HTMLElement | null) => HTMLElement | null;
}

/**
 * A primitive's `morph` prop: anchors (either may be omitted), `"auto"` (no
 * anchors: grow out of whatever was just activated, fold back into it), or
 * `false` to keep the primitive's plain fade.
 */
export type SurfaceMorphProp = SurfaceMorph | "auto" | false;

/** The anchors `attachSurfaceMorph` works with, resolved by the hook. */
export interface ResolvedSurfaceMorph {
  readonly origin: () => HTMLElement | null;
  readonly target?: () => HTMLElement | null;
}

export interface MorphProfile {
  readonly grow: MotionCurve;
  readonly fold: MotionCurve;
  readonly contentFadeOutMs: number;
  readonly contentFadeInMs: number;
  readonly contentRiseMs: number;
  readonly contentRisePx: number;
  readonly staggerMs: number;
  /** Content starts to appear once the ghost has covered this much of its travel. */
  readonly revealAt: number;
  /** The ghost hands off to the landing control over the last stretch of the fold. */
  readonly foldFadeFrom: number;
  /** Hide the origin while open: the control *became* the popup. */
  readonly hideOrigin: boolean;
  /** A short scale pulse on the landing control as the ghost arrives. */
  readonly pulseLanding: boolean;
}

/** Dialogs: a damped spring (ζ≈0.9) — a hair of settle, no visible bounce. */
export const DIALOG_MORPH_PROFILE: MorphProfile = {
  grow: springCurve({ stiffness: 300, damping: 31 }),
  fold: { easing: "cubic-bezier(0.16, 1, 0.3, 1)", durationMs: 340 },
  contentFadeOutMs: 90,
  contentFadeInMs: 160,
  contentRiseMs: 260,
  contentRisePx: 6,
  staggerMs: 36,
  revealAt: 0.4,
  foldFadeFrom: 0.6,
  hideOrigin: true,
  pulseLanding: true,
};

/**
 * Popovers open on every other click, so they move faster and stay modest:
 * the trigger stays visible (it labels what the popover changes) and the
 * landing takes no pulse.
 */
export const POPOVER_MORPH_PROFILE: MorphProfile = {
  grow: springCurve({ stiffness: 460, damping: 40 }),
  fold: { easing: "cubic-bezier(0.16, 1, 0.3, 1)", durationMs: 240 },
  contentFadeOutMs: 70,
  contentFadeInMs: 120,
  contentRiseMs: 200,
  contentRisePx: 4,
  staggerMs: 24,
  revealAt: 0.32,
  foldFadeFrom: 0.5,
  hideOrigin: false,
  pulseLanding: false,
};

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/**
 * Set on the surface while a ghost carries it: the surface then paints only
 * its content (see `index.css`). Without it the two translucent plates,
 * frosts and shadows stack while they overlap, and the popup visibly turns
 * see-through the moment the ghost is removed.
 */
export const SURFACE_HANDOFF_ATTRIBUTE = "data-surface-morphing";

/** Marks the element that paints a popup's visible surface when it is not the popup itself. */
export const MORPH_SURFACE_ATTRIBUTE = "data-morph-surface";

/**
 * Pins a morphing dialog's own scale/translate entrance and exit: the ghost
 * carries the geometry. Opacity is left to the morph's Web Animations, which
 * outrank the CSS transition. The phone tier keeps its bottom-sheet motion.
 */
export const DIALOG_MORPH_POPUP_CLASS_NAME =
  "not-phone:data-starting-style:translate-y-0! not-phone:data-starting-style:scale-100! not-phone:data-ending-style:translate-y-0! not-phone:data-ending-style:scale-100!";

/** The popover equivalent: base-ui popovers enter by scale only. */
export const POPOVER_MORPH_POPUP_CLASS_NAME =
  "not-phone:data-starting-style:scale-100! not-phone:data-ending-style:scale-100!";

function isMorphSuppressed(): boolean {
  return (
    isReducedMotionEffective() ||
    getPresentationTier() === "phone" ||
    typeof HTMLElement.prototype.animate !== "function"
  );
}

/* ───────── Auto origin: the control the user just activated ───────── */

const AUTO_ORIGIN_WINDOW_MS = 1200;
/**
 * A right-click usually opens a context menu — native in the desktop app,
 * where picking an item fires no DOM event at all — so the row it targeted
 * stays the origin for as long as a person plausibly spends in that menu.
 */
const CONTEXT_MENU_ORIGIN_WINDOW_MS = 15_000;
const ACTIVATABLE =
  'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"], summary';
interface Activation {
  readonly element: HTMLElement;
  /** The trigger of the menu `element` sits in: menus close as dialogs open. */
  readonly menuTrigger: HTMLElement | null;
  readonly at: number;
  readonly windowMs: number;
}
let lastActivation: Activation | null = null;
let activationTrackingInstalled = false;

/**
 * The button that opened the menu `control` belongs to. base-ui wires the
 * trigger's `aria-controls` to the menu popup's id; read it while the menu is
 * still open, because both go away as it closes.
 */
function menuTriggerFor(control: HTMLElement): HTMLElement | null {
  const menu = control.closest<HTMLElement>('[role="menu"]');
  if (!menu?.id) return null;
  return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`);
}

function recordActivation(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>(ACTIVATABLE);
  if (!control) return;
  if (event.type === "contextmenu") {
    lastActivation = {
      element: control,
      menuTrigger: null,
      at: performance.now(),
      windowMs: CONTEXT_MENU_ORIGIN_WINDOW_MS,
    };
    return;
  }
  // An item in a DOM context menu has no trigger button; the row that was
  // right-clicked to open that menu is where its dialog should fold back.
  const previous = lastActivation;
  const menuTrigger =
    menuTriggerFor(control) ??
    (control.closest('[role="menu"]') && previous?.windowMs === CONTEXT_MENU_ORIGIN_WINDOW_MS
      ? previous.element
      : null);
  lastActivation = {
    element: control,
    menuTrigger,
    at: performance.now(),
    windowMs: AUTO_ORIGIN_WINDOW_MS,
  };
}

/** Idempotent; installed by the first primitive that may need an automatic origin. */
export function installActivationTracking(): void {
  if (activationTrackingInstalled || typeof document === "undefined") return;
  activationTrackingInstalled = true;
  document.addEventListener("pointerdown", recordActivation, true);
  document.addEventListener("contextmenu", recordActivation, true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") recordActivation(event);
    },
    true,
  );
}

/** The control activated within the last moment, if it is still on screen. */
export function recentActivation(): Activation | null {
  if (!lastActivation) return null;
  if (performance.now() - lastActivation.at > lastActivation.windowMs) return null;
  return isMorphable(lastActivation.element) ? lastActivation : null;
}

/* ───────── The morph ───────── */

export interface AttachSurfaceMorphOptions {
  readonly profile: MorphProfile;
  /** The element painting the visible surface; defaults to the popup. */
  readonly surface?: HTMLElement;
  /**
   * Where the ghost lives. It paints beneath `before` (DOM order) at
   * `zIndex`; defaults to the popup's parent, just before the popup.
   */
  readonly ghostHost?: { parent: Element; before: Node | null; zIndex?: string };
  /**
   * Start the grow on the next frame instead of now. Popovers need it: their
   * positioner is placed asynchronously after mount, and base-ui's starting
   * style keeps the popup invisible for that first frame.
   */
  readonly deferToNextFrame?: boolean;
}

/** Runs the grow now and arms the fold for when base-ui starts the close. */
export function attachSurfaceMorph(
  popup: HTMLElement,
  morph: ResolvedSurfaceMorph,
  options: AttachSurfaceMorphOptions,
): () => void {
  const host: { parent: Element | null; before: Node | null; zIndex?: string } =
    options.ghostHost ?? { parent: popup.parentElement, before: popup };
  if (!host.parent || isMorphSuppressed()) return () => {};
  const hostParent = host.parent;
  const profile = options.profile;
  const surface = options.surface ?? popup;

  const surfaceRadius = cornerRadiusOf(surface, 12);
  // Snapshotted before the surface hands its painting to a ghost.
  const surfacePaint = readSurfacePaint(surface);
  const origin = morph.origin();
  const content: Animation[] = [];
  let originHidden: Animation | null = null;
  let grow: GhostTravel | null = null;
  let growGhost: HTMLElement | null = null;
  let foldTimer: number | null = null;
  let pendingFrame: number | null = null;
  let folding = false;

  const spawnGhost = (rect: DOMRectReadOnly | ReturnType<typeof toSurfaceRect>, radius: number) =>
    createSurfaceGhost({
      paint: surfacePaint,
      rect,
      radius,
      parent: hostParent,
      before: host.before,
      ...(host.zIndex ? { zIndex: host.zIndex } : {}),
    });

  const beginGrow = () => {
    pendingFrame = null;
    const end = surface.getBoundingClientRect();
    if (isMorphable(origin) && end.width > 0) {
      const start = origin.getBoundingClientRect();
      const originRadius = cornerRadiusOf(origin, 8);
      const ghost = spawnGhost(start, originRadius);
      surface.setAttribute(SURFACE_HANDOFF_ATTRIBUTE, "");
      growGhost = ghost;
      grow = travelGhost(ghost, {
        from: toSurfaceRect(start),
        to: toSurfaceRect(end),
        fromRadius: originRadius,
        toRadius: surfaceRadius,
        curve: profile.grow,
      });
      void grow.finished.then(() => {
        if (growGhost !== ghost) return;
        // Same task, same frame: the surface takes its painting back exactly
        // where the ghost stands, so nothing visibly changes.
        surface.removeAttribute(SURFACE_HANDOFF_ATTRIBUTE);
        ghost.remove();
        growGhost = null;
      });
      if (profile.hideOrigin) {
        originHidden = origin.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: profile.contentFadeOutMs,
          fill: "forwards",
        });
      }
      const revealAt = profile.grow.durationMs * profile.revealAt;
      content.push(
        popup.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: profile.contentFadeInMs,
          delay: revealAt,
          easing: "linear",
          fill: "backwards",
        }),
      );
      Array.from(surface.children).forEach((child, index) => {
        content.push(
          child.animate(
            [
              { opacity: 0, transform: `translateY(${profile.contentRisePx}px)` },
              { opacity: 1, transform: "none" },
            ],
            {
              duration: profile.contentRiseMs,
              delay: revealAt + index * profile.staggerMs,
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
  };
  if (options.deferToNextFrame) pendingFrame = window.requestAnimationFrame(beginGrow);
  else beginGrow();

  /** Brings a hidden origin back in as the ghost lands, instead of popping it. */
  const revealOrigin = (delayMs: number) => {
    if (!originHidden) return;
    originHidden.cancel();
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
   * live attach's hand-off attribute from the shared surface.
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
    if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
    stopGrow();
    for (const animation of content) animation.cancel();

    const from = toSurfaceRect(surface.getBoundingClientRect());
    if (from.width === 0) {
      revealOrigin(0);
      return;
    }
    const total = profile.contentFadeOutMs + profile.fold.durationMs;
    // One animation owns the popup's opacity for the whole fold, which is
    // what keeps base-ui from unmounting it until the ghost has landed.
    popup.animate(
      [{ opacity: 1 }, { opacity: 0, offset: profile.contentFadeOutMs / total }, { opacity: 0 }],
      { duration: total, fill: "forwards" },
    );
    const ghost = spawnGhost(from, surfaceRadius);
    // The ghost takes the surface over at once; only the content fades.
    surface.setAttribute(SURFACE_HANDOFF_ATTRIBUTE, "");
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
        curve: profile.fold,
        fadeOutFrom: profile.foldFadeFrom,
      }).finished.then(() => ghost.remove());
      revealOrigin(profile.fold.durationMs * profile.foldFadeFrom);
      if (profile.pulseLanding) {
        landing.animate(
          [{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }],
          { duration: 260, delay: profile.fold.durationMs * 0.78, easing: EASE_OUT },
        );
      }
    }, profile.contentFadeOutMs);
  };

  const observer = new MutationObserver(() => {
    if (popup.hasAttribute("data-ending-style")) fold();
  });
  observer.observe(popup, { attributes: true, attributeFilter: ["data-ending-style"] });

  return () => {
    observer.disconnect();
    if (foldTimer !== null) window.clearTimeout(foldTimer);
    if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    stopGrow();
    // Detached before any close (a remount, or dev StrictMode's double
    // attach): undo the entrance so a re-attach starts from a clean popup.
    if (!folding) {
      surface.removeAttribute(SURFACE_HANDOFF_ATTRIBUTE);
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
 * The popup ref for a primitive that may morph. Without `morph` it only
 * forwards the ref, so the popup keeps its regular scale/fade motion.
 * `resolveHost` lets a primitive place the ghost and name the surface
 * element once the popup is mounted (popovers render inside a positioner).
 */
export function useSurfaceMorphRef(
  morph: SurfaceMorphProp | undefined,
  forwardedRef: Ref<HTMLDivElement> | undefined,
  config: {
    readonly profile: MorphProfile;
    readonly resolveHost?: (popup: HTMLElement) => Omit<AttachSurfaceMorphOptions, "profile">;
  },
): (node: HTMLDivElement | null) => () => void {
  const spec: SurfaceMorph | null =
    morph === undefined || morph === false ? null : morph === "auto" ? {} : morph;
  const enabled = spec !== null;
  const tracksActivation = spec !== null && spec.origin === undefined;
  useEffect(() => {
    if (tracksActivation) installActivationTracking();
  }, [tracksActivation]);
  // Read once per mount: the activation record moves on with the next click,
  // and the fold must return to the control this popup grew from.
  const resolveAnchors = useEvent(() => {
    if (spec?.origin) return { origin: spec.origin(), menuTrigger: null };
    const activation = recentActivation();
    return { origin: activation?.element ?? null, menuTrigger: activation?.menuTrigger ?? null };
  });
  const resolveTarget = useEvent(
    (origin: HTMLElement | null, menuTrigger: HTMLElement | null): HTMLElement | null => {
      if (spec?.target) return spec.target(origin);
      return origin?.isConnected ? origin : menuTrigger;
    },
  );
  const resolveHost = useEvent((popup: HTMLElement) => config.resolveHost?.(popup) ?? {});
  const profile = config.profile;
  return useCallback(
    (node: HTMLDivElement | null) => {
      assignRef(forwardedRef, node);
      let detach = () => {};
      if (node && enabled) {
        const { origin, menuTrigger } = resolveAnchors();
        detach = attachSurfaceMorph(
          node,
          { origin: () => origin, target: () => resolveTarget(origin, menuTrigger) },
          { profile, ...resolveHost(node) },
        );
      }
      return () => {
        detach();
        assignRef(forwardedRef, null);
      };
    },
    [enabled, forwardedRef, profile, resolveAnchors, resolveHost, resolveTarget],
  );
}
