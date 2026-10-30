import type {
  ChangeRequestReviewEvent,
  ChangeRequestUpdateInput,
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
  SourceControlMergeChangeRequestInput,
} from "@ryco/contracts";
import {
  isHeadMovedError,
  MERGE_METHOD_ACTION,
  MERGE_METHOD_CONFIRM,
  mergeDeleteBranchDefault,
  offeredMergeMethods,
  resolveMergeMethod,
  resolveReviewEvents,
  type ChangeRequestNextAction,
  type MergeMethodOption,
  type ReviewEventOption,
} from "@ryco/client-runtime/state/pull-request-review";
import {
  canMergeChangeRequests,
  preferredUpdateBranchMethod,
  type ChangeRequestHostCapabilities,
  type ChangeRequestUpdateBranchMethod,
} from "@ryco/shared/changeRequestHostCapabilities";
import { WS_METHODS } from "@ryco/contracts/rpc";

import { nodeRoleAllows, type NodeSessionRole } from "../../connection/nodeRoleAccess";

/**
 * What the phone lets a reader do with an open pull request: submit a review,
 * merge it, or bring its branch up to date. Each is offered only where the
 * host implements it, the viewer may do it and the shared next-action rules
 * say it is the step to take, and nothing is offered to a session whose role
 * on the node may not send it; every one waits for the node to be ready for
 * changes. React-free; the screen lays these out and sends the inputs built
 * here.
 */

export const PULL_REQUEST_NOT_READY =
  "Reconnect to this node to review or merge. Reading still works.";

export interface PullRequestReviewAction {
  readonly options: ReadonlyArray<ReviewEventOption>;
  /** Shown when the viewer opened the pull request and can only comment. */
  readonly authorNote: string | null;
}

export interface PullRequestMergeAction {
  /** The method choice; null where the host does not report the repository's settings. */
  readonly methods: ReadonlyArray<MergeMethodOption> | null;
  readonly method: SourceControlChangeRequestMergeMethod;
  readonly label: string;
  readonly confirmLabel: string;
  /** The "Delete branch after merge" default; null when the choice does not apply. */
  readonly deleteBranchDefault: boolean | null;
}

export interface PullRequestUpdateBranchAction {
  readonly method: ChangeRequestUpdateBranchMethod;
}

export interface PullRequestActions {
  /** Null when every offered action can be sent; else why none can right now. */
  readonly blockedReason: string | null;
  readonly review: PullRequestReviewAction | null;
  readonly merge: PullRequestMergeAction | null;
  readonly updateBranch: PullRequestUpdateBranchAction | null;
}

const NO_ACTIONS: PullRequestActions = {
  blockedReason: null,
  review: null,
  merge: null,
  updateBranch: null,
};

export function derivePullRequestActions(input: {
  readonly detail: SourceControlChangeRequestDetail | null;
  /** Null until activity loads (or on hosts without it). */
  readonly viewer: ChangeRequestViewerCapabilities | null;
  readonly nextAction: ChangeRequestNextAction | null;
  readonly capabilities: ChangeRequestHostCapabilities;
  /** The node takes changes now (connected, not read-only, not a cached view). */
  readonly mutationReady: boolean;
  /** The session's role on the node; undefined while unknown (the node then decides). */
  readonly role: NodeSessionRole | undefined;
  /** The merge method the reader picked; else the first the repository allows. */
  readonly chosenMethod: SourceControlChangeRequestMergeMethod | null;
}): PullRequestActions {
  const { detail, viewer, nextAction, capabilities, role } = input;
  if (detail === null || detail.state !== "open") return NO_ACTIONS;
  // A role the node refuses the change to (a viewer) is not offered it at all:
  // reconnecting would not help.
  const roleAllows = (method: string) => role === undefined || nodeRoleAllows(role, method);

  const reviews = resolveReviewEvents({
    capabilities,
    isAuthor: viewer?.isAuthor ?? false,
    chosen: null,
  });
  const review: PullRequestReviewAction | null =
    reviews.options.length > 0 &&
    viewer?.canReview !== false &&
    roleAllows(WS_METHODS.sourceControlSubmitChangeRequestReview)
      ? {
          options: reviews.options,
          authorNote:
            viewer?.isAuthor === true
              ? "You opened this pull request, so you can comment but not approve or request changes."
              : null,
        }
      : null;

  let merge: PullRequestMergeAction | null = null;
  if (
    canMergeChangeRequests(capabilities) &&
    nextAction?.kind === "merge" &&
    !nextAction.blocking &&
    nextAction.viewerCanAct &&
    roleAllows(WS_METHODS.sourceControlMergeChangeRequest)
  ) {
    const method = resolveMergeMethod(detail, input.chosenMethod, capabilities.merge.methods);
    merge = {
      methods: offeredMergeMethods(detail, capabilities.merge.methods),
      method,
      label: MERGE_METHOD_ACTION[method],
      confirmLabel: MERGE_METHOD_CONFIRM[method],
      deleteBranchDefault: mergeDeleteBranchDefault(detail, capabilities),
    };
  }

  const updateMethod = preferredUpdateBranchMethod(capabilities);
  const updateBranch: PullRequestUpdateBranchAction | null =
    nextAction?.kind === "update-branch" &&
    nextAction.viewerCanAct &&
    updateMethod !== null &&
    detail.headSha !== undefined &&
    viewer?.canUpdateBranch !== false &&
    roleAllows(WS_METHODS.sourceControlUpdateChangeRequest)
      ? { method: updateMethod }
      : null;

  const anything = review !== null || merge !== null || updateBranch !== null;
  return {
    blockedReason: anything && !input.mutationReady ? PULL_REQUEST_NOT_READY : null,
    review,
    merge,
    updateBranch,
  };
}

/**
 * The verdict a review sends for the one the reader picked in the draft, by
 * the shared rules: a verdict the host does not take falls back, and the
 * author only comments.
 */
export function pullRequestReviewEvent(input: {
  readonly capabilities: ChangeRequestHostCapabilities;
  readonly viewer: Pick<ChangeRequestViewerCapabilities, "isAuthor"> | null;
  readonly chosen: ChangeRequestReviewEvent | null;
}): ChangeRequestReviewEvent {
  return resolveReviewEvents({
    capabilities: input.capabilities,
    isAuthor: input.viewer?.isAuthor ?? false,
    chosen: input.chosen,
  }).event;
}

export type PullRequestActionSheet = "review" | "merge";

/**
 * The sheet on screen: the one the reader opened, while its action is still
 * offered. A refresh that finds the pull request merged or closed takes the
 * action away, and its sheet closes with it rather than going blank.
 */
export function shownPullRequestActionSheet(
  opened: PullRequestActionSheet | null,
  actions: Pick<PullRequestActions, "review" | "merge">,
): PullRequestActionSheet | null {
  if (opened === "review") return actions.review === null ? null : "review";
  if (opened === "merge") return actions.merge === null ? null : "merge";
  return null;
}

/** The merge request: guarded by the head the reader saw where the host can guard it. */
export function buildPullRequestMergeInput(input: {
  readonly cwd: string;
  readonly number: number;
  readonly method: SourceControlChangeRequestMergeMethod;
  /** Null when the choice does not apply (the host decides). */
  readonly deleteBranch: boolean | null;
  readonly headSha: string | null;
  readonly capabilities: Pick<ChangeRequestHostCapabilities, "merge">;
}): SourceControlMergeChangeRequestInput {
  return {
    cwd: input.cwd,
    reference: String(input.number),
    mergeMethod: input.method,
    ...(input.deleteBranch !== null && input.capabilities.merge.deleteBranch
      ? { deleteBranch: input.deleteBranch }
      : {}),
    ...(input.capabilities.merge.expectedHeadSha && input.headSha
      ? { expectedHeadSha: input.headSha }
      : {}),
  };
}

export function buildPullRequestUpdateBranchInput(input: {
  readonly cwd: string;
  readonly number: number;
  readonly method: ChangeRequestUpdateBranchMethod;
  readonly headSha: string;
}): ChangeRequestUpdateInput {
  return {
    cwd: input.cwd,
    reference: String(input.number),
    action: { kind: "update-branch", method: input.method, expectedHeadSha: input.headSha },
  };
}

/** One sentence for a refused change: new commits get their own, everything else its message. */
export function describePullRequestActionError(error: unknown): string {
  if (isHeadMovedError(error)) {
    return "New commits were pushed. Review the latest changes, then try again.";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The change did not go through. Try again.";
}
