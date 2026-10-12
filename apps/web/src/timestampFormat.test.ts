import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatElapsedClockLabel,
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  formatRelativeTimeUntilLabel,
  getTimestampFormatOptions,
  relativeLabelRefreshDelayMs,
} from "./timestampFormat";

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });
});

describe("formatRelativeTimeUntilLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
  });

  it("formats seconds remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:00:45.000Z")).toBe("45s left");
  });

  it("formats minutes remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:15:00.000Z")).toBe("15m left");
  });

  it("formats hours remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T18:00:00.000Z")).toBe("6h left");
  });
});

describe("formatExpiresInLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatExpiresInLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
  });

  it("uses sub-minute second count", () => {
    expect(formatExpiresInLabel("2026-04-07T12:00:45.000Z")).toBe("Expires in 45s");
  });

  it("uses minutes and seconds under one hour", () => {
    expect(formatExpiresInLabel("2026-04-07T12:04:12.000Z")).toBe("Expires in 4m 12s");
    expect(formatExpiresInLabel("2026-04-07T12:15:00.000Z")).toBe("Expires in 15m");
  });

  it("uses hours with minute and second remainder", () => {
    expect(formatExpiresInLabel("2026-04-07T14:02:03.000Z")).toBe("Expires in 2h 2m 3s");
    expect(formatExpiresInLabel("2026-04-07T18:00:00.000Z")).toBe("Expires in 6h");
  });
});

describe("formatElapsedDurationLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns just now when the instant is current or in the future", () => {
    expect(formatElapsedDurationLabel("2026-04-07T12:00:00.000Z")).toBe("just now");
    expect(formatElapsedDurationLabel("2026-04-07T12:01:00.000Z")).toBe("just now");
  });

  it("formats seconds, minutes, hours, and days", () => {
    expect(formatElapsedDurationLabel("2026-04-07T11:59:45.000Z")).toBe("15s");
    expect(formatElapsedDurationLabel("2026-04-07T11:45:00.000Z")).toBe("15m");
    expect(formatElapsedDurationLabel("2026-04-07T06:00:00.000Z")).toBe("6h");
    expect(formatElapsedDurationLabel("2026-04-03T12:00:00.000Z")).toBe("4d");
  });
});

describe("formatElapsedClockLabel", () => {
  const start = "2026-04-07T12:00:00.000Z";
  const at = (seconds: number) => Date.parse(start) + seconds * 1000;

  it("reads like a stopwatch", () => {
    expect(formatElapsedClockLabel(start, at(0))).toBe("0:00");
    expect(formatElapsedClockLabel(start, at(7))).toBe("0:07");
    expect(formatElapsedClockLabel(start, at(252))).toBe("4:12");
    expect(formatElapsedClockLabel(start, at(3729))).toBe("1:02:09");
  });

  it("never runs backwards or breaks on bad input", () => {
    expect(formatElapsedClockLabel(start, at(-30))).toBe("0:00");
    expect(formatElapsedClockLabel("not a date", at(30))).toBe("0:00");
  });
});

describe("relativeLabelRefreshDelayMs", () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);

  it("waits for the next whole-minute crossing of the nearest label", () => {
    // 3m 20s ago reads "3m ago" until 4m: 40 s from now.
    expect(relativeLabelRefreshDelayMs([now - 200_000], now)).toBe(40_025);
    // A reset in 2h 0m 10s reads "2h" whose minute count changes in 10 s.
    expect(relativeLabelRefreshDelayMs([now + 7_210_000], now)).toBe(10_025);
    expect(relativeLabelRefreshDelayMs([now - 200_000, now + 7_210_000], now)).toBe(10_025);
  });

  it("ticks every second only while a future instant counts down in seconds", () => {
    expect(relativeLabelRefreshDelayMs([now + 45_000], now)).toBe(1_000);
    // "just now" changes once, at a minute.
    expect(relativeLabelRefreshDelayMs([now - 45_000], now)).toBe(15_025);
  });

  it("refreshes at least once a minute and ignores missing instants", () => {
    expect(relativeLabelRefreshDelayMs([], now)).toBe(60_000);
    expect(relativeLabelRefreshDelayMs([undefined, Number.NaN], now)).toBe(60_000);
    expect(relativeLabelRefreshDelayMs([now - 60_000], now)).toBe(60_000);
  });
});
