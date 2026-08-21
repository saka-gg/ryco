import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  availablePercent,
  clampUsedPercent,
  describeRateLimitWindow,
  formatRateLimitResetLabel,
  formatRateLimitResetText,
  hasRateLimitWindows,
  resolveRateLimitWindowLabel,
} from "./codexUsageLimits";

describe("resolveRateLimitWindowLabel", () => {
  it("prefers the driver-supplied label over the duration bucket", () => {
    expect(
      resolveRateLimitWindowLabel(
        { usedPercent: 63, windowDurationMins: 7 * 24 * 60, label: "Fable weekly" },
        "Weekly",
      ),
    ).toBe("Fable weekly");
  });

  it("derives the label from the duration when none is supplied", () => {
    expect(resolveRateLimitWindowLabel({ usedPercent: 10, windowDurationMins: 300 }, "Short")).toBe(
      "5h",
    );
  });

  it("falls back to the slot label when the duration is absent", () => {
    expect(resolveRateLimitWindowLabel({ usedPercent: 10 }, "Short window")).toBe("Short window");
  });
});

describe("hasRateLimitWindows", () => {
  it("is false for an undefined or window-less snapshot", () => {
    expect(hasRateLimitWindows(undefined)).toBe(false);
    expect(hasRateLimitWindows({ limitId: "claude-oauth" })).toBe(false);
  });

  it("is true when only the model-scoped window is present", () => {
    expect(hasRateLimitWindows({ tertiary: { usedPercent: 63, label: "Fable weekly" } })).toBe(
      true,
    );
  });
});

describe("clampUsedPercent", () => {
  it("returns the value unchanged when in range", () => {
    expect(clampUsedPercent(0)).toBe(0);
    expect(clampUsedPercent(42)).toBe(42);
    expect(clampUsedPercent(100)).toBe(100);
  });

  it("clamps below-zero values to zero", () => {
    expect(clampUsedPercent(-10)).toBe(0);
  });

  it("clamps above-100 values to 100", () => {
    expect(clampUsedPercent(150)).toBe(100);
  });

  it("treats non-finite values as zero", () => {
    expect(clampUsedPercent(Number.NaN)).toBe(0);
    expect(clampUsedPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("availablePercent", () => {
  it("inverts the clamped used-percent", () => {
    expect(availablePercent(0)).toBe(100);
    expect(availablePercent(25)).toBe(75);
    expect(availablePercent(100)).toBe(0);
  });

  it("clamps before inverting", () => {
    expect(availablePercent(150)).toBe(0);
    expect(availablePercent(-10)).toBe(100);
  });
});

describe("describeRateLimitWindow", () => {
  it("buckets short windows by hour count", () => {
    expect(describeRateLimitWindow({ usedPercent: 0, windowDurationMins: 300 })).toEqual({
      label: "5h",
      bucket: "short",
    });
    expect(describeRateLimitWindow({ usedPercent: 0, windowDurationMins: 60 })).toEqual({
      label: "1h",
      bucket: "short",
    });
  });

  it("labels weekly windows even when slightly under 7 days", () => {
    expect(describeRateLimitWindow({ usedPercent: 0, windowDurationMins: 7 * 24 * 60 })).toEqual({
      label: "Weekly",
      bucket: "week",
    });
    expect(
      describeRateLimitWindow({ usedPercent: 0, windowDurationMins: 7 * 24 * 60 - 60 }),
    ).toEqual({ label: "Weekly", bucket: "week" });
  });

  it("falls back to a generic day count for in-between windows", () => {
    expect(describeRateLimitWindow({ usedPercent: 0, windowDurationMins: 2 * 24 * 60 })).toEqual({
      label: "2d",
      bucket: "other",
    });
  });

  it("returns a generic Window label when duration is missing or invalid", () => {
    expect(describeRateLimitWindow({ usedPercent: 0 })).toEqual({
      label: "Window",
      bucket: "other",
    });
    expect(describeRateLimitWindow({ usedPercent: 0, windowDurationMins: 0 })).toEqual({
      label: "Window",
      bucket: "other",
    });
  });
});

describe("formatRateLimitResetLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats a future epoch second as a 'left' suffix label", () => {
    const fourHoursLater = Math.floor(new Date("2026-04-07T16:00:00.000Z").getTime() / 1000);
    expect(formatRateLimitResetLabel(fourHoursLater)).toBe("4h left");
  });

  it("returns null for missing or non-finite timestamps", () => {
    expect(formatRateLimitResetLabel(undefined)).toBeNull();
    expect(formatRateLimitResetLabel(Number.NaN)).toBeNull();
    expect(formatRateLimitResetLabel(0)).toBeNull();
    expect(formatRateLimitResetLabel(-1)).toBeNull();
  });
});

describe("formatRateLimitResetText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("frames a future timestamp as 'resets in X' without the trailing 'left'", () => {
    const fourHoursLater = Math.floor(new Date("2026-04-07T16:00:00.000Z").getTime() / 1000);
    expect(formatRateLimitResetText(fourHoursLater)).toBe("resets in 4h");
  });

  it("collapses the 'Expired' sentinel to a lowercase 'expired'", () => {
    const oneMinuteAgo = Math.floor(new Date("2026-04-07T11:59:00.000Z").getTime() / 1000);
    expect(formatRateLimitResetText(oneMinuteAgo)).toBe("expired");
  });

  it("returns null when the timestamp is missing or invalid", () => {
    expect(formatRateLimitResetText(undefined)).toBeNull();
    expect(formatRateLimitResetText(0)).toBeNull();
  });
});
