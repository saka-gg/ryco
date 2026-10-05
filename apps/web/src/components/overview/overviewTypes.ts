import type { EnvironmentId, SourceControlChangeRequestMergeability } from "@ryco/contracts";
import type { ReactNode } from "react";

import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import type { OverviewWorkflowCheckRow } from "../overviewPullRequestChecks.logic";
import type { OverviewErrorInfo } from "./overviewErrors.logic";
import type { PrCheckStatusView } from "../projectExplorer/prCheckStatus";

export interface OverviewPanelItem {
  label: string;
  value: string;
  detail?: string;
  additions?: number;
  deletions?: number;
  breakdown?: ReadonlyArray<{
    label: string;
    value: string;
    detail?: string;
    additions?: number;
    deletions?: number;
    muted?: boolean;
  }>;
  action?: "files" | "review";
  icon?: "changes";
}

export type OverviewPullRequestCheckRun = OverviewWorkflowCheckRow;

export interface OverviewPullRequestState {
  /**
   * Pull request number. Absent when the state carries only branch-level CI
   * checks (e.g. the default branch has no pull request); PR-specific UI keys
   * off this being present.
   */
  number?: number;
  /** Pull request title. Absent for branch-only checks (see {@link number}). */
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  commentsCount?: number;
  /** Count of reviewers who have approved (from change-request participants). */
  reviewsApproved?: number;
  /** Count of reviewers from whom a review has been requested. */
  reviewsRequested?: number;
  checkStatus: PrCheckStatusView | null;
  checksLoading: boolean;
  /** Classified source-control fetch error (transient vs terminal), if any. */
  checksError?: OverviewErrorInfo;
  mergeability?: SourceControlChangeRequestMergeability;
  hasMergeConflicts: boolean;
  activeCheckCount: number;
  runs: ReadonlyArray<OverviewPullRequestCheckRun>;
  latestRuns: ReadonlyArray<OverviewPullRequestCheckRun>;
}

/**
 * Per-file git change type, mirroring the porcelain status letters.
 * M = modified, A = added, D = deleted, R = renamed, C = copied, T = type change.
 */
export type OverviewFileStatus = "M" | "A" | "D" | "R" | "C" | "T";

/** Where a changed file currently lives relative to the branch. */
export type OverviewFileCategory = "local" | "committed";

export interface OverviewChangedFile {
  path: string;
  insertions: number;
  deletions: number;
  /**
   * "local" = has uncommitted working-tree changes; "committed" = already
   * committed on the branch. Undefined when the source can't distinguish (the
   * list is then rendered flat).
   */
  category?: OverviewFileCategory | undefined;
  /**
   * Single-letter change type shown as the colored M/A/D tag. Optional because
   * the current `VcsStatusResult.workingTree.files` contract does not yet carry
   * it (see TODO in ChatOverviewPanel).
   */
  status?: OverviewFileStatus | undefined;
  /** Whether the file is staged for commit. Undefined when unknown. */
  staged?: boolean | undefined;
  /** Whether the file has unresolved merge conflicts. Undefined when unknown. */
  hasConflict?: boolean | undefined;
}

export interface OverviewChanges {
  files: ReadonlyArray<OverviewChangedFile>;
  insertions: number;
  deletions: number;
  refName: string | null;
  aheadCount: number;
  behindCount: number;
}

export type OverviewPanelMode = "floating" | "sheet" | "sidebar";

/** The data and callbacks rendered by the overview panel's Status Board. */
export interface OverviewLayoutProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  changes?: OverviewChanges | undefined;
  overviewItems?: ReadonlyArray<OverviewPanelItem> | undefined;
  pullRequest?: OverviewPullRequestState | null | undefined;
  onRefreshPullRequest?: (() => void) | undefined;
  /** Opens the pull request in the workspace panel; ⌘/Ctrl-click keeps the host link. */
  onOpenPullRequestInApp?: (() => void) | undefined;
  isRefreshingPullRequest?: boolean | undefined;
  subagents?: ReadonlyArray<ThreadSubagentView> | undefined;
  sourceControlActions?: ReactNode | undefined;
  branchControl?: ReactNode | undefined;
  environmentId: EnvironmentId;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  onOpenFiles?: (() => void) | undefined;
  onOpenReview?: (() => void) | undefined;
  onOpenSubagent?: ((subagent: ThreadSubagentView) => void) | undefined;
}
