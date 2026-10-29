import { describe, expect, it } from "vite-plus/test";

import {
  calendarDaysWords,
  calendarRuns,
  calendarWords,
  isValidTimeZone,
  nextCalendarRun,
  normalizeWeekdays,
  parseLocalTime,
  zonedInstant,
} from "./automationCalendar.ts";

const BERLIN = "Europe/Berlin";
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const WEEKDAYS = [1, 2, 3, 4, 5];

describe("automationCalendar", () => {
  it("runs at the same wall-clock time across a clock change", () => {
    const rule = { timeZone: BERLIN, minutes: 9 * 60, weekdays: [0, 1, 2, 3, 4, 5, 6] };
    // Berlin leaves summer time on 2026-10-25: 09:00 is 07:00Z before, 08:00Z after.
    const runs = calendarRuns(
      rule,
      Date.parse("2026-10-24T00:00:00Z"),
      Date.parse("2026-10-26T23:00:00Z"),
      10,
    ).map(iso);
    expect(runs).toEqual([
      "2026-10-24T07:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
      "2026-10-26T08:00:00.000Z",
    ]);
  });

  it("skips a time the clocks jump over and runs a repeated time once, at its first instance", () => {
    const daily = (minutes: number) => ({
      timeZone: BERLIN,
      minutes,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    // 2026-03-29: 02:00 → 03:00, so 02:30 does not exist that day.
    expect(zonedInstant({ year: 2026, month: 3, day: 29, minutes: 150 }, BERLIN)).toBeNull();
    expect(
      calendarRuns(
        daily(150),
        Date.parse("2026-03-28T00:00:00Z"),
        Date.parse("2026-03-30T23:00:00Z"),
        10,
      ).map(iso),
    ).toEqual(["2026-03-28T01:30:00.000Z", "2026-03-30T00:30:00.000Z"]);
    // 2026-10-25: 03:00 → 02:00, so 02:30 happens twice; the first is 00:30Z.
    expect(iso(zonedInstant({ year: 2026, month: 10, day: 25, minutes: 150 }, BERLIN))).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(
      calendarRuns(
        daily(150),
        Date.parse("2026-10-25T00:00:00Z"),
        Date.parse("2026-10-25T23:00:00Z"),
        10,
      ).map(iso),
    ).toEqual(["2026-10-25T00:30:00.000Z"]);
  });

  it("finds the next weekday run strictly after a time", () => {
    const rule = { timeZone: BERLIN, minutes: 9 * 60, weekdays: WEEKDAYS };
    // Friday 2026-10-30 09:00 Berlin is 08:00Z; after it comes Monday Nov 2.
    expect(iso(nextCalendarRun(rule, Date.parse("2026-10-30T07:59:00Z")))).toBe(
      "2026-10-30T08:00:00.000Z",
    );
    expect(iso(nextCalendarRun(rule, Date.parse("2026-10-30T08:00:00Z")))).toBe(
      "2026-11-02T08:00:00.000Z",
    );
    expect(nextCalendarRun({ ...rule, weekdays: [] }, 0)).toBeNull();
  });

  it("reads zones, times and weekdays strictly", () => {
    expect(isValidTimeZone(BERLIN)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(parseLocalTime("09:30")).toBe(570);
    expect(parseLocalTime("24:00")).toBeNull();
    expect(parseLocalTime("9:30")).toBeNull();
    expect(normalizeWeekdays([5, 1, 1, 3])).toEqual([1, 3, 5]);
    expect(normalizeWeekdays([7])).toBeNull();
    expect(normalizeWeekdays([])).toBeNull();
  });

  it("says the days and time in plain words", () => {
    expect(calendarDaysWords([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(calendarDaysWords(WEEKDAYS)).toBe("every weekday");
    expect(calendarDaysWords([6, 0])).toBe("every weekend day");
    expect(calendarDaysWords([5])).toBe("every Friday");
    expect(calendarDaysWords([1, 3, 5])).toBe("Mon, Wed and Fri");
    expect(calendarWords({ timeZone: BERLIN, minutes: 540, weekdays: WEEKDAYS }, BERLIN)).toBe(
      "every weekday at 09:00",
    );
    expect(calendarWords({ timeZone: BERLIN, minutes: 540, weekdays: WEEKDAYS }, "UTC")).toBe(
      "every weekday at 09:00 (Europe/Berlin)",
    );
  });
});
