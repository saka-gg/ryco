import "../../index.css";

import { EnvironmentId, MessageId } from "@ryco/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import {
  readTimelineRowHeight,
  readTimelineWidth,
  resetTimelineRowHeightsForTests,
  timelineRowHeightStats,
} from "./timelineRowHeights";

// The real virtual list: these tests are about what it measures and lays out.
const THREAD_KEY = "environment-local:thread-heights";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: THREAD_KEY,
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    onUndoTurn: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

function makeEntries(longIndex: number | null = null) {
  return Array.from({ length: 30 }, (_, index) => {
    const role = index % 2 === 0 ? ("user" as const) : ("assistant" as const);
    const paragraphs = role === "assistant" ? 1 + (index % 4) : 1;
    const base = Array.from(
      { length: paragraphs },
      (_, paragraph) =>
        `Paragraph ${paragraph + 1} of message ${index}: the quick brown fox jumps over the lazy dog, then keeps running across the field until the line wraps.`,
    ).join("\n\n");
    const text = index === longIndex ? `${base}\n\n${base}\n\n${base}` : base;
    const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
    return {
      id: `row-${index}`,
      kind: "message" as const,
      createdAt,
      message: { id: MessageId.make(`message-${index}`), role, text, createdAt, streaming: false },
    };
  });
}

async function renderTimeline(entries: ReturnType<typeof makeEntries>) {
  return render(
    <div style={{ width: 640, height: 520 }}>
      <MessagesTimeline {...buildProps()} timelineEntries={entries} />
    </div>,
  );
}

/** Rendered rows, in layout order, with their on-screen boxes. */
function renderedRowBoxes() {
  return [...document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]")]
    .map((element) => element.getBoundingClientRect())
    .filter((box) => box.height > 0)
    .toSorted((left, right) => left.top - right.top);
}

function expectRowsLaidOutWithoutOverlap() {
  const boxes = renderedRowBoxes();
  expect(boxes.length).toBeGreaterThan(1);
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index]!.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom - 1);
  }
}

const settle = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
  });

describe("MessagesTimeline remembered row heights", () => {
  afterEach(() => {
    resetTimelineRowHeightsForTests();
  });

  it("lays a reopened thread out from remembered heights without re-measuring its rows", async () => {
    const first = await renderTimeline(makeEntries());
    await settle();
    expectRowsLaidOutWithoutOverlap();
    const afterFirstOpen = timelineRowHeightStats();
    expect(afterFirstOpen.entries).toBeGreaterThan(0);
    expect(readTimelineWidth(THREAD_KEY)).toBeGreaterThan(0);
    await first.unmount();

    const second = await renderTimeline(makeEntries());
    try {
      await settle();
      expectRowsLaidOutWithoutOverlap();
      // Every remembered row was laid out at its height: no measurement had to correct one.
      // (Rows the first visit never rendered are measured as usual.)
      expect(timelineRowHeightStats().rewrites).toBe(afterFirstOpen.rewrites);
    } finally {
      await second.unmount();
    }
  });

  it("corrects a remembered height whose row changed while the thread was closed", async () => {
    const first = await renderTimeline(makeEntries());
    await settle();
    await first.unmount();
    const width = readTimelineWidth(THREAD_KEY);
    const before = readTimelineRowHeight(THREAD_KEY, "row-29", width);
    expect(before).toBeGreaterThan(0);
    const rewritesBefore = timelineRowHeightStats().rewrites;

    // The newest row (in view at the end) grew while the thread was closed.
    const second = await renderTimeline(makeEntries(29));
    try {
      await settle();
      expectRowsLaidOutWithoutOverlap();
      const after = readTimelineRowHeight(THREAD_KEY, "row-29", readTimelineWidth(THREAD_KEY));
      expect(after).toBeGreaterThan(before! * 2);
      expect(timelineRowHeightStats().rewrites).toBeGreaterThan(rewritesBefore);
    } finally {
      await second.unmount();
    }
  });
});
