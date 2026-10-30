import type {
  ChangeRequest,
  ChangeRequestActivity,
  EnvironmentId,
  SourceControlChangeRequestDetail,
  SourceControlProviderInfo,
} from "@ryco/contracts";
import type { ChangeRequestHostCapabilities } from "@ryco/shared/changeRequestHostCapabilities";
import {
  derivePullRequestSelectionChecks,
  derivePullRequestSelectionNextAction,
  derivePullRequestSelectionThreads,
  reviewDraftKey,
  type ChangeRequestChecksSummary,
  type ChangeRequestNextAction,
  type PullRequestsListDerivation,
  type ReviewThreadIndex,
} from "@ryco/client-runtime/state/pull-request-review";

import type { ChangeRequestMutationTarget } from "../../rpc/sourceControlAtoms";
import type { SourceControlQueryState } from "../../rpc/useSourceControl";
import type { SourceControlPauseText } from "../../sourceControlPause";
import type { PullRequestsTab } from "./pullRequestsSearch";

/**
 * The pull requests page's models: the list with its load state, the selected
 * change request's model, and the layout metrics. The list and selection
 * rules themselves are the shared ones in
 * `@ryco/client-runtime/state/pull-request-review` (`listModel.ts`); the page
 * hook and the test provider both build on these, so tests exercise the exact
 * rules the page runs.
 */

export interface PullRequestsListModel extends PullRequestsListDerivation {
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: string | null;
  /** Set while a list read is refused because the host is rate limiting this account. */
  readonly pause: SourceControlPauseText | null;
}

export interface PullRequestSelectionModel {
  readonly number: number;
  /** The reference every query and mutation for this PR uses (the number as text). */
  readonly reference: string;
  /** List row, available before the detail loads. */
  readonly summary: ChangeRequest | null;
  readonly detail: SourceControlQueryState<SourceControlChangeRequestDetail>;
  readonly activity: SourceControlQueryState<ChangeRequestActivity>;
  readonly headSha: string | null;
  readonly checks: ChangeRequestChecksSummary;
  /** Null until the detail loads. */
  readonly nextAction: ChangeRequestNextAction | null;
  readonly threads: ReviewThreadIndex;
  readonly draftKey: string | null;
  readonly mutationTarget: ChangeRequestMutationTarget;
}

export interface PullRequestsModel {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly provider: SourceControlProviderInfo | null;
  /**
   * What the host implements (`@ryco/shared/changeRequestHostCapabilities`).
   * Every control whose capability is false is hidden; reads it cannot serve
   * are not made.
   */
  readonly capabilities: ChangeRequestHostCapabilities;
  readonly list: PullRequestsListModel;
  readonly selection: PullRequestSelectionModel | null;
}

/**
 * Assembles the selection from the reads and the pieces derived from their
 * data. The page memoizes each piece on data (not on the query wrappers, which
 * change on every fetch start and end), so the thread index and next action
 * keep their identity across refetches that return nothing new.
 */
export function assemblePullRequestSelection(input: {
  readonly number: number;
  readonly summary: ChangeRequest | null;
  readonly detail: SourceControlQueryState<SourceControlChangeRequestDetail>;
  readonly activity: SourceControlQueryState<ChangeRequestActivity>;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly checks: ChangeRequestChecksSummary;
  readonly nextAction: ChangeRequestNextAction | null;
  readonly threads: ReviewThreadIndex;
}): PullRequestSelectionModel {
  const { detail, activity, summary, environmentId, cwd } = input;
  const reference = String(input.number);
  return {
    number: input.number,
    reference,
    summary,
    detail,
    activity,
    headSha: detail.data?.headSha ?? activity.data?.headSha ?? summary?.headSha ?? null,
    checks: input.checks,
    nextAction: input.nextAction,
    threads: input.threads,
    draftKey:
      environmentId !== null && cwd !== null
        ? reviewDraftKey({ environmentId, cwd, number: input.number })
        : null,
    mutationTarget: { environmentId, cwd, reference },
  };
}

/** The selected change request's model from its list row and the two reads. */
export function derivePullRequestSelection(input: {
  readonly number: number;
  readonly summary: ChangeRequest | null;
  readonly detail: SourceControlQueryState<SourceControlChangeRequestDetail>;
  readonly activity: SourceControlQueryState<ChangeRequestActivity>;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}): PullRequestSelectionModel {
  const checks = derivePullRequestSelectionChecks(input.detail.data, input.summary);
  return assemblePullRequestSelection({
    ...input,
    checks,
    nextAction: derivePullRequestSelectionNextAction(
      input.detail.data,
      input.activity.data,
      checks,
    ),
    threads: derivePullRequestSelectionThreads(input.activity.data),
  });
}

// ── Layout ──────────────────────────────────────────────────────────

/** Page widths (excluding the app sidebar) where regions change shape. */
export const PULL_REQUESTS_LIST_DOCK_MIN_PAGE_WIDTH = 900;
export const PULL_REQUESTS_RAIL_DOCK_MIN_READER_WIDTH = 800;
export const PULL_REQUESTS_TREE_DOCK_MIN_READER_WIDTH = 720;
export const PULL_REQUESTS_BAR_COMPACT_MAX_READER_WIDTH = 640;

export interface PullRequestsLayoutMetrics {
  readonly listDocked: boolean;
  readonly listVisible: boolean;
  readonly listFillsPage: boolean;
  readonly readerWidth: number;
  readonly railDocked: boolean;
  readonly treeDocked: boolean;
  readonly barCompact: boolean;
  readonly leadingRegion: "list" | "reader";
}

export function derivePullRequestsLayoutMetrics(input: {
  readonly pageWidth: number;
  readonly listWidth: number;
  readonly listHidden: boolean;
  readonly hasSelection: boolean;
  readonly tab: PullRequestsTab;
  /** A reader with no list at all (a thread's workspace panel): it owns the whole width. */
  readonly listless?: boolean | undefined;
}): PullRequestsLayoutMetrics {
  // Files takes the full width; the list is a drawer there (`\`).
  const listDocked =
    !input.listless &&
    input.pageWidth >= PULL_REQUESTS_LIST_DOCK_MIN_PAGE_WIDTH &&
    !(input.hasSelection && input.tab === "files");
  const listVisible = listDocked && !input.listHidden;
  // Without a selection on a narrow page, the list itself fills the page.
  const listFillsPage = !input.listless && !input.hasSelection && !listDocked;
  const readerWidth = Math.max(0, input.pageWidth - (listVisible ? input.listWidth + 1 : 0));
  return {
    listDocked,
    listVisible,
    listFillsPage,
    readerWidth,
    railDocked: readerWidth >= PULL_REQUESTS_RAIL_DOCK_MIN_READER_WIDTH,
    treeDocked: readerWidth >= PULL_REQUESTS_TREE_DOCK_MIN_READER_WIDTH,
    barCompact: readerWidth < PULL_REQUESTS_BAR_COMPACT_MAX_READER_WIDTH,
    leadingRegion: listVisible || listFillsPage ? "list" : "reader",
  };
}
