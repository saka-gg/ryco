/**
 * On a translucent window, cuts the page out from under floating overlays, so a
 * translucent menu, picker, popover or toast shows the window's glass rather
 * than the text it covers. Ported from Synara's glassOverlayCutout (MIT, see
 * docs/licenses/synara-computer-use.txt).
 *
 * A backdrop blur cannot hide what sits behind an element over a see-through
 * region: Chromium composites the blurred copy over the sharp original, so text
 * stays readable through a thin fill. Overlays are portaled next to the app
 * root, so the root is clipped instead, with one hole per overlay; behind each
 * hole only the window's coat and the natively blurred desktop remain.
 * Paint-only: it never changes layout, hit-testing, or scroll position.
 *
 * A raised surface floating over content from inside the page (the side chat)
 * cannot be cut out of the root: the hole would take the surface with it. It
 * registers instead ({@link registerInPageGlassOverlay}), and the elements
 * beside it (its siblings) get the hole.
 *
 * Idle cost is one MutationObserver on the body's direct children plus one per
 * portal container; the per-frame work only runs while an overlay is showing,
 * and for an in-page overlay only until its geometry settles.
 */
import { WINDOW_TRANSLUCENCY_ATTRIBUTE } from "../themes/windowTranslucency";

/**
 * Hover cards appear on every row crossing. Re-clipping the whole app for each
 * one changes its compositing while the pointer moves, so they get a dense fill
 * in index.css instead and are never cut out.
 */
const HOVER_OVERLAY_SELECTOR = '[data-slot="tooltip-popup"], [data-slot="preview-card-popup"]';

/**
 * The floating overlay surfaces. Keep in step with the overlay rules of the
 * translucent window block in index.css.
 */
export const GLASS_OVERLAY_SELECTOR = `:is(.selection-glass-surface, .app-toast-surface, [data-slot="popover-popup"], [data-slot="autocomplete-popup"]):not(${HOVER_OVERLAY_SELECTOR})`;

/**
 * Set on a portaled overlay that sits on another portaled layer instead of on
 * the page (a select inside a dialog, a menu opened from a popover). That layer
 * is not part of the root, so it cannot be cut out from under the overlay, and
 * the thin fill would leave its text readable; index.css makes it near-opaque.
 */
export const GLASS_BACKED_ATTRIBUTE = "data-glass-backed";

/** An overlay fading in or out is cut out only once it covers more than it reveals. */
const MIN_OVERLAY_OPACITY = 0.5;

/** A layer counts as backing only if it paints: an invisible click-catcher does not. */
const MIN_BACKING_ALPHA = 0.5;

/**
 * Frames to keep reading after the last covering overlay is gone. Some overlays
 * stay mounted while hidden, so "nothing mounted" never arrives; this lets the
 * loop stop anyway, and outlasts a fade so it does not stop halfway through one.
 */
const IDLE_FRAMES_BEFORE_STOP = 30;

const backedOverlays = new WeakMap<HTMLElement, boolean>();

/**
 * Set on a registered in-page overlay while it is registered, so index.css can
 * give it the raised glass pane in place of its own fill.
 */
export const GLASS_IN_PAGE_ATTRIBUTE = "data-glass-in-page";

const inPageOverlays = new Set<HTMLElement>();
let scheduleInstalledCutout: (() => void) | null = null;
let observeInPageOverlay: ((surface: HTMLElement) => () => void) | null = null;

/**
 * Registers a raised surface that floats over content inside the page. While
 * the window is whole-window glass, its siblings are cut out from under it, so
 * it shows the glass rather than the content it covers. Returns the unregister
 * function.
 */
export function registerInPageGlassOverlay(surface: HTMLElement): () => void {
  inPageOverlays.add(surface);
  surface.setAttribute(GLASS_IN_PAGE_ATTRIBUTE, "");
  const unobserve = observeInPageOverlay?.(surface) ?? (() => {});
  scheduleInstalledCutout?.();
  return () => {
    unobserve();
    inPageOverlays.delete(surface);
    surface.removeAttribute(GLASS_IN_PAGE_ATTRIBUTE);
    scheduleInstalledCutout?.();
  };
}

/** Alpha of a computed CSS color (`rgb()`, `rgba()`, or `color()`/`oklab()` with `/ a`). */
export function computedColorAlpha(color: string): number {
  if (color === "transparent") return 0;
  const match = color.startsWith("rgba(")
    ? color.match(/,\s*([\d.]+)\s*\)$/)
    : color.match(/\/\s*([\d.]+)\s*\)$/);
  return match ? Number(match[1]) : 1;
}

/**
 * Whether the first painted thing under the overlay's centre is another portaled
 * layer. The overlay's own subtree and its ancestors are skipped, and so is
 * anything unpainted, such as the transparent backdrop a modal menu puts down.
 */
function isBackedByPortaledLayer(overlay: HTMLElement, root: HTMLElement): boolean {
  const rect = overlay.getBoundingClientRect();
  const stack = document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  for (const element of stack) {
    // Ancestors include the body, whose coat must never count as backing.
    if (overlay.contains(element) || element.contains(overlay)) continue;
    if (root.contains(element)) return false;
    const style = getComputedStyle(element);
    if (
      style.backgroundImage !== "none" ||
      computedColorAlpha(style.backgroundColor) >= MIN_BACKING_ALPHA
    ) {
      return true;
    }
  }
  return false;
}

interface CutoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/** Two decimals: sub-pixel precision without long float tails in the path string. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundedRectPath(rect: CutoutRect): string {
  const { x, y, width: w, height: h } = rect;
  const r = Math.max(0, Math.min(rect.radius, w / 2, h / 2));
  const n = round2;
  return [
    `M${n(x + r)} ${n(y)}`,
    `H${n(x + w - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}`,
    `V${n(y + h - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}`,
    `H${n(x + r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}`,
    `V${n(y + r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}`,
    "Z",
  ].join(" ");
}

/** Full box with one rounded hole; separate inverse clips are intersected for several holes. */
export function inverseRectPath(width: number, height: number, rect: CutoutRect): string {
  return `M0 0 H${Math.ceil(width)} V${Math.ceil(height)} H0 Z ${roundedRectPath(rect)}`;
}

function isCoveringOverlay(element: HTMLElement): boolean {
  if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  return Number(getComputedStyle(element).opacity) >= MIN_OVERLAY_OPACITY;
}

function cutoutRectWithin(element: HTMLElement, box: DOMRect): CutoutRect {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x - box.x,
    y: rect.y - box.y,
    width: rect.width,
    height: rect.height,
    radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
  };
}

let cutoutId = 0;

interface CutoutBox {
  readonly width: number;
  readonly height: number;
  readonly rects: CutoutRect[];
}

/**
 * Keeps the page clipped around every open overlay while the window is
 * translucent: the app root under portaled overlays, the siblings of in-page
 * ones. Returns a disposer.
 */
export function installGlassOverlayCutout(root: HTMLElement): () => void {
  const documentElement = document.documentElement;
  const observedContainers = new WeakSet<Node>();
  interface AppliedClip {
    readonly previous: string;
    signature: string;
    definitions: SVGGElement | null;
  }
  const applied = new Map<HTMLElement, AppliedClip>();
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:fixed;width:0;height:0;pointer-events:none";
  const defs = document.createElementNS(svgNamespace, "defs");
  svg.append(defs);
  let frame: number | null = null;
  let idleFrames = 0;
  let lastSignature = "";

  const applyClipPaths = (next: Map<HTMLElement, CutoutBox>) => {
    for (const [element, state] of applied) {
      if (next.has(element)) continue;
      element.style.clipPath = state.previous;
      state.definitions?.remove();
      applied.delete(element);
    }
    for (const [element, box] of next) {
      const signature = JSON.stringify(box);
      const state = applied.get(element) ?? {
        previous: element.style.clipPath,
        signature: "",
        definitions: null,
      };
      if (state.signature === signature) continue;
      state.signature = signature;
      state.definitions?.remove();
      state.definitions = null;
      if (box.rects.length === 1) {
        element.style.clipPath = `path(evenodd, "${inverseRectPath(box.width, box.height, box.rects[0]!)}")`;
      } else {
        // Even-odd holes in one path XOR where overlays overlap. Intersect
        // individual inverse clips instead, so their shared area stays hidden too.
        if (!svg.isConnected) document.body.append(svg);
        const group = document.createElementNS(svgNamespace, "g");
        const prefix = `glass-cutout-${++cutoutId}`;
        for (const [index, rect] of box.rects.entries()) {
          const clip = document.createElementNS(svgNamespace, "clipPath");
          clip.id = `${prefix}-${index}`;
          clip.setAttribute("clipPathUnits", "userSpaceOnUse");
          const path = document.createElementNS(svgNamespace, "path");
          path.setAttribute("clip-rule", "evenodd");
          path.setAttribute("d", inverseRectPath(box.width, box.height, rect));
          if (index > 0) path.setAttribute("clip-path", `url(#${prefix}-${index - 1})`);
          clip.append(path);
          group.append(clip);
        }
        defs.append(group);
        state.definitions = group;
        element.style.clipPath = `url(#${prefix}-${box.rects.length - 1})`;
      }
      applied.set(element, state);
    }
  };

  const addCutout = (
    next: Map<HTMLElement, CutoutBox>,
    element: HTMLElement,
    overlays: readonly HTMLElement[],
  ) => {
    const box = element.getBoundingClientRect();
    const rects = overlays
      .map((overlay) => cutoutRectWithin(overlay, box))
      .filter(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.x < box.width &&
          rect.y < box.height &&
          rect.x + rect.width > 0 &&
          rect.y + rect.height > 0,
      );
    if (rects.length === 0) return;
    const previous = next.get(element);
    next.set(element, {
      width: box.width,
      height: box.height,
      rects: [...(previous?.rects ?? []), ...rects],
    });
  };

  /** Portaled overlays: the root is cut out. Returns how many are showing. */
  const collectPortaledCutouts = (next: Map<HTMLElement, CutoutBox>): number => {
    // Only the portal containers are searched: the root holds the whole transcript.
    const overlays: HTMLElement[] = [];
    for (const child of document.body.children) {
      if (child === root || child === svg || !(child instanceof HTMLElement)) continue;
      if (child.matches(GLASS_OVERLAY_SELECTOR)) overlays.push(child);
      overlays.push(...child.querySelectorAll<HTMLElement>(GLASS_OVERLAY_SELECTOR));
    }
    let covering = 0;
    const onPage: HTMLElement[] = [];
    for (const overlay of overlays) {
      if (!isCoveringOverlay(overlay)) {
        // A kept-mounted overlay can reopen somewhere else; read its backing again then.
        backedOverlays.delete(overlay);
        overlay.removeAttribute(GLASS_BACKED_ATTRIBUTE);
        continue;
      }
      covering += 1;
      let backed = backedOverlays.get(overlay);
      if (backed === undefined) {
        backed = isBackedByPortaledLayer(overlay, root);
        backedOverlays.set(overlay, backed);
      }
      if (overlay.hasAttribute(GLASS_BACKED_ATTRIBUTE) !== backed) {
        overlay.toggleAttribute(GLASS_BACKED_ATTRIBUTE, backed);
      }
      if (!backed) onPage.push(overlay);
    }
    addCutout(next, root, onPage);
    return covering;
  };

  /**
   * In-page overlays: their siblings are cut out. Only on whole-window glass;
   * elsewhere they sit on opaque content.
   */
  const collectInPageCutouts = (next: Map<HTMLElement, CutoutBox>) => {
    if (documentElement.getAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE) !== "window") return;
    for (const surface of inPageOverlays) {
      const parent = surface.parentElement;
      if (!parent || !isCoveringOverlay(surface)) continue;
      for (const sibling of parent.children) {
        if (!(sibling instanceof HTMLElement) || inPageOverlays.has(sibling)) continue;
        addCutout(next, sibling, [surface]);
      }
    }
  };

  const tick = () => {
    frame = null;
    const next = new Map<HTMLElement, CutoutBox>();
    let covering = 0;
    if (documentElement.hasAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE)) {
      covering = collectPortaledCutouts(next);
      collectInPageCutouts(next);
    }
    applyClipPaths(next);
    // An open portaled overlay keeps the loop reading (overlays follow their
    // anchor and resize with their content); in-page overlays only until their
    // holes stop moving, since they can stay open indefinitely. Resizes and
    // state changes reschedule it (see the observers below).
    const signature = JSON.stringify([...next.values()]);
    const moving = signature !== lastSignature;
    lastSignature = signature;
    idleFrames = covering > 0 || moving ? 0 : idleFrames + 1;
    if (idleFrames > IDLE_FRAMES_BEFORE_STOP) return;
    frame = requestAnimationFrame(tick);
  };

  const schedule = () => {
    idleFrames = 0;
    if (frame === null) frame = requestAnimationFrame(tick);
  };
  scheduleInstalledCutout = schedule;

  // An in-page overlay and its siblings change geometry without anything the
  // body observers see: their enter/exit classes, and resizes.
  const resizeObserver = new ResizeObserver(schedule);
  const inPageObserver = new MutationObserver(schedule);
  const observeSurface = (surface: HTMLElement) => {
    resizeObserver.observe(surface);
    const parent = surface.parentElement;
    if (parent) resizeObserver.observe(parent);
    inPageObserver.observe(surface, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      resizeObserver.unobserve(surface);
      if (parent) resizeObserver.unobserve(parent);
    };
  };
  observeInPageOverlay = observeSurface;
  const unobserveExisting = [...inPageOverlays].map(observeSurface);

  // Portaled overlays mount inside containers appended to the body, never inside
  // the root, so the root's own (very busy) subtree is not observed.
  const containerObserver = new MutationObserver(schedule);
  const observeContainers = () => {
    for (const child of document.body.children) {
      if (child === root || child === svg || observedContainers.has(child)) continue;
      observedContainers.add(child);
      // Attributes too: a kept-mounted overlay reopens by flipping its state attributes.
      containerObserver.observe(child, { attributes: true, childList: true, subtree: true });
    }
  };
  const bodyObserver = new MutationObserver(() => {
    observeContainers();
    schedule();
  });
  bodyObserver.observe(document.body, { childList: true });
  // The scope can change while an overlay is open (Appearance settings).
  const scopeObserver = new MutationObserver(schedule);
  scopeObserver.observe(documentElement, {
    attributes: true,
    attributeFilter: [WINDOW_TRANSLUCENCY_ATTRIBUTE],
  });
  window.addEventListener("resize", schedule);
  observeContainers();
  schedule();

  return () => {
    bodyObserver.disconnect();
    containerObserver.disconnect();
    scopeObserver.disconnect();
    inPageObserver.disconnect();
    for (const unobserve of unobserveExisting) unobserve();
    resizeObserver.disconnect();
    window.removeEventListener("resize", schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    scheduleInstalledCutout = null;
    observeInPageOverlay = null;
    applyClipPaths(new Map());
    svg.remove();
  };
}
