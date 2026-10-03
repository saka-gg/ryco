// FILE: containerTransform.ts
// Purpose: Container-transform motion (Material's shared-container pattern):
//          a childless "ghost" copy of a surface travels between two rects, so
//          a dialog visibly grows out of the control that opened it and folds
//          back into wherever its result now lives.
// Layer: Web UI motion primitive (DOM only, no React)
// Why: Scaling the real surface would distort its text and corner radius, and
//      animating the real surface's size would relayout its content every
//      frame. The ghost is one empty box, so a frame costs one layout of an
//      element with no children and no backdrop work beyond what the surface
//      itself already paints.

export interface MotionCurve {
  /** CSS easing (a `linear()` spring sample or a cubic-bezier). */
  readonly easing: string;
  readonly durationMs: number;
}

export interface SurfaceRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A damped spring sampled into a CSS `linear()` easing. The duration is the
 * simulated settle time, so the curve and its duration always agree.
 */
export function springCurve(input: {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass?: number;
  readonly samples?: number;
}): MotionCurve {
  const mass = input.mass ?? 1;
  const step = 1 / 240;
  let position = 0;
  let velocity = 0;
  let elapsed = 0;
  const trace = [0];
  while (elapsed < 4) {
    const acceleration = (-input.stiffness * (position - 1) - input.damping * velocity) / mass;
    velocity += acceleration * step;
    position += velocity * step;
    elapsed += step;
    trace.push(position);
    if (Math.abs(1 - position) < 0.0008 && Math.abs(velocity) < 0.01) break;
  }
  const samples = Math.max(2, input.samples ?? 48);
  const points: string[] = [];
  for (let index = 0; index < samples; index += 1) {
    const value =
      index === samples - 1
        ? 1
        : (trace[Math.round((index / (samples - 1)) * (trace.length - 1))] ?? 1);
    points.push(String(Math.round(value * 10_000) / 10_000));
  }
  return { easing: `linear(${points.join(", ")})`, durationMs: Math.round(elapsed * 1000) };
}

export function toSurfaceRect(rect: DOMRectReadOnly): SurfaceRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Whether an element is attached and occupies space, i.e. a rect worth morphing to. */
export function isMorphable(element: Element | null | undefined): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function cornerRadiusOf(element: Element, fallback: number): number {
  const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius);
  return Number.isFinite(radius) ? radius : fallback;
}

function frameFor(rect: SurfaceRect, radius: number): Keyframe {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderRadius: `${radius}px`,
  };
}

/** The parts of a surface's painting a ghost reproduces. */
export interface SurfacePaint {
  readonly backgroundColor: string;
  readonly boxShadow: string;
  readonly borderStyle: string;
  readonly borderWidth: string;
  readonly borderColor: string;
  readonly backdropFilter: string;
}

/**
 * Snapshots a surface's paint. Take it before the surface hands its painting
 * to a ghost (see `dialogMorph.ts`), since it reads as transparent after.
 */
export function readSurfacePaint(surface: Element): SurfacePaint {
  const paint = getComputedStyle(surface);
  return {
    backgroundColor: paint.backgroundColor,
    boxShadow: paint.boxShadow,
    borderStyle: paint.borderTopStyle,
    borderWidth: paint.borderTopWidth,
    borderColor: paint.borderTopColor,
    backdropFilter: paint.backdropFilter,
  };
}

/**
 * Creates the ghost: a fixed-position, childless copy of a surface's paint
 * (fill, border, shadow, frost) at `rect`. It is inserted before `before` so
 * it paints beneath that sibling, whose content fades in or out over it.
 */
export function createSurfaceGhost(input: {
  readonly paint: SurfacePaint;
  readonly rect: SurfaceRect;
  readonly radius: number;
  readonly parent: Element;
  readonly before?: Node | null;
}): HTMLElement {
  const paint = input.paint;
  const ghost = document.createElement("div");
  ghost.setAttribute("aria-hidden", "true");
  ghost.dataset.slot = "morph-ghost";
  const style = ghost.style;
  style.position = "fixed";
  style.margin = "0";
  style.pointerEvents = "none";
  style.contain = "strict";
  style.boxSizing = "border-box";
  style.backgroundColor = paint.backgroundColor;
  style.boxShadow = paint.boxShadow;
  style.borderStyle = paint.borderStyle;
  style.borderWidth = paint.borderWidth;
  style.borderColor = paint.borderColor;
  style.backdropFilter = paint.backdropFilter;
  style.setProperty("-webkit-backdrop-filter", paint.backdropFilter);
  Object.assign(style, frameFor(input.rect, input.radius));
  input.parent.insertBefore(ghost, input.before ?? null);
  return ghost;
}

export interface GhostTravel {
  readonly finished: Promise<void>;
  cancel(): void;
}

/**
 * Moves a ghost between two rects. `fadeOutFrom` (0–1) fades it out over the
 * tail of the travel — used when folding into a control smaller than the
 * surface, so the landing hands off to the control instead of covering it.
 */
export function travelGhost(
  ghost: HTMLElement,
  input: {
    readonly from: SurfaceRect;
    readonly to: SurfaceRect;
    readonly fromRadius: number;
    readonly toRadius: number;
    readonly curve: MotionCurve;
    readonly fadeOutFrom?: number;
  },
): GhostTravel {
  const animations = [
    ghost.animate([frameFor(input.from, input.fromRadius), frameFor(input.to, input.toRadius)], {
      duration: input.curve.durationMs,
      easing: input.curve.easing,
      fill: "forwards",
    }),
  ];
  if (input.fadeOutFrom !== undefined) {
    animations.push(
      ghost.animate([{ opacity: 1 }, { opacity: 1, offset: input.fadeOutFrom }, { opacity: 0 }], {
        duration: input.curve.durationMs,
        easing: "linear",
        fill: "forwards",
      }),
    );
  }
  return {
    finished: Promise.all(animations.map((animation) => animation.finished)).then(
      () => undefined,
      () => undefined,
    ),
    cancel: () => {
      for (const animation of animations) animation.cancel();
    },
  };
}
