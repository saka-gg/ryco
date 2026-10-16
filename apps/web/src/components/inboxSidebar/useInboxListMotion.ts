import {
  createContext,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { readMotionDurationMs } from "../../lib/perf/motion";

/** Row shells carry this attribute; the hook positions and animates them. */
export const INBOX_ROW_KEY_ATTRIBUTE = "data-inbox-row-key";
/** Dispatched (bubbling) by a row that starts leaving, so the highlight lets go. */
export const INBOX_ROW_LEAVING_EVENT = "inbox:row-leaving";

const GENTLE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** The house stack duration; appearance preferences zero it for reduced motion. */
export function readInboxMotionDurationMs(): number {
  return readMotionDurationMs("--app-motion-duration-stack", 260);
}

/**
 * Whether elements mounting now should animate in. Closed until the list's
 * first commit, so a fresh sidebar paints still and only later changes move.
 */
interface InboxMotionGate {
  ready: boolean;
  enabled: boolean;
}
export const InboxMotionContext = createContext<RefObject<InboxMotionGate> | null>(null);

/**
 * Animates an element in once, on mount, when the list's motion gate is open.
 * Callers key the element by its state so a state change remounts it.
 */
export function useInboxEnterAnimation<T extends Element>(
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
) {
  const gate = useContext(InboxMotionContext);
  const ref = useRef<T>(null);
  // Mount-only by design: the element is keyed by the state it shows, so the
  // animation captured at mount is the one to play.
  const [mountAnimation] = useState(() => ({ keyframes, options }));
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !gate?.current.ready || !gate.current.enabled) return;
    if (readInboxMotionDurationMs() === 0) return;
    node.animate(mountAnimation.keyframes, mountAnimation.options);
  }, [gate, mountAnimation]);
  return ref;
}

/** Each row's layout offset (`offsetTop`: transforms never read as movement). */
function readRowTops(list: HTMLElement): Map<string, number> {
  const tops = new Map<string, number>();
  for (const row of list.querySelectorAll<HTMLElement>(`[${INBOX_ROW_KEY_ATTRIBUTE}]`)) {
    tops.set(row.getAttribute(INBOX_ROW_KEY_ATTRIBUTE)!, row.offsetTop);
  }
  return tops;
}

/**
 * Motion for the inbox list:
 * - one highlight glides between hovered rows instead of each row fading its
 *   own background;
 * - when the row order changes (a thread finishes and moves to Recent, gets
 *   pinned, settles), rows glide from their old position, across sections.
 *
 * Positions are layout offsets (`offsetTop`), so scrolling and in-flight
 * transforms never read as movement.
 */
export function useInboxListMotion(input: {
  readonly enabled: boolean;
  readonly orderSignature: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef<HTMLElement | null>(null);
  const topsRef = useRef(new Map<string, number>());
  const signatureRef = useRef<string | null>(null);
  const gateRef = useRef<InboxMotionGate>({ ready: false, enabled: input.enabled });

  const placeHighlight = useCallback(() => {
    const highlight = highlightRef.current;
    if (!highlight) return;
    const row = hoveredRef.current;
    if (!row || !row.isConnected || row.dataset.settling !== undefined) {
      highlight.dataset.visible = "false";
      return;
    }
    const wasVisible = highlight.dataset.visible === "true";
    if (!wasVisible) highlight.style.transition = "none";
    // Horizontal too: folded delegated rows are indented under their host.
    highlight.style.transform = `translate(${row.offsetLeft}px, ${row.offsetTop}px)`;
    highlight.style.width = `${row.offsetWidth}px`;
    highlight.style.height = `${row.offsetHeight}px`;
    if (!wasVisible) {
      void highlight.offsetWidth;
      highlight.style.transition = "";
    }
    highlight.dataset.visible = "true";
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const row = (event.target as Element).closest<HTMLElement>(`[${INBOX_ROW_KEY_ATTRIBUTE}]`);
      if (row === hoveredRef.current) return;
      hoveredRef.current = row;
      placeHighlight();
    },
    [placeHighlight],
  );
  const onPointerLeave = useCallback(() => {
    hoveredRef.current = null;
    placeHighlight();
  }, [placeHighlight]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const release = () => placeHighlight();
    list.addEventListener(INBOX_ROW_LEAVING_EVENT, release);
    return () => list.removeEventListener(INBOX_ROW_LEAVING_EVENT, release);
  }, [placeHighlight]);

  // Row positions are re-read only when the order changed or the list resized
  // since the last read (a state line or badge changed a row's height). Most
  // commits (a streaming thread's summary, a clock tick) move nothing, and
  // reading every row's offset after each of them forced a layout per commit.
  const positionsDirtyRef = useRef(true);
  const resizeObserverRef = useRef<{ list: HTMLElement; observer: ResizeObserver } | null>(null);
  const observeListResizes = useCallback(
    (list: HTMLElement | null) => {
      const current = resizeObserverRef.current;
      if (current?.list === list) return;
      current?.observer.disconnect();
      resizeObserverRef.current = null;
      positionsDirtyRef.current = true;
      if (list === null || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => {
        // Layout is already computed here. A row changed height without a
        // reorder: refresh the resting positions now, so the next reorder
        // glides from where rows actually are, and keep the highlight on its row.
        if (signatureRef.current !== null && list.getClientRects().length > 0) {
          topsRef.current = readRowTops(list);
          positionsDirtyRef.current = false;
        } else {
          positionsDirtyRef.current = true;
        }
        placeHighlight();
      });
      observer.observe(list);
      resizeObserverRef.current = { list, observer };
    },
    [placeHighlight],
  );
  // Unmounted or hidden (an inactive sidebar pane's effects are torn down):
  // forget positions so the next visible reorder never glides from stale ones.
  useLayoutEffect(
    () => () => {
      resizeObserverRef.current?.observer.disconnect();
      resizeObserverRef.current = null;
      topsRef.current = new Map();
      signatureRef.current = null;
      positionsDirtyRef.current = true;
    },
    [],
  );

  // Runs after every commit, but reads layout only when something may have
  // moved; it is the only way to know where a row was before it moved to
  // another section.
  useLayoutEffect(() => {
    const list = listRef.current;
    observeListResizes(list);
    if (!list) return;
    const reordered =
      signatureRef.current !== null && signatureRef.current !== input.orderSignature;
    if (
      input.enabled &&
      signatureRef.current !== null &&
      !reordered &&
      !positionsDirtyRef.current
    ) {
      gateRef.current.ready = true;
      gateRef.current.enabled = input.enabled;
      return;
    }
    // Motion off, or the inbox is mounted but hidden (display: none reads every
    // offset as 0): skip the layout reads and forget positions, so the next
    // visible reorder never glides from stale coordinates.
    if (!input.enabled || list.getClientRects().length === 0) {
      topsRef.current = new Map();
      signatureRef.current = null;
      gateRef.current.ready = true;
      gateRef.current.enabled = false;
      return;
    }
    const duration = reordered ? readInboxMotionDurationMs() : 0;
    const previous = topsRef.current;
    const next = new Map<string, number>();
    for (const row of list.querySelectorAll<HTMLElement>(`[${INBOX_ROW_KEY_ATTRIBUTE}]`)) {
      const key = row.getAttribute(INBOX_ROW_KEY_ATTRIBUTE)!;
      const top = row.offsetTop;
      next.set(key, top);
      if (duration === 0) continue;
      const before = previous.get(key);
      if (before === undefined) {
        row.animate(
          [
            { opacity: 0, transform: "translateY(-4px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration,
            easing: GENTLE,
          },
        );
      } else if (Math.abs(before - top) > 0.5) {
        row.animate(
          [{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }],
          { duration: duration * 1.6, easing: GENTLE },
        );
      }
    }
    topsRef.current = next;
    signatureRef.current = input.orderSignature;
    positionsDirtyRef.current = false;
    // Child layout effects of this commit already ran with the gate closed.
    gateRef.current.ready = true;
    gateRef.current.enabled = input.enabled;
    placeHighlight();
  });

  return { listRef, highlightRef, gateRef, onPointerMove, onPointerLeave };
}

/*
 * A single one-second clock shared by every running row, alive only while a
 * running row is mounted.
 */
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockNow = Date.now();

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const notify of clockListeners) notify();
    }, 1000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

// Between ticks the snapshot is the last tick; with no clock running, a fresh
// second (stable within the second, as useSyncExternalStore requires).
const readClock = () => {
  if (clockTimer === null) clockNow = Math.floor(Date.now() / 1000) * 1000;
  return clockNow;
};

export function useInboxClock(): number {
  return useSyncExternalStore(subscribeClock, readClock, readClock);
}
