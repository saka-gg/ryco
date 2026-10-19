import {
  WEEKDAY_NAMES_SHORT,
  addDays,
  calendarDayDiff,
  dayStart,
  formatDate,
} from "@ryco/shared/automationSchedule";

/**
 * Due dates on the Tasks page are whole days: `dueAt` is the ISO instant of
 * the due day's local midnight, and every label counts calendar days from
 * today, so a task due "Tomorrow" says so all of today.
 */

/** A due date this many days away or fewer reads amber. */
const DUE_SOON_DAYS = 2;

function dueDayMs(dueAt: string): number | null {
  const ms = Date.parse(dueAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Calendar days from today to the due day (negative once it has passed); `null` for a bad date. */
export function dueDayDiff(dueAt: string, nowMs: number): number | null {
  const ms = dueDayMs(dueAt);
  return ms === null ? null : calendarDayDiff(nowMs, ms);
}

/** "Overdue", "Today", "Tomorrow", a weekday within the week ("Fri"), else the date ("Oct 24"). */
export function dueLabel(dueAt: string, nowMs: number): string | null {
  const ms = dueDayMs(dueAt);
  if (ms === null) return null;
  const diff = calendarDayDiff(nowMs, ms);
  if (diff < 0) return "Overdue";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff < 7) return WEEKDAY_NAMES_SHORT[new Date(ms).getDay()] ?? formatDate(ms, nowMs);
  return formatDate(ms, nowMs);
}

/** Due within two days, or already overdue: the meta line shows it in amber. */
export function isDueSoon(dueAt: string, nowMs: number): boolean {
  const diff = dueDayDiff(dueAt, nowMs);
  return diff !== null && diff <= DUE_SOON_DAYS;
}

export function isOverdue(dueAt: string, nowMs: number): boolean {
  const diff = dueDayDiff(dueAt, nowMs);
  return diff !== null && diff < 0;
}

/** The `dueAt` for a day: the ISO instant of that day's local midnight. */
export function dueAtForDay(dayMs: number): string {
  return new Date(dayStart(dayMs)).toISOString();
}

/** The local midnight a `dueAt` falls on, for the calendar; `null` without one. */
export function dueAtDayStart(dueAt: string | null): number | null {
  if (dueAt === null) return null;
  const ms = dueDayMs(dueAt);
  return ms === null ? null : dayStart(ms);
}

/**
 * The next `weekday` (0 = Sunday) after today: today's own weekday means a
 * week from today, never today itself.
 */
export function nextWeekdayDayStart(nowMs: number, weekday: number): number {
  const today = dayStart(nowMs);
  const ahead = (weekday - new Date(today).getDay() + 7) % 7 || 7;
  return addDays(today, ahead);
}

export interface DueQuickPick {
  readonly label: "Today" | "Tomorrow" | "Next week";
  readonly dayMs: number;
}

/** The due popover's quick picks; "Next week" is the coming Monday. */
export function dueQuickPicks(nowMs: number): ReadonlyArray<DueQuickPick> {
  const today = dayStart(nowMs);
  return [
    { label: "Today", dayMs: today },
    { label: "Tomorrow", dayMs: addDays(today, 1) },
    { label: "Next week", dayMs: nextWeekdayDayStart(nowMs, 1) },
  ];
}
