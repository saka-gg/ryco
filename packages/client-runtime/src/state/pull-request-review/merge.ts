import type {
  ChangeRequestReviewEvent,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";
import {
  supportsChangeRequestReviewEvent,
  type ChangeRequestHostCapabilities,
} from "@ryco/shared/changeRequestHostCapabilities";

/**
 * The merge and review choices every client offers the same way: which merge
 * methods a pull request can use (and which one to preselect), whether to
 * delete the head branch afterwards, which review verdicts the viewer may
 * pick, and how a refusal because new commits arrived reads.
 */

// ── Merge methods ────────────────────────────────────────────────────

export const MERGE_METHODS: ReadonlyArray<SourceControlChangeRequestMergeMethod> = [
  "squash",
  "merge",
  "rebase",
];

export const MERGE_METHOD_LABEL: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/** Button wording: GitHub's own ("Merge pull request" for a merge commit). */
export const MERGE_METHOD_ACTION: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge pull request",
  rebase: "Rebase and merge",
};

export const MERGE_METHOD_CONFIRM: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "Confirm squash and merge",
  merge: "Confirm merge",
  rebase: "Confirm rebase and merge",
};

export const MERGE_METHOD_HINT: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "One commit on the base branch",
  merge: "Keeps every commit plus a merge commit",
  rebase: "Replays every commit onto the base",
};

export interface MergeMethodOption {
  readonly method: SourceControlChangeRequestMergeMethod;
  readonly label: string;
  /** Why this method cannot be picked, or null when it can. */
  readonly disabledReason: string | null;
}

/**
 * The merge methods to offer: the ones the host's provider can merge with
 * (`hostMethods`; others are not shown at all), each disabled with a reason
 * when this repository turns it off.
 */
export function mergeMethodOptions(
  detail: Pick<SourceControlChangeRequestDetail, "mergeCapabilities">,
  hostMethods?: ReadonlySet<SourceControlChangeRequestMergeMethod>,
): ReadonlyArray<MergeMethodOption> {
  return MERGE_METHODS.filter((method) => hostMethods?.has(method) ?? true).map((method) => ({
    method,
    label: MERGE_METHOD_LABEL[method],
    disabledReason:
      detail.mergeCapabilities && !detail.mergeCapabilities[method]
        ? "Not allowed in this repository"
        : null,
  }));
}

/**
 * The merge method choice to show, or null when there is none to offer: only
 * a pull request whose host reports the repository's merge settings gets one.
 * Without them every method would look allowed, and the reader could pick one
 * the repository refuses.
 */
export function offeredMergeMethods(
  detail: Pick<SourceControlChangeRequestDetail, "mergeCapabilities">,
  hostMethods?: ReadonlySet<SourceControlChangeRequestMergeMethod>,
): ReadonlyArray<MergeMethodOption> | null {
  return detail.mergeCapabilities ? mergeMethodOptions(detail, hostMethods) : null;
}

/** The preferred method when the host and repository allow it, else the first they allow. */
export function resolveMergeMethod(
  detail: Pick<SourceControlChangeRequestDetail, "mergeCapabilities">,
  preferred: SourceControlChangeRequestMergeMethod | null,
  hostMethods?: ReadonlySet<SourceControlChangeRequestMergeMethod>,
): SourceControlChangeRequestMergeMethod {
  const allowed = mergeMethodOptions(detail, hostMethods).filter(
    (option) => option.disabledReason === null,
  );
  if (preferred && allowed.some((option) => option.method === preferred)) return preferred;
  return allowed[0]?.method ?? preferred ?? "squash";
}

/**
 * The "Delete branch after merge" default: the repository's setting, where
 * the host can delete branches and the branch is this repository's own; null
 * when the choice does not apply.
 */
export function mergeDeleteBranchDefault(
  detail: Pick<SourceControlChangeRequestDetail, "isCrossRepository" | "deleteBranchOnMerge">,
  capabilities: Pick<ChangeRequestHostCapabilities, "merge">,
): boolean | null {
  return capabilities.merge.deleteBranch && detail.isCrossRepository !== true
    ? (detail.deleteBranchOnMerge ?? false)
    : null;
}

/** The host refused a merge or update because new commits arrived since the reader looked. */
export function isHeadMovedError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return /head (?:changed|moved)|changed since it was loaded|head branch was modified/iu.test(
    message,
  );
}

// ── Review verdicts ──────────────────────────────────────────────────

export const REVIEW_EVENT_LABEL: Record<ChangeRequestReviewEvent, string> = {
  comment: "Comment",
  approve: "Approve",
  request_changes: "Request changes",
};

const REVIEW_EVENTS: ReadonlyArray<ChangeRequestReviewEvent> = [
  "comment",
  "approve",
  "request_changes",
];

export interface ReviewEventOption {
  readonly event: ChangeRequestReviewEvent;
  readonly label: string;
  /** The author can only comment on their own pull request. */
  readonly disabled: boolean;
}

/**
 * The verdicts a review can carry here, and the one in effect: verdicts the
 * host does not take are not offered at all, the author can only comment, and
 * a choice no longer allowed falls back to the first offered verdict.
 */
export function resolveReviewEvents(input: {
  readonly capabilities: ChangeRequestHostCapabilities;
  readonly isAuthor: boolean;
  readonly chosen: ChangeRequestReviewEvent | null;
}): {
  readonly options: ReadonlyArray<ReviewEventOption>;
  readonly event: ChangeRequestReviewEvent;
} {
  const offered = REVIEW_EVENTS.filter((event) =>
    supportsChangeRequestReviewEvent(input.capabilities, event),
  );
  const fallback = offered[0] ?? "comment";
  const chosen = input.chosen ?? fallback;
  const event = !offered.includes(chosen)
    ? fallback
    : input.isAuthor && chosen !== "comment"
      ? "comment"
      : chosen;
  return {
    options: offered.map((option) => ({
      event: option,
      label: REVIEW_EVENT_LABEL[option],
      disabled: input.isAuthor && option !== "comment",
    })),
    event,
  };
}
