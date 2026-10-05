import { useLayoutEffect, useState, type RefObject } from "react";

/** An element's content width, tracked with a ResizeObserver; `initialWidth` until measured. */
export function useElementWidth(
  ref: RefObject<HTMLElement | null>,
  initialWidth: number | (() => number),
): number {
  const [width, setWidth] = useState(initialWidth);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
