import { describe, expect, it } from "vite-plus/test";

import { encodeWidgetTimeline, isWidgetKind, WIDGET_TIMELINE_VERSION } from "./widgetTimeline";

describe("the widget timeline file", () => {
  it("carries its version and its entries in time order", () => {
    const json = encodeWidgetTimeline([
      { at: 2_000, content: { label: "later" } },
      { at: 1_000, content: { label: "now" } },
    ]);
    expect(JSON.parse(json)).toEqual({
      v: WIDGET_TIMELINE_VERSION,
      entries: [
        { at: 1_000, content: { label: "now" } },
        { at: 2_000, content: { label: "later" } },
      ],
    });
  });

  it("accepts only kinds that cannot name another file", () => {
    expect(isWidgetKind("subscription-usage")).toBe(true);
    for (const kind of ["", "../usage", "a/b", "Usage", "usage.json", "x".repeat(65)]) {
      expect(isWidgetKind(kind), kind).toBe(false);
    }
  });
});
