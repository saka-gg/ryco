/**
 * Month-grid plumbing for the calendar: which days a month view shows and how
 * a day reads aloud. Pure local-time arithmetic on top of the shared schedule
 * module (no schedule math lives here).
 */
import {
  MONTH_NAMES_LONG,
  WEEKDAY_NAMES_LONG,
  WEEKDAY_NAMES_SHORT,
  addDays,
  daysInMonth,
} from "@ryco/shared/automationSchedule";

/** Local midnight on the first of `ms`'s month. */
export function monthStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Local midnight on the last day of `ms`'s month. */
export function monthLastDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
}

/** The 42 days (six Monday-first weeks) a month view shows. */
export function monthGridDays(viewMs: number): number[] {
  const lead = (new Date(viewMs).getDay() + 6) % 7;
  const days: number[] = [];
  let day = addDays(viewMs, -lead);
  for (let i = 0; i < 42; i += 1) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

/** "October 2026" */
export function monthTitle(viewMs: number): string {
  const d = new Date(viewMs);
  return `${MONTH_NAMES_LONG[d.getMonth()] ?? ""} ${d.getFullYear()}`;
}

/** Monday-first weekday columns: `{ short: "Mo", long: "Monday" }`. */
export const WEEK_COLUMNS: ReadonlyArray<{ readonly short: string; readonly long: string }> = [
  1, 2, 3, 4, 5, 6, 0,
].map((day) => ({
  short: (WEEKDAY_NAMES_SHORT[day] ?? "").slice(0, 2),
  long: WEEKDAY_NAMES_LONG[day] ?? "",
}));

/** "Thursday, October 8, 2026, today, unavailable, in the past" */
export function dayAriaLabel(
  dayMs: number,
  options: {
    readonly today: boolean;
    readonly unavailable: "past" | "late" | null;
    readonly lateNote: string;
  },
): string {
  const d = new Date(dayMs);
  const why =
    options.unavailable === "late"
      ? `, unavailable, ${options.lateNote}`
      : options.unavailable === "past"
        ? ", unavailable, in the past"
        : "";
  return `${WEEKDAY_NAMES_LONG[d.getDay()] ?? ""}, ${MONTH_NAMES_LONG[d.getMonth()] ?? ""} ${d.getDate()}, ${d.getFullYear()}${options.today ? ", today" : ""}${why}`;
}

/** `dayMs`'s day of the month in `viewMs`'s month, clamped to that month's length. */
export function sameDateInMonth(dayMs: number, viewMs: number): number {
  const from = new Date(dayMs);
  const to = new Date(viewMs);
  return new Date(
    to.getFullYear(),
    to.getMonth(),
    Math.min(from.getDate(), daysInMonth(to.getFullYear(), to.getMonth())),
  ).getTime();
}
