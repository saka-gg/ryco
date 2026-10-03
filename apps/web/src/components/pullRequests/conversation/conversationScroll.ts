import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { usePullRequestReaderStore } from "../pullRequestsLayoutStore";
import { usePullRequestsShortcut } from "../pullRequestsShortcuts";

/**
 * Scroll behaviour of the Conversation pane: reporting the masthead's
 * visibility to the bar, remembering the scroll offset per pull request,
 * landing on a linked thread, and N/P between unresolved threads.
 */

const FLASH_CLASS = "pr-thread-flash";
const FLASH_MS = 1600;
const THREAD_SELECTOR = "[data-pr-thread]";
const UNRESOLVED_THREAD_SELECTOR = "[data-pr-thread][data-unresolved]";

/** Replays the landing ring on `element` (a static ring under reduced motion). */
export function flashThread(element: HTMLElement): void {
  element.classList.remove(FLASH_CLASS);
  // Restart the animation when the same thread is flashed twice in a row.
  void element.offsetWidth;
  element.classList.add(FLASH_CLASS);
  window.setTimeout(() => element.classList.remove(FLASH_CLASS), FLASH_MS);
}

/** Scrolls `root` so `element` sits in the upper third of the pane (instantly: the flash marks it). */
export function scrollThreadIntoView(root: HTMLElement, element: HTMLElement): void {
  const rootRect = root.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const offset = Math.max(24, Math.min(160, (root.clientHeight - rect.height) / 3));
  root.scrollTop += rect.top - rootRect.top - offset;
}

function findThread(root: HTMLElement, threadId: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(THREAD_SELECTOR)) {
    if (element.dataset.prThread === threadId) return element;
  }
  return null;
}

/**
 * Reports whether the masthead has scrolled out above the pane, so the bar
 * can show the title (#5 in the motion table).
 */
export function useMastheadVisibility(input: {
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly mastheadRef: RefObject<HTMLElement | null>;
  readonly readerKey: string | null;
  readonly enabled: boolean;
}): void {
  const { scrollRef, mastheadRef, readerKey, enabled } = input;
  const setMastheadHidden = usePullRequestReaderStore((state) => state.setMastheadHidden);
  useEffect(() => {
    if (!readerKey) return;
    const root = scrollRef.current;
    const masthead = mastheadRef.current;
    if (!enabled || !root || !masthead || typeof IntersectionObserver === "undefined") {
      setMastheadHidden(readerKey, false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        const rootTop = entry.rootBounds?.top ?? root.getBoundingClientRect().top;
        setMastheadHidden(
          readerKey,
          !entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop + 1,
        );
      },
      { root, threshold: 0 },
    );
    observer.observe(masthead);
    return () => observer.disconnect();
  }, [enabled, mastheadRef, readerKey, scrollRef, setMastheadHidden]);
}

/**
 * Remembers the pane's scroll offset per pull request (the reader remounts
 * per selection) and restores it once the content is there. The first
 * wheel, touch or key press hands control back to the reader.
 */
export function useConversationScrollMemory(input: {
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly readerKey: string | null;
  /** Detail and activity have loaded (or failed): the content has its height. */
  readonly settled: boolean;
  /** A deep link owns the initial position. */
  readonly skip: boolean;
}): void {
  const { scrollRef, readerKey, settled, skip } = input;
  const setScrollTop = usePullRequestReaderStore((state) => state.setScrollTop);
  const pendingRef = useRef<number | null>(null);
  const initializedRef = useRef(false);
  const lastTopRef = useRef(0);

  useLayoutEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (readerKey && !skip) {
        const stored =
          usePullRequestReaderStore.getState().scrollTop[`${readerKey}\0conversation`] ?? 0;
        if (stored > 0) pendingRef.current = stored;
      }
    }
    const root = scrollRef.current;
    const target = pendingRef.current;
    if (!root || target === null) return;
    root.scrollTop = target;
    if (settled || Math.abs(root.scrollTop - target) < 1) pendingRef.current = null;
  }, [readerKey, scrollRef, settled, skip]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !readerKey) return;
    let timer: number | undefined;
    const onScroll = () => {
      lastTopRef.current = root.scrollTop;
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setScrollTop(readerKey, "conversation", lastTopRef.current),
        150,
      );
    };
    const release = () => {
      pendingRef.current = null;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("wheel", release, { passive: true });
    root.addEventListener("touchstart", release, { passive: true });
    root.addEventListener("keydown", release);
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", release);
      root.removeEventListener("touchstart", release);
      root.removeEventListener("keydown", release);
      setScrollTop(readerKey, "conversation", lastTopRef.current);
    };
  }, [readerKey, scrollRef, setScrollTop]);
}

/**
 * Lands on the thread named by the URL's `thread` (#16): scrolls it into the
 * upper third of the pane and flashes it, once per thread id.
 */
export function useThreadReveal(input: {
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly threadId: string | undefined;
  readonly ready: boolean;
}): void {
  const { scrollRef, threadId, ready } = input;
  const handledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId || !ready || handledRef.current === threadId) return;
    const root = scrollRef.current;
    const element = root ? findThread(root, threadId) : null;
    if (!root || !element) return;
    handledRef.current = threadId;
    scrollThreadIntoView(root, element);
    flashThread(element);
  }, [ready, scrollRef, threadId]);
}

/** N / P: the next or previous unresolved thread in the timeline, wrapping around. */
export function useUnresolvedThreadKeys(scrollRef: RefObject<HTMLElement | null>): void {
  const currentRef = useRef<string | null>(null);
  const step = (offset: 1 | -1): boolean => {
    const root = scrollRef.current;
    if (!root) return false;
    const threads = [...root.querySelectorAll<HTMLElement>(UNRESOLVED_THREAD_SELECTOR)];
    if (threads.length === 0) return false;
    let index = threads.findIndex((element) => element.dataset.prThread === currentRef.current);
    if (index !== -1) {
      index = (index + offset + threads.length) % threads.length;
    } else {
      // Nothing visited yet: pick relative to what is on screen.
      const top = root.getBoundingClientRect().top;
      const positions = threads.map((element) => element.getBoundingClientRect().top - top);
      if (offset === 1) {
        index = positions.findIndex((position) => position > 8);
        if (index === -1) index = 0;
      } else {
        index = positions.findLastIndex((position) => position < -8);
        if (index === -1) index = threads.length - 1;
      }
    }
    const target = threads[index];
    if (!target) return false;
    currentRef.current = target.dataset.prThread ?? null;
    scrollThreadIntoView(root, target);
    flashThread(target);
    return true;
  };
  usePullRequestsShortcut("n", () => step(1), { tab: "conversation" });
  usePullRequestsShortcut("p", () => step(-1), { tab: "conversation" });
}
