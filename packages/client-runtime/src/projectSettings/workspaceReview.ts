/**
 * What the "Delete workspace" review shows, from the server's preview alone:
 * which preview may be confirmed, what work would be lost, how many
 * conversations go with it, and how a run that did not complete is told.
 * Confirm applies exactly that preview (its fingerprint), so a workspace that
 * changed in between is refused, never guessed at. Shared by the web review
 * (project map, app dialog) and the phone's review sheet.
 */
import type {
  WorkspaceLifecyclePreview,
  WorkspaceLifecycleResult,
  ThreadId,
} from "@ryco/contracts";

import {
  WORKSPACE_LIFECYCLE_ACTION_LABELS,
  type WorkspaceReviewAction,
} from "../state/lifecycle/index.ts";
import { workspaceLifecycleIncompleteTitle } from "../state/lifecycle/outcome.ts";
import { workspaceLostWorkFacts, type WorkspaceFact } from "./workspaces.ts";

/** One answer to a preview request. */
export type WorkspaceReviewPreview =
  | { readonly status: "ready"; readonly preview: WorkspaceLifecyclePreview }
  | { readonly status: "error"; readonly message: string };

export const WORKSPACE_REVIEW_UNSUPPORTED = "This device does not support workspace actions.";
export const WORKSPACE_REVIEW_OUTDATED =
  "This device's Ryco cannot delete workspaces yet. Update it, then retry.";
export const WORKSPACE_REVIEW_PREVIEW_FAILED = "The workspace could not be inspected.";
export const WORKSPACE_REVIEW_APPLY_FAILED = "The action could not be applied.";

export interface WorkspaceReviewView {
  /** What the review says now: the current preview, an error, or null while it loads. */
  readonly view: WorkspaceReviewPreview | null;
  /** The preview Confirm applies: only the one for the current options. */
  readonly preview: WorkspaceLifecyclePreview | null;
  /** What is on screen: the current preview, else the last one while options re-inspect. */
  readonly shown: WorkspaceLifecyclePreview | null;
  /** The last preview stays on screen (dimmed) while a newer one loads. */
  readonly refreshing: boolean;
  /** The server refuses: nothing would change. */
  readonly blocked: boolean;
  /** Work only this checkout holds, as short facts. */
  readonly lostWork: readonly WorkspaceFact[];
  /** Something would be lost; Confirm says "Delete anyway". */
  readonly losesWork: boolean;
  /** Conversations of the workspace (active and archived) the reader may also delete. */
  readonly conversationCount: number;
}

/**
 * The review's state from what has loaded. `current` answers the options on
 * screen (null while it loads); `last` is the latest answer to any options.
 */
export function resolveWorkspaceReview(input: {
  /** Why this reader may not inspect workspaces on the device, or null when they may. */
  readonly previewDenied: string | null;
  /** The device offers the lifecycle API at all. */
  readonly lifecycleAvailable: boolean;
  readonly current: WorkspaceReviewPreview | null;
  readonly last: WorkspaceReviewPreview | null;
}): WorkspaceReviewView {
  const { current } = input;
  const view: WorkspaceReviewPreview | null =
    input.previewDenied !== null
      ? { status: "error", message: input.previewDenied }
      : !input.lifecycleAvailable
        ? { status: "error", message: WORKSPACE_REVIEW_UNSUPPORTED }
        : // A node that predates deleting answers with an ordinary removal.
          current?.status === "ready" && current.preview.effects.discard !== true
          ? { status: "error", message: WORKSPACE_REVIEW_OUTDATED }
          : current;
  const preview = view?.status === "ready" ? view.preview : null;
  const shown =
    preview ?? (view === null && input.last?.status === "ready" ? input.last.preview : null);
  const lostWork = shown ? workspaceLostWorkFacts(shown.workspace) : [];
  return {
    view,
    preview,
    shown,
    refreshing: preview === null && shown !== null,
    blocked: preview !== null && preview.blockers.length > 0,
    lostWork,
    losesWork: shown !== null && (shown.effects.discardsWork === true || lostWork.length > 0),
    conversationCount: shown
      ? shown.workspace.conversations.active + shown.workspace.conversations.archived
      : 0,
  };
}

/** What a run that did not complete says in the review, or null for a completed one. */
export interface WorkspaceReviewFailure {
  readonly title: string;
  readonly message: string;
  readonly detail: string | null;
  readonly tone: "warning" | "destructive";
}

export function workspaceReviewResultFailure(
  action: WorkspaceReviewAction,
  result: WorkspaceLifecycleResult,
): WorkspaceReviewFailure | null {
  if (result.outcome === "completed") return null;
  return {
    title: workspaceLifecycleIncompleteTitle(action, result.outcome),
    message: result.message,
    detail: result.steps.find((step) => step.status === "failed")?.detail ?? null,
    tone: result.outcome === "partial" ? "warning" : "destructive",
  };
}

/** An apply that threw before the node answered. */
export function workspaceReviewApplyError(
  action: WorkspaceReviewAction,
  message: string,
): WorkspaceReviewFailure {
  return {
    title: `${WORKSPACE_LIFECYCLE_ACTION_LABELS[action]} failed`,
    message,
    detail: null,
    tone: "destructive",
  };
}

/** The conversations an apply of this preview deletes (restorable for a few seconds). */
export function workspaceReviewDeletedConversationIds(
  preview: WorkspaceLifecyclePreview,
): readonly ThreadId[] {
  return preview.request.deleteConversations === true
    ? (preview.effects.trashConversationIds ?? [])
    : [];
}

/** What deleting does, in one line: "Removes the checkout from disk and deletes branch x." */
export function workspaceReviewEffectParts(preview: WorkspaceLifecyclePreview): {
  readonly action: string;
  /** The branch it deletes too, or null when the branch stays. */
  readonly deletesBranch: string | null;
} {
  return {
    action: preview.effects.removeCheckout
      ? "Removes the checkout from disk"
      : "Removes the workspace",
    deletesBranch: preview.effects.deleteBranch ? preview.effects.branch : null,
  };
}

/** The confirm button's label. */
export const workspaceReviewConfirmLabel = (losesWork: boolean): string =>
  losesWork ? "Delete anyway" : "Delete workspace";

/** The error text of a thrown request, or the fallback when it has none. */
export const workspaceReviewErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;
