import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "~/lib/utils";

/** File lists with more rows than this (T3 Code's threshold) render only the rows in view. */
export const WINDOW_FILE_ROWS_AFTER = 250;
// Rows rendered beyond the scrolled viewport on each side.
const ROW_OVERSCAN = 8;
const INITIAL_RANGE = { start: 0, end: 40, rowStride: 26 };

/**
 * Renders a long list of equal-height rows: once `virtualized`, only the rows
 * its ancestors leave in view (plus overscan) mount, laid out at the stride
 * `rowStrideClassName` gives an invisible probe. The list needs no scroller of
 * its own, so it also works inside a virtualized timeline item. A row holding
 * keyboard focus stays mounted when scrolled away.
 */
export function WindowedRows<Row>(props: {
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row) => string;
  renderRow: (row: Row) => ReactNode;
  virtualized: boolean;
  /** Sizes the probe to one row and the gap after it, e.g. `h-6.5` for 24px rows 2px apart. */
  rowStrideClassName: string;
  /** Lays out rows in normal flow when not virtualized, e.g. `flex flex-col gap-0.5`. */
  className?: string;
}) {
  const { rows, rowKey, renderRow, virtualized } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState(INITIAL_RANGE);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const probe = probeRef.current;
    if (!virtualized || !container || !probe) return;

    // The rows in view are those inside every ancestor that clips them. The
    // first `overflow: auto` ancestor is not always the scroller: an element
    // with only `overflow-x: hidden` computes `overflow-y: auto` too.
    const ancestors: HTMLElement[] = [];
    for (let parent = container.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(parent);
    }
    const clippingAncestors = ancestors.filter(
      (ancestor) => getComputedStyle(ancestor).overflowY !== "visible",
    );

    const measure = () => {
      // The layout height: rows are placed in the list's own (untransformed) space.
      const rowStride = Number.parseFloat(getComputedStyle(probe).height);
      if (!(rowStride > 0)) return;
      let viewportTop = 0;
      let viewportBottom = document.documentElement.clientHeight;
      for (const ancestor of clippingAncestors) {
        const top = ancestor.getBoundingClientRect().top + ancestor.clientTop;
        viewportTop = Math.max(viewportTop, top);
        viewportBottom = Math.min(viewportBottom, top + ancestor.clientHeight);
      }
      const listTop = container.getBoundingClientRect().top;
      const start = Math.max(
        0,
        Math.min(rows.length, Math.floor((viewportTop - listTop) / rowStride) - ROW_OVERSCAN),
      );
      const end = Math.max(
        start,
        Math.min(rows.length, Math.ceil((viewportBottom - listTop) / rowStride) + ROW_OVERSCAN),
      );
      setRange((current) =>
        current.start === start && current.end === end && current.rowStride === rowStride
          ? current
          : { start, end, rowStride },
      );
    };
    measure();

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    // Scroll events do not bubble; capturing them on the document sees every
    // scroller. A transform moves rows without a scroll or a resize: a card that
    // scales in shifts a tall list's top by hundreds of pixels until it ends.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("animationend", onScroll, true);
    document.addEventListener("transitionend", onScroll, true);
    window.addEventListener("resize", onScroll);
    // Content above the list (a streaming message, a timeline item resizing)
    // moves it without a scroll, so watch every ancestor's size too. Resizes
    // land before paint: render the new window in the same frame.
    const resizeObserver = new ResizeObserver(() => flushSync(measure));
    for (const element of [container, probe, ...ancestors]) resizeObserver.observe(element);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("animationend", onScroll, true);
      document.removeEventListener("transitionend", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [virtualized, rows.length]);

  const start = virtualized ? Math.min(range.start, rows.length) : 0;
  const end = virtualized ? Math.min(range.end, rows.length) : rows.length;
  const indices: number[] = [];
  for (let index = start; index < end; index += 1) indices.push(index);
  // Keep keyboard focus on its row when mouse scrolling moves it outside the window.
  if (virtualized && focusedKey !== null) {
    const focusedIndex = rows.findIndex((row) => rowKey(row) === focusedKey);
    if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
    if (focusedIndex >= end) indices.push(focusedIndex);
  }

  return (
    <div
      ref={containerRef}
      className={virtualized ? "relative" : props.className}
      style={virtualized ? { height: rows.length * range.rowStride } : undefined}
      onFocusCapture={(event) => {
        const row = (event.target as Element).closest<HTMLElement>("[data-windowed-row]");
        setFocusedKey(row?.dataset.windowedRow ?? null);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null);
      }}
    >
      {virtualized ? (
        <div
          ref={probeRef}
          aria-hidden="true"
          className={cn("pointer-events-none invisible absolute", props.rowStrideClassName)}
        />
      ) : null}
      {indices.map((index) => {
        const row = rows[index]!;
        const key = rowKey(row);
        return (
          <div
            key={key}
            data-windowed-row={key}
            className={virtualized ? "absolute inset-x-0" : undefined}
            style={virtualized ? { top: index * range.rowStride } : undefined}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );
}
