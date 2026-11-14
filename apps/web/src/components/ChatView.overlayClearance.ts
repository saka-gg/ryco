import { type RefObject, useEffect } from "react";

/** Chat column custom properties carrying the floating bars' heights. */
export const COMPOSER_CLEARANCE_PROPERTY = "--chat-composer-clearance";
export const HEADER_CLEARANCE_PROPERTY = "--chat-header-clearance";

/**
 * Publishes `bar`'s rendered height plus a small gap on `host` as a CSS
 * variable. The size comes from the observer's notifications, which run once
 * layout is clean and before the first paint: reading the height here
 * directly would force a layout of the freshly committed tree on every
 * switch. `onResize` runs when a later change moves the clearance, not for the
 * first value. Returns the cleanup that drops the variable.
 */
export function publishOverlayClearance(
  host: HTMLElement,
  bar: HTMLElement,
  property: string,
  onResize?: () => void,
): () => void {
  let published: number | null = null;
  const apply = () => {
    const clearance = bar.offsetHeight + 8;
    host.style.setProperty(property, `${clearance}px`);
    const moved = published !== null && clearance !== published;
    published = clearance;
    if (moved) onResize?.();
  };
  const observer = new ResizeObserver(apply);
  observer.observe(bar);
  return () => {
    observer.disconnect();
    host.style.removeProperty(property);
  };
}

/**
 * Keeps `property` on `host` at `bar`'s height while the bar overlays the
 * transcript (`active`), and drops it otherwise. Runs again when the chat
 * surface mounts or unmounts, which replaces the elements.
 */
export function useOverlayClearance(
  hostRef: RefObject<HTMLElement | null>,
  barRef: RefObject<HTMLElement | null>,
  active: boolean,
  property: string,
  surfaceMounted: boolean,
  onResize?: () => void,
): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!active) {
      host.style.removeProperty(property);
      return;
    }
    const bar = barRef.current;
    if (!bar) return;
    return publishOverlayClearance(host, bar, property, onResize);
  }, [hostRef, barRef, active, property, surfaceMounted, onResize]);
}
