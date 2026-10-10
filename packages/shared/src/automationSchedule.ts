/**
 * Automation schedules: local-time math, validation and words.
 *
 * Pure and DOM-free. Every calendar computation runs in the host's local time
 * zone through `Date`'s local accessors, so day boundaries, "tomorrow" and
 * clock changes (DST) are the user's own. Intervals are elapsed time, never
 * calendar rules: "every 24 hours from 03:00" lands at 02:00 after clocks go
 * back. That matches the server, which adds `intervalMs` to the start.
 *
 * Times are accepted as epoch milliseconds or ISO strings (the contract shape),
 * schedules as either the contract `AgentControlAutomationSchedule` (ISO) or
 * the millisecond `ScheduleMs`, so callers never convert by hand.
 *
 * Validation mirrors the server's `validateDefinition` exactly (start strictly
 * after now, end at or before now + 90 days, interval at least 15 minutes,
 * recurring end not before the start) plus the client-only draft checks
 * (title, prompt, model, the per-project active limit), worded for inline use.
 */
import {
  AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
  AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
  AGENT_CONTROL_AUTOMATION_PROMPT_MAX_CHARS,
  AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
  AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
  AGENT_CONTROL_TITLE_MAX_CHARS,
  PROVIDER_DISPLAY_NAMES,
  type AgentControlAutomationSchedule,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderAvailability,
  type ServerProviderState,
} from "@ryco/contracts";

import { getModelDisplayName } from "./model.ts";

// ── Units and limits ─────────────────────────────────────────────────

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** The backend's automation limits, under the names the dialog uses. */
export const AUTOMATION_LIMITS = {
  minIntervalMs: AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
  horizonMs: AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
  perProject: AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  promptMax: AGENT_CONTROL_AUTOMATION_PROMPT_MAX_CHARS,
  titleMax: AGENT_CONTROL_TITLE_MAX_CHARS,
  approvalTtlMs: AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS,
  historyMax: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
} as const;

// ── Shapes ───────────────────────────────────────────────────────────

/** Epoch milliseconds or an ISO date-time string. */
export type TimeInput = number | string;

export type ScheduleMs =
  | { readonly kind: "once"; readonly runAt: number }
  | {
      readonly kind: "fixed-interval";
      readonly startsAt: number;
      readonly intervalMs: number;
      readonly endsAt: number;
    };

/** A schedule as the contracts carry it (ISO) or in milliseconds. */
export type ScheduleInput = ScheduleMs | AgentControlAutomationSchedule;

/** Milliseconds for a time input; NaN when it is missing or unreadable. */
export function toMs(value: TimeInput | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

/** An ISO string for a millisecond time; "" when the time is not finite. */
export function isoFromMs(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

export function scheduleToMs(schedule: ScheduleInput): ScheduleMs {
  if (schedule.kind === "once") return { kind: "once", runAt: toMs(schedule.runAt) };
  return {
    kind: "fixed-interval",
    startsAt: toMs(schedule.startsAt),
    intervalMs: Number(schedule.intervalMs),
    endsAt: toMs(schedule.endsAt),
  };
}

/** The contract shape (ISO strings, integer interval) for a millisecond schedule. */
export function scheduleToContract(schedule: ScheduleInput): AgentControlAutomationSchedule {
  const s = scheduleToMs(schedule);
  if (s.kind === "once") return { kind: "once", runAt: isoFromMs(s.runAt) };
  return {
    kind: "fixed-interval",
    startsAt: isoFromMs(s.startsAt),
    intervalMs: Math.round(s.intervalMs),
    endsAt: isoFromMs(s.endsAt),
  };
}

// ── Local calendar math ──────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
export const MONTH_NAMES_SHORT = MONTHS;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_NAMES_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
export const WEEKDAY_NAMES_SHORT = WEEKDAYS;

/** Local midnight of the day `ms` falls on. */
export function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days later, keeping the wall-clock time (DST-safe). */
export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Calendar months later, clamping the day to the target month's length. */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return d.getTime();
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Wall-clock minutes since local midnight. */
export function minutesOf(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** The local time `minutes` after the midnight of `dayMs`'s day (1440 rolls over). */
export function withMinutes(dayMs: number, minutes: number): number {
  const d = new Date(dayMs);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

export function sameDay(a: number, b: number): boolean {
  return dayStart(a) === dayStart(b);
}

/** Calendar days from `fromMs` to `toMs` (23 h and 25 h days count as one). */
export function calendarDayDiff(fromMs: number, toMs: number): number {
  return Math.round((dayStart(toMs) - dayStart(fromMs)) / DAY_MS);
}

export const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
export const roundMinute = (ms: number) => Math.round(ms / MINUTE_MS) * MINUTE_MS;
/** The next quarter hour at or after `ms` (quarter-hour offsets keep this local). */
export const ceilQuarter = (ms: number) => Math.ceil(ms / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
export const floorQuarter = (ms: number) => Math.floor(ms / (15 * MINUTE_MS)) * 15 * MINUTE_MS;

/** "Europe/Berlin" — the zone every time here is shown in. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
  } catch {
    return "Local time";
  }
}

// ── Formatting ───────────────────────────────────────────────────────

const yearSuffix = (ms: number, nowMs: number | undefined) =>
  nowMs != null && new Date(ms).getFullYear() !== new Date(nowMs).getFullYear()
    ? `, ${new Date(ms).getFullYear()}`
    : "";

/** "09:00" */
export function formatTime(ms: TimeInput): string {
  const d = new Date(toMs(ms));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "Wed" (or "Wednesday") */
export function formatWeekday(ms: TimeInput, long = false): string {
  const day = new Date(toMs(ms)).getDay();
  return (long ? WEEKDAY_NAMES_LONG : WEEKDAYS)[day] ?? "";
}

/** "Wed, Oct 7" — with ", 2027" when `nowMs` is given and the year differs. */
export function formatDay(ms: TimeInput, nowMs?: number): string {
  const t = toMs(ms);
  const d = new Date(t);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${yearSuffix(t, nowMs)}`;
}

/** "Oct 7" — with ", 2027" when `nowMs` is given and the year differs. */
export function formatDate(ms: TimeInput, nowMs?: number): string {
  const t = toMs(ms);
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${yearSuffix(t, nowMs)}`;
}

/** "Wed, Oct 7 · 09:00" — the one absolute format of the dialog. */
export function formatDateTime(ms: TimeInput, nowMs?: number): string {
  return `${formatDay(ms, nowMs)} · ${formatTime(ms)}`;
}

/** "Oct 7, 09:00" — the compact form (run previews, one-click fixes). */
export function formatShortDateTime(ms: TimeInput, nowMs?: number): string {
  return `${formatDate(ms, nowMs)}, ${formatTime(ms)}`;
}

/** "2 h" · "30 min" · "1 h 30 min" · "1 day" · "2 weeks" */
export function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms % WEEK_MS === 0) return ms === WEEK_MS ? "1 week" : `${ms / WEEK_MS} weeks`;
  if (ms % DAY_MS === 0) return ms === DAY_MS ? "1 day" : `${ms / DAY_MS} days`;
  const hh = Math.floor(ms / HOUR_MS);
  const mm = Math.round((ms % HOUR_MS) / MINUTE_MS);
  if (!hh) return `${mm} min`;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

/** "1 day" · "2 days" · "3 h" · "15 min" — a duration in whole units. */
export function durationWords(ms: number): string {
  if (ms >= DAY_MS - MINUTE_MS) {
    const n = Math.round(ms / DAY_MS);
    return `${n} ${n === 1 ? "day" : "days"}`;
  }
  if (ms >= HOUR_MS) return `${Math.round(ms / HOUR_MS)} h`;
  return `${Math.round(ms / MINUTE_MS)} min`;
}

/** Strict m:ss (h:mm:ss over an hour). */
export function formatClock(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}

/**
 * Time left, never shaped like a clock time: "13m", "1h 5m", and m:ss only
 * under two minutes ("1:42"). `{ exact: true }` always gives m:ss.
 */
export function countdown(msLeft: number, options: { readonly exact?: boolean } = {}): string {
  if (options.exact) return formatClock(msLeft);
  const left = Math.max(0, msLeft);
  if (left < 2 * MINUTE_MS) return formatClock(left);
  if (left < HOUR_MS) return `${Math.ceil(left / MINUTE_MS)}m`;
  const m = Math.ceil(left / MINUTE_MS);
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}

/** "today 16:00" · "tomorrow 09:00" · "yesterday 22:40" · "Oct 12, 09:00" */
export function dayTime(ms: TimeInput, nowMs: number, separator = " "): string {
  const t = toMs(ms);
  const n = calendarDayDiff(nowMs, t);
  const time = formatTime(t);
  if (n === 0) return `today${separator}${time}`;
  if (n === 1) return `tomorrow${separator}${time}`;
  if (n === -1) return `yesterday${separator}${time}`;
  return `${formatDate(t, nowMs)}, ${time}`;
}

/** "today at 16:00" · "tomorrow at 09:00" · "Fri, Oct 9 at 16:00" */
export function anchorAt(ms: TimeInput, nowMs: number): string {
  const t = toMs(ms);
  const n = calendarDayDiff(nowMs, t);
  const time = formatTime(t);
  if (n === 0) return `today at ${time}`;
  if (n === 1) return `tomorrow at ${time}`;
  if (n === -1) return `yesterday at ${time}`;
  return `${formatDay(t, nowMs)} at ${time}`;
}

/**
 * "today 16:00" · "tomorrow 09:00" · "yesterday 22:40", else the dialog's one
 * absolute format "Wed, Oct 7 · 12:40".
 */
export function when(ms: TimeInput, nowMs: number): string {
  const t = toMs(ms);
  const n = calendarDayDiff(nowMs, t);
  const time = formatTime(t);
  if (n === 0) return `today ${time}`;
  if (n === 1) return `tomorrow ${time}`;
  if (n === -1) return `yesterday ${time}`;
  return formatDateTime(t);
}

/**
 * Relative time, one style everywhere: "now" (under 45 s), "in 7m" ·
 * "in 3h 20m" under 12 h, then "in 22h" · "tomorrow" · "in 4 days" (and the
 * same in the past: "7m ago", "yesterday", "3 days ago").
 */
export function rel(ms: TimeInput, nowMs: number): string {
  const t = toMs(ms);
  const diff = t - nowMs;
  const a = Math.abs(diff);
  const future = diff > 0;
  const words = (s: string) => (future ? `in ${s}` : `${s} ago`);
  if (a < 45_000) return "now";
  if (a < 12 * HOUR_MS) {
    const hh = Math.floor(a / HOUR_MS);
    const mm = Math.max(hh ? 0 : 1, Math.floor((a % HOUR_MS) / MINUTE_MS));
    return words(hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`);
  }
  const days = Math.abs(calendarDayDiff(nowMs, t));
  if (days === 0 || a < 36 * HOUR_MS) return words(`${Math.round(a / HOUR_MS)}h`);
  if (days === 1) return future ? "tomorrow" : "yesterday";
  return words(`${days} days`);
}

// ── Schedule math ────────────────────────────────────────────────────

/** The first run: `runAt` or `startsAt`. */
export function firstRun(schedule: ScheduleInput): number {
  const s = scheduleToMs(schedule);
  return s.kind === "once" ? s.runAt : s.startsAt;
}

/** The last run inside the end (the end is inclusive). */
export function lastRun(schedule: ScheduleInput): number {
  const s = scheduleToMs(schedule);
  if (s.kind === "once") return s.runAt;
  if (!(s.intervalMs > 0) || s.endsAt < s.startsAt) return s.startsAt;
  return s.startsAt + Math.floor((s.endsAt - s.startsAt) / s.intervalMs) * s.intervalMs;
}

/** Occurrences in [fromMs, toMs] (inclusive), at most `limit`. */
export function scheduleOccurrences(
  schedule: ScheduleInput | null | undefined,
  fromMs = Number.NEGATIVE_INFINITY,
  untilMs = Number.POSITIVE_INFINITY,
  limit = 500,
): number[] {
  if (!schedule) return [];
  const s = scheduleToMs(schedule);
  if (s.kind === "once")
    return s.runAt >= fromMs && s.runAt <= untilMs && limit > 0 ? [s.runAt] : [];
  const { startsAt, intervalMs, endsAt } = s;
  if (!(intervalMs > 0) || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return [];
  const out: number[] = [];
  const k0 = fromMs > startsAt ? Math.ceil((fromMs - startsAt) / intervalMs) : 0;
  const end = Math.min(endsAt, untilMs);
  for (let t = startsAt + k0 * intervalMs; t <= end && out.length < limit; t += intervalMs) {
    out.push(t);
  }
  return out;
}

/** The first occurrence strictly after `nowMs`, or null. */
export function nextRun(schedule: ScheduleInput | null | undefined, nowMs: number): number | null {
  if (!schedule) return null;
  const s = scheduleToMs(schedule);
  if (s.kind === "once") return s.runAt > nowMs ? s.runAt : null;
  return scheduleOccurrences(s, nowMs + 1, Number.POSITIVE_INFINITY, 1)[0] ?? null;
}

/** How many occurrences fall at or after `fromMs`. */
export function countRuns(
  schedule: ScheduleInput | null | undefined,
  fromMs = Number.NEGATIVE_INFINITY,
): number {
  if (!schedule) return 0;
  const s = scheduleToMs(schedule);
  if (s.kind === "once") return s.runAt >= fromMs ? 1 : 0;
  if (!(s.intervalMs > 0) || !(s.endsAt >= s.startsAt)) return 0;
  const k0 = fromMs > s.startsAt ? Math.ceil((fromMs - s.startsAt) / s.intervalMs) : 0;
  const kN = Math.floor((s.endsAt - s.startsAt) / s.intervalMs);
  return Math.max(0, kN - k0 + 1);
}

/**
 * A copy whose start is the next future occurrence when the start has passed
 * (the backend rejects a past start, even on edits, pauses and resumes).
 *
 * `leadMs` keeps the start at least that far ahead — the first occurrence
 * after `nowMs + leadMs`, same phase — for a change that may be approved up
 * to `leadMs` later (the server re-checks the start when it applies it). When
 * no occurrence is left that late, the plain next occurrence is used.
 */
export function rollForward(
  schedule: ScheduleInput,
  nowMs: number,
  options: { readonly leadMs?: number } = {},
): ScheduleMs {
  const s = scheduleToMs(schedule);
  const after = nowMs + Math.max(0, options.leadMs ?? 0);
  if (s.kind === "once" || s.startsAt > after) return s;
  const next = nextRun(s, after) ?? (s.startsAt > nowMs ? null : nextRun(s, nowMs));
  return next == null ? s : { ...s, startsAt: next };
}

/**
 * Where a day-based interval's wall-clock time moves at a clock change:
 * `{ at: first run at the new time, from: "03:00", to: "02:00" }`, or null.
 */
export function dstShift(
  schedule: ScheduleInput | null | undefined,
  fromMs: number,
): { readonly at: number; readonly from: string; readonly to: string } | null {
  if (!schedule) return null;
  const s = scheduleToMs(schedule);
  if (s.kind === "once" || s.intervalMs % HOUR_MS !== 0 || s.intervalMs < DAY_MS) return null;
  const occ = scheduleOccurrences(s, fromMs, Number.POSITIVE_INFINITY, 120);
  for (let i = 1; i < occ.length; i++) {
    const a = formatTime(occ[i - 1]!);
    const b = formatTime(occ[i]!);
    if (a !== b) return { at: occ[i]!, from: a, to: b };
  }
  return null;
}

export interface ClockChange {
  /** The moment the clocks change (to the minute). */
  readonly change: number;
  /** The first run at the new wall-clock time. */
  readonly run: number;
  readonly from: string;
  readonly to: string;
  /** "Clocks go back Oct 25 — from then on it runs at 02:00, not 03:00 (fixed 24-hour interval)." */
  readonly text: string;
}

const dayNumber = (ms: number) => {
  const d = new Date(ms);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime() / DAY_MS);
};

/** The clock change a fixed (≥ 1 day) interval drifts across, in words. */
export function clockChange(
  schedule: ScheduleInput | null | undefined,
  nowMs: number,
): ClockChange | null {
  if (!schedule) return null;
  const s = scheduleToMs(schedule);
  if (s.kind === "once" || !dstShift(s, nowMs)) return null;
  const occ = scheduleOccurrences(s, nowMs, Number.POSITIVE_INFINITY, 160);
  const i = occ.findIndex((t, k) => k > 0 && formatTime(t) !== formatTime(occ[k - 1]!));
  if (i < 1) return null;
  const before = occ[i - 1]!;
  const run = occ[i]!;
  const offset = (t: number) => new Date(t).getTimezoneOffset();
  let lo = before;
  let hi = run;
  while (hi - lo > MINUTE_MS) {
    const mid = Math.floor((lo + hi) / 2);
    if (offset(mid) === offset(lo)) lo = mid;
    else hi = mid;
  }
  const iv = s.intervalMs;
  const ivWords =
    iv === DAY_MS
      ? "24-hour"
      : iv % WEEK_MS === 0
        ? `${iv / WEEK_MS}-week`
        : iv % DAY_MS === 0
          ? `${iv / DAY_MS}-day`
          : formatInterval(iv);
  const direction = offset(run) > offset(before) ? "back" : "forward";
  const fromWhen = dayNumber(run) === dayNumber(hi) ? "from then on" : `from ${formatDay(run)}`;
  return {
    change: hi,
    run,
    from: formatTime(before),
    to: formatTime(run),
    text: `Clocks go ${direction} ${formatDate(hi, nowMs)} — ${fromWhen} it runs at ${formatTime(run)}, not ${formatTime(before)} (fixed ${ivWords} interval).`,
  };
}

/* The slot an interval is anchored on: its first run while that is ahead,
   else the next run (whose wall-clock time is the one that holds now, after
   any DST change), else the first run. */
function anchorOf(s: Extract<ScheduleMs, { kind: "fixed-interval" }>, nowMs: number): number {
  if (s.startsAt > nowMs) return s.startsAt;
  return nextRun(s, nowMs) ?? s.startsAt;
}

/**
 * "Every 2 h" · "Every 24 h from 03:00" · "Every 7 days from Fri 16:00" ·
 * "Hourly" · "Once". Never "Daily at" / "Weekly, Fri": intervals are elapsed time.
 */
export function cadence(schedule: ScheduleInput | null | undefined, nowMs: number): string {
  if (!schedule) return "";
  const s = scheduleToMs(schedule);
  if (s.kind === "once") return "Once";
  const i = s.intervalMs;
  if (i % DAY_MS === 0) {
    const ref = anchorOf(s, nowMs);
    const at = i === DAY_MS ? formatTime(ref) : `${formatWeekday(ref)} ${formatTime(ref)}`;
    return `Every ${i === DAY_MS ? "24 h" : `${i / DAY_MS} days`} from ${at}`;
  }
  if (i === HOUR_MS) return "Hourly";
  return `Every ${formatInterval(i)}`;
}

/** "Every 2 h · until Oct 31" · "Once · today 16:00" */
export function scheduleLabel(schedule: ScheduleInput | null | undefined, nowMs: number): string {
  if (!schedule) return "";
  const s = scheduleToMs(schedule);
  if (s.kind === "once") return `Once · ${dayTime(s.runAt, nowMs)}`;
  return `${cadence(s, nowMs)} · until ${formatDate(s.endsAt, nowMs)}`;
}

/**
 * For sentences: "every 7 days from Fri, Oct 9 at 16:00 until Dec 11",
 * "every 24 hours from 03:00 until Oct 31", "once, tomorrow at 09:00".
 * `{ dst: true }` folds a clock change in — "(02:00 from Oct 25)" — use it
 * only where no separate clock-change note is shown.
 */
export function phrase(
  schedule: ScheduleInput | null | undefined,
  nowMs: number,
  options: { readonly dst?: boolean } = {},
): string {
  if (!schedule) return "";
  const s = scheduleToMs(schedule);
  if (s.kind === "once") {
    const n = calendarDayDiff(nowMs, s.runAt);
    const t = formatTime(s.runAt);
    if (n === 0) return `once, today at ${t}`;
    if (n === 1) return `once, tomorrow at ${t}`;
    return `once, on ${formatDay(s.runAt)} at ${t}`;
  }
  const i = s.intervalMs;
  const ahead = s.startsAt > nowMs;
  const shift = options.dst ? dstShift(s, nowMs) : null;
  const dst = shift ? ` (${shift.to} from ${formatDate(shift.at, nowMs)})` : "";
  let core: string;
  if (i % DAY_MS === 0) {
    const every = i === DAY_MS ? "every 24 hours" : `every ${i / DAY_MS} days`;
    const ref = anchorOf(s, nowMs);
    const at = ahead
      ? anchorAt(ref, nowMs)
      : i === DAY_MS
        ? formatTime(ref)
        : `${formatWeekday(ref)} ${formatTime(ref)}`;
    core = `${every} from ${at}${dst}`;
  } else {
    const every =
      i === HOUR_MS
        ? "every hour"
        : i % HOUR_MS === 0
          ? `every ${i / HOUR_MS} hours`
          : `every ${Math.round(i / MINUTE_MS)} minutes`;
    core = ahead ? `${every} from ${anchorAt(s.startsAt, nowMs)}${dst}` : `${every}${dst}`;
  }
  return `${core} until ${formatDate(s.endsAt, nowMs)}`;
}

/** The interval as the word after "every": "day" · "2 hours" · "45 minutes" · "1 h 30 min". */
export function everyWords(intervalMs: number): string {
  const ms = intervalMs;
  if (ms === DAY_MS) return "day";
  if (ms === WEEK_MS) return "week";
  if (ms % WEEK_MS === 0) return `${ms / WEEK_MS} weeks`;
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} days`;
  if (ms === HOUR_MS) return "hour";
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} hours`;
  const m = Math.round(ms / MINUTE_MS);
  if (m < 60) return `${m} minutes`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "Every hour" · "Every 2 days" · "Every 45 minutes" — the interval picker's names. */
export function intervalLabel(ms: number): string {
  if (!(ms > 0)) return "—";
  if (ms % WEEK_MS === 0) return ms === WEEK_MS ? "Every week" : `Every ${ms / WEEK_MS} weeks`;
  if (ms % DAY_MS === 0) return ms === DAY_MS ? "Every day" : `Every ${ms / DAY_MS} days`;
  if (ms % HOUR_MS === 0) return ms === HOUR_MS ? "Every hour" : `Every ${ms / HOUR_MS} hours`;
  const m = Math.round(ms / MINUTE_MS);
  if (m < 180) return `Every ${m} minutes`;
  return `Every ${Math.floor(m / 60)} h ${m % 60} min`;
}

// ── Pickers: presets, ends, previews ─────────────────────────────────

/** The interval picker's chips, then "Custom". */
export const INTERVAL_PRESETS: ReadonlyArray<{ readonly label: string; readonly ms: number }> = [
  { label: "15m", ms: 15 * MINUTE_MS },
  { label: "30m", ms: 30 * MINUTE_MS },
  { label: "1h", ms: HOUR_MS },
  { label: "2h", ms: 2 * HOUR_MS },
  { label: "6h", ms: 6 * HOUR_MS },
  { label: "Daily", ms: DAY_MS },
  { label: "Weekly", ms: WEEK_MS },
];

/** The end picker's durations, then "Max" and "On a date…". */
export const UNTIL_PRESETS: ReadonlyArray<{ readonly label: string; readonly ms: number }> = [
  { label: "1 day", ms: DAY_MS },
  { label: "1 week", ms: WEEK_MS },
  { label: "2 weeks", ms: 2 * WEEK_MS },
  { label: "30 days", ms: 30 * DAY_MS },
];

/** A preset's end: day-based presets keep the start's wall-clock time across a clock change. */
export function endFor(startMs: number, presetMs: number): number {
  return presetMs % DAY_MS === 0
    ? addDays(startMs, Math.round(presetMs / DAY_MS))
    : startMs + presetMs;
}

/** The latest end the end picker offers: now + 90 days, to the minute. */
export function untilLimit(nowMs: number): number {
  return floorMinute(nowMs + AUTOMATION_LIMITS.horizonMs);
}

export type UntilMode =
  | { readonly kind: "dur"; readonly ms: number }
  | { readonly kind: "max" }
  | { readonly kind: "date" };

/**
 * The end picker's duration an end is, to the minute (by calendar days or by
 * elapsed time, so an end across a clock change still reads as "1 week"), or
 * null. The one rule behind `detectUntilMode` and `endWords`.
 */
export function endPreset(startMs: number, endMs: number): (typeof UNTIL_PRESETS)[number] | null {
  return (
    UNTIL_PRESETS.find(
      (preset) =>
        Math.abs(endMs - endFor(startMs, preset.ms)) < MINUTE_MS ||
        Math.abs(endMs - startMs - preset.ms) < MINUTE_MS,
    ) ?? null
  );
}

/** Which end-picker choice an end reads as: a duration preset, "Max", or a date. */
export function detectUntilMode(startMs: number, endMs: number, nowMs: number): UntilMode {
  const preset = endPreset(startMs, endMs);
  if (preset) return { kind: "dur", ms: preset.ms };
  const max = untilLimit(nowMs);
  if (endMs <= max + MINUTE_MS && endMs > max - DAY_MS && endMs - startMs > DAY_MS) {
    return { kind: "max" };
  }
  return { kind: "date" };
}

/**
 * "for 1 week" when the end is one of the end picker's durations, else
 * "until Oct 14": `{ conn: "for" | "until", text, dur }`.
 */
export function endWords(
  startMs: number,
  endMs: number,
  nowMs?: number,
): { readonly conn: "for" | "until"; readonly text: string; readonly dur: boolean } {
  const preset = endPreset(startMs, endMs);
  if (preset) return { conn: "for", text: preset.label, dur: true };
  return { conn: "until", text: formatDate(endMs, nowMs), dur: false };
}

export interface RunPreviewWindow {
  readonly kind: ScheduleMs["kind"];
  /** The next (up to) five runs at or after now. */
  readonly next: readonly number[];
  /** Runs left at or after now. */
  readonly count: number;
  readonly first: number | null;
  readonly last: number | null;
}

/** What the next-runs preview shows: the next five runs, the count, first and last. */
export function runPreviewWindow(
  schedule: ScheduleInput | null | undefined,
  nowMs: number,
): RunPreviewWindow | null {
  if (!schedule) return null;
  const s = scheduleToMs(schedule);
  const next = scheduleOccurrences(s, nowMs, Number.POSITIVE_INFINITY, 5);
  const count = countRuns(s, nowMs);
  if (!next.length) return { kind: s.kind, next, count: 0, first: null, last: null };
  return { kind: s.kind, next, count, first: next[0]!, last: lastRun(s) };
}

/**
 * The preview's one note: the dated clock change for day-based intervals,
 * else the approval load when runs come often. `approvals`: "auto" (load
 * only when > 8 a day), true (always say runs wait), false (never).
 */
export function runPreviewNote(
  schedule: ScheduleInput | null | undefined,
  nowMs: number,
  approvals: "auto" | boolean = "auto",
): string {
  if (!schedule) return "";
  const s = scheduleToMs(schedule);
  const w = runPreviewWindow(s, nowMs);
  if (!w || !w.count) return "";
  if (s.kind === "fixed-interval" && s.intervalMs % DAY_MS === 0) {
    const runs = scheduleOccurrences(s, nowMs, Number.POSITIVE_INFINITY, 400);
    const t0 = minutesOf(runs[0]!);
    const i = runs.findIndex((t) => minutesOf(t) !== t0);
    if (i >= 1) {
      const prev = runs[i - 1]!;
      const offset0 = new Date(prev).getTimezoneOffset();
      let at = prev;
      while (at < runs[i]! && new Date(at).getTimezoneOffset() === offset0) at += HOUR_MS;
      const back = new Date(runs[i]!).getTimezoneOffset() > offset0;
      return `Clocks go ${back ? "back" : "forward"} on ${formatDate(at, nowMs)} — from then on runs land at ${formatTime(runs[i]!)}, since the interval is elapsed time.`;
    }
  }
  if (approvals === false) return "";
  if (s.kind === "once")
    return approvals === true ? "It waits up to 15 min for your approval when it's due." : "";
  const perDay = DAY_MS / s.intervalMs;
  if (perDay > 8 && w.count > 8)
    return `About ${Math.round(perDay)} runs a day — each waits up to 15 min for your approval.`;
  return approvals === true ? "Each run waits up to 15 min for your approval." : "";
}

// ── Validation ───────────────────────────────────────────────────────

export type ScheduleErrorKey =
  | "start"
  | "end"
  | "interval"
  | "title"
  | "prompt"
  | "model"
  | "limit";
export type ScheduleErrors = Partial<Record<ScheduleErrorKey, string>>;

/** The model a definition runs: `ModelSelection` fits. */
export interface ScheduleModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
}

/** A definition to check: the contract definition, or the same with a millisecond schedule. */
export interface ScheduleDefinitionInput {
  readonly execution: {
    readonly title: string;
    readonly prompt: string;
    readonly modelSelection: ScheduleModelSelection | null;
  };
  readonly schedule: ScheduleInput | null;
  readonly enabled: boolean;
}

type AutomationProviderModel = AutomationProviderInfo["models"][number];

/**
 * What schedules need of a device's provider: `ServerProvider` fits. The
 * readiness fields are `ServerProvider`'s; an absent one reads as ready.
 */
export interface AutomationProviderInfo {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly installed?: boolean | undefined;
  readonly status?: ServerProviderState | undefined;
  readonly availability?: ServerProviderAvailability | undefined;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly shortName?: string | undefined;
    readonly capabilities?: ModelCapabilities | null | undefined;
  }>;
}

export interface ScheduleValidationOptions {
  /** Active schedules in the checkout (enabled, not cancelled, a run left). */
  readonly activeCount?: number;
  /** Whether the schedule being edited is active now (re-enabling counts against the limit). */
  readonly editingActive?: boolean;
  /** For the limit sentence: "ryco already has 25 active schedules…". */
  readonly projectName?: string;
  /** The device's providers; omitted skips the availability check. */
  readonly providers?: ReadonlyArray<AutomationProviderInfo>;
}

/** "Claude" — the provider's own name, else its driver's. */
export function providerDisplayName(provider: AutomationProviderInfo): string {
  return (
    provider.displayName?.trim() || PROVIDER_DISPLAY_NAMES[provider.driver] || provider.instanceId
  );
}

/** Whether runs can start on it — the server's `isAgentControlProviderReady`. */
export function isAutomationProviderReady(provider: AutomationProviderInfo): boolean {
  return (
    provider.enabled !== false &&
    provider.installed !== false &&
    (provider.status ?? "ready") === "ready" &&
    (provider.availability ?? "available") === "available"
  );
}

/** The selection's model on its provider, by exact slug (the server takes no aliases). */
function scheduleModelOf(
  selection: ScheduleModelSelection,
  providers: ReadonlyArray<AutomationProviderInfo>,
): AutomationProviderModel | null {
  return (
    providers
      .find((p) => p.instanceId === selection.instanceId)
      ?.models.find((m) => m.slug === selection.model) ?? null
  );
}

const optionValueFits = (
  descriptor: ProviderOptionDescriptor,
  value: ProviderOptionSelection["value"],
) =>
  descriptor.type === "boolean"
    ? typeof value === "boolean"
    : typeof value === "string" && descriptor.options.some((choice) => choice.id === value);

/**
 * Why the server would refuse the model, as a sentence, or null. Mirrors its
 * `providerForSelection`: the provider exists and is ready, the model is there
 * by exact slug, and every option is one of the model's, set once, to one of
 * its values.
 */
export function scheduleModelError(
  selection: ScheduleModelSelection | null | undefined,
  providers: ReadonlyArray<AutomationProviderInfo>,
): string | null {
  if (!selection?.instanceId || !selection.model) return "Pick a model.";
  const provider = providers.find((p) => p.instanceId === selection.instanceId);
  if (!provider) return `${selection.instanceId} isn't set up on this device.`;
  const name = providerDisplayName(provider);
  if (!isAutomationProviderReady(provider)) {
    const why =
      provider.enabled === false
        ? "is turned off"
        : provider.installed === false
          ? "isn't installed"
          : "isn't ready";
    return `${name} ${why} on this device. Pick another model.`;
  }
  const model = scheduleModelOf(selection, providers);
  if (!model) return `${selection.model} isn't available on ${name} any more. Pick another model.`;
  const modelName = getModelDisplayName(model);
  const seen = new Set<string>();
  for (const option of selection.options ?? []) {
    if (seen.has(option.id))
      return `${modelName} has ${option.id} set twice. Pick the model again.`;
    seen.add(option.id);
    const descriptor = model.capabilities?.optionDescriptors?.find((d) => d.id === option.id);
    if (!descriptor)
      return `${modelName} has no ${option.id} setting any more. Pick the model again.`;
    if (!optionValueFits(descriptor, option.value))
      return `${modelName} doesn't offer ${descriptor.label} “${String(option.value)}” any more. Pick the model again.`;
  }
  return null;
}

/**
 * The selection with only the options its model offers (one per id, a value
 * the model has) — for a switch to another model, which keeps the effort only
 * where the new model has it. Unchanged when nothing is dropped or the model
 * is unknown.
 */
export function fitScheduleModelOptions(
  selection: ModelSelection,
  providers: ReadonlyArray<AutomationProviderInfo>,
): ModelSelection {
  const model = scheduleModelOf(selection, providers);
  const options = selection.options ?? [];
  if (!model || options.length === 0) return selection;
  const seen = new Set<string>();
  const kept = options.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    const descriptor = model.capabilities?.optionDescriptors?.find((d) => d.id === option.id);
    return descriptor !== undefined && optionValueFits(descriptor, option.value);
  });
  if (kept.length === options.length) return selection;
  const { options: _dropped, ...rest } = selection;
  return kept.length > 0 ? { ...rest, options: kept } : rest;
}

/**
 * The server's rules plus the draft's, as plain sentences safe to show inline.
 * `start | end | interval` mirror `validateDefinition`; `title | prompt` the
 * execution template schema; `model` the server's `providerForSelection`
 * against the device's providers; `limit` the per-checkout active-schedule
 * cap (creating, or re-enabling a stopped one).
 */
export function validateScheduleDefinition(
  definition: ScheduleDefinitionInput,
  nowMs: number,
  options: ScheduleValidationOptions = {},
): { readonly ok: boolean; readonly errors: ScheduleErrors } {
  const errors: { -readonly [K in ScheduleErrorKey]?: string } = {};
  const L = AUTOMATION_LIMITS;
  const title = definition.execution.title.trim();
  if (!title) errors.title = "Give it a short title.";
  else if (title.length > L.titleMax)
    errors.title = `Keep the title under ${L.titleMax} characters.`;

  const prompt = definition.execution.prompt.trim();
  if (!prompt) errors.prompt = "Tell the agent what to do on each run.";
  else if (prompt.length > L.promptMax)
    errors.prompt = `The prompt is ${prompt.length.toLocaleString("en-US")} characters; the limit is ${L.promptMax.toLocaleString("en-US")}.`;

  const selection = definition.execution.modelSelection;
  if (!selection?.instanceId || !selection.model) errors.model = "Pick a model.";
  else if (options.providers) {
    const modelError = scheduleModelError(selection, options.providers);
    if (modelError) errors.model = modelError;
  }

  const horizon = nowMs + L.horizonMs;
  if (!definition.schedule) errors.start = "Pick when it runs.";
  else {
    const s = scheduleToMs(definition.schedule);
    if (s.kind === "once") {
      if (!Number.isFinite(s.runAt)) errors.start = "Pick a date and time.";
      else if (s.runAt <= nowMs)
        errors.start = `That time has passed. Pick a time after ${dayTime(nowMs, nowMs)}.`;
      else if (s.runAt > horizon)
        errors.start = `Schedules reach at most 90 days ahead — ${formatDate(horizon, nowMs)} at the latest.`;
    } else {
      if (!Number.isFinite(s.startsAt)) errors.start = "Pick when the first run happens.";
      else if (s.startsAt <= nowMs)
        errors.start = `The first run has to be in the future — after ${dayTime(nowMs, nowMs)}.`;
      if (!Number.isFinite(s.intervalMs) || s.intervalMs <= 0)
        errors.interval = "Pick how often it runs.";
      else if (s.intervalMs < L.minIntervalMs)
        errors.interval = "Runs can be at most every 15 minutes.";
      if (!Number.isFinite(s.endsAt)) errors.end = "Recurring schedules need an end.";
      else if (Number.isFinite(s.startsAt) && s.endsAt < s.startsAt)
        errors.end = "It ends before the first run.";
      else if (s.endsAt > horizon)
        errors.end = `Recurring schedules end within 90 days — ${formatDate(horizon, nowMs)} at the latest.`;
    }
  }

  if (
    definition.enabled !== false &&
    !options.editingActive &&
    options.activeCount != null &&
    options.activeCount >= L.perProject
  ) {
    errors.limit = `${options.projectName ?? "This project"} already has ${L.perProject} active schedules, the most a project can have. Pause or cancel one first.`;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}
