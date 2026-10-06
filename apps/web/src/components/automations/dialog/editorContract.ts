/**
 * The seam between the Automations dialog (host) and its schedule editor.
 *
 * The host owns the dialog: which pane shows, selection, the undo bar, the
 * Escape order and closing. While an editor is open the host renders exactly
 * one `ScheduleEditorSlotProps`-shaped component in the detail column, inside
 * a pane (`.ad-pane.ad-pane-editor`: absolute, no padding, a flex column that
 * hides overflow — the editor brings its own scroll area and pinned footer,
 * like the lab's `.c-ed-scroll` + `.c-ed-foot`).
 *
 * The editor owns everything inside that pane: the title field, Repeats |
 * Once, the sentence tokens and their popovers, model and permissions, the
 * prompt, inline messages, the footer (hint, dirty-draft confirm, Discard,
 * "Save for approval", ⌘↵) and the save itself (`checkout.command`).
 *
 * Escape and close: the host routes them. Escape on a dirty draft first asks
 * (the host sets `confirm: "escape"`; the editor shows "Unsaved changes. Press
 * Esc again to discard them, or keep editing" in its footer); the second
 * Escape discards it into the undo bar. Closing the dialog (× or outside)
 * with a dirty draft asks once with `confirm: "close"`; closing again
 * discards it quietly with the dialog.
 */
import type { AgentControlAutomationId } from "@ryco/contracts";
import type {
  ScheduleDraft,
  ScheduleProposal,
  ScheduleRow,
} from "@ryco/client-runtime/state/agentControl";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import type { ProjectAutomationsCheckout } from "../data/useProjectAutomations";

/** What the editor reports about its draft, and what Restore hands back. */
export interface ScheduleEditorDraftState {
  /** The device (checkout) the draft saves to. */
  readonly checkoutKey: string;
  readonly draft: ScheduleDraft;
  /**
   * `scheduleDraftKey` of the draft as it opened; "" for a re-proposal (an
   * expired proposal is always worth saving again).
   */
  readonly initialKey: string;
  /** A new schedule ("Nothing runs until you approve it.") rather than a change. */
  readonly isNew: boolean;
  /** `scheduleDraftKey(draft) !== initialKey`. */
  readonly dirty: boolean;
}

/** Where the editor starts from. */
export type ScheduleEditorSource =
  /**
   * A blank schedule (`blankScheduleDraft`). `checkoutKey` is the device to
   * start on (one with room under the active limit), or null when no device
   * has room — the editor then says the limit in its footer.
   */
  | { readonly kind: "new"; readonly checkoutKey: string | null }
  /**
   * Edit a schedule. Like the lab: a pending edit (or a proposed new
   * schedule) is edited as proposed, else the schedule itself
   * (`draftOfLatest`, its past start rolled forward). The device is fixed.
   */
  | { readonly kind: "edit"; readonly checkoutKey: string; readonly row: ScheduleRow }
  /**
   * "Propose again" on an expired create or edit: start from that proposal
   * (`draftOfLatest(proposal)`); `initialKey` is "" so it is always dirty.
   */
  | {
      readonly kind: "repropose";
      readonly checkoutKey: string;
      readonly row: ScheduleRow;
      readonly proposal: ScheduleProposal;
    }
  /** Restore (or ⌘Z) after a discard: the draft exactly as it was left. */
  | { readonly kind: "restore"; readonly state: ScheduleEditorDraftState };

/** Why the editor closed itself. Escape and dialog close are the host's. */
export type ScheduleEditorCloseReason =
  /** Discard in the footer. (Escape never reaches the editor: the host handles it.) */
  | "discard"
  /** Saved with nothing changed: nothing was proposed (the editor says so). */
  | "unchanged";

/** A pending dirty-draft question, shown in the editor's footer. */
export type ScheduleEditorConfirm = "escape" | "close" | null;

export interface ScheduleEditorSavedResult {
  /** The device it was proposed on. */
  readonly checkoutKey: string;
  /** The schedule the proposal is for (new ones get their id at save). */
  readonly automationId: AgentControlAutomationId;
  /**
   * Where the editor's header (title) sat as it saved: the host folds a plate
   * from here into the row that now says what is waiting, then rings the row
   * once and focuses it. Null skips the flight.
   */
  readonly fromRect: DOMRectReadOnly | null;
}

export interface ScheduleEditorSlotProps {
  readonly source: ScheduleEditorSource;
  /** The logical project (name for the limit sentence, checkouts for the device token). */
  readonly project: SidebarProjectSnapshot;
  /**
   * The project's checkouts, this device first: device labels, providers
   * (model picker), snapshot (limit and validation), `command` (save).
   */
  readonly checkouts: readonly ProjectAutomationsCheckout[];
  /** The dialog's minute clock (ms). Re-renders once a minute. */
  readonly nowMs: number;
  /** What takes focus when the editor opens ("Edit model" opens on the model pick). */
  readonly focus: "title" | "model";
  /**
   * Opened from the selected row's own detail: the detail's heading and the
   * editor's title field sit in the same spot, so nothing travels.
   */
  readonly fromDetail: boolean;
  /**
   * The control a new draft's plate grows out of (New schedule, Propose
   * again, Restore), or null.
   */
  readonly origin: HTMLElement | null;
  /** A pending dirty-draft question; the editor shows it in its footer. */
  readonly confirm: ScheduleEditorConfirm;
  /** "keep editing" in the confirm (or any edit): drop the question. */
  readonly onKeepEditing: () => void;
  /**
   * Call on every draft change (and once on open), not only when `dirty`
   * flips: the host keeps the latest draft for Restore, tells a dirty draft
   * from a clean one when Escape or close arrive, and drops a pending
   * confirm when the draft changes.
   */
  readonly onDirtyChange: (dirty: boolean, state: ScheduleEditorDraftState) => void;
  /** The save went through (`command` resolved true). The host closes the editor. */
  readonly onSaved: (result: ScheduleEditorSavedResult) => void;
  /** The editor closed itself. A dirty "discard" goes to the undo bar. */
  readonly onClose: (reason: ScheduleEditorCloseReason) => void;
}
