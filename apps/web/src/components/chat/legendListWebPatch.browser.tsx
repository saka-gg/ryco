// Covers the web-entry (`react.*`) sections of `patches/@legendapp%2Flist@3.3.10.patch` against the
// real list: the transcript reveals as soon as the initial end scroll lands (not after the
// list's 100 ms `platformScrollCompletion` fallback) and `getEstimatedItemSize` lays out rows that
// have not been measured yet. The props mirror `MessagesTimeline` (header and footer clearance,
// end anchoring, `estimatedItemSize={56}` with per-type averages).
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createRef, useLayoutEffect, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { findLegendListItemContainer } from "../../perf/timelineRevealObserver";

interface Row {
  readonly id: string;
  readonly kind: "user" | "assistant" | "work";
  readonly height: number;
}

const HEADER_HEIGHT = 48;
const FOOTER_HEIGHT = 140;
const VIEWPORT_HEIGHT = 860;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turns of a user message, 0-2 work rows and a heavy-tailed reply. Heights sit on the 1/8 px grid
// (like real text rows) unless `integer` is set.
function makeRows(name: string, seed: number, turns: number, integer = false): Row[] {
  const random = mulberry32(seed);
  const rows: Row[] = [];
  const push = (kind: Row["kind"], height: number) => {
    const rounded = integer ? Math.round(height) : Math.round(height * 8) / 8;
    rows.push({ id: `${name}-${rows.length}`, kind, height: rounded });
  };
  for (let turn = 0; turn < turns; turn += 1) {
    push("user", 64 + random() * 140);
    const workRows = Math.floor(random() * 3);
    for (let w = 0; w < workRows; w += 1) push("work", random() < 0.8 ? 32 : 32 + random() * 300);
    const tail = random();
    push(
      "assistant",
      tail < 0.7
        ? 90 + random() * 300
        : tail < 0.93
          ? 400 + random() * 600
          : 1000 + random() * 1500,
    );
  }
  return rows;
}

const totalHeight = (rows: readonly Row[]) =>
  rows.reduce((sum, row) => sum + row.height, 0) + HEADER_HEIGHT + FOOTER_HEIGHT;

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) await nextFrame();
}

interface HarnessProps {
  readonly rows: readonly Row[];
  readonly listRef: RefObject<LegendListRef | null>;
  readonly footerHeight?: number;
  readonly initialScrollOffset?: number;
  readonly getEstimatedItemSize?: (
    row: Row,
    index: number,
    type: string | undefined,
  ) => number | undefined;
  readonly onItemSizeChanged?: (info: { itemKey: string; size: number; previous: number }) => void;
  readonly onMounted?: () => void;
}

function Harness(props: HarnessProps) {
  const { listRef, onMounted } = props;
  // Runs after LegendList attached its ref, before the browser paints the first frame.
  useLayoutEffect(() => onMounted?.(), [onMounted]);
  return (
    <div style={{ position: "relative", height: VIEWPORT_HEIGHT, width: 800 }}>
      <LegendList<Row>
        ref={listRef}
        data={props.rows}
        keyExtractor={(row) => row.id}
        getItemType={(row) => row.kind}
        renderItem={({ item }) => (
          <div data-row-id={item.id} style={{ height: item.height }}>
            {item.id}
          </div>
        )}
        estimatedItemSize={56}
        recycleItems={false}
        {...(props.initialScrollOffset === undefined
          ? { initialScrollAtEnd: true }
          : { initialScrollOffset: props.initialScrollOffset })}
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.1}
        maintainVisibleContentPosition
        {...(props.getEstimatedItemSize
          ? { getEstimatedItemSize: props.getEstimatedItemSize }
          : {})}
        {...(props.onItemSizeChanged ? { onItemSizeChanged: props.onItemSizeChanged } : {})}
        style={{ height: "100%", overflowX: "hidden" }}
        ListHeaderComponent={<div style={{ height: HEADER_HEIGHT }} />}
        ListFooterComponent={<div style={{ height: props.footerHeight ?? FOOTER_HEIGHT }} />}
      />
    </div>
  );
}

function scrollNodeOf(listRef: RefObject<LegendListRef | null>): HTMLElement {
  const node = listRef.current?.getScrollableNode();
  if (!(node instanceof HTMLElement)) throw new Error("LegendList has no scroll node");
  return node;
}

// LegendList fades its item container in once `readyToRender` flips (`opacity: 0` until then).
function isRevealed(node: HTMLElement): boolean {
  const container = findLegendListItemContainer(node);
  return container !== undefined && container.style.opacity !== "0";
}

function distanceFromEnd(node: HTMLElement): number {
  return node.scrollHeight - node.clientHeight - node.scrollTop;
}

interface Mounted {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly rerender: (props: Omit<HarnessProps, "listRef">) => Promise<void>;
  readonly unmount: () => Promise<void>;
  /** Frames from the mount until the item container became visible (0: already at mount), or -1. */
  readonly revealFrame: number;
  /**
   * The scroller's `scrollTop` when `readyToRender` flipped to true: where the list stood when it
   * decided to reveal. Measured rows can move `scrollTop` a frame later while keeping the same rows
   * in view, so a later read depends on how long the test took to look.
   */
  readonly readyScrollTop: () => number;
  /** Whether LegendList's `readyToRender` signal was seen flipping to true. */
  readonly sawReadyToRender: () => boolean;
}

async function mountList(
  props: Omit<HarnessProps, "listRef" | "onMounted">,
  maxFrames: number,
): Promise<Mounted> {
  const listRef = createRef<LegendListRef>();
  let ready = false;
  let unlisten: (() => void) | undefined;
  // Frames are counted from the commit that mounted the list, not from when `render()`
  // returns: React's `act` can let a frame, and with it the reveal, pass before it does.
  let watching = false;
  let revealFrame = -1;
  let readyScrollTop = Number.NaN;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onMounted = () => {
    if (watching) return;
    watching = true;
    const node = scrollNodeOf(listRef);
    unlisten = listRef.current?.getState?.()?.listen?.("readyToRender", (value: boolean) => {
      if (!value || ready) return;
      ready = true;
      readyScrollTop = node.scrollTop;
    });
    if (isRevealed(node)) {
      revealFrame = 0;
      settle();
      return;
    }
    let frame = 0;
    const step = () => {
      frame += 1;
      if (isRevealed(node)) revealFrame = frame;
      if (revealFrame >= 0 || frame >= maxFrames) settle();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const screen = await render(<Harness {...props} listRef={listRef} onMounted={onMounted} />);
  await settled;
  return {
    listRef,
    revealFrame,
    readyScrollTop: () => readyScrollTop,
    sawReadyToRender: () => ready,
    rerender: async (next) => {
      await screen.rerender(<Harness {...next} listRef={listRef} />);
    },
    unmount: async () => {
      unlisten?.();
      await screen.unmount();
    },
  };
}

async function expectFooterChangeKeepsTheEndVisible(from: number, to: number): Promise<void> {
  const rows = makeRows("a", 1, 150);
  const mounted = await mountList({ rows, footerHeight: from }, 30);
  try {
    expect(mounted.revealFrame).toBeGreaterThan(0);
    await frames(2);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mounted.rerender({ rows, footerHeight: to });
    const node = scrollNodeOf(mounted.listRef);
    const hiddenFrames: number[] = [];
    for (let frame = 1; frame <= 10; frame += 1) {
      await nextFrame();
      if (!isRevealed(node)) hiddenFrames.push(frame);
    }
    expect(hiddenFrames).toEqual([]);
    expect(distanceFromEnd(node)).toBeLessThanOrEqual(2);
  } finally {
    await mounted.unmount();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LegendList web entry patch: initial end scroll arrival", () => {
  it("reveals an end-anchored list with a footer without the 100 ms fallback timer", async () => {
    // The fallback is a setTimeout; with timers frozen only a real arrival can reveal the list.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mounted = await mountList({ rows: makeRows("a", 1, 150) }, 10);
    try {
      const node = scrollNodeOf(mounted.listRef);
      expect(mounted.revealFrame).toBeGreaterThan(0);
      expect(mounted.sawReadyToRender()).toBe(true);
      expect(distanceFromEnd(node)).toBeLessThanOrEqual(1);
      // The list's own scroll agrees with the scroller (3.3.10 alone kept it one footer past it).
      const listScroll = mounted.listRef.current?.getState().scroll ?? -1;
      expect(Math.abs(listScroll - node.scrollTop)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("reveals without the fallback timer when the rows array is replaced while it opens", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const rows = makeRows("a", 1, 150);
    const listRef = createRef<LegendListRef>();
    const screen = await render(<Harness rows={rows} listRef={listRef} />);
    const node = scrollNodeOf(listRef);
    let revealFrame = -1;
    for (let frame = 1; frame <= 12 && revealFrame < 0; frame += 1) {
      // A thread view re-derives its rows while it opens: same rows, new array.
      if (frame <= 3) await screen.rerender(<Harness rows={[...rows]} listRef={listRef} />);
      await nextFrame();
      if (isRevealed(node)) revealFrame = frame;
    }
    try {
      expect(revealFrame).toBeGreaterThan(0);
      expect(distanceFromEnd(node)).toBeLessThanOrEqual(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the reader at the end when rows are prepended right after the reveal", async () => {
    const rows = makeRows("a", 1, 150);
    const mounted = await mountList({ rows }, 30);
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      await mounted.rerender({ rows: [...makeRows("older", 7, 8), ...rows] });
      await frames(6);
      const node = scrollNodeOf(mounted.listRef);
      expect(isRevealed(node)).toBe(true);
      expect(distanceFromEnd(node)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps following the end when rows are appended after the reveal", async () => {
    const rows = makeRows("a", 1, 150);
    const mounted = await mountList({ rows }, 30);
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      await mounted.rerender({ rows: [...rows, ...makeRows("newer", 9, 3)] });
      await frames(6);
      const node = scrollNodeOf(mounted.listRef);
      expect(isRevealed(node)).toBe(true);
      expect(distanceFromEnd(node)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("stays visible at the end when the footer grows after the reveal", async () => {
    await expectFooterChangeKeepsTheEndVisible(140, 220);
  });

  it("stays visible at the end when the footer shrinks after the reveal", async () => {
    // A shrinking composer clearance must not re-arm the initial scroll and hide the transcript.
    await expectFooterChangeKeepsTheEndVisible(220, 140);
  });

  it("reveals a list shorter than its viewport", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mounted = await mountList({ rows: makeRows("short", 3, 2) }, 10);
    try {
      const node = scrollNodeOf(mounted.listRef);
      expect(mounted.revealFrame).toBeGreaterThan(0);
      expect(node.scrollTop).toBe(0);
    } finally {
      await mounted.unmount();
    }
  });

  it("reveals an initialScrollOffset list at its offset without the fallback timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mounted = await mountList(
      { rows: makeRows("a", 1, 150), initialScrollOffset: 2_000 },
      10,
    );
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      expect(mounted.sawReadyToRender()).toBe(true);
      expect(Math.abs(mounted.readyScrollTop() - 2_000)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("leaves programmatic scrolls after the reveal as they were", async () => {
    const rows = makeRows("a", 1, 150);
    const mounted = await mountList({ rows }, 30);
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      const list = mounted.listRef.current;
      if (!list) throw new Error("list unmounted");
      const node = scrollNodeOf(mounted.listRef);

      await list.scrollToOffset({ offset: 0, animated: false });
      await frames(4);
      await list.scrollToIndex({ index: rows.length - 1, animated: true });
      await frames(4);
      // A jump to the last row still brings the footer (the composer clearance) into view.
      expect(distanceFromEnd(node)).toBeLessThanOrEqual(2);
      expect(list.getState().isAtEnd).toBe(true);

      await list.scrollToOffset({ offset: 0, animated: false });
      await frames(4);
      await list.scrollToEnd({ animated: true });
      await frames(4);
      expect(distanceFromEnd(node)).toBeLessThanOrEqual(2);
      expect(isRevealed(node)).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});

describe("LegendList web entry patch: getEstimatedItemSize", () => {
  it("lays out unmeasured rows at their estimated sizes", async () => {
    const rows = makeRows("est", 11, 140, true);
    expect(rows.length).toBeGreaterThan(350);
    const onItemSizeChanged = vi.fn();
    const mounted = await mountList(
      { rows, getEstimatedItemSize: (row) => row.height, onItemSizeChanged },
      30,
    );
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      const node = scrollNodeOf(mounted.listRef);
      // Without the prop the list would be ~rows × 56 px tall here.
      expect(Math.abs(node.scrollHeight - totalHeight(rows))).toBeLessThanOrEqual(2);
      // Every rendered row measured exactly what it was laid out with.
      expect(onItemSizeChanged).not.toHaveBeenCalled();
      expect(distanceFromEnd(node)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("falls back to the per-type averages when the estimate returns undefined", async () => {
    const rows = makeRows("est", 11, 140, true);
    const plain = await mountList({ rows }, 30);
    let plainHeight: number;
    try {
      plainHeight = scrollNodeOf(plain.listRef).scrollHeight;
    } finally {
      await plain.unmount();
    }

    const estimate = vi.fn(() => undefined);
    const mounted = await mountList({ rows, getEstimatedItemSize: estimate }, 30);
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      expect(estimate).toHaveBeenCalled();
      expect(scrollNodeOf(mounted.listRef).scrollHeight).toBe(plainHeight);
    } finally {
      await mounted.unmount();
    }
  });

  it("stops asking for the estimate of a row once it was measured", async () => {
    const rows = makeRows("est", 11, 140, true);
    const askedFor: string[] = [];
    const getEstimatedItemSize = (row: Row) => {
      askedFor.push(row.id);
      return row.height;
    };
    const mounted = await mountList({ rows, getEstimatedItemSize }, 30);
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      await frames(2);
      const measured = new Set(mounted.listRef.current?.getState().sizes.keys() ?? []);
      expect(measured.size).toBeGreaterThan(0);
      // The rows on screen were laid out from their estimates before they were measured.
      expect([...measured].every((id) => askedFor.includes(id))).toBe(true);
      askedFor.length = 0;

      // New rows ask for an estimate; measured ones keep their measurement.
      const newer = makeRows("newer", 9, 3, true);
      await mounted.rerender({ rows: [...rows, ...newer], getEstimatedItemSize });
      await frames(6);
      expect(askedFor.some((id) => id.startsWith("newer-"))).toBe(true);
      expect(askedFor.filter((id) => measured.has(id))).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps laid-out rows at their sizes while a scroll to a row is in flight", async () => {
    // LegendList freezes the sizes of unmeasured rows during a scrollTo (its average-size
    // snapshot), so the target cannot move under the scroll; a changed estimate must not move it.
    const rows = makeRows("est", 11, 140, true);
    let extra = 0;
    const mounted = await mountList(
      { rows, getEstimatedItemSize: (row) => row.height + extra },
      30,
    );
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      const list = mounted.listRef.current;
      if (!list) throw new Error("list unmounted");
      const node = scrollNodeOf(mounted.listRef);
      const target = rows[60];
      if (!target) throw new Error("fixture too short");
      const scrolled = list.scrollToIndex({ index: 60, animated: true });
      extra = 40;
      await scrolled;
      await frames(4);
      const element = node.querySelector<HTMLElement>(`[data-row-id="${target.id}"]`);
      expect(element).not.toBeNull();
      const offsetFromTop =
        (element?.getBoundingClientRect().top ?? Infinity) - node.getBoundingClientRect().top;
      // scrollToIndex aligns the row's top with the scroller's top.
      expect(Math.abs(offsetFromTop)).toBeLessThanOrEqual(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps rows apart when an estimate changes between layout and measurement", async () => {
    // Rows are laid out from estimates 40 px too tall; then the same function starts answering
    // exactly (a remembered height arriving, say). A row measured at the newer estimate must
    // still move the rows that were positioned with the older one.
    const rows = makeRows("est", 11, 140, true);
    let exact = false;
    const mounted = await mountList(
      { rows, getEstimatedItemSize: (row) => (exact ? row.height : row.height + 40) },
      30,
    );
    exact = true;
    try {
      expect(mounted.revealFrame).toBeGreaterThan(0);
      const node = scrollNodeOf(mounted.listRef);
      for (const fraction of [1, 0.6, 0.3]) {
        node.scrollTop = fraction * (node.scrollHeight - node.clientHeight);
        await frames(6);
        const rectByIndex = new Map<number, DOMRect>();
        for (const element of node.querySelectorAll<HTMLElement>("[data-row-id]")) {
          const index = rows.findIndex((row) => row.id === element.dataset.rowId);
          rectByIndex.set(index, element.getBoundingClientRect());
        }
        let neighbours = 0;
        for (const [index, rect] of rectByIndex) {
          const next = rectByIndex.get(index + 1);
          if (!next) continue;
          neighbours += 1;
          // Rows next to each other in the data touch: no overlap and no gap.
          expect(Math.abs(next.top - rect.bottom)).toBeLessThanOrEqual(1);
        }
        expect(neighbours).toBeGreaterThan(0);
        const viewport = node.getBoundingClientRect();
        expect(
          [...rectByIndex.values()].some(
            (rect) => rect.bottom > viewport.top && rect.top < viewport.bottom,
          ),
        ).toBe(true);
      }
    } finally {
      await mounted.unmount();
    }
  });
});
