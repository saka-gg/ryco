import { useLayoutEffect, useState, type RefObject } from "react";

/** Track the element width, using a page-sized default until first measured. */
export function useElementWidth(
  ref: RefObject<HTMLElement | null>,
  initialWidth: number | (() => number) = () =>
    typeof window === "undefined" ? 1200 : Math.max(0, window.innerWidth - 260),
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
