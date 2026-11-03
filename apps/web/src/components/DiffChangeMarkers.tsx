import { memo, useEffect, useState, type RefObject } from "react";

import { cn } from "~/lib/utils";
import {
  DIFF_CHANGE_MARKER_HEIGHT_PX,
  layoutDiffChangeMarkers,
  type DiffChangeMarker,
  type DiffHunkAnchor,
  type DiffHunkKind,
} from "../lib/diffReviewNavigation";

const MARKER_TONE: Record<DiffHunkKind, string> = {
  added: "bg-success",
  removed: "bg-destructive",
  modified: "bg-warning",
};

const MARKER_LABEL: Record<DiffHunkKind, string> = {
  added: "Added lines",
  removed: "Deleted lines",
  modified: "Changed lines",
};

/**
 * Scrollbar markers for the diff panel: one tick per hunk (overlapping ones merge), placed by
 * where the hunk sits in its file's section and scaled to the scroller's height. A click
 * reveals that hunk; the keyboard path is previous/next hunk (Alt+Up/Down).
 */
export const DiffChangeMarkers = memo(function DiffChangeMarkers(props: {
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly anchors: readonly DiffHunkAnchor[];
  readonly onReveal: (index: number) => void;
}) {
  const { anchors, viewportRef } = props;
  const [markers, setMarkers] = useState<readonly DiffChangeMarker[]>([]);

  useEffect(() => {
    const root = viewportRef.current;
    const scroller = root?.querySelector<HTMLElement>(".diff-render-surface");
    if (!root || !scroller || anchors.length === 0) {
      setMarkers([]);
      return;
    }
    const readSections = () =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-diff-file-index]"));
    let frame = 0;
    const measure = () => {
      frame = 0;
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const boxes = new Map<number, { readonly top: number; readonly height: number }>();
      // Read again each time: a theme switch remounts the sections.
      for (const section of readSections()) {
        const box = section.getBoundingClientRect();
        boxes.set(Number(section.dataset.diffFileIndex), {
          top: box.top - origin,
          height: box.height,
        });
      }
      const next = layoutDiffChangeMarkers({
        anchors,
        contentTop: (index) => {
          const anchor = anchors[index]!;
          const box = boxes.get(anchor.fileIndex);
          return box ? box.top + anchor.offset * box.height : null;
        },
        scrollHeight: scroller.scrollHeight,
        trackHeight: scroller.clientHeight,
      });
      setMarkers((current) =>
        current.length === next.length &&
        current.every(
          (marker, index) =>
            marker.index === next[index]!.index && Math.abs(marker.top - next[index]!.top) < 0.5,
        )
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // Markers follow the layout (files drawing, folding, resizing), not the scroll position.
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    // The scroller's content box grows and shrinks with every file in it.
    for (const child of scroller.children) observer.observe(child);
    for (const section of readSections()) observer.observe(section);
    schedule();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [anchors, viewportRef]);

  if (markers.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Hunk markers"
      className="pointer-events-none absolute inset-y-0 right-[10px] z-10 w-[6px]"
    >
      {markers.map((marker) => (
        <button
          key={marker.index}
          type="button"
          // Alt+Up/Down is the keyboard path; a tab stop per hunk would bury the panel's controls.
          tabIndex={-1}
          aria-label={`${MARKER_LABEL[marker.kind]}: hunk ${marker.index + 1} of ${anchors.length}`}
          data-hunk-marker={marker.kind}
          className={cn(
            "pointer-events-auto absolute left-0 w-full cursor-pointer rounded-full opacity-70 transition-opacity hover:opacity-100",
            MARKER_TONE[marker.kind],
          )}
          style={{ top: `${marker.top}px`, height: `${DIFF_CHANGE_MARKER_HEIGHT_PX}px` }}
          onClick={() => props.onReveal(marker.index)}
        />
      ))}
    </div>
  );
});
