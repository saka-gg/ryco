import { useCallback, useEffect, useRef, useState } from "react";

import { useEvent } from "../../../hooks/useEvent";
import { readMotionDurationMs } from "../../../lib/perf/motion";

export interface MapCamera {
  x: number;
  y: number;
  k: number;
}

export interface MapBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
const easeOutExpo = (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));

/** Elements a pointer can start a pan on: anything that is not a node or an overlay. */
const PAN_BLOCKERS = "[data-map-node], [data-map-ui], button, a, input, textarea";

/**
 * Pan and zoom for the project map. The camera lives in a ref and is written
 * straight to the world's transform, so dragging never re-renders React;
 * only the rounded zoom (for the % readout and level of detail) is state.
 * Trackpad scroll pans, ⌘/ctrl-scroll or pinch zooms at the pointer, drag on
 * empty canvas pans, double-click fits. Camera moves ease unless motion is off.
 */
export function useMapCamera(options: {
  readonly onFit: () => void;
  readonly onBackgroundClick: () => void;
  /** The reader moved the camera (pan, scroll, zoom): stop auto-fitting. */
  readonly onUserMove?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const camera = useRef<MapCamera>({ x: 0, y: 0, k: 1 });
  const tween = useRef(0);
  const [zoom, setZoom] = useState(1);
  const onFit = useEvent(options.onFit);
  const onBackgroundClick = useEvent(options.onBackgroundClick);
  const onUserMove = useEvent(() => options.onUserMove?.());

  const apply = useCallback(() => {
    const host = hostRef.current;
    const world = worldRef.current;
    const { x, y, k } = camera.current;
    if (world) world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    if (host) {
      const size = 22 * k;
      host.style.setProperty("--map-grid-size", `${size}px`);
      host.style.setProperty("--map-grid-x", `${x % size}px`);
      host.style.setProperty("--map-grid-y", `${y % size}px`);
      host.dataset.zoom = k < 0.55 ? "far" : k > 1.35 ? "near" : "mid";
    }
    setZoom((previous) => (Math.abs(previous - k) < 0.005 ? previous : k));
  }, []);

  const setCamera = useCallback(
    (
      next: Partial<MapCamera>,
      motion?: { readonly animate?: boolean; readonly duration?: number },
    ) => {
      cancelAnimationFrame(tween.current);
      const target = {
        x: next.x ?? camera.current.x,
        y: next.y ?? camera.current.y,
        k: clamp(next.k ?? camera.current.k, MIN_ZOOM, MAX_ZOOM),
      };
      const duration = motion?.animate
        ? Math.min(
            motion.duration ?? 680,
            readMotionDurationMs("--app-motion-duration-pane", 360) * 2,
          )
        : 0;
      if (duration <= 0) {
        camera.current = target;
        apply();
        return;
      }
      const from = { ...camera.current };
      const start = performance.now();
      const step = (now: number) => {
        const p = easeOutExpo(Math.min(1, (now - start) / duration));
        camera.current = {
          x: from.x + (target.x - from.x) * p,
          y: from.y + (target.y - from.y) * p,
          k: from.k + (target.k - from.k) * p,
        };
        apply();
        if (p < 1) tween.current = requestAnimationFrame(step);
      };
      tween.current = requestAnimationFrame(step);
    },
    [apply],
  );

  /** Fit a world box into the host, leaving `insetRight` for an open panel. */
  const fit = useCallback(
    (
      bounds: MapBounds,
      fitOptions: {
        readonly animate?: boolean;
        readonly padding?: number;
        readonly maxZoom?: number;
        readonly insetRight?: number;
        readonly insetTop?: number;
      } = {},
    ) => {
      const host = hostRef.current;
      if (!host || bounds.w <= 0 || bounds.h <= 0) return;
      const pad = fitOptions.padding ?? 64;
      const top = fitOptions.insetTop ?? 0;
      const width = host.clientWidth - (fitOptions.insetRight ?? 0);
      const height = host.clientHeight - top;
      if (width <= 0 || height <= 0) return;
      const k = clamp(
        Math.min((width - pad * 2) / bounds.w, (height - pad * 2) / bounds.h),
        MIN_ZOOM,
        fitOptions.maxZoom ?? 1,
      );
      setCamera(
        {
          k,
          x: width / 2 - (bounds.x + bounds.w / 2) * k,
          y: top + height / 2 - (bounds.y + bounds.h / 2) * k,
        },
        { animate: fitOptions.animate ?? false },
      );
    },
    [setCamera],
  );

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number, animate = false) => {
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { x, y, k } = camera.current;
      const nextK = clamp(k * factor, MIN_ZOOM, MAX_ZOOM);
      const wx = (px - x) / k;
      const wy = (py - y) / k;
      setCamera({ k: nextK, x: px - wx * nextK, y: py - wy * nextK }, { animate, duration: 380 });
    },
    [setCamera],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const host = hostRef.current;
      if (!host) return;
      onUserMove();
      const rect = host.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor, true);
    },
    [onUserMove, zoomAt],
  );

  /** Move the camera just enough that a world box is visible (outside `insetRight`). */
  const reveal = useCallback(
    (
      box: MapBounds,
      revealOptions: { readonly insetRight?: number; readonly insetTop?: number } = {},
    ) => {
      const host = hostRef.current;
      if (!host) return;
      const { x, y, k } = camera.current;
      const left = box.x * k + x;
      const top = box.y * k + y;
      const right = left + box.w * k;
      const bottom = top + box.h * k;
      const maxRight = host.clientWidth - (revealOptions.insetRight ?? 0) - 24;
      const minTop = (revealOptions.insetTop ?? 0) + 16;
      let dx = 0;
      let dy = 0;
      if (right > maxRight) dx = maxRight - right;
      if (left + dx < 24) dx = 24 - left;
      if (top < minTop) dy = minTop - top;
      else if (bottom > host.clientHeight - 64) dy = host.clientHeight - 64 - bottom;
      if (dx || dy) setCamera({ x: x + dx, y: y + dy }, { animate: true, duration: 560 });
    },
    [setCamera],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null =
      null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if ((event.target as Element | null)?.closest(PAN_BLOCKERS)) return;
      drag = {
        x: event.clientX,
        y: event.clientY,
        cx: camera.current.x,
        cy: camera.current.y,
        moved: false,
        id: event.pointerId,
      };
      host.setPointerCapture(event.pointerId);
      host.dataset.panning = "";
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        onUserMove();
      }
      setCamera({ x: drag.cx + dx, y: drag.cy + dy });
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      delete host.dataset.panning;
      if (!moved) onBackgroundClick();
    };
    const onWheel = (event: WheelEvent) => {
      // Overlays (inspector, controls) scroll themselves.
      if ((event.target as Element | null)?.closest("[data-map-ui]")) return;
      event.preventDefault();
      onUserMove();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0045));
      } else {
        setCamera({ x: camera.current.x - event.deltaX, y: camera.current.y - event.deltaY });
      }
    };
    const onDoubleClick = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest(PAN_BLOCKERS)) return;
      onFit();
    };
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("dblclick", onDoubleClick);
    return () => {
      cancelAnimationFrame(tween.current);
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("dblclick", onDoubleClick);
    };
  }, [onBackgroundClick, onFit, onUserMove, setCamera, zoomAt]);

  return { hostRef, worldRef, camera, zoom, setCamera, fit, zoomBy, reveal };
}
