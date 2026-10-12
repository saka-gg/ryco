import { useEffect, useRef, useState } from "react";

type ViewportIntersectionRef = (node: Element | null) => void;
type IntersectionListener = (entry: IntersectionObserverEntry) => void;

/**
 * Hysteresis for rows whose visibility gates a live subscription (git status,
 * change-request detail): fling-scrolling past a row never subscribes, and a
 * row scrolled briefly out of view keeps its stream instead of dropping it and
 * forcing the server to recompute status when it scrolls back.
 */
export const SOURCE_CONTROL_VISIBILITY_HYSTERESIS = {
  enterDelayMs: 150,
  exitDelayMs: 60_000,
} as const;

interface SharedIntersectionObserver {
  readonly ctor: typeof IntersectionObserver;
  readonly observer: IntersectionObserver;
  readonly listeners: Map<Element, Set<IntersectionListener>>;
}

// One observer per root margin for every sidebar and inbox row, instead of
// one observer per row (hundreds at boot with both panes populated).
const sharedObservers = new Map<string, SharedIntersectionObserver>();

function observeViewportIntersection(
  node: Element,
  rootMargin: string,
  listener: IntersectionListener,
): () => void {
  const ctor = globalThis.IntersectionObserver;
  let shared = sharedObservers.get(rootMargin);
  if (shared !== undefined && shared.ctor !== ctor) {
    // The global was replaced (tests stub it): never mix implementations.
    shared.observer.disconnect();
    sharedObservers.delete(rootMargin);
    shared = undefined;
  }
  if (shared === undefined) {
    const listeners = new Map<Element, Set<IntersectionListener>>();
    const observer = new ctor(
      (entries) => {
        for (const entry of entries) {
          const targetListeners = listeners.get(entry.target);
          if (targetListeners === undefined) continue;
          // Set iteration tolerates a listener removing itself mid-loop.
          for (const targetListener of targetListeners) targetListener(entry);
        }
      },
      { rootMargin },
    );
    shared = { ctor, observer, listeners };
    sharedObservers.set(rootMargin, shared);
  }
  const current = shared;
  let nodeListeners = current.listeners.get(node);
  if (nodeListeners === undefined) {
    nodeListeners = new Set();
    current.listeners.set(node, nodeListeners);
    current.observer.observe(node);
  }
  nodeListeners.add(listener);

  return () => {
    const registered = current.listeners.get(node);
    if (registered === undefined || !registered.delete(listener)) return;
    if (registered.size > 0) return;
    current.listeners.delete(node);
    if (current.listeners.size === 0) {
      current.observer.disconnect();
      if (sharedObservers.get(rootMargin) === current) sharedObservers.delete(rootMargin);
      return;
    }
    current.observer.unobserve(node);
  };
}

function isNearViewport(node: Element, rootMargin: string): boolean {
  if (node.getClientRects().length === 0) return false;
  const margin = Number.parseFloat(rootMargin) || 0;
  const rect = node.getBoundingClientRect();
  return (
    rect.bottom >= -margin &&
    rect.top <= window.innerHeight + margin &&
    rect.right >= 0 &&
    rect.left <= window.innerWidth
  );
}

export function useHasIntersectedViewport(
  rootMargin = "160px 0px",
): [ViewportIntersectionRef, boolean] {
  const [node, setNode] = useState<Element | null>(null);
  const [hasIntersected, setHasIntersected] = useState(false);

  useEffect(() => {
    if (hasIntersected || node === null) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setHasIntersected(true);
      return;
    }

    return observeViewportIntersection(node, rootMargin, (entry) => {
      if (entry.isIntersecting) {
        setHasIntersected(true);
      }
    });
  }, [hasIntersected, node, rootMargin]);

  return [setNode, hasIntersected];
}

export function useIsIntersectingViewport(
  rootMargin = "160px 0px",
  hysteresis: { readonly enterDelayMs?: number; readonly exitDelayMs?: number } = {},
): [ViewportIntersectionRef, boolean] {
  const [node, setNode] = useState<Element | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);
  // The value last handed to React, readable from observer callbacks.
  const isIntersectingRef = useRef(false);
  const enterDelayMs = hysteresis.enterDelayMs ?? 0;
  const exitDelayMs = hysteresis.exitDelayMs ?? 0;

  useEffect(() => {
    const setVisible = (next: boolean) => {
      isIntersectingRef.current = next;
      setIsIntersecting(next);
    };
    if (node === null) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      const updateIntersection = () => {
        setVisible(isNearViewport(node, rootMargin));
      };
      updateIntersection();
      window.addEventListener("resize", updateIntersection);
      window.addEventListener("scroll", updateIntersection, true);
      return () => {
        window.removeEventListener("resize", updateIntersection);
        window.removeEventListener("scroll", updateIntersection, true);
      };
    }

    let pending: ReturnType<typeof setTimeout> | null = null;
    const cancelPending = () => {
      if (pending !== null) {
        clearTimeout(pending);
        pending = null;
      }
    };
    const stopObserving = observeViewportIntersection(node, rootMargin, (entry) => {
      cancelPending();
      const next = entry.isIntersecting;
      // Already in that state (offscreen at mount, or back in view before the
      // exit delay ran out): nothing to schedule.
      if (next === isIntersectingRef.current) return;
      const delayMs = next ? enterDelayMs : exitDelayMs;
      if (delayMs <= 0) {
        setVisible(next);
        return;
      }
      pending = setTimeout(() => {
        pending = null;
        setVisible(next);
      }, delayMs);
    });
    return () => {
      cancelPending();
      stopObserving();
    };
  }, [enterDelayMs, exitDelayMs, node, rootMargin]);

  return [setNode, isIntersecting];
}
