/**
 * Plain phrases into a local time — the "type" date picker's reader.
 *
 * "tomorrow 9", "fri 17:30", "in 2h", "12.10. 14:00", "next monday 9am",
 * "tonight"… `parseWhen` only reads; whether the time may be used (after now,
 * inside the 90-day window) is `explainWhen`'s, which also offers the nearest
 * usable time as a one-click fix. `suggestWhen` offers 3–5 valid completions
 * for what is typed. All local time (see `automationSchedule`).
 */
import {
  AUTOMATION_LIMITS,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  MONTH_NAMES_LONG,
  MONTH_NAMES_SHORT,
  WEEKDAY_NAMES_LONG,
  WEEK_MS,
  addDays,
  ceilQuarter,
  daysInMonth,
  dayStart,
  floorMinute,
  floorQuarter,
  formatDate,
  formatDateTime,
  formatShortDateTime,
  formatTime,
  calendarDayDiff,
  minutesOf,
  rel,
  roundMinute,
  sameDay,
  withMinutes,
} from "./automationSchedule.ts";

export interface ParsedWhen {
  readonly ok: true;
  readonly ms: number;
  /** "Thu, Oct 8 · 09:00" */
  readonly label: string;
  /** "tomorrow" · "in 2h" */
  readonly rel: string;
  /** Whether the phrase named a day (else the next such time of day). */
  readonly hasDate: boolean;
  /** Whether the phrase named a time (else `defaultTime`). */
  readonly hasTime: boolean;
}
export interface WhenParseError {
  readonly ok: false;
  readonly error: string;
}
export type WhenParseResult = ParsedWhen | WhenParseError;

const fail = (error: string): WhenParseError => ({ ok: false, error });
const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtMinutes = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

/** "today 10:45" · "tomorrow 09:00" · "Jan 5, 10:30" — for one-click fixes. */
export function nearWords(ms: number, nowMs: number): string {
  if (sameDay(ms, nowMs)) return `today ${formatTime(ms)}`;
  if (calendarDayDiff(nowMs, ms) === 1) return `tomorrow ${formatTime(ms)}`;
  return formatShortDateTime(ms);
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};
const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const PARTS: Readonly<Record<string, number>> = {
  morning: 540,
  noon: 720,
  midday: 720,
  afternoon: 840,
  evening: 1080,
  tonight: 1260,
  night: 1260,
  midnight: 0,
};
const PM_PARTS: ReadonlySet<string> = new Set(["afternoon", "evening", "tonight", "night"]);
const UNITS: Readonly<Record<string, number>> = {
  m: MINUTE_MS,
  min: MINUTE_MS,
  mins: MINUTE_MS,
  minute: MINUTE_MS,
  minutes: MINUTE_MS,
  h: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: WEEK_MS,
  wk: WEEK_MS,
  wks: WEEK_MS,
  week: WEEK_MS,
  weeks: WEEK_MS,
};
const lookup = (table: Readonly<Record<string, number>>, key: string | undefined) =>
  key != null && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** Lower case, "a.m." → "am", "·" "," "@" → spaces, single spaces. */
export function normalizeWhenText(text: string | null | undefined): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\ba\.m\.?/g, "am")
    .replace(/\bp\.m\.?/g, "pm")
    .replace(/[·,@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDuration(src: string): { readonly ms: number } | WhenParseError {
  const s = src
    .replace(/\band\b/g, " ")
    .replace(/\bhalf an? hour\b/g, "30 min")
    .replace(/\ban? (?=[a-z])/g, "1 ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return fail("Add an amount, like “in 2h”");
  const re = /(\d+(?:[.,]\d+)?)\s*([a-z]*)\s*/y;
  let total = 0;
  let prev: number | null = null;
  let idx = 0;
  while (idx < s.length) {
    re.lastIndex = idx;
    const m = re.exec(s);
    if (!m || !m[0]) return fail(`Didn't catch “${src.trim()}” — try “in 2h” or “in 45 min”`);
    idx = re.lastIndex;
    const amount = m[1] ?? "";
    const n = Number.parseFloat(amount.replace(",", "."));
    let unit = m[2] ?? "";
    if (!unit) {
      if (prev === HOUR_MS) unit = "min";
      else if (prev === DAY_MS) unit = "h";
      else return fail(`Add a unit — “${amount} min”, “${amount} h” or “${amount} days”?`);
    }
    const u = lookup(UNITS, unit);
    if (!u) return fail(`Didn't catch “${unit}” — use min, h, days or weeks`);
    total += n * u;
    prev = u;
  }
  if (total < MINUTE_MS) return fail("That's less than a minute away");
  return { ms: total };
}

function toMinutes(
  hours: number,
  minutes: number,
  ampm: string | undefined,
): { readonly min: number } | WhenParseError {
  if (minutes > 59) return fail(`“${pad2(minutes)}” isn't a minute`);
  let h = hours;
  if (ampm) {
    if (h < 1 || h > 12) return fail(`“${h}${ampm}” isn't a time — use 1–12 with am/pm`);
    h = (h % 12) + (ampm[0] === "p" ? 12 : 0);
  } else if (h > 23) return fail(`“${h}:${pad2(minutes)}” isn't a time`);
  return { min: h * 60 + minutes };
}

/** A time of day only: "9", "9:30", "21:05", "9pm", "930", "noon" → minutes, or null. */
export function parseTimeOfDay(text: string): number | null {
  const s = normalizeWhenText(text).replace(/\s+/g, "");
  if (!s) return null;
  if (s === "noon" || s === "midday") return 720;
  if (s === "midnight") return 0;
  let m = s.match(/^(\d{1,2})(?:[:.h](\d{2}))?(am|pm|a|p)?h?$/);
  if (m) {
    const r = toMinutes(Number(m[1]), m[2] != null ? Number(m[2]) : 0, m[3]);
    return "min" in r ? r.min : null;
  }
  m = s.match(/^(\d{3,4})(am|pm|a|p)?$/);
  if (m) {
    const v = Number(m[1]);
    const r = toMinutes(Math.floor(v / 100), v % 100, m[2]);
    return "min" in r ? r.min : null;
  }
  return null;
}

const DURATION_HEAD =
  /^\d+(?:[.,]\d+)?\s*(?:m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)(?:\s|$|\d)/;

interface ParseState {
  date: number | null;
  dateWord: string | null;
  month: number | null;
  day: number | null;
  year: number | null;
  wd: number | null;
  wdNext: boolean;
  min: number | null;
  part: string | null;
  ampm: boolean;
}

/**
 * Read a phrase as a local time. Range checks are `explainWhen`'s: this only
 * reads. `defaultTime` (minutes, default 09:00) fills in a phrase without a time.
 */
export function parseWhen(
  text: string,
  nowMs: number,
  options: { readonly defaultTime?: number } = {},
): WhenParseResult {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const s0 = normalizeWhenText(text);
  if (!s0) return fail("Type when — “tomorrow 9”, “fri 17:30” or “in 2h”");
  const done = (ms: number, hasDate: boolean, hasTime: boolean): ParsedWhen => ({
    ok: true,
    ms,
    label: formatDateTime(ms, now),
    rel: rel(ms, now),
    hasDate,
    hasTime,
  });
  if (s0 === "now") return done(floorMinute(now), true, true);
  const offset =
    s0.match(/^now\s*\+\s*(.+)$/) ??
    s0.match(/^\+\s*(.+)$/) ??
    s0.match(/^in\s+(.+)$/) ??
    s0.match(/^(.+?)\s+from now$/);
  if (offset) {
    const d = parseDuration(offset[1] ?? "");
    return "ms" in d ? done(roundMinute(now + d.ms), true, true) : d;
  }
  if (DURATION_HEAD.test(s0)) {
    const d = parseDuration(s0);
    if ("ms" in d) return done(roundMinute(now + d.ms), true, true);
  }

  const s = s0
    .replace(/\bday after tomorrow\b/g, "overmorrow")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1")
    .replace(/\b(at|on|the|of|by)\b/g, " ")
    .replace(/\bo'?clock\b/g, " ")
    .replace(/(\d)\s+(am|pm|a|p)\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  const toks = s.split(" ").filter(Boolean);
  const today = dayStart(now);
  const st: ParseState = {
    date: null,
    dateWord: null,
    month: null,
    day: null,
    year: null,
    wd: null,
    wdNext: false,
    min: null,
    part: null,
    ampm: false,
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] ?? "";
    const nx = toks[i + 1];
    let mm: RegExpMatchArray | null;
    const setDate = (ms: number, word: string): WhenParseError | null => {
      if (st.date != null) return fail("Two days there — keep one");
      st.date = ms;
      st.dateWord = word;
      return null;
    };
    let err: WhenParseError | null = null;
    const month = lookup(MONTHS, t);
    const weekday = lookup(WEEKDAYS, t);
    if (t === "today") err = setDate(today, "Today");
    else if (t === "tomorrow" || t === "tmrw" || t === "tmr" || t === "tom")
      err = setDate(addDays(today, 1), "Tomorrow");
    else if (t === "overmorrow") err = setDate(addDays(today, 2), "The day after tomorrow");
    else if (t === "yesterday") err = setDate(addDays(today, -1), "Yesterday");
    else if (t === "this") continue;
    else if (t === "next") {
      if (lookup(WEEKDAYS, nx) != null) st.wdNext = true;
      else if (nx === "week") {
        st.wd = 1;
        st.wdNext = true;
        i++;
      } else return fail("Next what? Try “next monday 9am”");
    } else if (lookup(PARTS, t) != null) {
      st.part = t;
      if (t === "tonight" && st.date == null) {
        st.date = today;
        st.dateWord = "Tonight";
      }
    } else if (weekday != null) st.wd = weekday;
    else if (month != null) {
      st.month = month;
      if (nx && /^\d{1,2}$/.test(nx) && st.day == null) {
        st.day = Number(nx);
        i++;
      }
    } else if (/^\d{1,2}$/.test(t) && lookup(MONTHS, nx) != null) {
      st.day = Number(t);
      st.month = lookup(MONTHS, nx) ?? null;
      i++;
    } else if ((mm = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/))) {
      st.day = Number(mm[1]);
      st.month = Number(mm[2]) - 1;
      if (mm[3]) st.year = mm[3].length === 2 ? 2000 + Number(mm[3]) : Number(mm[3]);
      if (st.month < 0 || st.month > 11) return fail(`There's no month ${mm[2]}`);
    } else if ((mm = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
      st.year = Number(mm[1]);
      st.month = Number(mm[2]) - 1;
      st.day = Number(mm[3]);
      if (st.month < 0 || st.month > 11) return fail(`There's no month ${mm[2]}`);
    } else if (
      /^\d{4}$/.test(t) &&
      st.month != null &&
      st.year == null &&
      Number(t) >= 2000 &&
      Number(t) <= 2100
    )
      st.year = Number(t);
    else if (
      (mm = t.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)?$/)) ||
      (mm = t.match(/^(\d{3,4})(am|pm|a|p)?$/))
    ) {
      if (st.min != null) return fail("Two times there — keep one");
      let r: { readonly min: number } | WhenParseError;
      if (mm[0].length >= 3 && /^\d{3,4}/.test(mm[0]) && !/[:.]/.test(mm[0])) {
        const v = Number.parseInt(mm[1] ?? "", 10);
        r = toMinutes(Math.floor(v / 100), v % 100, mm[2]);
      } else r = toMinutes(Number(mm[1]), mm[2] != null ? Number(mm[2]) : 0, mm[3]);
      if (!("min" in r)) return r;
      st.min = r.min;
      st.ampm = /[ap]m?$/.test(t);
    } else if (t.includes("/")) return fail("Write dates as “12.10.” or “oct 12”");
    else return fail(`Didn't catch “${t}”`);
    if (err) return err;
  }

  /* "evening 7" means 19:00. */
  if (
    st.min != null &&
    st.part &&
    PM_PARTS.has(st.part) &&
    !st.ampm &&
    st.min >= 60 &&
    st.min < 720
  )
    st.min += 720;
  let minutes = st.min ?? (st.part ? (lookup(PARTS, st.part) ?? null) : null);
  const hasTime = minutes != null;
  if (minutes == null) minutes = options.defaultTime ?? 540;
  const midnight = st.part === "midnight" && st.min == null;
  let ms: number;
  let hasDate = true;
  if (st.month != null) {
    const monthIndex = st.month;
    const day = st.day;
    const shortName = MONTH_NAMES_SHORT[monthIndex] ?? "";
    const longName = MONTH_NAMES_LONG[monthIndex] ?? "";
    if (day == null) return fail(`Which day in ${longName}? Try “${shortName.toLowerCase()} 12”`);
    if (st.date != null) return fail("Two days there — keep one");
    const minutesOfDay = minutes;
    const build = (year: number) => {
      if (day < 1 || day > daysInMonth(year, monthIndex)) return null;
      return withMinutes(new Date(year, monthIndex, day).getTime(), minutesOfDay);
    };
    const year = st.year ?? new Date(now).getFullYear();
    const built = build(year);
    if (built == null) return fail(`${longName} ${year} has ${daysInMonth(year, monthIndex)} days`);
    ms = built;
    if (st.year == null && ms < now - 60 * DAY_MS) ms = build(year + 1) ?? ms;
    const wd = new Date(ms).getDay();
    if (st.wd != null && wd !== st.wd)
      return fail(`${shortName} ${day} is a ${WEEKDAY_NAMES_LONG[wd] ?? ""}`);
  } else if (st.wd != null) {
    if (st.date != null) {
      const wd = new Date(st.date).getDay();
      if (wd !== st.wd) return fail(`${st.dateWord ?? ""} is a ${WEEKDAY_NAMES_LONG[wd] ?? ""}`);
      ms = withMinutes(st.date, minutes);
    } else {
      let delta = (st.wd - new Date(now).getDay() + 7) % 7;
      if (st.wdNext && delta === 0) delta = 7;
      ms = withMinutes(addDays(today, delta), minutes);
      if (!st.wdNext && delta === 0 && ms <= now) ms = withMinutes(addDays(today, 7), minutes);
    }
  } else if (st.date != null) ms = withMinutes(st.date, minutes);
  else if (hasTime) {
    hasDate = false;
    ms = withMinutes(today, minutes);
    if (ms <= now) ms = withMinutes(addDays(today, 1), minutes);
  } else return fail("Didn't catch that — try “tomorrow 9” or “in 2h”");
  if (midnight && hasDate) ms = addDays(ms, 1);
  return done(ms, hasDate, hasTime);
}

export interface WhenExplanation {
  readonly kind: "past" | "early" | "late" | "invalid";
  /** The full sentence: "That was 2h ago — pick a later time". */
  readonly text: string;
  /** The short form shown next to a fix: "That was 2h ago". */
  readonly short: string;
  /** The nearest usable time (≥ 5 min ahead, on a quarter hour), or null. */
  readonly fix: number | null;
  /** "today 10:45" · "tomorrow 09:00" · "Jan 5, 10:30" */
  readonly fixLabel: string | null;
}

/**
 * Why a time can't be used, in plain words (null when it can), plus a
 * one-click fix. The backend wants a start strictly in the future, so `min`
 * is exclusive whenever it is "now", and anything at or before the live clock
 * is refused even when the host's `min` is a few seconds stale.
 */
export function explainWhen(
  ms: number,
  options: {
    readonly nowMs: number;
    readonly min?: number | null;
    readonly max?: number | null;
    readonly minReason?: string;
    readonly maxReason?: string;
  },
): WhenExplanation | null {
  const now = options.nowMs;
  if (!Number.isFinite(ms))
    return {
      kind: "invalid",
      text: "Pick a time",
      short: "Pick a time",
      fix: null,
      fixLabel: null,
    };
  const lo = options.min ?? null;
  const hi = options.max ?? null;
  if (lo != null && (ms < lo || ms <= now)) {
    let fix: number | null = ceilQuarter(Math.max(lo, now + 5 * MINUTE_MS));
    if (hi != null && fix > hi) fix = null;
    const fixLabel = fix == null ? null : nearWords(fix, now);
    if (ms <= now + 30_000) {
      if (Math.abs(ms - now) < 60_000)
        return {
          kind: "past",
          text: "That's now — pick a later time",
          short: "That's now",
          fix,
          fixLabel,
        };
      return {
        kind: "past",
        text: `That was ${rel(ms, now)} — pick a later time`,
        short: `That was ${rel(ms, now)}`,
        fix,
        fixLabel,
      };
    }
    return {
      kind: "early",
      text: options.minReason ?? `Too early — the earliest is ${formatDateTime(lo, now)}`,
      short: options.minReason ?? "Too early",
      fix,
      fixLabel,
    };
  }
  if (hi != null && ms > hi) {
    let fix: number | null = floorQuarter(hi);
    if ((lo != null && fix < lo) || fix <= now) fix = null;
    const horizon = Math.abs(hi - now - AUTOMATION_LIMITS.horizonMs) < DAY_MS;
    return {
      kind: "late",
      text:
        options.maxReason ??
        (horizon
          ? `Past the 90-day limit — the latest is ${formatDate(hi, now)}`
          : `Too late — the latest is ${formatDateTime(hi, now)}`),
      short: options.maxReason ?? (horizon ? "Past the 90-day limit" : "Too late"),
      fix,
      fixLabel: fix == null ? null : nearWords(fix, now),
    };
  }
  return null;
}

export interface WhenSuggestion {
  /** What the option reads as typed: "tomorrow 9am". */
  readonly phrase: string;
  readonly ms: number;
  readonly label: string;
  readonly rel: string;
  /** "Earliest" / "Latest" when this is the nearest usable time to an out-of-range reading. */
  readonly nearest?: "Earliest" | "Latest";
}

export const WHEN_DEFAULT_SUGGESTIONS = [
  "in 1 hour",
  "tonight",
  "tomorrow 9am",
  "monday 9am",
  "in 1 week",
] as const;

/** 3–5 valid completions for what is typed (the defaults when nothing is). */
export function suggestWhen(
  text: string,
  nowMs: number,
  options: {
    readonly min?: number | null;
    readonly max?: number | null;
    readonly defaultTime?: number;
  } = {},
): WhenSuggestion[] {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const s = normalizeWhenText(text);
  const out: WhenSuggestion[] = [];
  const seen = new Set<number>();
  const parseOptions = options.defaultTime != null ? { defaultTime: options.defaultTime } : {};
  const range = { nowMs: now, min: options.min ?? null, max: options.max ?? null };
  const add = (candidate: string) => {
    if (out.length >= 5) return;
    const r = parseWhen(candidate, now, parseOptions);
    if (!r.ok || seen.has(r.ms)) return;
    if (explainWhen(r.ms, range)) return;
    seen.add(r.ms);
    out.push({ phrase: candidate, ms: r.ms, label: r.label, rel: r.rel });
  };
  if (!s) {
    WHEN_DEFAULT_SUGGESTIONS.forEach(add);
    return out;
  }
  const exact = parseWhen(s, now, parseOptions);
  if (exact.ok) {
    seen.add(exact.ms);
    /* Out of the window: the nearest valid time leads the list. */
    const r = explainWhen(exact.ms, range);
    if (r?.fix != null && !seen.has(r.fix)) {
      seen.add(r.fix);
      const fixDate = new Date(r.fix);
      out.push({
        phrase: `${(MONTH_NAMES_SHORT[fixDate.getMonth()] ?? "").toLowerCase()} ${fixDate.getDate()} ${formatTime(r.fix)}`,
        ms: r.fix,
        label: formatDateTime(r.fix, now),
        rel: rel(r.fix, now),
        nearest: r.kind === "late" ? "Latest" : "Earliest",
      });
    }
  }
  const words = s.split(" ");
  const candidates: string[] = [];
  const offset = s.match(/^(?:in|now ?\+|\+) ?(\d+)? ?([a-z]*)$/);
  if (offset) {
    if (!offset[1])
      candidates.push("in 15 min", "in 30 min", "in 1 hour", "in 2 hours", "in 1 day");
    else {
      const n = offset[1];
      const units = [`${n} min`, `${n} hours`, `${n} days`, `${n} weeks`];
      const u = offset[2];
      for (const x of units)
        if (!u || (x.split(" ")[1] ?? "").startsWith(u)) candidates.push(`in ${x}`);
      for (const x of units) candidates.push(`in ${x}`);
    }
  } else if (/^\d{1,2}$/.test(s)) {
    const d = new Date(now);
    candidates.push(`today ${s}:00`, `tomorrow ${s}:00`);
    candidates.push(`${(MONTH_NAMES_SHORT[d.getMonth()] ?? "").toLowerCase()} ${s}`);
    candidates.push(`${(MONTH_NAMES_SHORT[(d.getMonth() + 1) % 12] ?? "").toLowerCase()} ${s}`);
  }
  const pool = [
    "tonight",
    "tomorrow 9am",
    "tomorrow 14:00",
    "tomorrow 18:00",
    "today 18:00",
    "tomorrow evening",
    "next week",
    "in 1 hour",
    "in 2 hours",
    "noon",
  ];
  for (const w of WEEKDAY_NAMES_LONG.map((x) => x.toLowerCase()))
    pool.push(`${w} 9am`, `${w} 14:00`, `${w} 17:30`, `next ${w} 9am`);
  const prefixOf = (poolWords: readonly string[]) =>
    words.every((w, i) => {
      const pw = poolWords[i];
      return pw != null && pw !== "" && pw.startsWith(w);
    });
  for (const p of pool) if (prefixOf(p.split(" "))) candidates.push(p);
  if (exact.ok && exact.hasDate && !exact.hasTime)
    candidates.push(`${s} 9am`, `${s} 14:00`, `${s} 18:00`);
  if (exact.ok && exact.hasTime && !exact.hasDate) {
    const wd = (WEEKDAY_NAMES_LONG[(new Date(now).getDay() + 2) % 7] ?? "").toLowerCase();
    candidates.push(`today ${s}`, `tomorrow ${s}`, `${wd} ${s}`);
  }
  /* A complete reading: the same time on nearby days, and a week later. */
  if (exact.ok && exact.hasDate && exact.hasTime && !/^(in|now|\+)/.test(s)) {
    const hm = fmtMinutes(minutesOf(exact.ms));
    const d = new Date(exact.ms);
    const wd = (WEEKDAY_NAMES_LONG[d.getDay()] ?? "").toLowerCase();
    const next = (WEEKDAY_NAMES_LONG[(d.getDay() + 1) % 7] ?? "").toLowerCase();
    const week = new Date(addDays(exact.ms, 7));
    candidates.push(
      `${next} ${hm}`,
      `tomorrow ${hm}`,
      `${(MONTH_NAMES_SHORT[week.getMonth()] ?? "").toLowerCase()} ${week.getDate()} ${hm}`,
      `${wd} 9am`,
    );
  }
  candidates.forEach(add);
  if (out.length < 3) WHEN_DEFAULT_SUGGESTIONS.forEach(add);
  return out;
}

/** The calendar's quick picks: in an hour (next 5 min), tonight 21:00, tomorrow 09:00, Monday 09:00. */
export function whenQuickPicks(
  nowMs: number,
): ReadonlyArray<{ readonly label: string; readonly ms: number }> {
  const inHour = new Date(nowMs + HOUR_MS);
  const extra = inHour.getSeconds() || inHour.getMilliseconds() ? 1 : 0;
  inHour.setMinutes(Math.ceil((inHour.getMinutes() + extra) / 5) * 5, 0, 0);
  const today = dayStart(nowMs);
  const dow = new Date(nowMs).getDay();
  const toMonday = (1 - dow + 7) % 7 || 7;
  return [
    { label: "In 1 hour", ms: inHour.getTime() },
    { label: "Tonight 21:00", ms: withMinutes(today, 1260) },
    { label: "Tomorrow 09:00", ms: withMinutes(addDays(today, 1), 540) },
    { label: "Monday 09:00", ms: withMinutes(addDays(today, toMonday), 540) },
  ];
}
