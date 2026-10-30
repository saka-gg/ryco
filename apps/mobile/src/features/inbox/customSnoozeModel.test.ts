import { describe, expect, it } from "vite-plus/test";

import {
  canStepCustomSnoozeDayBack,
  customSnoozeDayLabel,
  finishCustomSnooze,
  initialCustomSnoozeDraft,
  isCustomSnoozeRequested,
  requestCustomSnooze,
  resolveCustomSnoozeDraft,
  stepCustomSnoozeDay,
  stepCustomSnoozeTime,
} from "./customSnoozeModel";

// Wednesday 2026-10-28 14:07 local.
const now = new Date(2026, 9, 28, 14, 7);

describe("custom snooze draft", () => {
  it("starts an hour out, or at two hours of duration", () => {
    const draft = initialCustomSnoozeDraft(now);
    expect(draft).toEqual({
      mode: "date",
      date: "2026-10-28",
      time: "15:07",
      amount: "2",
      unit: "hours",
    });
    expect(resolveCustomSnoozeDraft(draft, now)).toEqual({
      snoozedUntil: new Date(2026, 9, 28, 15, 7).toISOString(),
    });
  });

  it("steps the day, never before today", () => {
    const draft = initialCustomSnoozeDraft(now);
    expect(customSnoozeDayLabel(draft, now)).toBe("Today");
    expect(canStepCustomSnoozeDayBack(draft, now)).toBe(false);
    expect(stepCustomSnoozeDay(draft, -1, now)).toBe(draft);
    const tomorrow = stepCustomSnoozeDay(draft, 1, now);
    expect(tomorrow.date).toBe("2026-10-29");
    expect(customSnoozeDayLabel(tomorrow, now)).toBe("Tomorrow");
    expect(canStepCustomSnoozeDayBack(tomorrow, now)).toBe(true);
    // Across a month end.
    expect(stepCustomSnoozeDay({ ...draft, date: "2026-10-31" }, 1, now).date).toBe("2026-11-01");
  });

  it("steps the time on a 15-minute grid, around the clock", () => {
    const draft = initialCustomSnoozeDraft(now);
    expect(stepCustomSnoozeTime(draft, 1).time).toBe("15:15");
    expect(stepCustomSnoozeTime(draft, -1).time).toBe("15:00");
    expect(stepCustomSnoozeTime({ ...draft, time: "15:00" }, -1).time).toBe("14:45");
    expect(stepCustomSnoozeTime({ ...draft, time: "23:50" }, 1).time).toBe("00:00");
    expect(stepCustomSnoozeTime({ ...draft, time: "00:00" }, -1).time).toBe("23:45");
  });

  it("says what to fix for a past time or an empty duration", () => {
    const draft = initialCustomSnoozeDraft(now);
    expect(resolveCustomSnoozeDraft({ ...draft, time: "14:00" }, now)).toEqual({
      error: "Choose a valid date and time in the future.",
    });
    expect(resolveCustomSnoozeDraft({ ...draft, mode: "duration", amount: "" }, now)).toEqual({
      error: "Enter a positive duration.",
    });
    expect(
      resolveCustomSnoozeDraft({ ...draft, mode: "duration", amount: "90", unit: "minutes" }, now),
    ).toEqual({ snoozedUntil: new Date(now.getTime() + 90 * 60_000).toISOString() });
  });
});

describe("custom snooze request", () => {
  it("resolves the chosen time, or null when a newer request replaces it", async () => {
    const first = requestCustomSnooze();
    expect(isCustomSnoozeRequested()).toBe(true);
    const second = requestCustomSnooze();
    await expect(first).resolves.toBeNull();
    finishCustomSnooze("2026-10-29T08:00:00.000Z");
    await expect(second).resolves.toBe("2026-10-29T08:00:00.000Z");
    expect(isCustomSnoozeRequested()).toBe(false);
  });
});
