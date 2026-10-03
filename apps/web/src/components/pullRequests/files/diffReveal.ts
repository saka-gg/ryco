import type { DiffAnnotationSide } from "@ryco/client-runtime/state/pull-request-review";

import { DIFF_SURFACE_BASE_UNSAFE_CSS } from "../../../lib/diffRendering";
import { readMotionDurationMs } from "../../../lib/perf/motion";

/**
 * Pull request diff surface: the shared pierre theming, a neutral selection
 * and gutter `+` (no brand blue), untinted annotation rows (threads sit on
 * the diff's own surface), and the deep-link flash for a revealed line. Pierre renders lines inside a shadow root, so the
 * page stylesheet cannot reach them; this CSS (and its keyframes) is injected
 * through `unsafeCSS`. The flash is an inset overlay, so a line keeps its own
 * addition/deletion tint underneath; under reduced motion it is a static ring.
 */
export const PULL_REQUEST_DIFF_UNSAFE_CSS = `${DIFF_SURFACE_BASE_UNSAFE_CSS}
pre,
[data-diff],
[data-file] {
  --diffs-selection-base: color-mix(in srgb, var(--foreground) 55%, var(--background)) !important;
}
[data-line-annotation],
[data-gutter-buffer="annotation"] {
  --diffs-annotation-bg: var(--diffs-bg) !important;
}
[data-line-annotation][data-selected-line],
[data-gutter-buffer="annotation"][data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg) !important;
}
[data-utility-button] {
  background-color: var(--primary) !important;
  color: var(--primary-foreground) !important;
}
[data-line][data-pr-flash="flash"] {
  animation: pr-line-flash 1.6s var(--app-motion-ease, ease);
}
[data-line][data-pr-flash="ring"] {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ring) 80%, transparent);
}
@keyframes pr-line-flash {
  0%, 100% { box-shadow: inset 0 0 0 100vmax transparent; }
  30% { box-shadow: inset 0 0 0 100vmax color-mix(in srgb, var(--primary) 14%, transparent); }
}
`;

const FLASH_MS = 1600;
/** Pierre's default row height; only used to estimate how far an unrendered line is. */
const ESTIMATED_LINE_HEIGHT = 20;
const MAX_REVEAL_ATTEMPTS = 24;

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function diffShadowRoot(fileElement: HTMLElement): ShadowRoot | null {
  return fileElement.querySelector("diffs-container")?.shadowRoot ?? null;
}

/** The rendered content row for `line` on `side`, if pierre has it in the DOM. */
export function findDiffLineElement(
  fileElement: HTMLElement,
  side: DiffAnnotationSide,
  line: number,
): HTMLElement | null {
  const root = diffShadowRoot(fileElement);
  if (!root) return null;
  const n = CSS.escape(String(line));
  const unified = root.querySelector<HTMLElement>("code[data-unified]");
  if (unified) {
    if (side === "additions") {
      return unified.querySelector<HTMLElement>(
        `[data-line="${n}"]:not([data-line-type="change-deletion"])`,
      );
    }
    return (
      unified.querySelector<HTMLElement>(`[data-line-type="change-deletion"][data-line="${n}"]`) ??
      unified.querySelector<HTMLElement>(`[data-alt-line="${n}"]:not([data-line-type^="change-"])`)
    );
  }
  const column = root.querySelector<HTMLElement>(
    side === "additions" ? "code[data-additions]" : "code[data-deletions]",
  );
  return column?.querySelector<HTMLElement>(`[data-line="${n}"]`) ?? null;
}

function renderedLineRange(
  fileElement: HTMLElement,
  side: DiffAnnotationSide,
): { readonly min: number; readonly max: number } | null {
  const root = diffShadowRoot(fileElement);
  if (!root) return null;
  const column =
    root.querySelector<HTMLElement>("code[data-unified]") ??
    root.querySelector<HTMLElement>(
      side === "additions" ? "code[data-additions]" : "code[data-deletions]",
    );
  if (!column) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const element of column.querySelectorAll<HTMLElement>("[data-line]")) {
    const value = Number(element.dataset.line);
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Number.isFinite(min) ? { min, max } : null;
}

function centerInScroller(scroller: HTMLElement, element: HTMLElement): void {
  const target = element.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  const delta = target.top + target.height / 2 - (viewport.top + viewport.height / 2);
  scroller.scrollTop += delta;
}

/**
 * Scroll the virtualized diff until `line` is rendered, then center it.
 * Pierre only renders a window of each file, so a far line is approached in
 * steps estimated from the rendered range. Resolves with the line element, or
 * null when the line is not part of the diff (or the reveal was cancelled).
 */
export async function revealDiffLine(input: {
  readonly scroller: HTMLElement;
  readonly fileElement: HTMLElement;
  readonly side: DiffAnnotationSide;
  readonly line: number;
  readonly signal: AbortSignal;
}): Promise<HTMLElement | null> {
  const { scroller, fileElement, side, line, signal } = input;
  for (let attempt = 0; attempt < MAX_REVEAL_ATTEMPTS; attempt += 1) {
    if (signal.aborted) return null;
    const element = findDiffLineElement(fileElement, side, line);
    if (element && element.getBoundingClientRect().height > 0) {
      centerInScroller(scroller, element);
      await nextFrame();
      return signal.aborted ? null : (findDiffLineElement(fileElement, side, line) ?? element);
    }
    const range = renderedLineRange(fileElement, side);
    if (range === null) {
      fileElement.scrollIntoView({ block: "start", behavior: "instant" });
    } else if (line > range.max) {
      scroller.scrollTop += Math.min(8000, (line - range.max) * ESTIMATED_LINE_HEIGHT);
    } else if (line < range.min) {
      scroller.scrollTop -= Math.min(8000, (range.min - line) * ESTIMATED_LINE_HEIGHT);
    } else if (attempt > 2) {
      // Inside the rendered window but absent: not a line of this diff.
      return null;
    }
    await nextFrame();
    await nextFrame();
  }
  return null;
}

/** Center an element (a thread, the outdated list) inside the diff scroller. */
export function centerElement(scroller: HTMLElement, element: HTMLElement): void {
  centerInScroller(scroller, element);
}

function alignDelta(
  scroller: HTMLElement,
  element: HTMLElement,
  align: "center" | "start",
): number {
  const target = element.getBoundingClientRect();
  const viewport = scroller.getBoundingClientRect();
  return align === "start"
    ? target.top - viewport.top
    : target.top + target.height / 2 - (viewport.top + viewport.height / 2);
}

const LAYOUT_WAIT_MAX_MS = 6000;

/**
 * Wait until every mounted pierre file has been laid out. Files render only
 * once the highlighter worker is ready (a cold pool takes a moment), and
 * until then they have no height, so any scroll target measured earlier is
 * wrong by however tall the files above it turn out to be.
 */
export async function waitForDiffLayout(
  viewport: HTMLElement,
  signal: AbortSignal,
): Promise<boolean> {
  const started = performance.now();
  while (!signal.aborted) {
    const containers = viewport.querySelectorAll<HTMLElement>("diffs-container");
    let ready = containers.length > 0;
    for (const container of containers) {
      if (container.offsetHeight === 0) {
        ready = false;
        break;
      }
    }
    if (ready) return true;
    if (performance.now() - started > LAYOUT_WAIT_MAX_MS) return false;
    await nextFrame();
  }
  return false;
}

const HOLD_QUIET_MS = 280;
const HOLD_MAX_MS = 4000;

/**
 * Keep a revealed target centered while the diff above it settles. Pierre
 * sizes files as they highlight in the worker, so the first moments after a
 * jump can grow the content above the target by thousands of pixels; this
 * follows the target frame by frame until the layout has been still for a
 * moment, the reader scrolls or types, or the reveal is cancelled. `resolve`
 * finds the target again each frame (virtualized rows are re-created), and
 * `recover` walks back to it when it is no longer rendered.
 */
export async function holdInView(input: {
  readonly scroller: HTMLElement;
  readonly resolve: () => HTMLElement | null;
  readonly recover: () => Promise<HTMLElement | null>;
  readonly signal: AbortSignal;
  /** `start` pins the target's top to the top of the viewport (a file header). */
  readonly align?: "center" | "start";
}): Promise<HTMLElement | null> {
  const { scroller, signal } = input;
  const hold = { interrupted: false };
  const interrupt = () => {
    hold.interrupted = true;
  };
  const options = { passive: true, capture: true } as const;
  scroller.addEventListener("wheel", interrupt, options);
  scroller.addEventListener("touchstart", interrupt, options);
  scroller.addEventListener("pointerdown", interrupt, options);
  window.addEventListener("keydown", interrupt, options);
  const started = performance.now();
  let lastMove = started;
  let element: HTMLElement | null = null;
  try {
    while (!signal.aborted && !hold.interrupted) {
      const now = performance.now();
      if (now - lastMove > HOLD_QUIET_MS || now - started > HOLD_MAX_MS) break;
      element = input.resolve();
      if (!element || element.getBoundingClientRect().height === 0) {
        element = await input.recover();
        lastMove = performance.now();
        if (!element) break;
        continue;
      }
      const delta = alignDelta(scroller, element, input.align ?? "center");
      if (Math.abs(delta) > 2) {
        scroller.scrollTop += delta;
        lastMove = performance.now();
      }
      await nextFrame();
    }
  } finally {
    scroller.removeEventListener("wheel", interrupt, options);
    scroller.removeEventListener("touchstart", interrupt, options);
    scroller.removeEventListener("pointerdown", interrupt, options);
    window.removeEventListener("keydown", interrupt, options);
  }
  return signal.aborted ? null : (input.resolve() ?? element);
}

function flashMode(): "flash" | "ring" {
  return readMotionDurationMs("--app-motion-duration-pane", 360) === 0 ? "ring" : "flash";
}

/** Flash a pierre line (shadow DOM) once; a static ring under reduced motion. */
export function flashDiffLine(element: HTMLElement): void {
  element.dataset.prFlash = flashMode();
  window.setTimeout(() => {
    delete element.dataset.prFlash;
  }, FLASH_MS);
}

/** Flash a page element (a thread) with the shared jump flash. */
export function flashElement(element: HTMLElement): void {
  const className = flashMode() === "flash" ? "pr-jump-flash" : "pr-jump-ring";
  element.classList.remove("pr-jump-flash", "pr-jump-ring");
  // Restart the animation when the same thread is revealed twice in a row.
  void element.offsetWidth;
  element.classList.add(className);
  window.setTimeout(() => element.classList.remove(className), FLASH_MS);
}
