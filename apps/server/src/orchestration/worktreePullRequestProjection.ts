import type {
  PullRequestState,
  WorktreeCreatedPayload,
  WorktreePullRequestLink,
  WorktreeSourceControlStateUpdatedPayload,
} from "@ryco/contracts";
import {
  applySourceControlStateToPullRequestLinks,
  initialPullRequestLinks,
  readWorktreePullRequestLinks,
  type WorktreePullRequestSource,
} from "@ryco/shared/worktreePullRequests";

import { resolveEventPullRequestTerminalAt } from "./pullRequestTerminalAt.ts";

/**
 * How a `worktree.*` event changes a stored worktree's pull request fields.
 * Shared by the in-memory projector and the SQL projection pipeline so both
 * read models hold the same links and the same current pull request.
 */

export function projectCreatedWorktreePullRequests(
  payload: typeof WorktreeCreatedPayload.Type,
): ReadonlyArray<WorktreePullRequestLink> {
  return (
    payload.pullRequests ??
    initialPullRequestLinks({
      origin: payload.origin,
      prNumber: payload.prNumber,
      prTitle: payload.prTitle,
      createdAt: payload.createdAt,
    })
  );
}

export interface ProjectedWorktreeSourceControlState {
  readonly prNumber?: number | null;
  readonly prTitle?: string | null;
  readonly prState: PullRequestState | null;
  readonly prIsDraft: boolean | null;
  readonly prTerminalAt: string | null;
  readonly issueState: WorktreeSourceControlStateUpdatedPayload["issueState"];
  readonly pullRequests: ReadonlyArray<WorktreePullRequestLink>;
  readonly updatedAt: string;
}

export function projectWorktreeSourceControlState(
  existing: WorktreePullRequestSource,
  payload: WorktreeSourceControlStateUpdatedPayload,
): ProjectedWorktreeSourceControlState {
  return {
    // Current events always carry the current pull request; older ones only
    // when they relinked the workspace.
    ...(payload.prNumber !== undefined ? { prNumber: payload.prNumber } : {}),
    ...(payload.prTitle !== undefined ? { prTitle: payload.prTitle } : {}),
    prState: payload.prState,
    prIsDraft: payload.prIsDraft,
    prTerminalAt: resolveEventPullRequestTerminalAt(payload, existing),
    issueState: payload.issueState,
    pullRequests: applySourceControlStateToPullRequestLinks(
      readWorktreePullRequestLinks(existing),
      payload,
      existing.prNumber,
    ),
    updatedAt: payload.updatedAt,
  };
}
