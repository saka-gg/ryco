import { describe, expect, it } from "vite-plus/test";

import {
  dueAtDayStart,
  dueAtForDay,
  dueLabel,
  dueQuickPicks,
  isDueSoon,
  isOverdue,
  nextWeekdayDayStart,
} from "./taskDue.logic";

// Sunday, Oct 18 2026, mid-afternoon local time.
const NOW = new Date(2026, 9, 18, 15, 30).getTime();
const dueIn = (days: number) => dueAtForDay(new Date(2026, 9, 18 + days, 12).getTime());

describe("dueLabel", () => {
  it("names the nearest days and the weekdays of the coming week", () => {
    expect(dueLabel(dueIn(0), NOW)).toBe("Today");
    expect(dueLabel(dueIn(1), NOW)).toBe("Tomorrow");
    expect(dueLabel(dueIn(2), NOW)).toBe("Tue");
    expect(dueLabel(dueIn(6), NOW)).toBe("Sat");
  });

  it("names the date from a week out, with the year only when it differs", () => {
    expect(dueLabel(dueIn(7), NOW)).toBe("Oct 25");
    expect(dueLabel(dueAtForDay(new Date(2027, 0, 4).getTime()), NOW)).toBe("Jan 4, 2027");
  });

  it("says Overdue once the day has passed", () => {
    expect(dueLabel(dueIn(-1), NOW)).toBe("Overdue");
    expect(dueLabel(dueIn(-30), NOW)).toBe("Overdue");
  });

  it("says nothing for a date it cannot read", () => {
    expect(dueLabel("not a date", NOW)).toBeNull();
  });
});

describe("isDueSoon / isOverdue", () => {
  it("is soon within two days and while overdue", () => {
    expect(isDueSoon(dueIn(-1), NOW)).toBe(true);
    expect(isDueSoon(dueIn(0), NOW)).toBe(true);
    expect(isDueSoon(dueIn(2), NOW)).toBe(true);
    expect(isDueSoon(dueIn(3), NOW)).toBe(false);
    expect(isOverdue(dueIn(-1), NOW)).toBe(true);
    expect(isOverdue(dueIn(0), NOW)).toBe(false);
  });

  it("counts calendar days, not 24-hour spans", () => {
    const lateTonight = new Date(2026, 9, 18, 23, 59).getTime();
    expect(dueLabel(dueIn(1), lateTonight)).toBe("Tomorrow");
    expect(isOverdue(dueIn(0), lateTonight)).toBe(false);
  });
});

describe("due days", () => {
  it("stores a day as the ISO instant of its local midnight", () => {
    const dueAt = dueAtForDay(new Date(2026, 9, 21, 17, 45).getTime());
    expect(Date.parse(dueAt)).toBe(new Date(2026, 9, 21).getTime());
    expect(dueAtDayStart(dueAt)).toBe(new Date(2026, 9, 21).getTime());
    expect(dueAtDayStart(null)).toBeNull();
  });

  it("finds the next weekday, a week out on today's own weekday", () => {
    expect(nextWeekdayDayStart(NOW, 1)).toBe(new Date(2026, 9, 19).getTime());
    expect(nextWeekdayDayStart(NOW, 5)).toBe(new Date(2026, 9, 23).getTime());
    expect(nextWeekdayDayStart(NOW, 0)).toBe(new Date(2026, 9, 25).getTime());
  });

  it("offers today, tomorrow and the coming Monday", () => {
    expect(dueQuickPicks(NOW)).toEqual([
      { label: "Today", dayMs: new Date(2026, 9, 18).getTime() },
      { label: "Tomorrow", dayMs: new Date(2026, 9, 19).getTime() },
      { label: "Next week", dayMs: new Date(2026, 9, 19).getTime() },
    ]);
    const monday = new Date(2026, 9, 19, 9).getTime();
    expect(dueQuickPicks(monday)[2]?.dayMs).toBe(new Date(2026, 9, 26).getTime());
  });
});
