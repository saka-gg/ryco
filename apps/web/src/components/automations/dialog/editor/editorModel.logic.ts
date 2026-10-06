/**
 * The schedule editor's pure model (the lab's direction C editor): where a
 * draft starts from, what the sentence says, how a fix or a new start moves
 * the draft, which field a failed save focuses, and where a token's popover
 * lands. Schedule math and words come from the shared model; nothing here
 * re-derives them.
 */
import {
  draftFromDefinition,
  draftOfLatest,
  envWords,
  scheduleDraftKey,
  type ScheduleDraft,
} from "@ryco/client-runtime/state/agentControl";
import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
} from "@ryco/contracts";
import {
  endWords,
  everyWords,
  formatDateTime,
  formatDay,
  when,
  type ScheduleErrors,
} from "@ryco/shared/automationSchedule";
import { createModelSelection, getProviderOptionCurrentValue } from "@ryco/shared/model";

import { REASONING_DESCRIPTOR_IDS } from "../../../chat/modelTuning.logic";
import type { ScheduleEditorSource } from "../editorContract";

/** A token in the sentence or a pick on the agent line: each opens one popover or menu. */
export type EditorTokenKind =
  | "interval"
  | "start"
  | "end"
  | "device"
  | "env"
  | "ref"
  | "model"
  | "mode";

/** What the editor opens with. */
export interface EditorOpening {
  /** The device (checkout) the draft saves to. */
  readonly checkoutKey: string;
  readonly draft: ScheduleDraft;
  /** `scheduleDraftKey` as it opened; "" for a re-proposal (always worth saving). */
  readonly initialKey: string;
  /** A new schedule ("Nothing runs until you approve it.") rather than a change. */
  readonly isNew: boolean;
}

/** What the opening needs of a checkout (`ProjectAutomationsCheckout` fits). */
export interface EditorCheckoutInput {
  readonly key: string;
  readonly projectId: ScheduleDraft["projectId"];
  readonly providers: ReadonlyArray<ServerProvider>;
}

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

/**
 * Where the editor starts. Like the lab: a pending edit (or a proposed new
 * schedule) is edited as proposed, else the schedule itself — its past start
 * rolled forward, since the backend refuses one.
 */
export function editorOpening(input: {
  readonly source: ScheduleEditorSource;
  readonly checkouts: readonly EditorCheckoutInput[];
  readonly nowMs: number;
  /** The branch a new worktree run starts off (the main checkout's branch). */
  readonly defaultBaseRef: string;
  /**
   * The project a new draft names while the project has no checkout to save
   * to (the logical project's own id); Save stays refused without one.
   */
  readonly fallbackProjectId: ProjectId;
  /** Builds a blank draft for a device (`blankScheduleDraft`, injected for its model default). */
  readonly blank: (checkout: EditorCheckoutInput) => ScheduleDraft;
}): EditorOpening {
  const { source, checkouts, nowMs, defaultBaseRef } = input;
  if (source.kind === "restore") {
    return {
      checkoutKey: source.state.checkoutKey,
      draft: source.state.draft,
      initialKey: source.state.initialKey,
      isNew: source.state.isNew,
    };
  }
  if (source.kind === "new") {
    const checkout =
      checkouts.find((candidate) => candidate.key === source.checkoutKey) ?? checkouts[0];
    const key = checkout?.key ?? source.checkoutKey ?? "";
    const draft = input.blank(
      checkout ?? { key, projectId: input.fallbackProjectId, providers: [] },
    );
    return { checkoutKey: key, draft, initialKey: scheduleDraftKey(draft), isNew: true };
  }
  const row = source.row;
  const options = { defaultBaseRef };
  if (source.kind === "repropose") {
    return {
      checkoutKey: source.checkoutKey,
      draft: draftOfLatest(source.proposal, nowMs, options),
      initialKey: "",
      isNew: !row.automation,
    };
  }
  const proposed = row.proposal?.kind === "edit" || !row.automation;
  const from = proposed ? (row.proposal ?? row.lapsed) : row.automation;
  const draft = from
    ? draftOfLatest(from, nowMs, options)
    : draftFromDefinition(row.def, { id: row.id, defaultBaseRef });
  return {
    checkoutKey: source.checkoutKey,
    draft,
    initialKey: scheduleDraftKey(draft),
    isNew: !row.automation,
  };
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
  /** "a new worktree" · "the main checkout" */
  readonly env: string;
  readonly envLabel: string;
  /** The branch a worktree run starts from; the server's own default is HEAD. */
  readonly ref: string;
  readonly refLabel: string;
}

/** The sentence's words: "Every [day] from [tomorrow 09:00] for [30 days] on … in … off …". */
export function sentenceWords(draft: ScheduleDraft, nowMs: number): SentenceWords {
  const interval = everyWords(draft.intervalMs);
  const start = when(draft.start, nowMs);
  // Relative words ("tomorrow 09:00") also say the day for a screen reader.
  const absolute = start === formatDateTime(draft.start) ? "" : `, ${formatDay(draft.start)}`;
  const ends = endWords(draft.start, draft.endsAt, nowMs);
  const env = envWords(draft.envMode);
  return {
    interval,
    intervalLabel: `Repeat interval: every ${interval}`,
    startWord: draft.kind === "once" ? "Once," : "from",
    start,
    startLabel: `${draft.kind === "once" ? "Runs at" : "First run"}: ${start}${absolute}`,
    endWord: ends.conn,
    end: ends.text,
    endLabel: `Ends: ${ends.conn} ${ends.text}`,
    env,
    envLabel: `Runs in: ${env}`,
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
  return {
    ...draft,
    start: startMs,
    endsAt: ends.dur ? startMs + (draft.endsAt - draft.start) : draft.endsAt,
  };
}

/** A message's one-click fix applied to the field it names. */
export function applyDraftFix(
  draft: ScheduleDraft,
  key: "start" | "interval" | "end" | "title",
  value: number,
): ScheduleDraft {
  if (key === "start") return withStart(draft, value);
  if (key === "end") return { ...draft, endsAt: value };
  if (key === "interval") return { ...draft, intervalMs: value };
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

/**
 * The footer's line: a pending dirty-draft question, else why the last save
 * was refused (the server's reason), else the limit, else what saving means.
 */
export type EditorHint =
  | { readonly kind: "confirm"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "limit"; readonly text: string }
  | { readonly kind: "plain"; readonly text: string };

export function editorHint(input: {
  readonly confirm: "escape" | "close" | null;
  /** The reason the last save was refused, until the draft changes. */
  readonly failure?: string | null | undefined;
  readonly limit: string | undefined;
  readonly isNew: boolean;
}): EditorHint {
  if (input.confirm)
    return {
      kind: "confirm",
      text: `Unsaved changes. ${input.confirm === "close" ? "Close again" : "Press Esc again"} to discard them, or`,
    };
  if (input.failure) return { kind: "failed", text: input.failure };
  if (input.limit) return { kind: "limit", text: input.limit };
  return {
    kind: "plain",
    text: `${input.isNew ? "Nothing runs" : "Nothing changes"} until you approve it.`,
  };
}

// ── Where a token's popover lands ────────────────────────────────────

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The lab's `desiredSpot`: under the whole sentence (so it stays readable
 * while you pick), at the token's x, inside the dialog; above the sentence
 * when the dialog has no room below, else as low as still fits.
 */
export function tokenPopupSpot(input: {
  readonly dialog: Box;
  /** The sentence (or the pick itself, outside the sentence). */
  readonly reference: Box;
  readonly token: Box;
  readonly popup: { readonly width: number; readonly height: number };
  readonly gap: number;
  readonly pad?: number;
}): { readonly left: number; readonly top: number } {
  const { dialog, reference, token, popup, gap } = input;
  const pad = input.pad ?? 12;
  const minLeft = dialog.left + pad;
  const left = Math.min(
    Math.max(token.left, minLeft),
    Math.max(minLeft, dialog.right - pad - popup.width),
  );
  let top = reference.bottom + gap;
  if (top + popup.height > dialog.bottom - pad) {
    const above = reference.top - gap - popup.height;
    top =
      above >= dialog.top + pad
        ? above
        : Math.max(dialog.top + pad, dialog.bottom - pad - popup.height);
  }
  return { left, top };
}
