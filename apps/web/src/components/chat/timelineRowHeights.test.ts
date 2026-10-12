import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  readTimelineRowHeight,
  readTimelineWidth,
  rememberTimelineRowHeight,
  rememberTimelineWidth,
  resetTimelineRowHeightsForTests,
  TIMELINE_ROW_HEIGHT_CACHE_MAX_ENTRIES,
  timelineRowHeightStats,
} from "./timelineRowHeights";

describe("timelineRowHeights", () => {
  afterEach(() => resetTimelineRowHeightsForTests());

  it("returns a remembered height only at the width it was measured at", () => {
    rememberTimelineRowHeight("thread-a", "row-1", 640.4, 152);
    expect(readTimelineRowHeight("thread-a", "row-1", 640)).toBe(152);
    expect(readTimelineRowHeight("thread-a", "row-1", 700)).toBeUndefined();
    expect(readTimelineRowHeight("thread-a", "row-1", undefined)).toBeUndefined();
    expect(readTimelineRowHeight("thread-b", "row-1", 640)).toBeUndefined();
  });

  it("ignores measurements without a width or size", () => {
    rememberTimelineRowHeight("thread-a", "row-1", undefined, 152);
    rememberTimelineRowHeight("thread-a", "row-2", 640, 0);
    expect(timelineRowHeightStats()).toEqual({ entries: 0, writes: 0, rewrites: 0 });
  });

  it("evicts the least recently used height past its capacity", () => {
    for (let index = 0; index < TIMELINE_ROW_HEIGHT_CACHE_MAX_ENTRIES; index += 1) {
      rememberTimelineRowHeight("thread-a", `row-${index}`, 640, 40);
    }
    // Reading row-0 makes it recent, so row-1 is the one evicted next.
    expect(readTimelineRowHeight("thread-a", "row-0", 640)).toBe(40);
    rememberTimelineRowHeight("thread-a", "row-new", 640, 40);
    expect(timelineRowHeightStats().entries).toBe(TIMELINE_ROW_HEIGHT_CACHE_MAX_ENTRIES);
    expect(readTimelineRowHeight("thread-a", "row-0", 640)).toBe(40);
    expect(readTimelineRowHeight("thread-a", "row-1", 640)).toBeUndefined();
  });

  it("counts a correction to a height already remembered at that width as a rewrite", () => {
    rememberTimelineRowHeight("thread-a", "row-1", 640, 100);
    rememberTimelineRowHeight("thread-a", "row-1", 640, 120);
    rememberTimelineRowHeight("thread-a", "row-1", 700, 90);
    expect(timelineRowHeightStats()).toEqual({ entries: 1, writes: 3, rewrites: 1 });
  });

  it("remembers the width a thread last laid out at", () => {
    expect(readTimelineWidth("thread-a")).toBeUndefined();
    rememberTimelineWidth("thread-a", 811.6);
    rememberTimelineWidth("thread-b", 0);
    expect(readTimelineWidth("thread-a")).toBe(812);
    expect(readTimelineWidth("thread-b")).toBeUndefined();
  });
});
