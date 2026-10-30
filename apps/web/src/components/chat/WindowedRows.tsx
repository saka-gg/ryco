import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "~/lib/utils";

// Rows rendered beyond the scrolled viewport on each side.
const ROW_OVERSCAN = 8;
const INITIAL_RANGE = { start: 0, end: 40, rowStride: 26 };

/**
 * Renders a long list of equal-height rows: once `virtualized`, only the rows
 * inside the nearest scrolling ancestor's viewport (plus overscan) mount, laid
 * out at the stride `rowStrideClassName` gives an invisible probe. The list
 * needs no scroller of its own, so it also works inside a virtualized timeline
 * item. A row holding keyboard focus stays mounted when scrolled away.
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

    // Observe the ancestors up to the scroller too: content above the list (a
    // streaming message, a timeline item resizing) moves it without a scroll.
    const observed: HTMLElement[] = [container, probe];
    let scrollElement: HTMLElement | null = null;
    for (let parent = container.parentElement; parent; parent = parent.parentElement) {
      observed.push(parent);
      if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        scrollElement = parent;
        break;
      }
    }

    const measure = () => {
      const rowStride = probe.getBoundingClientRect().height;
      if (rowStride <= 0) return;
      const listTop = container.getBoundingClientRect().top;
      const viewportTop = scrollElement
        ? scrollElement.getBoundingClientRect().top + scrollElement.clientTop
        : 0;
      const viewportHeight = scrollElement?.clientHeight ?? document.documentElement.clientHeight;
      const start = Math.max(
        0,
        Math.min(rows.length, Math.floor((viewportTop - listTop) / rowStride) - ROW_OVERSCAN),
      );
      const end = Math.max(
        start,
        Math.min(
          rows.length,
          Math.ceil((viewportTop + viewportHeight - listTop) / rowStride) + ROW_OVERSCAN,
        ),
      );
      setRange((current) =>
        current.start === start && current.end === end && current.rowStride === rowStride
          ? current
          : { start, end, rowStride },
      );
    };
    measure();

    const scrollTarget: HTMLElement | Window = scrollElement ?? window;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // Resizes land before paint, so render the new window in the same frame.
    const resizeObserver = new ResizeObserver(() => flushSync(measure));
    for (const element of observed) resizeObserver.observe(element);
    return () => {
      scrollTarget.removeEventListener("scroll", onScroll);
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
