import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import {
  clampPullRequestsListWidth,
  PULL_REQUESTS_LIST_DEFAULT_WIDTH,
  PULL_REQUESTS_LIST_MAX_WIDTH,
  PULL_REQUESTS_LIST_MIN_WIDTH,
  PULL_REQUESTS_LIST_WIDTH_VAR,
  usePullRequestsLayoutStore,
} from "../pullRequestsLayoutStore";

/** Arrow-key step; Shift moves in larger steps. */
const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_LARGE = 48;

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  /** The page root whose `--pr-list-width` the drag drives directly. */
  readonly page: HTMLElement | null;
  frame: number | null;
  nextWidth: number;
}

/**
 * The docked list's right edge: drag it, or focus it and use ←/→ (Shift for
 * bigger steps), Home/End for the narrowest/widest list. Double-click resets
 * the width. It sits over the list's hairline, so it adds no width of its own.
 *
 * A drag writes the column width straight to the page's `--pr-list-width`
 * once per frame — no React render, no storage write — and commits the final
 * width to the layout store (and so to storage) when it ends.
 */
export function ListResizeHandle() {
  const listWidth = usePullRequestsLayoutStore((state) => state.listWidth);
  const setListWidth = usePullRequestsLayoutStore((state) => state.setListWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!dragging) return;
    // Keep the resize cursor and stop text selection wherever the pointer goes.
    const { style } = document.body;
    const previous = { cursor: style.cursor, userSelect: style.userSelect };
    style.cursor = "col-resize";
    style.userSelect = "none";
    return () => {
      style.cursor = previous.cursor;
      style.userSelect = previous.userSelect;
    };
  }, [dragging]);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.frame !== null && drag?.frame !== undefined) cancelAnimationFrame(drag.frame);
      drag?.page?.style.removeProperty(PULL_REQUESTS_LIST_WIDTH_VAR);
    },
    [],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: usePullRequestsLayoutStore.getState().listWidth,
      page: event.currentTarget.closest<HTMLElement>(".pr-page"),
      frame: null,
      nextWidth: usePullRequestsLayoutStore.getState().listWidth,
    };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.nextWidth = clampPullRequestsListWidth(drag.startWidth + event.clientX - drag.startX);
    // One layout pass per frame, however fast the pointer reports.
    if (drag.frame === null) {
      const handle = event.currentTarget;
      drag.frame = requestAnimationFrame(() => {
        drag.frame = null;
        drag.page?.style.setProperty(PULL_REQUESTS_LIST_WIDTH_VAR, `${drag.nextWidth}px`);
        handle.setAttribute("aria-valuenow", String(drag.nextWidth));
        handle.setAttribute("aria-valuetext", `${drag.nextWidth} pixels`);
      });
    }
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    setListWidth(drag.nextWidth);
    // The store owns the width again (the column falls back to it).
    drag.page?.style.removeProperty(PULL_REQUESTS_LIST_WIDTH_VAR);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = listWidth - step;
        break;
      case "ArrowRight":
        next = listWidth + step;
        break;
      case "Home":
        next = PULL_REQUESTS_LIST_MIN_WIDTH;
        break;
      case "End":
        next = PULL_REQUESTS_LIST_MAX_WIDTH;
        break;
      default:
        return;
    }
    event.preventDefault();
    setListWidth(next);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize pull request list"
      aria-valuemin={PULL_REQUESTS_LIST_MIN_WIDTH}
      aria-valuemax={PULL_REQUESTS_LIST_MAX_WIDTH}
      aria-valuenow={listWidth}
      aria-valuetext={`${listWidth} pixels`}
      data-dragging={dragging}
      className="pr-list-resize relative z-10 -ml-px w-px shrink-0 cursor-col-resize touch-none outline-hidden select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => setListWidth(PULL_REQUESTS_LIST_DEFAULT_WIDTH)}
      onKeyDown={onKeyDown}
    >
      {/* A wider grab area than the 1px line it sits on. */}
      <span aria-hidden className="absolute inset-y-0 -right-[3px] -left-[3px]" />
      <span
        aria-hidden
        className="pr-list-resize-line absolute inset-y-0 -left-px w-[2px] rounded-full"
      />
    </div>
  );
}
