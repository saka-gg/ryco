/**
 * Calendar schedules: runs at one wall-clock time on chosen weekdays, in a named
 * time zone ("weekdays at 09:00, Europe/Berlin"), unlike a fixed interval, which is
 * elapsed time and drifts by an hour at a clock change.
 *
 * Clock changes: a time that does not exist on a day (inside the hour clocks spring
 * forward) is skipped that day; a time that happens twice (the hour clocks go back)
 * runs once, at its first instance.
 *
 * Pure: zone math through `Intl.DateTimeFormat`, no I/O. Shared by the server's
 * scheduler and every client's schedule words, so both compute the same runs.
 *
 * @module automationCalendar
 */

export interface CalendarRule {
  /** IANA zone, e.g. "Europe/Berlin". */
  readonly timeZone: string;
  /** Minutes after local midnight, 0–1439. */
  readonly minutes: number;
  /** Weekdays it runs on, 0 = Sunday … 6 = Saturday. */
  readonly weekdays: ReadonlyArray<number>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether the runtime knows the zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Minutes after midnight for "HH:MM"; null when it is not a valid 24-hour time. */
export function parseLocalTime(text: string): number | null {
  const match = LOCAL_TIME.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** "HH:MM" for minutes after midnight. */
export function formatLocalTime(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minutes: number;
}

/** The wall-clock date and time of an instant in a zone (to the minute). */
export function localDateTime(ms: number, timeZone: string): LocalDateTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? Number.NaN);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    minutes: part("hour") * 60 + part("minute"),
  };
}

/** UTC milliseconds of a wall-clock date and time read as if it were UTC. */
const asUtc = (local: LocalDateTime) =>
  Date.UTC(local.year, local.month - 1, local.day) + local.minutes * MINUTE_MS;

/** The zone's offset from UTC at an instant, in milliseconds (to the minute). */
function offsetAt(ms: number, timeZone: string): number {
  const floored = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  return asUtc(localDateTime(floored, timeZone)) - floored;
}

/**
 * The instant a wall-clock date and time happens in a zone: the earlier one when it
 * happens twice, null when it does not happen (a clock change skips it).
 */
export function zonedInstant(local: LocalDateTime, timeZone: string): number | null {
  const wall = asUtc(local);
  const offsets = new Set([
    offsetAt(wall - 14 * 60 * MINUTE_MS, timeZone),
    offsetAt(wall, timeZone),
    offsetAt(wall + 14 * 60 * MINUTE_MS, timeZone),
  ]);
  let earliest: number | null = null;
  for (const offset of offsets) {
    const candidate = wall - offset;
    if (asUtc(localDateTime(candidate, timeZone)) !== wall) continue;
    if (earliest === null || candidate < earliest) earliest = candidate;
  }
  return earliest;
}

/** The weekday (0 = Sunday) of a calendar date. */
const weekdayOf = (local: Pick<LocalDateTime, "year" | "month" | "day">) =>
  new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();

/** The calendar date `days` after a date. */
function addCalendarDays(
  local: Pick<LocalDateTime, "year" | "month" | "day">,
  days: number,
): Pick<LocalDateTime, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day) + days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * The first run strictly after `afterMs`, or null when the rule has no weekday.
 * Looks at most two weeks ahead, which covers every rule with a weekday (a skipped
 * day comes back the following week).
 */
export function nextCalendarRun(rule: CalendarRule, afterMs: number): number | null {
  if (rule.weekdays.length === 0 || !Number.isFinite(afterMs)) return null;
  const days = new Set(rule.weekdays);
  const today = localDateTime(afterMs, rule.timeZone);
  for (let offset = 0; offset <= 14; offset += 1) {
    const date = addCalendarDays(today, offset);
    if (!days.has(weekdayOf(date))) continue;
    const run = zonedInstant({ ...date, minutes: rule.minutes }, rule.timeZone);
    if (run !== null && run > afterMs) return run;
  }
  return null;
}

/** Runs in [fromMs, untilMs] (inclusive), at most `limit`. */
export function calendarRuns(
  rule: CalendarRule,
  fromMs: number,
  untilMs: number,
  limit: number,
): number[] {
  const out: number[] = [];
  let cursor = fromMs - 1;
  while (out.length < limit) {
    const next = nextCalendarRun(rule, cursor);
    if (next === null || next > untilMs) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** How many runs fall in [fromMs, untilMs], counted up to `cap`. */
export function countCalendarRuns(
  rule: CalendarRule,
  fromMs: number,
  untilMs: number,
  cap = 1_000,
): number {
  return calendarRuns(rule, fromMs, untilMs, cap).length;
}

/** The rule of a contract calendar schedule; null when its time of day is not valid. */
export function calendarRuleOf(schedule: {
  readonly timeZone: string;
  readonly localTime: string;
  readonly weekdays: ReadonlyArray<number>;
}): CalendarRule | null {
  const minutes = parseLocalTime(schedule.localTime);
  return minutes === null
    ? null
    : { timeZone: schedule.timeZone, minutes, weekdays: schedule.weekdays };
}

/** A sorted copy without repeats, or null when a day is not 0–6 or none is left. */
export function normalizeWeekdays(weekdays: ReadonlyArray<number>): number[] | null {
  if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return null;
  const unique = [...new Set(weekdays)].toSorted((left, right) => left - right);
  return unique.length > 0 ? unique : null;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "every day" · "every weekday" · "every weekend day" · "every Friday" · "Mon, Wed and Fri". */
export function calendarDaysWords(weekdays: ReadonlyArray<number>): string {
  const days = normalizeWeekdays(weekdays) ?? [];
  if (days.length === 7) return "every day";
  if (days.join() === "1,2,3,4,5") return "every weekday";
  if (days.join() === "0,6") return "every weekend day";
  if (days.length === 1) return `every ${WEEKDAY_LONG[days[0]!]}`;
  const names = days.map((day) => WEEKDAY_SHORT[day]!);
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "every weekday at 09:00" (with the zone when it is not the reader's own). */
export function calendarWords(rule: CalendarRule, readerTimeZone?: string): string {
  const zone =
    readerTimeZone !== undefined && readerTimeZone !== rule.timeZone ? ` (${rule.timeZone})` : "";
  return `${calendarDaysWords(rule.weekdays)} at ${formatLocalTime(rule.minutes)}${zone}`;
}
