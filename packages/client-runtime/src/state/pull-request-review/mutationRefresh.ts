import type { ChangeRequestUpdateAction, SourceControlChangeRequestDetail } from "@ryco/contracts";

/**
 * Which cached reads a change-request mutation can have made stale.
 *
 * - `checkout`: the head, base, or merge state moved, so every source-control
 *   read of the checkout is stale (diff, checks, lists, details). Callers run
 *   the broad workspace invalidation and ignore the other flags.
 * - `detail`: refetch the change request's detail. False when the mutation
 *   either returns the fresh detail (it is written instead) or patches it
 *   locally with the full answer.
 * - `activity`: refetch the timeline / review threads.
 * - `lists`: refetch list and search reads, because a field list rows show
 *   (state, draft, title, labels, assignees, reviewers, review decision) moved.
 *
 * Diffs, job logs, and file contents are never in scope short of `checkout`:
 * no comment, review, or metadata action can change them.
 */
export interface ChangeRequestRefreshScope {
  readonly checkout: boolean;
  readonly detail: boolean;
  readonly activity: boolean;
  readonly lists: boolean;
}

/** The detail fields that decide whether an update moved the head or merged. */
export type ChangeRequestRefreshDetail = Pick<
  SourceControlChangeRequestDetail,
  "state" | "headSha"
>;

export type ChangeRequestMutation =
  /** A new conversation comment; the host returns the fresh detail. */
  | { readonly kind: "comment" }
  /** A comment, review body, or review comment edited or deleted (patched locally). */
  | { readonly kind: "comment-update" }
  /** A reaction toggled; the host returns the fresh detail. */
  | { readonly kind: "reaction" }
  /** A whole review (verdict plus line comments). */
  | { readonly kind: "review" }
  /** A reply in a review thread (the returned thread is written). */
  | { readonly kind: "thread-reply" }
  /** A review thread resolved or unresolved. */
  | { readonly kind: "thread-resolve" }
  /** A lifecycle action; the host returns the fresh detail (`next`). */
  | {
      readonly kind: "update";
      readonly action: ChangeRequestUpdateAction;
      readonly previous?: ChangeRequestRefreshDetail | null;
      readonly next?: ChangeRequestRefreshDetail | null;
    };

const NONE: ChangeRequestRefreshScope = Object.freeze({
  checkout: false,
  detail: false,
  activity: false,
  lists: false,
});

function scope(fields: Partial<ChangeRequestRefreshScope>): ChangeRequestRefreshScope {
  return { ...NONE, ...fields };
}

const CHECKOUT = scope({ checkout: true });

/** True when the returned detail shows the head moved or the request merged. */
function movedHeadOrMerged(
  previous: ChangeRequestRefreshDetail | null | undefined,
  next: ChangeRequestRefreshDetail | null | undefined,
): boolean {
  if (!next) return false;
  if (next.state === "merged" && previous?.state !== "merged") return true;
  return Boolean(previous?.headSha && next.headSha && previous.headSha !== next.headSha);
}

function updateScope(action: ChangeRequestUpdateAction): ChangeRequestRefreshScope {
  switch (action.kind) {
    case "edit":
      // A new base changes the diff, the merge base, and possibly the checks.
      if (action.baseRefName !== undefined) return CHECKOUT;
      // A rename is a timeline event and a list column; a body-only edit (task
      // checkboxes included) touches nothing the returned detail does not carry.
      return action.title !== undefined ? scope({ activity: true, lists: true }) : NONE;
    case "update-branch":
      return CHECKOUT;
    case "set-draft":
    case "close":
    case "reopen":
    case "reviewers":
    case "labels":
    case "assignees":
      return scope({ activity: true, lists: true });
    case "auto-merge":
    case "delete-branch":
      return scope({ activity: true });
  }
}

/**
 * Resolves the reads a change-request mutation must refresh. Lifecycle actions
 * escalate to the whole checkout when the returned detail shows the head moved
 * or the request merged (an auto-merge that landed immediately, say).
 */
export function resolveChangeRequestRefreshScope(
  mutation: ChangeRequestMutation,
): ChangeRequestRefreshScope {
  switch (mutation.kind) {
    case "comment":
    case "comment-update":
    case "reaction":
    case "thread-reply":
      return scope({ activity: true });
    case "thread-resolve":
      // Required conversation resolution can change whether the request may merge.
      return scope({ activity: true, detail: true });
    case "review":
      // A verdict moves the review decision, reviewer states, list rows, and the timeline.
      return scope({ activity: true, detail: true, lists: true });
    case "update":
      return movedHeadOrMerged(mutation.previous, mutation.next)
        ? CHECKOUT
        : updateScope(mutation.action);
  }
}
