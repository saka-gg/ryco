import { MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ExpandedImageContent } from "./ExpandedImageContent";
import type { ExpandedImageItem } from "./ExpandedImagePreview";
import {
  clampImageOffset,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  stepImageZoom,
  zoomImageAt,
  type ImageZoomState,
} from "./zoomableImage.logic";

const NOT_ZOOMED: ImageZoomState = { scale: 1, x: 0, y: 0 };

/** Which zoom a key asks for in the image viewer: with or without Cmd/Ctrl. */
export function imageZoomKeyAction(
  event: Pick<KeyboardEvent, "key" | "altKey">,
): "in" | "out" | "reset" | null {
  if (event.altKey) return null;
  if (event.key === "+" || event.key === "=") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "reset";
  return null;
}

/**
 * An expanded image the reader can zoom and pan: a pinch or Ctrl+wheel zooms
 * at the pointer, a drag or a wheel pans a zoomed image, a double click
 * toggles 2×, and + / − / 0 (with or without Cmd/Ctrl) zoom from the keyboard.
 * At 100% the image fits its box exactly as before; zooming happens inside the
 * box, so the controls around it never move.
 */
export function ZoomableImage(props: {
  readonly image: ExpandedImageItem;
  readonly className?: string;
  /** Keys reach the viewer through the dialog: it forwards them here while it owns the keyboard. */
  readonly keyTarget?: "window" | "none";
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ readonly src: string; readonly zoom: ImageZoomState }>({
    src: props.image.src,
    zoom: NOT_ZOOMED,
  });
  // Another image starts at 100%.
  const zoom = state.src === props.image.src ? state.zoom : NOT_ZOOMED;
  const setZoom = (next: ImageZoomState) => setState({ src: props.image.src, zoom: next });
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);

  const box = () => {
    const element = boxRef.current;
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { rect, width: element.clientWidth, height: element.clientHeight };
  };
  const zoomAround = (scale: number, clientX?: number, clientY?: number) => {
    const measured = box();
    if (measured === null) return;
    const point =
      clientX === undefined || clientY === undefined
        ? { x: 0, y: 0 }
        : {
            x: clientX - (measured.rect.left + measured.rect.width / 2),
            y: clientY - (measured.rect.top + measured.rect.height / 2),
          };
    setZoom(zoomImageAt(zoom, scale, point, measured));
  };
  const zoomBy = (direction: 1 | -1) => zoomAround(stepImageZoom(zoom.scale, direction));

  const onWheel = useEffectEvent((event: WheelEvent) => {
    const measured = box();
    if (measured === null) return;
    if (event.ctrlKey) {
      // A pinch or Ctrl+wheel: proportional, at the pointer.
      event.preventDefault();
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-event.deltaY / 250)));
      zoomAround(zoom.scale * factor, event.clientX, event.clientY);
      return;
    }
    if (zoom.scale <= IMAGE_ZOOM_MIN) return;
    event.preventDefault();
    setZoom(
      clampImageOffset({ ...zoom, x: zoom.x - event.deltaX, y: zoom.y - event.deltaY }, measured),
    );
  });
  useEffect(() => {
    const element = boxRef.current;
    if (element === null) return;
    const listener = (event: WheelEvent) => onWheel(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, []);

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    // A contained viewer leaves the composer usable: typing there never zooms.
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest("input, textarea, select") !== null)
    ) {
      return;
    }
    const action = imageZoomKeyAction(event);
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "reset") setZoom(NOT_ZOOMED);
    else zoomBy(action === "in" ? 1 : -1);
  });
  useEffect(() => {
    if (props.keyTarget === "none") return;
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [props.keyTarget]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (zoom.scale <= IMAGE_ZOOM_MIN || event.button !== 0) return;
    try {
      // Keeps the drag when the pointer leaves the box mid-pan.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still works inside the box.
    }
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const measured = box();
    if (current === null || current.pointerId !== event.pointerId || measured === null) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) current.moved = true;
    drag.current = { ...current, x: event.clientX, y: event.clientY };
    setZoom(clampImageOffset({ ...zoom, x: zoom.x + dx, y: zoom.y + dy }, measured));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  const zoomed = zoom.scale > IMAGE_ZOOM_MIN;
  return (
    <div className="relative">
      <div
        ref={boxRef}
        data-image-zoom={zoom.scale}
        className={cn(
          "relative overflow-hidden rounded-lg touch-none",
          zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) =>
          zoomed ? setZoom(NOT_ZOOMED) : zoomAround(2, event.clientX, event.clientY)
        }
      >
        <ExpandedImageContent
          image={props.image}
          {...(props.className ? { className: props.className } : {})}
          style={
            zoomed
              ? {
                  transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                  transformOrigin: "center",
                }
              : undefined
          }
        />
      </div>
      <div
        role="group"
        aria-label="Image zoom"
        className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-white/10 bg-black/65 p-0.5 text-white/90 shadow-lg backdrop-blur-sm"
      >
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          disabled={!zoomed}
          className="rounded-full text-white/90 hover:bg-white/10 hover:text-white"
          onClick={() => zoomBy(-1)}
        >
          <MinusIcon />
        </Button>
        <button
          type="button"
          aria-label={`Zoom ${Math.round(zoom.scale * 100)}%, reset`}
          className="min-w-12 rounded-full px-1.5 text-center text-xs tabular-nums hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          onClick={() => setZoom(NOT_ZOOMED)}
        >
          {Math.round(zoom.scale * 100)}%
        </button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          disabled={zoom.scale >= IMAGE_ZOOM_MAX}
          className="rounded-full text-white/90 hover:bg-white/10 hover:text-white"
          onClick={() => zoomBy(1)}
        >
          <PlusIcon />
        </Button>
      </div>
    </div>
  );
}
