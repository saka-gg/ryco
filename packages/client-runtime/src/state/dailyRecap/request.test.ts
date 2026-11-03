import type { UsageCalendarDate } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dailyRecapRequest, previousCalendarDate, previousDayRecapRequest } from "./request.ts";

const date = (value: string) => value as UsageCalendarDate;

describe("daily recap requests", () => {
  it("asks for the client's own local day", () => {
    // 00:30 on Saturday in Berlin, 15:30 on Friday in Los Angeles.
    const nowMs = Date.parse("2026-10-23T22:30:00.000Z");
    expect(dailyRecapRequest(nowMs, "Europe/Berlin")).toEqual({
      date: "2026-10-24",
      timeZone: "Europe/Berlin",
    });
    expect(dailyRecapRequest(nowMs, "America/Los_Angeles")).toEqual({
      date: "2026-10-23",
      timeZone: "America/Los_Angeles",
    });
  });

  it.each([
    ["2026-10-24", "2026-10-23"],
    ["2026-03-01", "2026-02-28"],
    ["2028-03-01", "2028-02-29"],
    ["2027-01-01", "2026-12-31"],
    // The days after Europe's clocks go forward and back.
    ["2026-03-30", "2026-03-29"],
    ["2026-10-26", "2026-10-25"],
  ])("counts back from %s to %s", (from, to) => {
    expect(previousCalendarDate(date(from))).toBe(to);
  });

  it("asks for yesterday's totals in the same time zone, with one thread per section", () => {
    expect(previousDayRecapRequest({ date: date("2026-01-01"), timeZone: "Asia/Tokyo" })).toEqual({
      date: "2025-12-31",
      timeZone: "Asia/Tokyo",
      limit: 1,
    });
  });
});
