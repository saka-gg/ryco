/**
 * The web schedule editor's own model (the lab's direction C editor): where a
 * draft starts from, the footer's line and where a token's popover lands. The
 * editor rules it shares with the phone (the sentence, fixes, the model
 * default) live in `@ryco/client-runtime/state/automations/editor`.
 */
import {
  draftFromDefinition,
  draftOfLatest,
  scheduleDraftKey,
  type ScheduleDraft,
} from "@ryco/client-runtime/state/agentControl";
import type { ProjectId, ServerProvider } from "@ryco/contracts";

import type { ScheduleEditorSource } from "../editorContract";

/** A token in the sentence or a pick on the agent line: each opens one popover or menu. */
export type EditorTokenKind =
  | "interval"
  | "start"
  | "end"
  | "device"
  | "env"
  | "ref"
  | "chat"
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
