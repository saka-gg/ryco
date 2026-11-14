import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  centerElement,
  findDiffLineElement,
  nextFrame,
  renderedLineRange,
} from "../components/pullRequests/files/diffReveal";
import {
  adjacentDiffHunkIndex,
  firstBelow,
  type DiffHunkAnchor,
} from "../lib/diffReviewNavigation";

const DIFF_SCROLLER_SELECTOR = ".diff-render-surface";
/** A revealed hunk sits on the reading line; this much drift still counts as on it. */
const READING_LINE_TOLERANCE_PX = 4;

function fileSection(root: ParentNode, fileIndex: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-diff-file-index="${fileIndex}"]`);
}

/**
 * Whether a hunk starts below `line` (a viewport y). Files above or below the line answer from
 * their section's box; in the file under the line, a rendered row answers exactly, an
 * unrendered one by where its number falls against the rows pierre drew.
 */
function hunkStartsBelow(root: ParentNode, anchor: DiffHunkAnchor, line: number): boolean {
  const section = fileSection(root, anchor.fileIndex);
  if (!section) return true;
  const box = section.getBoundingClientRect();
  if (box.top > line) return true;
  if (box.bottom <= line) return false;
  const row = findDiffLineElement(section, anchor.side, anchor.line);
  const rowBox = row?.getBoundingClientRect();
  if (rowBox && rowBox.height > 0) return rowBox.top > line;
  const range = renderedLineRange(section, anchor.side);
  return range === null || anchor.line > range.max;
}

/**
 * Keys that scroll the diff. Hunk steps use Alt, so a modified key is not one; a text field
 * keeps the keys for its caret.
 */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

function isScrollKey(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || !SCROLL_KEYS.has(event.key)) return false;
  const target = event.target;
  return !(
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}

const MAX_REVEAL_ATTEMPTS = 16;
/**
 * How long a jump waits for pierre to draw a file it has not drawn a row of yet. Counted in
 * attempts, as the approach steps are, that wait ran out on a busy machine and the jump landed
 * on the file's top instead of its hunk.
 */
const FIRST_DRAW_TIMEOUT_MS = 5_000;
/**
 * Pierre's virtualizer (1.6.2) can leave a file that scrolled into view blank until its scroll
 * window moves again. Every this many waiting rounds the scroller moves by one pixel, which the
 * next round's estimate takes back.
 */
const FIRST_DRAW_NUDGE_ROUNDS = 4;

/** Whether pierre has drawn any row of the file yet, on either side. */
function hasDrawnRows(section: HTMLElement): boolean {
  return (
    renderedLineRange(section, "additions") !== null ||
    renderedLineRange(section, "deletions") !== null
  );
}

/**
 * Scrolls a hunk's first changed row to the middle of the scroller. Pierre draws only the rows
 * near the viewport, and a partial patch's line numbers jump between hunks, so an unrendered
 * hunk is approached from its place among the file's rows (`offset`), then by half a screen
 * at a time toward its line, until pierre has drawn it. Waiting for a blank file's first rows
 * spends no attempt.
 */
async function revealHunk(
  scroller: HTMLElement,
  section: HTMLElement,
  anchor: DiffHunkAnchor,
  signal: AbortSignal,
): Promise<HTMLElement | null> {
  let estimated = false;
  const firstDrawDeadline = performance.now() + FIRST_DRAW_TIMEOUT_MS;
  let firstDrawRounds = 0;
  for (let attempt = 0; attempt < MAX_REVEAL_ATTEMPTS;) {
    if (signal.aborted || !section.isConnected) return null;
    const row = findDiffLineElement(section, anchor.side, anchor.line);
    if (row && row.getBoundingClientRect().height > 0) {
      centerElement(scroller, row);
      await nextFrame();
      return signal.aborted ? null : row;
    }
    const range = renderedLineRange(section, anchor.side);
    const awaitingFirstDraw = estimated && range === null && !hasDrawnRows(section);
    if (awaitingFirstDraw && performance.now() > firstDrawDeadline) return null;
    if (!estimated || range === null) {
      estimated = true;
      const box = section.getBoundingClientRect();
      const top = box.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = top + anchor.offset * box.height - scroller.clientHeight / 2;
    } else if (anchor.line > range.max) {
      scroller.scrollTop += scroller.clientHeight / 2;
    } else if (anchor.line < range.min) {
      scroller.scrollTop -= scroller.clientHeight / 2;
    } else if (attempt > 3) {
      // Inside the drawn rows but absent: not a row of this diff.
      return null;
    }
    if (awaitingFirstDraw) {
      firstDrawRounds += 1;
      if (firstDrawRounds % FIRST_DRAW_NUDGE_ROUNDS === 0) {
        // At the end of the scroll range a pixel down is clamped away: move up instead.
        const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 0.5;
        scroller.scrollTop += atEnd ? -1 : 1;
      }
    } else {
      attempt += 1;
    }
    await nextFrame();
    await nextFrame();
  }
  return null;
}

/**
 * `revealHunk`, ended by the reader taking over the panel (`controller` aborts). A jump waiting
 * for a blank file sets the scroll position every round, and would keep pulling a reader who
 * scrolled away back.
 */
async function revealUntilTakeover(
  root: HTMLElement,
  scroller: HTMLElement,
  section: HTMLElement,
  anchor: DiffHunkAnchor,
  controller: AbortController,
): Promise<HTMLElement | null> {
  const takeover = new AbortController();
  const listening = { signal: takeover.signal, passive: true } as const;
  const cancel = () => controller.abort();
  root.addEventListener("wheel", cancel, listening);
  root.addEventListener("touchstart", cancel, listening);
  root.addEventListener("pointerdown", cancel, listening);
  root.addEventListener(
    "keydown",
    (event) => {
      if (isScrollKey(event)) controller.abort();
    },
    listening,
  );
  try {
    return await revealHunk(scroller, section, anchor, controller.signal);
  } finally {
    takeover.abort();
  }
}

/**
 * Previous/next hunk for the diff panel. The reading line is the middle of the scroller, where
 * a jump centers its hunk.
 */
export function useDiffHunkNavigation(input: {
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly anchors: readonly DiffHunkAnchor[];
  readonly enabled: boolean;
}) {
  const { viewportRef, anchors, enabled } = input;
  // The first hunk below the reading line, measured on scroll.
  const [below, setBelow] = useState(0);
  // The hunk the last jump revealed, and the scroll position it left (null while revealing).
  const cursorRef = useRef<{
    readonly anchors: readonly DiffHunkAnchor[];
    readonly index: number;
    scrollTop: number | null;
  } | null>(null);
  const revealRef = useRef<AbortController | null>(null);

  const readingLine = useCallback((scroller: HTMLElement) => {
    const box = scroller.getBoundingClientRect();
    return box.top + box.height / 2 + READING_LINE_TOLERANCE_PX;
  }, []);

  const cursorIndex = useCallback(
    (scroller: HTMLElement): number | null => {
      const cursor = cursorRef.current;
      if (!cursor || cursor.anchors !== anchors) return null;
      if (cursor.scrollTop !== null && Math.abs(scroller.scrollTop - cursor.scrollTop) > 2)
        return null;
      return cursor.index;
    },
    [anchors],
  );

  useEffect(() => {
    const root = viewportRef.current;
    const scroller = root?.querySelector<HTMLElement>(DIFF_SCROLLER_SELECTOR);
    if (!enabled || anchors.length === 0 || !root || !scroller) {
      setBelow(0);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (scroller.clientHeight === 0) return;
      const cursor = cursorIndex(scroller);
      if (cursor !== null) {
        setBelow(cursor + 1);
        return;
      }
      const line = readingLine(scroller);
      setBelow(firstBelow(anchors.length, (index) => hunkStartsBelow(root, anchors[index]!, line)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // Files grow as pierre draws them, which moves hunks without a scroll.
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    for (const section of root.querySelectorAll("[data-diff-file-index]"))
      observer.observe(section);
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
      // A diff that changes under a jump ends it (a file folded, a live turn's update): its
      // hunk may be gone or elsewhere.
      revealRef.current?.abort();
    };
  }, [anchors, cursorIndex, enabled, readingLine, viewportRef]);

  useEffect(
    () => () => {
      revealRef.current?.abort();
    },
    [],
  );

  const reveal = useCallback(
    async (index: number) => {
      const root = viewportRef.current;
      const scroller = root?.querySelector<HTMLElement>(DIFF_SCROLLER_SELECTOR);
      const anchor = anchors[index];
      const section = anchor && root ? fileSection(root, anchor.fileIndex) : null;
      if (!root || !scroller || !anchor || !section) return;
      revealRef.current?.abort();
      const controller = new AbortController();
      revealRef.current = controller;
      const cursor = { anchors, index, scrollTop: null as number | null };
      cursorRef.current = cursor;
      setBelow(index + 1);
      const row = await revealUntilTakeover(root, scroller, section, anchor, controller);
      if (controller.signal.aborted) return;
      // Not a rendered line (an unusual hunk): the file's start is the next best place.
      if (!row) section.scrollIntoView({ block: "start", behavior: "instant" });
      cursor.scrollTop = scroller.scrollTop;
    },
    [anchors, viewportRef],
  );

  const go = useCallback(
    (direction: 1 | -1) => {
      const root = viewportRef.current;
      const scroller = root?.querySelector<HTMLElement>(DIFF_SCROLLER_SELECTOR);
      if (!root || !scroller) return;
      const line = readingLine(scroller);
      const target = adjacentDiffHunkIndex({
        count: anchors.length,
        direction,
        cursor: cursorIndex(scroller),
        isBelow: (index) => hunkStartsBelow(root, anchors[index]!, line),
      });
      if (target !== null) void reveal(target);
    },
    [anchors, cursorIndex, readingLine, reveal, viewportRef],
  );

  const count = anchors.length;
  const current = Math.min(below, count) - 1;
  return {
    count,
    canPrevious: enabled && current - 1 >= 0,
    canNext: enabled && current + 1 < count,
    go,
    reveal,
  };
}
