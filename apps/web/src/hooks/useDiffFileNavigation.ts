import { useCallback, useEffect, useState, type RefObject } from "react";

export function adjacentDiffFileIndex(
  count: number,
  current: number,
  direction: -1 | 1,
): number | null {
  const target = current + direction;
  return target >= 0 && target < count ? target : null;
}

/** Find the last header at or above the viewport top, using logarithmic layout reads. */
export function visibleDiffFileIndex(
  count: number,
  topAt: (index: number) => number,
  threshold: number,
): number {
  if (count === 0) return -1;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (topAt(middle) <= threshold) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

export function useDiffFileNavigation(
  viewportRef: RefObject<HTMLElement | null>,
  paths: readonly string[],
  enabled: boolean,
) {
  const [visiblePath, setVisiblePath] = useState<string | null>(null);
  useEffect(() => {
    const surface = viewportRef.current?.querySelector<HTMLElement>(".diff-render-surface");
    if (!enabled || !paths.length || !surface) {
      setVisiblePath(null);
      return;
    }
    // Cache the anchors between content changes, rather than querying on every scroll.
    const anchors = Array.from(surface.querySelectorAll<HTMLElement>("[data-diff-file-path]"));
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (surface.clientHeight === 0) return;
      const atBottom =
        surface.scrollTop > 0 &&
        surface.scrollHeight - surface.clientHeight - surface.scrollTop <= 1;
      const index = atBottom
        ? anchors.length - 1
        : visibleDiffFileIndex(
            anchors.length,
            (i) => anchors[i]!.getBoundingClientRect().top,
            surface.getBoundingClientRect().top + 8,
          );
      setVisiblePath(anchors[index]?.dataset.diffFilePath ?? null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    for (const anchor of anchors) observer.observe(anchor);
    surface.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      surface.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, paths, viewportRef]);

  const index = paths.length === 0 ? -1 : Math.max(0, paths.indexOf(visiblePath ?? ""));
  const jump = useCallback(
    (direction: -1 | 1) => {
      const target = adjacentDiffFileIndex(paths.length, index, direction);
      if (target === null) return;
      const anchor = Array.from(
        viewportRef.current?.querySelectorAll<HTMLElement>("[data-diff-file-path]") ?? [],
      ).find((element) => element.dataset.diffFilePath === paths[target]);
      if (!anchor) return;
      // Instant jumps avoid racing a second click against an in-progress smooth scroll.
      anchor.scrollIntoView({ block: "start", behavior: "instant" });
      setVisiblePath(paths[target]!);
    },
    [index, paths, viewportRef],
  );
  return {
    index,
    path: paths[index] ?? null,
    jump,
    canPrevious: adjacentDiffFileIndex(paths.length, index, -1) !== null,
    canNext: adjacentDiffFileIndex(paths.length, index, 1) !== null,
  };
}
