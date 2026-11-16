import { useEffect, useRef, type RefObject } from "react";

import { useReducedMotionEffective } from "../../hooks/useAppearancePreference";
import { scheduleIdleTask } from "../../lib/idleTask";
import { useHtmlRenderTheme } from "../../themes/htmlRenderTheme";
import {
  ACTIVE_FRAME_MS,
  ALPHA_STEPS,
  FADE_IN_MS,
  IDLE_FRAME_MS,
  MAX_VORTICES,
  VORTEX_LIFE_MS,
  WAVE_PRESETS,
  canvasPixelRatio,
  cellExtent,
  computeBackgroundFrame,
  createBackgroundGrid,
  hasLiveVortex,
  smoothstep,
  type BackgroundGrid,
  type EmptyChatBackgroundVariant,
  type Vortex,
} from "./EmptyChatBackground.logic";

/** Clicks on these never start a vortex: they belong to a control. */
const INTERACTIVE_SELECTOR =
  "a,button,input,textarea,select,label,form,[contenteditable='true'],[role='button'],[role='combobox'],[role='menuitem'],[role='option'],[role='textbox'],[role='dialog'],[role='menu'],[role='listbox']";
/** A press that moves farther than this is a drag or a selection, not a click. */
const CLICK_SLOP_PX = 4;
/** Let the chat settle before the field starts. */
const START_DELAY_MS = 400;

interface BackgroundColors {
  readonly ink: string;
  readonly accent: string;
}

/**
 * The empty chat's animated field (Settings → Appearance → Chat background).
 * Fills its positioned parent behind the hero and composer; a click on empty
 * space in `containerRef` drops a vortex. Reduced motion draws one still frame
 * and ignores clicks.
 */
export function EmptyChatBackground({
  variant,
  containerRef,
}: {
  readonly variant: EmptyChatBackgroundVariant;
  readonly containerRef: RefObject<HTMLElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = useReducedMotionEffective();
  const theme = useHtmlRenderTheme();
  const ink = theme.variables["--foreground"] ?? "rgb(128, 128, 128)";
  const accent = theme.variables["--chart-1"] ?? ink;
  const colorsRef = useRef<BackgroundColors>({ ink, accent });
  const redrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    colorsRef.current = { ink, accent };
    redrawRef.current?.();
  }, [ink, accent]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const startMs = performance.now();
    const seed = Math.random() * 1000;
    const firstPreset = Math.floor(Math.random() * WAVE_PRESETS.length);
    let grid: BackgroundGrid | null = null;
    let order = new Uint32Array(0);
    const starts = new Uint32Array(ALPHA_STEPS + 2);
    const cursor = new Uint32Array(ALPHA_STEPS + 2);
    let pixelRatio = 1;
    let firstFrameMs: number | null = null;
    let vortices: Vortex[] = [];
    let timer = 0;
    let frame = 0;
    let lastFrameMs = 0;
    let started = false;
    let disposed = false;
    let cancelIdle: (() => void) | null = null;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        grid = null;
        return;
      }
      pixelRatio = canvasPixelRatio(window.devicePixelRatio, rect.width, rect.height);
      canvas.width = Math.round(rect.width * pixelRatio);
      canvas.height = Math.round(rect.height * pixelRatio);
      grid = createBackgroundGrid(variant, rect.width, rect.height);
      order = new Uint32Array(grid.cols * grid.rows);
    };

    const paint = (current: BackgroundGrid, alphas: Float32Array, color: string) => {
      const { frame: cells, variant: shape } = current;
      // Counting sort by opacity step, so each step is one path and one fill.
      starts.fill(0);
      for (let index = 0; index < cells.count; index += 1) {
        const step = Math.round(alphas[index]! * ALPHA_STEPS);
        if (step > 0) starts[step + 1]! += 1;
      }
      for (let step = 1; step <= ALPHA_STEPS + 1; step += 1) starts[step]! += starts[step - 1]!;
      cursor.set(starts);
      for (let index = 0; index < cells.count; index += 1) {
        const step = Math.round(alphas[index]! * ALPHA_STEPS);
        if (step > 0) order[cursor[step]!++] = index;
      }
      context.fillStyle = color;
      context.strokeStyle = color;
      for (let step = 1; step <= ALPHA_STEPS; step += 1) {
        const begin = starts[step]!;
        const end = starts[step + 1]!;
        if (begin === end) continue;
        context.globalAlpha = step / ALPHA_STEPS;
        context.beginPath();
        for (let position = begin; position < end; position += 1) {
          const index = order[position]!;
          const x = cells.x[index]!;
          const y = cells.y[index]!;
          const extent = cellExtent(shape, cells.value[index]!, cells.size[index]!);
          if (shape === "flow") {
            const dx = Math.cos(cells.angle[index]!) * extent;
            const dy = Math.sin(cells.angle[index]!) * extent;
            context.moveTo(x - dx, y - dy);
            context.lineTo(x + dx, y + dy);
          } else if (extent >= 0.35) {
            context.moveTo(x + extent, y);
            context.arc(x, y, extent, 0, Math.PI * 2);
          }
        }
        if (shape === "flow") context.stroke();
        else context.fill();
      }
    };

    const draw = (nowMs: number) => {
      if (!grid) return;
      if (firstFrameMs === null) firstFrameMs = nowMs;
      const fade = reducedMotion ? 1 : smoothstep(0, FADE_IN_MS, nowMs - firstFrameMs);
      const elapsedMs = reducedMotion ? 0 : nowMs - startMs;
      vortices = vortices.filter((vortex) => nowMs - vortex.startMs < VORTEX_LIFE_MS);
      computeBackgroundFrame(grid, {
        elapsedMs,
        seconds: elapsedMs / 1000 + seed,
        firstPreset,
        fade,
        vortices,
        nowMs,
      });
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.globalAlpha = 1;
      context.clearRect(0, 0, grid.width, grid.height);
      context.lineWidth = 1.25;
      context.lineCap = "round";
      const colors = colorsRef.current;
      paint(grid, grid.frame.inkAlpha, colors.ink);
      paint(grid, grid.frame.accentAlpha, colors.accent);
      context.globalAlpha = 1;
    };

    const isShown = () =>
      !document.hidden &&
      (typeof canvas.checkVisibility !== "function" ||
        canvas.checkVisibility({ opacityProperty: true, visibilityProperty: true }));

    const clearScheduled = () => {
      if (timer !== 0) window.clearTimeout(timer);
      if (frame !== 0) cancelAnimationFrame(frame);
      timer = 0;
      frame = 0;
    };

    const tick = () => {
      timer = 0;
      frame = 0;
      // A hidden document resumes from `visibilitychange`.
      if (disposed || !started || document.hidden) return;
      if (!isShown()) {
        timer = window.setTimeout(tick, 1000);
        return;
      }
      const nowMs = performance.now();
      lastFrameMs = nowMs;
      draw(nowMs);
      if (reducedMotion) return;
      if (hasLiveVortex(vortices, nowMs)) frame = requestAnimationFrame(onAnimationFrame);
      else timer = window.setTimeout(tick, IDLE_FRAME_MS);
    };

    const onAnimationFrame = (nowMs: number) => {
      frame = 0;
      if (nowMs - lastFrameMs < ACTIVE_FRAME_MS) {
        frame = requestAnimationFrame(onAnimationFrame);
        return;
      }
      tick();
    };

    const restart = () => {
      clearScheduled();
      tick();
    };

    redrawRef.current = () => {
      if (started && reducedMotion) restart();
    };

    const startOrResize = () => {
      cancelIdle?.();
      cancelIdle = scheduleIdleTask(() => {
        cancelIdle = null;
        if (disposed) return;
        resize();
        started = true;
        restart();
      }, 1500);
    };

    const startTimer = window.setTimeout(startOrResize, START_DELAY_MS);
    const resizeObserver = new ResizeObserver(() => {
      if (started) startOrResize();
    });
    resizeObserver.observe(canvas);
    const onVisibilityChange = () => {
      if (!document.hidden && started && timer === 0 && frame === 0) tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const container = containerRef.current ?? canvas.parentElement;
    let press: { readonly id: number; readonly x: number; readonly y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      press = null;
      if (event.button !== 0 || !event.isPrimary) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return;
      press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      const pressed = press;
      press = null;
      if (!pressed || pressed.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_SLOP_PX) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
      vortices.push({ x, y, startMs: performance.now() });
      if (vortices.length > MAX_VORTICES) vortices.shift();
      // Leave the idle cadence for the vortex's frame rate right away.
      if (started && frame === 0) restart();
    };
    if (container && !reducedMotion) {
      container.addEventListener("pointerdown", onPointerDown, { passive: true });
      container.addEventListener("pointerup", onPointerUp, { passive: true });
    }

    return () => {
      disposed = true;
      redrawRef.current = null;
      window.clearTimeout(startTimer);
      cancelIdle?.();
      clearScheduled();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (container) {
        container.removeEventListener("pointerdown", onPointerDown);
        container.removeEventListener("pointerup", onPointerUp);
      }
    };
  }, [variant, reducedMotion, containerRef]);

  return (
    <div
      aria-hidden
      data-testid="empty-chat-background"
      data-variant={variant}
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
