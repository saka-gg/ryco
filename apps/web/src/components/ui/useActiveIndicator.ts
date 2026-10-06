import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The nav's active marker: one element that travels between items instead of
 * each item toggling its own background, so moving between sections reads as
 * motion rather than a cut.
 */
export function useActiveIndicator(activeKey: string | null) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<{ top: number; height: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list || !activeKey) {
      setRect(null);
      return;
    }
    const element = list.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(activeKey)}"]`);
    if (!element) {
      setRect(null);
      return;
    }
    setRect((previous) =>
      previous?.top === element.offsetTop && previous.height === element.offsetHeight
        ? previous
        : { top: element.offsetTop, height: element.offsetHeight },
    );
  }, [activeKey]);
  useLayoutEffect(() => {
    measure();
  }, [measure]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Measured on the next frame so a resize never feeds back into the
    // observer within the same frame.
    let pending = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(measure);
    });
    observer.observe(list);
    // The first placement lands without sliding in from the top.
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(pending);
      cancelAnimationFrame(frame);
    };
  }, [measure]);
  return { listRef, rect, animate };
}
