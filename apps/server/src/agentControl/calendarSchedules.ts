/**
 * The scheduler's calendar schedule rules (`kind: "calendar"`): validity, the first run
 * and the next run with the missed ones coalesced. Loaded through `import()` the first
 * time a calendar schedule is checked or due, so the zone math stays off the server boot
 * path.
 *
 * Pure: no services, no I/O.
 *
 * @module agentControl/calendarSchedules
 */
import type { AgentControlAutomationSchedule } from "@ryco/contracts";
import {
  calendarRuleOf,
  calendarRuns,
  isValidTimeZone,
  nextCalendarRun,
  normalizeWeekdays,
} from "@ryco/shared/automationCalendar";

type CalendarSchedule = Extract<AgentControlAutomationSchedule, { kind: "calendar" }>;

/** Why a calendar schedule cannot be used, or null. */
export function calendarScheduleProblem(schedule: CalendarSchedule): string | null {
  if (!isValidTimeZone(schedule.timeZone)) return "The schedule's time zone is not known.";
  if (calendarRuleOf(schedule) === null) return "The schedule's time of day is not valid.";
  const days = normalizeWeekdays(schedule.weekdays);
  if (days === null || days.length !== schedule.weekdays.length)
    return "The schedule's weekdays must be distinct, 0 to 6.";
  if (firstCalendarRun(schedule) === null)
    return "No run falls between the schedule's start and end.";
  return null;
}

/** The first calendar time at or after the start, inside the end; null when none is. */
export function firstCalendarRun(schedule: CalendarSchedule): string | null {
  const rule = calendarRuleOf(schedule);
  const first = rule === null ? null : nextCalendarRun(rule, Date.parse(schedule.startsAt) - 1);
  return first === null || first > Date.parse(schedule.endsAt)
    ? null
    : new Date(first).toISOString();
}

/** The run after `dueAt` (not before `now`), and how many times were missed in between. */
export function nextCalendarOccurrence(
  schedule: CalendarSchedule,
  dueAt: string,
  now: string,
): { readonly nextRunAt: string | null; readonly coalescedOccurrences: number } {
  const rule = calendarRuleOf(schedule);
  if (rule === null) return { nextRunAt: null, coalescedOccurrences: 0 };
  const dueMs = Date.parse(dueAt);
  const nowMs = Date.parse(now);
  const endsMs = Date.parse(schedule.endsAt);
  // Missed times coalesce into this one run, like a fixed interval's.
  const coalescedOccurrences = calendarRuns(rule, dueMs + 1, Math.min(nowMs, endsMs), 1_000).length;
  const next = nextCalendarRun(rule, Math.max(dueMs, nowMs));
  return {
    nextRunAt: next === null || next > endsMs ? null : new Date(next).toISOString(),
    coalescedOccurrences,
  };
}
