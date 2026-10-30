// Isolated from the pure group: these stub the process time zone.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveCustomSnooze } from "./threadSnooze.ts";

afterEach(() => vi.unstubAllEnvs());

describe("custom snooze across daylight saving changes", () => {
  it("rejects a local time the spring change skips", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      resolveCustomSnooze(
        { mode: "date", date: "2027-03-14", time: "02:30" },
        new Date("2027-03-01T00:00:00Z"),
      ),
    ).toBeNull();
  });

  it("counts a day of duration as 24 hours", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const before = new Date(2027, 2, 13, 12);
    expect(resolveCustomSnooze({ mode: "duration", amount: "1", unit: "days" }, before)).toBe(
      new Date(2027, 2, 14, 13).toISOString(),
    );
  });
});
