import { canSettleThread, type ThreadSettlementInput } from "./threadSettlement.ts";

export interface ThreadSnoozeState {
  readonly snoozedUntil?: string | null | undefined;
  readonly snoozedAt?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly latestTurn?:
    | { readonly state?: string | undefined; readonly completedAt?: string | null | undefined }
    | null
    | undefined;
}

/** Running work can be deferred; requests waiting on the user and undelivered work cannot. */
export function canSnoozeThread(input: ThreadSettlementInput) {
  const eligibility = canSettleThread({
    ...input,
    sessionStatus:
      input.sessionStatus === "running" || input.sessionStatus === "starting"
        ? null
        : input.sessionStatus,
  });
  return { canSnooze: eligibility.canSettle, blocker: eligibility.blocker };
}

/**
 * Derived from timestamps, so suspended clients and restarted servers need no timer event.
 *
 * A session error is not read here. The node decides whether an error wakes the thread and
 * clears the snooze when it does; every node that can snooze does that for provider errors. A
 * thread the node keeps snoozed through an error it decided on itself (a restart release, a
 * context handoff rollback) shows snoozed, as it is on the node.
 */
export function isThreadSnoozed(thread: ThreadSnoozeState, nowMs: number): boolean {
  const until = Date.parse(thread.snoozedUntil ?? "");
  const since = Date.parse(thread.snoozedAt ?? "");
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(until) ||
    !Number.isFinite(since) ||
    until <= nowMs
  )
    return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (Date.parse(thread.latestUserMessageAt ?? "") > since) return false;
  if (Date.parse(thread.latestTurn?.completedAt ?? "") > since) return false;
  return true;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface SnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly snoozedUntil: string;
}

/** Calendar choices use the user's local timezone and preserve local morning across DST. */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      snoozedUntil: new Date(now.getTime() + HOUR_MS).toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      snoozedUntil: new Date(now.getTime() + 3 * HOUR_MS).toISOString(),
    },
  ];
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() > now.getTime())
    presets.push({ id: "evening", label: "This evening", snoozedUntil: evening.toISOString() });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  presets.push({ id: "tomorrow", label: "Tomorrow morning", snoozedUntil: tomorrow.toISOString() });
  const monday = new Date(now);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  presets.push({ id: "next-week", label: "Next week", snoozedUntil: monday.toISOString() });
  return presets.filter(
    (preset, index) =>
      presets.findIndex((other) => other.snoozedUntil === preset.snoozedUntil) === index,
  );
}

/** A custom snooze as typed: a local date and time, or a duration from confirmation. */
export type CustomSnoozeInput =
  | { readonly mode: "date"; readonly date: string; readonly time: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

const CUSTOM_SNOOZE_UNIT_MS = { minutes: MINUTE_MS, hours: HOUR_MS, days: DAY_MS } as const;

/**
 * The wake instant of a custom snooze, or null when the input is invalid or not
 * in the future. A date is the user's local calendar day and wall-clock time; a
 * day of duration is 24 hours, so it starts counting when the user confirms.
 */
export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (input.amount.trim() === "" || !Number.isFinite(amount) || amount <= 0) return null;
    wake = new Date(now.getTime() + amount * CUSTOM_SNOOZE_UNIT_MS[input.unit]);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // A rolled-over date (Feb 30) or a local time a DST change skips reads back differently.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** `YYYY-MM-DD` of the local calendar day, the value a date field takes. */
export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `HH:MM` of the local wall clock, the value a time field takes. */
export function localSnoozeTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * When a snoozed thread woke by its timer, or null. The node keeps the snooze
 * after its time passes and clears it on the next activity, so a recorded snooze
 * whose time has passed woke at that time. A thread that woke early has no
 * snooze left: the node cleared it, and the thread shows why it woke instead
 * (it needs input, failed, or finished a turn).
 */
export function threadSnoozeWokeAt(
  thread: Pick<ThreadSnoozeState, "snoozedUntil" | "snoozedAt">,
  nowMs: number,
): string | null {
  const until = Date.parse(thread.snoozedUntil ?? "");
  const since = Date.parse(thread.snoozedAt ?? "");
  if (!Number.isFinite(until) || !Number.isFinite(since) || !Number.isFinite(nowMs)) return null;
  return until <= nowMs ? thread.snoozedUntil! : null;
}

/** A thread that woke shows "Woke" until the user visits it after the wake. */
export function isThreadWokeUnseen(input: {
  readonly wokeAt: string | null;
  readonly lastVisitedAt: string | null | undefined;
}): boolean {
  if (input.wokeAt === null) return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (!Number.isFinite(wokeAtMs)) return false;
  const visitedAtMs = Date.parse(input.lastVisitedAt ?? "");
  return !Number.isFinite(visitedAtMs) || visitedAtMs < wokeAtMs;
}

/**
 * The countdown of a snoozed thread: "28 min left", "1 hr 28 min left",
 * "2 days 1 hr left", "Less than a minute left", then "Returning…" once due.
 */
export function formatSnoozeCountdown(snoozedUntil: string, nowMs: number): string {
  const remainingMs = Date.parse(snoozedUntil) - nowMs;
  if (!(remainingMs > 0)) return "Returning…";
  const totalMinutes = Math.floor(remainingMs / MINUTE_MS);
  if (totalMinutes < 1) return "Less than a minute left";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts =
    days > 0
      ? [`${days} ${days === 1 ? "day" : "days"}`, hours > 0 ? `${hours} hr` : null]
      : [hours > 0 ? `${hours} hr` : null, minutes > 0 ? `${minutes} min` : null];
  return `${parts.filter((part) => part !== null).join(" ")} left`;
}

/** How often a snooze countdown re-reads the clock. */
export const SNOOZE_COUNTDOWN_TICK_MS = 15_000;
