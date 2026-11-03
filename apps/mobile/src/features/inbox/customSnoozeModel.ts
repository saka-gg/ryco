import {
  type CustomSnoozeInput,
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
} from "@ryco/shared/threadSnooze";

// "Custom…" in an Inbox row's snooze menu: the request the sheet answers, and
// the sheet's draft. The phone picks a day and a time with steppers (the app
// ships no native date picker), or a duration, and resolves them with the rule
// web uses (`resolveCustomSnooze`).

export type CustomSnoozeUnit = Extract<CustomSnoozeInput, { mode: "duration" }>["unit"];

export interface CustomSnoozeDraft {
  readonly mode: CustomSnoozeInput["mode"];
  /** The local day, `YYYY-MM-DD`. */
  readonly date: string;
  /** The local time, `HH:MM`. */
  readonly time: string;
  readonly amount: string;
  readonly unit: CustomSnoozeUnit;
}

/** The time stepper's step; a step lands on this grid. */
export const CUSTOM_SNOOZE_TIME_STEP_MINUTES = 15;
const MINUTES_PER_DAY = 24 * 60;

/** An hour from now, or two hours of duration. */
export function initialCustomSnoozeDraft(now: Date): CustomSnoozeDraft {
  const at = new Date(now.getTime() + 3_600_000);
  return {
    mode: "date",
    date: localSnoozeDate(at),
    time: localSnoozeTime(at),
    amount: "2",
    unit: "hours",
  };
}

function parseLocalDay(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return null;
  // Noon, so a day step never lands on the wrong day across a DST change.
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

/** The draft's day moved by `days`, never before today. */
export function stepCustomSnoozeDay(
  draft: CustomSnoozeDraft,
  days: number,
  now: Date,
): CustomSnoozeDraft {
  const day = parseLocalDay(draft.date) ?? parseLocalDay(localSnoozeDate(now))!;
  day.setDate(day.getDate() + days);
  const today = localSnoozeDate(now);
  const date = localSnoozeDate(day) < today ? today : localSnoozeDate(day);
  return date === draft.date ? draft : { ...draft, date };
}

/** The draft's time moved to the next (or previous) 15-minute mark, around the clock. */
export function stepCustomSnoozeTime(
  draft: CustomSnoozeDraft,
  direction: 1 | -1,
): CustomSnoozeDraft {
  const match = /^(\d{2}):(\d{2})$/u.exec(draft.time);
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  const step = CUSTOM_SNOOZE_TIME_STEP_MINUTES;
  const next =
    direction === 1
      ? Math.floor(minutes / step) * step + step
      : Math.ceil(minutes / step) * step - step;
  const wrapped = ((next % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return {
    ...draft,
    time: `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`,
  };
}

/** Whether the day stepper can still go back. */
export function canStepCustomSnoozeDayBack(draft: CustomSnoozeDraft, now: Date): boolean {
  return draft.date > localSnoozeDate(now);
}

/** "Today", "Tomorrow", else the weekday and date. */
export function customSnoozeDayLabel(draft: CustomSnoozeDraft, now: Date): string {
  if (draft.date === localSnoozeDate(now)) return "Today";
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
  if (draft.date === localSnoozeDate(tomorrow)) return "Tomorrow";
  const day = parseLocalDay(draft.date);
  return day
    ? day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    : draft.date;
}

/** The wake instant, or the sentence that says what to fix. */
export function resolveCustomSnoozeDraft(
  draft: CustomSnoozeDraft,
  now: Date,
): { readonly snoozedUntil: string } | { readonly error: string } {
  const input: CustomSnoozeInput =
    draft.mode === "date"
      ? { mode: "date", date: draft.date, time: draft.time }
      : { mode: "duration", amount: draft.amount, unit: draft.unit };
  const snoozedUntil = resolveCustomSnooze(input, now);
  if (snoozedUntil) return { snoozedUntil };
  return {
    error:
      draft.mode === "date"
        ? "Choose a valid date and time in the future."
        : "Enter a positive duration.",
  };
}

// The open request. One at a time: a new request dismisses the previous one.
let pending: ((snoozedUntil: string | null) => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Opens the custom snooze sheet; resolves the chosen wake instant, or null when dismissed. */
export function requestCustomSnooze(): Promise<string | null> {
  pending?.(null);
  return new Promise((resolve) => {
    pending = resolve;
    emit();
  });
}

/** Answers the open request, from the sheet. */
export function finishCustomSnooze(snoozedUntil: string | null): void {
  const resolve = pending;
  pending = null;
  emit();
  resolve?.(snoozedUntil);
}

export function isCustomSnoozeRequested(): boolean {
  return pending !== null;
}

export function subscribeCustomSnooze(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
