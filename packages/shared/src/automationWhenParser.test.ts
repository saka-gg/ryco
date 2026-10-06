process.env.TZ = "Europe/Berlin";

import { describe, expect, it } from "vite-plus/test";

import { DAY_MS, MINUTE_MS, formatDateTime } from "./automationSchedule.ts";
import {
  explainWhen,
  nearWords,
  normalizeWhenText,
  parseTimeOfDay,
  parseWhen,
  suggestWhen,
  whenQuickPicks,
} from "./automationWhenParser.ts";

/** Local wall-clock time (the lab's T helper). */
const T = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(y, m - 1, d, hh, mm).getTime();
/** The lab's fixed now: Wed Oct 7 2026, 10:42 in Berlin. */
const NOW = T(2026, 10, 7, 10, 42);

/* The lab's 48 phrase cases (pickers.js selfTest CASES), verbatim. */
const CASES: ReadonlyArray<readonly [string, number | "error"]> = [
  ["in 2h", T(2026, 10, 7, 12, 42)],
  ["in 2 h", T(2026, 10, 7, 12, 42)],
  ["in 45 min", T(2026, 10, 7, 11, 27)],
  ["in 1h30", T(2026, 10, 7, 12, 12)],
  ["in 1 hour 30 minutes", T(2026, 10, 7, 12, 12)],
  ["in an hour", T(2026, 10, 7, 11, 42)],
  ["in a week", T(2026, 10, 14, 10, 42)],
  ["in 3 days", T(2026, 10, 10, 10, 42)],
  ["2h", T(2026, 10, 7, 12, 42)],
  ["now+30m", T(2026, 10, 7, 11, 12)],
  ["now + 2h", T(2026, 10, 7, 12, 42)],
  ["+15m", T(2026, 10, 7, 10, 57)],
  ["tomorrow 9", T(2026, 10, 8, 9, 0)],
  ["tomorrow 9am", T(2026, 10, 8, 9, 0)],
  ["Tomorrow at 9:30pm", T(2026, 10, 8, 21, 30)],
  ["tomorrow evening 7", T(2026, 10, 8, 19, 0)],
  ["tonight", T(2026, 10, 7, 21, 0)],
  ["tonight 22:30", T(2026, 10, 7, 22, 30)],
  ["fri 17:30", T(2026, 10, 9, 17, 30)],
  ["friday 5pm", T(2026, 10, 9, 17, 0)],
  ["wed 9", T(2026, 10, 14, 9, 0)],
  ["wed 14:00", T(2026, 10, 7, 14, 0)],
  ["next monday 9am", T(2026, 10, 12, 9, 0)],
  ["next wed", T(2026, 10, 14, 9, 0)],
  ["oct 12 14:00", T(2026, 10, 12, 14, 0)],
  ["12 oct 14:00", T(2026, 10, 12, 14, 0)],
  ["october 12th at 2pm", T(2026, 10, 12, 14, 0)],
  ["12.10. 14:00", T(2026, 10, 12, 14, 0)],
  ["12.10.2026 14:00", T(2026, 10, 12, 14, 0)],
  ["2026-10-12 14:00", T(2026, 10, 12, 14, 0)],
  ["14:00", T(2026, 10, 7, 14, 0)],
  ["9:00", T(2026, 10, 8, 9, 0)],
  ["9pm", T(2026, 10, 7, 21, 0)],
  ["9 p.m.", T(2026, 10, 7, 21, 0)],
  ["1730", T(2026, 10, 7, 17, 30)],
  ["noon", T(2026, 10, 7, 12, 0)],
  ["midnight", T(2026, 10, 8, 0, 0)],
  ["day after tomorrow", T(2026, 10, 9, 9, 0)],
  ["jan 3", T(2027, 1, 3, 9, 0)],
  ["thu, oct 8 · 09:00", T(2026, 10, 8, 9, 0)],
  ["fri oct 8", "error"],
  ["tomorrow fri", "error"],
  ["feb 30", "error"],
  ["in 2", "error"],
  ["banana", "error"],
  ["25:00", "error"],
  ["13pm", "error"],
  ["10/12", "error"],
];

/* The lab's 8 time-of-day cases (TIME_CASES), verbatim. */
const TIME_CASES: ReadonlyArray<readonly [string, number | null]> = [
  ["9", 540],
  ["9:30", 570],
  ["21:05", 1265],
  ["9pm", 1260],
  ["12am", 0],
  ["930", 570],
  ["24:00", null],
  ["x", null],
];

describe("parseWhen — the lab's cases", () => {
  it("runs in Europe/Berlin", () => {
    expect(new Date(NOW).getTimezoneOffset()).toBe(-120);
    expect(CASES.length + TIME_CASES.length).toBe(56);
  });

  it.each(CASES)("%s", (phrase, want) => {
    const result = parseWhen(phrase, NOW);
    if (want === "error") {
      expect(result.ok).toBe(false);
    } else {
      expect(result).toMatchObject({ ok: true, ms: want });
    }
  });

  it.each(TIME_CASES)("time of day %s", (text, want) => {
    expect(parseTimeOfDay(text)).toBe(want);
  });
});

describe("parseWhen — readings", () => {
  it("labels the time absolutely and relatively", () => {
    expect(parseWhen("tomorrow 9", NOW)).toEqual({
      ok: true,
      ms: T(2026, 10, 8, 9, 0),
      label: "Thu, Oct 8 · 09:00",
      rel: "in 22h",
      hasDate: true,
      hasTime: true,
    });
    expect(parseWhen("in 2h", NOW)).toMatchObject({ label: "Wed, Oct 7 · 12:42", rel: "in 2h" });
    expect(parseWhen("jan 3", NOW)).toMatchObject({ label: "Sun, Jan 3, 2027 · 09:00" });
  });

  it("says whether a date and a time were named", () => {
    expect(parseWhen("fri", NOW)).toMatchObject({ hasDate: true, hasTime: false });
    expect(parseWhen("14:00", NOW)).toMatchObject({ hasDate: false, hasTime: true });
  });

  it("fills a missing time with the default", () => {
    expect(parseWhen("fri", NOW, { defaultTime: 17 * 60 + 30 })).toMatchObject({
      ms: T(2026, 10, 9, 17, 30),
    });
  });

  it("explains what it could not read, in the lab's words", () => {
    const error = (text: string) => {
      const result = parseWhen(text, NOW);
      return result.ok ? null : result.error;
    };
    expect(error("")).toBe("Type when — “tomorrow 9”, “fri 17:30” or “in 2h”");
    expect(error("fri oct 8")).toBe("Oct 8 is a Thursday");
    expect(error("tomorrow fri")).toBe("Tomorrow is a Thursday");
    expect(error("feb 30")).toBe("February 2026 has 28 days");
    expect(error("in 2")).toBe("Add a unit — “2 min”, “2 h” or “2 days”?");
    expect(error("banana")).toBe("Didn't catch “banana”");
    expect(error("25:00")).toBe("“25:00” isn't a time");
    expect(error("13pm")).toBe("“13pm” isn't a time — use 1–12 with am/pm");
    expect(error("10/12")).toBe("Write dates as “12.10.” or “oct 12”");
    expect(error("march")).toBe("Which day in March? Try “mar 12”");
    expect(error("next")).toBe("Next what? Try “next monday 9am”");
    expect(error("9 10")).toBe("Two times there — keep one");
    expect(error("today tomorrow")).toBe("Two days there — keep one");
    expect(error("13.13.")).toBe("There's no month 13");
    expect(error("in 10 s")).toBe("Didn't catch “s” — use min, h, days or weeks");
  });

  it("crosses the clock change on wall-clock time", () => {
    const eve = T(2026, 10, 24, 22, 0);
    // Oct 25 has 25 hours in Berlin; "tomorrow 9" is still 09:00 local.
    const result = parseWhen("tomorrow 9", eve);
    expect(result).toMatchObject({ ms: T(2026, 10, 25, 9, 0) });
    expect(new Date(T(2026, 10, 25, 9, 0)).getTimezoneOffset()).toBe(-60);
    // "in 24 hours" is elapsed time: 21:00 after clocks go back.
    expect(parseWhen("in 24 hours", eve)).toMatchObject({ ms: T(2026, 10, 25, 21, 0) });
  });

  it("normalizes separators and am/pm spellings", () => {
    expect(normalizeWhenText(" Thu,  Oct 8 · 9 P.M. ")).toBe("thu oct 8 9 pm");
  });
});

describe("explainWhen", () => {
  const range = { nowMs: NOW, min: NOW, max: NOW + 90 * DAY_MS };

  it("accepts a time inside the window", () => {
    expect(explainWhen(NOW + 5 * MINUTE_MS, range)).toBeNull();
    expect(explainWhen(NOW + 90 * DAY_MS, range)).toBeNull();
  });

  it("refuses now and the past with a fix on the next quarter hour ≥ 5 min ahead", () => {
    expect(explainWhen(NOW, range)).toEqual({
      kind: "past",
      text: "That's now — pick a later time",
      short: "That's now",
      fix: T(2026, 10, 7, 11, 0),
      fixLabel: "today 11:00",
    });
    expect(explainWhen(NOW - 2 * 60 * MINUTE_MS, range)).toMatchObject({
      kind: "past",
      text: "That was 2h ago — pick a later time",
      short: "That was 2h ago",
    });
  });

  it("refuses past the 90-day limit with the latest quarter hour as the fix", () => {
    const result = explainWhen(NOW + 91 * DAY_MS, range);
    expect(result).toMatchObject({
      kind: "late",
      text: "Past the 90-day limit — the latest is Jan 5, 2027",
      short: "Past the 90-day limit",
      fixLabel: "Jan 5, 09:30",
    });
  });

  it("names a host's own bounds", () => {
    const narrow = { nowMs: NOW, min: NOW + DAY_MS, max: NOW + 2 * DAY_MS };
    expect(explainWhen(NOW + 2 * 60 * MINUTE_MS, narrow)?.text).toBe(
      "Too early — the earliest is Thu, Oct 8 · 10:42",
    );
    expect(explainWhen(NOW + 3 * DAY_MS, narrow)?.text).toBe(
      "Too late — the latest is Fri, Oct 9 · 10:42",
    );
  });

  it("says when the time is unreadable", () => {
    expect(explainWhen(Number.NaN, range)?.text).toBe("Pick a time");
  });
});

describe("suggestWhen", () => {
  const range = { min: NOW, max: NOW + 90 * DAY_MS };

  it("offers the defaults when nothing is typed", () => {
    expect(suggestWhen("", NOW, range).map((s) => s.phrase)).toEqual([
      "in 1 hour",
      "tonight",
      "tomorrow 9am",
      "monday 9am",
      "in 1 week",
    ]);
  });

  it("completes a number with units", () => {
    expect(suggestWhen("in 2", NOW, range).map((s) => s.phrase)).toEqual([
      "in 2 min",
      "in 2 hours",
      "in 2 days",
      "in 2 weeks",
    ]);
    // The exact reading is the field's own chip, so the list never repeats it.
    expect(suggestWhen("in 2 h", NOW, range).map((s) => s.phrase)).toEqual([
      "in 2 min",
      "in 2 days",
      "in 2 weeks",
    ]);
  });

  it("leads with the nearest allowed time for an out-of-range reading", () => {
    const [first] = suggestWhen("yesterday 9", NOW, range);
    expect(first).toEqual({
      phrase: "oct 7 11:00",
      ms: T(2026, 10, 7, 11, 0),
      label: "Wed, Oct 7 · 11:00",
      rel: "in 18m",
      nearest: "Earliest",
    });
    expect(suggestWhen("in 100 days", NOW, range)[0]).toMatchObject({ nearest: "Latest" });
  });

  it("offers the same time on nearby days for a complete reading", () => {
    expect(suggestWhen("fri 17:30", NOW, range).map((s) => s.phrase)).toEqual([
      "saturday 17:30",
      "tomorrow 17:30",
      "oct 16 17:30",
      "friday 9am",
    ]);
  });

  it("never offers a time outside the window", () => {
    for (const s of suggestWhen("t", NOW, range)) {
      expect(explainWhen(s.ms, { nowMs: NOW, ...range })).toBeNull();
    }
  });
});

describe("whenQuickPicks", () => {
  it("rounds 'in 1 hour' up to five minutes and names fixed slots", () => {
    expect(whenQuickPicks(NOW)).toEqual([
      { label: "In 1 hour", ms: T(2026, 10, 7, 11, 45) },
      { label: "Tonight 21:00", ms: T(2026, 10, 7, 21, 0) },
      { label: "Tomorrow 09:00", ms: T(2026, 10, 8, 9, 0) },
      { label: "Monday 09:00", ms: T(2026, 10, 12, 9, 0) },
    ]);
  });
});

describe("nearWords", () => {
  it("reads fixes without a year", () => {
    expect(nearWords(T(2026, 10, 7, 11, 0), NOW)).toBe("today 11:00");
    expect(nearWords(T(2026, 10, 8, 9, 0), NOW)).toBe("tomorrow 09:00");
    expect(nearWords(T(2027, 1, 5, 9, 30), NOW)).toBe("Jan 5, 09:30");
    expect(formatDateTime(T(2027, 1, 5, 9, 30), NOW)).toBe("Tue, Jan 5, 2027 · 09:30");
  });
});
