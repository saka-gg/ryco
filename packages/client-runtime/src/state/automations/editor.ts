/**
 * The schedule editor's rules, shared by the web's Automations dialog and the
 * phone's schedule editor: a new schedule's model, what the sentence says, how
 * a fix or a new start moves the draft, which field a failed save is about and
 * the prompt counter. Schedule math and words come from the shared model;
 * nothing here re-derives them.
 */
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@ryco/contracts";
import {
  endWords,
  everyWords,
  formatDateTime,
  formatDay,
  when,
  type ScheduleErrors,
} from "@ryco/shared/automationSchedule";
import { calendarDaysWords, formatLocalTime, localDateTime } from "@ryco/shared/automationCalendar";
import {
  createModelSelection,
  getProviderOptionCurrentValue,
  REASONING_DESCRIPTOR_IDS,
} from "@ryco/shared/model";

import { isChatsAutomationScope } from "@ryco/shared/projectKind";
import {
  envWords,
  EXISTING_CHAT_WORDS,
  NEW_CHAT_WORDS,
  type ScheduleDraft,
} from "../agentControl/index.ts";

/**
 * The model a new schedule starts with on a device: the first provider that
 * is enabled, installed, ready and available, with its first model, at that
 * model's default effort (the lab's blank draft carries it, so the pick reads
 * "Sonnet 5.5 · Medium" like the dial). Null while the device's providers
 * aren't known (the draft then asks for one).
 */
export function defaultScheduleModel(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const provider = providers.find(
    (candidate) =>
      candidate.enabled &&
      candidate.installed &&
      candidate.status === "ready" &&
      candidate.availability !== "unavailable" &&
      candidate.models.length > 0,
  );
  const model = provider?.models[0];
  if (!provider || !model) return null;
  const effort = (model.capabilities?.optionDescriptors ?? []).find(
    (descriptor) => descriptor.type === "select" && REASONING_DESCRIPTOR_IDS.has(descriptor.id),
  );
  const value = effort ? getProviderOptionCurrentValue(effort) : undefined;
  return createModelSelection(
    provider.instanceId,
    model.slug,
    effort && typeof value === "string" ? [{ id: effort.id, value }] : null,
  );
}

/**
 * A selection that names nothing: validation says "Pick a model." The
 * shared draft has no "no model" (`ScheduleDraft.modelSelection` is a
 * `ModelSelection`), so this is the one place that spells it; a draft with
 * it never saves.
 */
export function emptyModelSelection(): ModelSelection {
  return { instanceId: "" as ProviderInstanceId, model: "" };
}

/** Whether a draft's model still has to be picked. */
export function modelMissing(selection: ModelSelection): boolean {
  return !selection.instanceId || !selection.model;
}

// ── The sentence ─────────────────────────────────────────────────────

export interface SentenceWords {
  /** "2 hours" — the word after "Every". */
  readonly interval: string;
  readonly intervalLabel: string;
  /** "from" (repeats) or "Once," (once). */
  readonly startWord: string;
  /** "tomorrow 09:00" · "Wed, Oct 7 · 12:40" */
  readonly start: string;
  readonly startLabel: string;
  /** "for" (a duration preset) or "until" (a date). */
  readonly endWord: "for" | "until";
  /** "1 week" · "Oct 20" */
  readonly end: string;
  readonly endLabel: string;
  /** "a new worktree" · "the main checkout" · "an existing chat" (a heartbeat) */
  readonly env: string;
  readonly envLabel: string;
  /** The heartbeat's chat: its title, else "pick a chat" while one is being picked. */
  readonly chat: string;
  readonly chatLabel: string;
  /** The branch a worktree run starts from; the server's own default is HEAD. */
  readonly ref: string;
  readonly refLabel: string;
}

/** Which calendar choice a draft's weekdays are, if any. */
export type CalendarChoice = "daily" | "weekdays" | "weekly";

export function calendarChoiceOf(draft: ScheduleDraft): CalendarChoice | null {
  if (draft.kind !== "calendar") return null;
  const days = draft.weekdays.join();
  if (days === "0,1,2,3,4,5,6") return "daily";
  if (days === "1,2,3,4,5") return "weekdays";
  return draft.weekdays.length === 1 ? "weekly" : null;
}

/** The weekdays a calendar choice runs on; "weekly" runs on the first run's weekday. */
export function calendarChoiceWeekdays(choice: CalendarChoice, draft: ScheduleDraft): number[] {
  if (choice === "daily") return [0, 1, 2, 3, 4, 5, 6];
  if (choice === "weekdays") return [1, 2, 3, 4, 5];
  return [weekdayIn(draft.start, draft.timeZone)];
}

/** The weekday (0 = Sunday) of an instant in a zone. */
function weekdayIn(ms: number, timeZone: string): number {
  const local = localDateTime(ms, timeZone);
  return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
}

/** "weekday at 09:00" · "Friday at 09:00" — a calendar schedule's words after "Every". */
function calendarIntervalWords(draft: ScheduleDraft): string {
  const days = calendarDaysWords(draft.weekdays).replace(/^every /, "");
  const minutes = Number.isFinite(draft.start)
    ? localDateTime(draft.start, draft.timeZone).minutes
    : 0;
  return `${days} at ${formatLocalTime(minutes)}`;
}

/**
 * The sentence's words: "Every [day] from [tomorrow 09:00] for [30 days] on … in … off …",
 * or for a heartbeat "… in [an existing chat] called [Fix CI flakes]". `chat.words` is what
 * the draft's chat reads as (`heartbeatChatWords`); `chat.choosingChat` says a chat is being
 * picked for a draft that has none yet.
 */
export function sentenceWords(
  draft: ScheduleDraft,
  nowMs: number,
  chat: { readonly words: string | null; readonly choosingChat: boolean } = {
    words: null,
    choosingChat: false,
  },
): SentenceWords {
  const interval =
    draft.kind === "calendar" ? calendarIntervalWords(draft) : everyWords(draft.intervalMs);
  const start = when(draft.start, nowMs);
  // Relative words ("tomorrow 09:00") also say the day for a screen reader.
  const absolute = start === formatDateTime(draft.start) ? "" : `, ${formatDay(draft.start)}`;
  const ends = endWords(draft.start, draft.endsAt, nowMs);
  // A heartbeat runs in its chat: the checkout of a new chat does not apply.
  const env =
    draft.target !== null || chat.choosingChat
      ? EXISTING_CHAT_WORDS
      : isChatsAutomationScope(draft.projectId)
        ? NEW_CHAT_WORDS
        : envWords(draft.envMode);
  const chatWords = draft.target === null ? null : chat.words;
  return {
    interval,
    intervalLabel:
      draft.kind === "calendar"
        ? `Repeats: every ${interval}`
        : `Repeat interval: every ${interval}`,
    startWord: draft.kind === "once" ? "Once," : "from",
    start,
    startLabel: `${draft.kind === "once" ? "Runs at" : "First run"}: ${start}${absolute}`,
    endWord: ends.conn,
    end: ends.text,
    endLabel: `Ends: ${ends.conn} ${ends.text}`,
    env,
    envLabel: `Runs in: ${env}`,
    chat: chatWords ?? "pick a chat",
    chatLabel: chatWords === null ? "Chat: none picked yet" : `Chat: ${chatWords}`,
    ref: draft.baseRef.trim() || "HEAD",
    refLabel: `Branch: ${draft.baseRef.trim() || "HEAD"}`,
  };
}

// ── Changes ──────────────────────────────────────────────────────────

/**
 * A new first run. An end said as a duration ("for 1 week") keeps its
 * length; an end said as a date stays on that date.
 */
export function withStart(draft: ScheduleDraft, startMs: number): ScheduleDraft {
  const ends = endWords(draft.start, draft.endsAt);
  const moved: ScheduleDraft = {
    ...draft,
    start: startMs,
    endsAt: ends.dur ? startMs + (draft.endsAt - draft.start) : draft.endsAt,
  };
  // A weekly calendar schedule runs on its first run's weekday (and time).
  return calendarChoiceOf(draft) === "weekly"
    ? { ...moved, weekdays: calendarChoiceWeekdays("weekly", moved) }
    : moved;
}

/** A message's one-click fix applied to the field it names. */
export function applyDraftFix(
  draft: ScheduleDraft,
  key: "start" | "interval" | "end" | "title",
  value: number,
): ScheduleDraft {
  if (key === "start") return withStart(draft, value);
  if (key === "end") return { ...draft, endsAt: value };
  if (key === "interval") return { ...draft, kind: "fixed-interval", intervalMs: value };
  return draft;
}

/** Where a failed save sends focus: the first field that is wrong, in reading order. */
export type EditorFocusField = "title" | "start" | "interval" | "end" | "prompt" | "model";

export function firstInvalidField(errors: ScheduleErrors): EditorFocusField | null {
  const order: readonly EditorFocusField[] = [
    "title",
    "start",
    "interval",
    "end",
    "prompt",
    "model",
  ];
  return order.find((key) => errors[key]) ?? null;
}

/** Said when a save is refused and the server gave no reason. */
export const SAVE_REFUSED = "That change couldn't be proposed.";

/**
 * The token a refused save is about, read from the server's reason: the
 * branch ("Requested worktree base ref is unavailable.") or the model
 * ("Provider instance '…' is unavailable.", "Model option '…' is
 * unavailable."). Null when it is about the schedule as a whole ("Schedule
 * changed. Refresh before saving.", the limit, a lost connection).
 */
export function saveFailureField(reason: string | null | undefined): "ref" | "model" | null {
  if (!reason) return null;
  if (/\bbase ref\b/i.test(reason)) return "ref";
  if (/\b(provider instance|model option|model)\b/i.test(reason)) return "model";
  return null;
}

/** The prompt's character count, said once there is one ("257 / 12,000"). */
export function promptCount(length: number, max: number): string {
  return length > 0 ? `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}` : "";
}
