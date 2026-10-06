/**
 * The Automations dialog's motion, ported from the lab's direction C: detail
 * panes cross-fade (old and new overlap, both absolute), content settles in,
 * and in-dialog plates (new → editor header, save → row) travel as WAAPI
 * ghosts. Text never scales; only surfaces travel.
 *
 * Reduced motion keeps every state change visible with crossfades of 120 ms
 * or less.
 */
import { isReducedMotionEffective } from "../../../themes/appearancePreferences";

export const DIALOG_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Full motion: not reduced, and the platform animates. */
export function dialogMotionOn(): boolean {
  return (
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.animate === "function" &&
    !isReducedMotionEffective()
  );
}

function canAnimate(): boolean {
  return typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.animate === "function";
}

/** Rise-and-fade a few elements in, staggered (the lab's `settle`). No-op without motion. */
export function settle(
  nodes: readonly Element[],
  options: {
    readonly y?: number;
    readonly duration?: number;
    readonly delay?: number;
    readonly stagger?: number;
  } = {},
): void {
  if (!dialogMotionOn()) return;
  nodes.forEach((node, index) => {
    node.animate(
      [
        { opacity: 0, translate: `0 ${options.y ?? 6}px` },
        { opacity: 1, translate: "0 0" },
      ],
      {
        duration: options.duration ?? 320,
        delay: (options.delay ?? 0) + index * (options.stagger ?? 0),
        easing: DIALOG_EASE,
        fill: "backwards",
      },
    );
  });
}

/**
 * How the next detail pane arrives:
 * - `none` — swapped in place (arrow keys, data changes);
 * - `fade` — a click: the old pane fades, the new one settles;
 * - `to-editor` — the old pane fades quickly; the editor brings its own entrance;
 * - `from-editor` — the editor fades, the detail rises back in under its heading.
 */
export type PaneTransition = "none" | "fade" | "to-editor" | "from-editor";

/** Animates a pane that just mounted. */
export function animatePaneIn(pane: HTMLElement, how: PaneTransition): void {
  if (!canAnimate() || how === "none") return;
  const motion = dialogMotionOn();
  if (how === "fade") {
    if (motion)
      settle(Array.from(pane.children).slice(0, 6), {
        y: 4,
        duration: 260,
        stagger: 22,
        delay: 40,
      });
    else pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 110 });
    return;
  }
  if (how === "from-editor") {
    if (!motion) {
      pane.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      return;
    }
    Array.from(pane.children)
      .slice(0, 7)
      .forEach((child, index) => {
        // The heading stays where the editor's title was; only its actions fade in.
        if (child.matches(".ad-dh")) {
          child.querySelector(".ad-dh-x")?.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 160,
            delay: 60,
            fill: "backwards",
          });
          return;
        }
        child.animate(
          [
            { opacity: 0, translate: "0 4px" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 240, delay: 100 + index * 24, easing: DIALOG_EASE, fill: "backwards" },
        );
      });
  }
}

/**
 * Keeps a pane React just removed on screen while it fades out under its
 * successor (the lab's overlapping cross-fade). Call from the pane's ref
 * cleanup: it waits a microtask, and only a pane that really left the
 * document (not a StrictMode re-attach) is put back, inert, behind the new
 * one. Its subtree is intact, since React detaches only the pane itself.
 */
export function retirePane(pane: HTMLElement, how: PaneTransition): void {
  const parent = pane.parentElement;
  const scrollTop = pane.scrollTop;
  if (!parent || !canAnimate() || how === "none") return;
  const motion = dialogMotionOn();
  const duration =
    how === "from-editor" ? (motion ? 120 : 100) : motion ? (how === "to-editor" ? 90 : 110) : 0;
  if (duration === 0) return;
  queueMicrotask(() => {
    // Still attached: a StrictMode re-attach. Parent gone: the dialog closed.
    if (pane.isConnected || !parent.isConnected) return;
    pane.inert = true;
    pane.classList.add("is-leaving");
    parent.insertBefore(pane, parent.firstChild);
    pane.scrollTop = scrollTop;
    pane.animate([{ opacity: 1 }, { opacity: 0 }], { duration, fill: "forwards" }).finished.then(
      () => pane.remove(),
      () => pane.remove(),
    );
  });
}

// ── Plates ───────────────────────────────────────────────────────────

export interface PlatePaint {
  readonly bg: string;
  readonly shadow: string;
  readonly radius: number;
}

/** A surface's fill, hairline and radius (a transparent fill reads as a faint plate). */
export function paintOf(element: Element): PlatePaint {
  const style = getComputedStyle(element);
  const bg = style.backgroundColor;
  const border = Number.parseFloat(style.borderTopWidth) > 0 ? style.borderTopColor : "transparent";
  return {
    bg: bg === "rgba(0, 0, 0, 0)" ? "rgba(127, 127, 127, 0.08)" : bg,
    shadow: `inset 0 0 0 1px ${border}`,
    radius: Number.parseFloat(style.borderTopLeftRadius) || 8,
  };
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A plate (the surface, never its text) travelling between two boxes inside
 * `host`, FLIP-style via a ghost. The ghost measures its own offset first, so
 * a transformed dialog (a containing block for `position: fixed`) is fine.
 * Resolves once it has landed and is gone.
 */
export function flyPlate(
  host: Element,
  input: {
    readonly from: Box;
    readonly to: Box;
    readonly fromPaint: PlatePaint;
    readonly toPaint: PlatePaint;
    readonly duration: number;
    readonly easing?: string;
    /** Fade the plate out over the tail of the travel, from this fraction (0–1). */
    readonly fadeFrom?: number;
  },
): Promise<void> {
  if (!dialogMotionOn()) return Promise.resolve();
  const ghost = document.createElement("div");
  ghost.setAttribute("aria-hidden", "true");
  ghost.className = "ad-ghost";
  Object.assign(ghost.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    margin: "0",
    pointerEvents: "none",
    boxSizing: "border-box",
  });
  host.append(ghost);
  const origin = ghost.getBoundingClientRect();
  const frame = (box: Box, paint: PlatePaint): Keyframe => ({
    left: `${box.left - origin.left}px`,
    top: `${box.top - origin.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: `${paint.radius}px`,
    backgroundColor: paint.bg,
    boxShadow: paint.shadow,
  });
  const animations = [
    ghost.animate([frame(input.from, input.fromPaint), frame(input.to, input.toPaint)], {
      duration: input.duration,
      easing: input.easing ?? DIALOG_EASE,
      fill: "forwards",
    }),
  ];
  if (input.fadeFrom !== undefined)
    animations.push(
      ghost.animate([{ opacity: 1 }, { opacity: 1, offset: input.fadeFrom }, { opacity: 0 }], {
        duration: input.duration,
        fill: "forwards",
      }),
    );
  return Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
    () => ghost.remove(),
  );
}

/** The save landing: a plate folds from the editor's header into the row, which rings once. */
export function landOnRow(host: Element, row: HTMLElement, fromRect: Box): void {
  if (!dialogMotionOn()) return;
  row.scrollIntoView({ block: "nearest" });
  const to = row.getBoundingClientRect();
  void flyPlate(host, {
    from: fromRect,
    to,
    fromPaint: { bg: "rgba(127, 127, 127, 0.1)", shadow: "inset 0 0 0 1px transparent", radius: 8 },
    toPaint: paintOf(row),
    duration: 320,
    fadeFrom: 0.7,
  }).then(() => {
    if (!row.isConnected) return;
    row.animate(
      [
        { boxShadow: "inset 0 0 0 1px rgba(127, 127, 127, 0)" },
        { boxShadow: "inset 0 0 0 1px rgba(127, 127, 127, 0.5)", offset: 0.35 },
        { boxShadow: "inset 0 0 0 1px rgba(127, 127, 127, 0)" },
      ],
      { duration: 520, easing: "ease-out" },
    );
  });
}
