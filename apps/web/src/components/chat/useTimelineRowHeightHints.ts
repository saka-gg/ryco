// FILE: useTimelineRowHeightHints.ts
// Purpose: Feeds the transcript's virtual list a height for every row it has not measured
//          (what the row measured last time at this width and font, or a content estimate)
//          and remembers what rows measure. Nothing persists: the memory is page state.
// Layer: Web chat timeline (React hook)
// Exports: useTimelineRowHeightHints, TimelineRowHeightHints

import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useState, type RefObject } from "react";

import { getPresentationTier } from "../../lib/presentationTier";
import { APPEARANCE_PREFERENCES_CHANGE_EVENT } from "../../themes/appearancePreferences";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  DEFAULT_TIMELINE_ROW_WIDTH_PX,
  estimateTimelineRowHeight,
  isRememberableTimelineRow,
  timelineRowHeightMemory,
  timelineRowHeightSignature,
  timelineRowLayoutKey,
  type TimelineRowHeightBucket,
  type TimelineRowHeightMemory,
  type TimelineRowLayout,
} from "./timelineRowHeights.logic";

/** LegendList's `onItemSizeChanged` report. `itemData` is missing for a row that left `data`. */
export interface TimelineItemSizeChange {
  readonly size: number;
  readonly previous: number;
  readonly index: number;
  readonly itemKey: string;
  readonly itemData: MessagesTimelineRow | undefined;
}

export interface TimelineRowHeightHints {
  /** LegendList `getEstimatedItemSize`: O(1) after a row's first call in a layout. */
  readonly getEstimatedItemSize: (
    row: MessagesTimelineRow,
    index: number,
    type: string | undefined,
  ) => number | undefined;
  /** LegendList `onItemSizeChanged`: remembers what a settled row measured. */
  readonly onItemSizeChanged: (info: TimelineItemSizeChange) => void;
  /** Ref for an invisible element laid out exactly as wide as a row's column. */
  readonly rowColumnRef: (element: HTMLElement | null) => void;
  /** Re-reads the column width; call where the timeline observes its size. */
  readonly onRowColumnResize: () => void;
}

/**
 * A new column width takes over once it has held this long. A drag or an animated pane
 * passes through a width per frame; switching layouts at each would re-estimate every
 * unmeasured row per frame and fill the memory with widths nobody reads again.
 */
const RESIZE_SETTLE_MS = 150;

interface Typography {
  readonly remPx: number;
  readonly key: string;
}

// Root font size and families: read once, again after each appearance change.
let typography: Typography | null = null;
let typographyListenerInstalled = false;

function readTypography(): Typography {
  if (typography) return typography;
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return { remPx: 16, key: "" };
  }
  const style = getComputedStyle(document.documentElement);
  const remPx = Number.parseFloat(style.fontSize);
  typography = {
    remPx: Number.isFinite(remPx) && remPx > 0 ? remPx : 16,
    // The root size is its own layout key part (`remPx`).
    key: [
      style.getPropertyValue("--font-family-sans").trim(),
      style.getPropertyValue("--font-family-mono").trim(),
    ].join("|"),
  };
  if (!typographyListenerInstalled && typeof window !== "undefined") {
    // Installed before any timeline subscribes, so a timeline's own listener reads fresh values.
    typographyListenerInstalled = true;
    window.addEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, () => {
      typography = null;
    });
  }
  return typography;
}

/** The last row-column width any timeline measured: the guess before a new one measures. */
let lastRowWidthPx: number | null = null;

let warnedEstimateFailure = false;

/** Marks the invisible element that is exactly as wide as a row (see `rowColumnRef`). */
const TIMELINE_ROW_COLUMN_PROBE_SELECTOR = "[data-timeline-row-column-probe]";

/**
 * The row width of the timeline this mount replaces in the same pane, while it is still in
 * the document (a thread switch renders the next timeline before the previous one leaves).
 */
function readReplacedTimelineRowWidth(listRef: RefObject<LegendListRef | null>): number | null {
  // Also renders on the server (static markup), where there is no DOM.
  if (typeof HTMLElement === "undefined") return null;
  const scroller: unknown = listRef.current?.getScrollableNode?.();
  if (!(scroller instanceof HTMLElement) || !scroller.isConnected) return null;
  const probe = scroller.parentElement?.querySelector(TIMELINE_ROW_COLUMN_PROBE_SELECTOR);
  const width = probe?.getBoundingClientRect().width ?? 0;
  return width > 0 ? width : null;
}

const sameWidth = (left: number, right: number) => Math.round(left) === Math.round(right);

interface PendingRowHeight {
  readonly height: number;
  readonly signature: string;
  readonly widthPx: number;
}

/** Per-mount state. Callbacks are stable fields, so passing them to the list costs nothing. */
class TimelineRowHeightHintsController implements TimelineRowHeightHints {
  readonly threadKey: string;
  private readonly memory: TimelineRowHeightMemory;
  private layout: TimelineRowLayout;
  private layoutKey: string;
  private bucket: TimelineRowHeightBucket;
  /** Bumped when the layout key changes; per-row estimates of older layouts are stale. */
  private version = 0;
  private readonly estimates = new WeakMap<
    MessagesTimelineRow,
    { readonly version: number; readonly height: number | undefined }
  >();
  private rowColumn: HTMLElement | null = null;
  private widthConfirmed = false;
  /**
   * Remembered heights apply only at a width measured for this mount: the pane's own
   * column, or the timeline it replaces in the pane. Until then, rows get content estimates.
   */
  private widthTrusted: boolean;
  /** One width read per synchronous batch (a layout pass, a batch of size reports). */
  private batchWidthPx: number | undefined;
  /** While the column is being resized: the width it last measured, not yet the layout's. */
  private resizingToPx: number | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Heights rows measured during a resize; the ones at the width it settles on are kept. */
  private readonly pending = new Map<string, PendingRowHeight>();

  constructor(memory: TimelineRowHeightMemory, threadKey: string, seedRowWidthPx: number | null) {
    this.memory = memory;
    this.threadKey = threadKey;
    const { remPx, key } = readTypography();
    // The list lays every row out once while it first renders, before this mount's own
    // column exists, so the width it starts from decides that first layout.
    this.widthTrusted = seedRowWidthPx !== null;
    this.layout = {
      rowWidthPx: seedRowWidthPx ?? lastRowWidthPx ?? (DEFAULT_TIMELINE_ROW_WIDTH_PX * remPx) / 16,
      remPx,
      typographyKey: key,
      tier: getPresentationTier(),
    };
    this.layoutKey = timelineRowLayoutKey(this.layout);
    this.bucket = memory.openBucket(threadKey, this.layoutKey);
  }

  /** The width a timeline replacing this one in the same pane can start from. */
  get confirmedRowWidthPx(): number | null {
    return this.widthConfirmed ? (this.resizingToPx ?? this.layout.rowWidthPx) : null;
  }

  readonly getEstimatedItemSize = (row: MessagesTimelineRow): number | undefined => {
    if (row === undefined) return undefined;
    // The column is attached before the list lays out (it precedes the list in the tree),
    // and the list has just measured its scroller, so this read costs no extra layout.
    if (!this.widthConfirmed) this.confirmWidth();
    this.syncTier();
    const memo = this.estimates.get(row);
    if (memo !== undefined && memo.version === this.version) return memo.height;
    let height: number | undefined;
    try {
      if (this.widthTrusted && isRememberableTimelineRow(row)) {
        height = this.memory.read(this.bucket, row.id, timelineRowHeightSignature(row));
      }
      height ??= estimateTimelineRowHeight(row, this.layout);
    } catch (error) {
      // The list falls back to its per-type averages; the failure is memoized like a height.
      height = undefined;
      if (!warnedEstimateFailure) {
        warnedEstimateFailure = true;
        console.warn("[MessagesTimeline] row height estimate failed", row.kind, error);
      }
    }
    this.estimates.set(row, { version: this.version, height });
    return height;
  };

  readonly onItemSizeChanged = (info: TimelineItemSizeChange): void => {
    const row = info.itemData;
    // The list can report a row after it left `data`: then it sends no row, or the row
    // now at that index.
    if (row === undefined || row.id !== info.itemKey || !(info.size > 0)) return;
    this.memory.noteCorrection();
    // Keyed by the width this row measured at (the chat width setting can widen rows
    // without resizing the viewport, and this report can precede the resize callback).
    // Without a readable column (detached, collapsed pane) the width is unknown: keep nothing.
    const widthPx = this.confirmWidth();
    if (widthPx === undefined) return;
    this.syncTier();
    if (!isRememberableTimelineRow(row)) return;
    // The list keeps (and compares a measurement against) the rounded height; the report
    // carries it floored to 1/8 px. Remembering the rounded one makes the next layout exact.
    const height = Math.round(info.size);
    const signature = timelineRowHeightSignature(row);
    if (this.resizingToPx !== undefined) {
      this.pending.set(row.id, { height, signature, widthPx });
      return;
    }
    this.bucket = this.memory.remember(this.bucket, row.id, height, signature);
  };

  readonly rowColumnRef = (element: HTMLElement | null): void => {
    this.rowColumn = element;
  };

  readonly onRowColumnResize = (): void => {
    this.confirmWidth();
  };

  refreshTypography(): void {
    const { remPx, key } = readTypography();
    this.applyLayout({ ...this.layout, remPx, typographyKey: key });
  }

  /** Ends a resize in progress at the width last measured (the timeline is unmounting). */
  dispose(): void {
    if (this.resizeTimer !== undefined) this.settleResize();
  }

  private syncTier(): void {
    // The store the tier hook reads; a re-render is not needed to notice a change.
    const tier = getPresentationTier();
    if (tier !== this.layout.tier) this.applyLayout({ ...this.layout, tier });
  }

  private readRowColumnWidth(): number | undefined {
    let width = this.batchWidthPx;
    if (width === undefined) {
      const element = this.rowColumn;
      if (element === null || !element.isConnected) return undefined;
      width = element.getBoundingClientRect().width;
      this.batchWidthPx = width;
      queueMicrotask(() => {
        this.batchWidthPx = undefined;
      });
    }
    // A collapsed (hidden) pane says nothing about its rows.
    return width > 0 ? width : undefined;
  }

  /** Reads the column width; returns it, or undefined when it cannot be read. */
  private confirmWidth(): number | undefined {
    const width = this.readRowColumnWidth();
    if (width === undefined) return undefined;
    lastRowWidthPx = width;
    if (!this.widthConfirmed) {
      // The first measured width replaces the guess at once.
      this.widthConfirmed = true;
      // Rows already laid out from content estimates keep them: switching them to remembered
      // heights now would move the list while its initial scroll converges. Rows the list asks
      // about from here on (new rows, changed rows, another layout) read the memory.
      this.widthTrusted = true;
      if (!sameWidth(width, this.layout.rowWidthPx)) {
        this.applyLayout({ ...this.layout, rowWidthPx: width });
      }
      return width;
    }
    if (!sameWidth(width, this.resizingToPx ?? this.layout.rowWidthPx)) {
      this.resizingToPx = width;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(this.settleResize, RESIZE_SETTLE_MS);
    }
    return width;
  }

  private readonly settleResize = (): void => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    const width = this.resizingToPx;
    this.resizingToPx = undefined;
    if (width !== undefined && !sameWidth(width, this.layout.rowWidthPx)) {
      this.applyLayout({ ...this.layout, rowWidthPx: width });
    }
    for (const [rowId, entry] of this.pending) {
      if (sameWidth(entry.widthPx, this.layout.rowWidthPx)) {
        this.bucket = this.memory.remember(this.bucket, rowId, entry.height, entry.signature);
      }
    }
    this.pending.clear();
  };

  private applyLayout(next: TimelineRowLayout): void {
    this.layout = next;
    const key = timelineRowLayoutKey(next);
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.bucket = this.memory.openBucket(this.threadKey, key);
    this.version += 1;
  }
}

/**
 * Row height hints for one mounted timeline: `getEstimatedItemSize` and
 * `onItemSizeChanged` for the list, and `rowColumnRef` for an element as wide as a row.
 * A thread opened again at the same width and font lays out at the heights its rows
 * measured before; the rest are estimated from their content.
 */
export function useTimelineRowHeightHints(input: {
  /** The list ref the timeline shares with the view; read once, when this mount starts. */
  readonly listRef: RefObject<LegendListRef | null>;
  readonly routeThreadKey: string;
  /** Tests pass their own; the app shares one. */
  readonly memory?: TimelineRowHeightMemory;
}): TimelineRowHeightHints {
  const { routeThreadKey } = input;
  const memory = input.memory ?? timelineRowHeightMemory;
  const [current, setCurrent] = useState(
    () =>
      new TimelineRowHeightHintsController(
        memory,
        routeThreadKey,
        readReplacedTimelineRowWidth(input.listRef),
      ),
  );
  let controller = current;
  if (controller.threadKey !== routeThreadKey) {
    // Another thread in the same mount: its own rows and bucket, before the list asks for
    // either (a layout effect would run after the list's own measurements of this commit).
    controller = new TimelineRowHeightHintsController(
      memory,
      routeThreadKey,
      current.confirmedRowWidthPx,
    );
    setCurrent(controller);
  }
  useEffect(() => {
    const onAppearanceChange = () => controller.refreshTypography();
    window.addEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, onAppearanceChange);
    return () => {
      window.removeEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, onAppearanceChange);
      controller.dispose();
    };
  }, [controller]);
  return controller;
}
