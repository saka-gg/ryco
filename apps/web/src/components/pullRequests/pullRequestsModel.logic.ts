import type {
  ChangeRequest,
  ChangeRequestActivity,
  EnvironmentId,
  SourceControlChangeRequestDetail,
  SourceControlLabel,
  SourceControlProviderInfo,
} from "@ryco/contracts";
import {
  getChangeRequestHostCapabilities,
  type ChangeRequestHostCapabilities,
  type ChangeRequestIdleRefresh,
} from "@ryco/shared/sourceControl";
import {
  deriveChangeRequestNextAction,
  indexReviewThreads,
  rankChangeRequests,
  reviewDraftKey,
  reviewRequestedPredicate,
  summarizeChangeRequestChecks,
  type ChangeRequestChecksSummary,
  type ChangeRequestListGroup,
  type ChangeRequestNextAction,
  type ReviewThreadIndex,
} from "@ryco/client-runtime/state/pull-request-review";
import { DateTime, Option } from "effect";

import type { ChangeRequestMutationTarget } from "../../rpc/sourceControlAtoms";
import type { SourceControlQueryState } from "../../rpc/useSourceControl";
import { arrangePullRequestStacks } from "./list/pullRequestListStacks.logic";
import {
  resolvePullRequestsSort,
  type PullRequestsSearch,
  type PullRequestsTab,
} from "./pullRequestsSearch";

/**
 * Pure derivations behind the pull requests page: the grouped list, the
 * selected change request's model, and the layout metrics. The page hook and
 * the test provider both build on these, so tests exercise the exact rules the
 * page runs.
 */

export const PULL_REQUESTS_LIST_LIMIT = 100;

export interface PullRequestsListModel {
  /** Ranked, filtered groups (needs your review / yours / others). */
  readonly groups: ReadonlyArray<ChangeRequestListGroup<ChangeRequest>>;
  /** Visible rows in display order, for keyboard movement. */
  readonly ordered: ReadonlyArray<ChangeRequest>;
  /** Every loaded change request by number (all list queries merged). */
  readonly byNumber: ReadonlyMap<number, ChangeRequest>;
  readonly labels: ReadonlyArray<SourceControlLabel>;
  readonly viewerLogin: string | null;
  /** False when the provider cannot filter by involvement (no grouping). */
  readonly involvementSupported: boolean;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: string | null;
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
   * What the host implements (`@ryco/shared/sourceControl`). Every control
   * whose capability is false is hidden; reads it cannot serve are not made.
   */
  readonly capabilities: ChangeRequestHostCapabilities;
  readonly list: PullRequestsListModel;
  readonly selection: PullRequestSelectionModel | null;
}

const EMPTY_THREADS = indexReviewThreads([]);

/**
 * The host's capabilities; until the checkout's provider is known, nothing is
 * offered (the `unknown` entry), so no control appears and then vanishes.
 */
export function derivePullRequestsCapabilities(
  provider: Pick<SourceControlProviderInfo, "kind"> | null,
): ChangeRequestHostCapabilities {
  return getChangeRequestHostCapabilities(provider?.kind ?? "unknown");
}

export function mergeChangeRequestLists(
  ...lists: ReadonlyArray<ReadonlyArray<ChangeRequest> | null | undefined>
): Map<number, ChangeRequest> {
  const byNumber = new Map<number, ChangeRequest>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      const existing = byNumber.get(entry.number);
      // Involvement reads and the state read return the same rows; keep the
      // richer one, and the existing object when the later read adds nothing
      // (so memoized rows keep their props).
      byNumber.set(
        entry.number,
        existing ? (addsNothing(existing, entry) ? existing : { ...existing, ...entry }) : entry,
      );
    }
  }
  return byNumber;
}

function addsNothing(existing: ChangeRequest, entry: ChangeRequest): boolean {
  for (const key of Object.keys(entry) as Array<keyof ChangeRequest>) {
    if (entry[key] !== existing[key]) return false;
  }
  return true;
}

function updatedMillis(entry: ChangeRequest): number {
  return Option.match(entry.updatedAt, {
    onNone: () => 0,
    onSome: (updatedAt) => DateTime.toEpochMillis(updatedAt),
  });
}

/**
 * Groups and filters the merged list reads. `authoredList` names the viewer
 * (any row's author) and `reviewRequestedList` decides "Needs your review";
 * without involvement support everything lands in one group.
 */
export function derivePullRequestsList(input: {
  readonly stateList: ReadonlyArray<ChangeRequest> | null;
  readonly authoredList: ReadonlyArray<ChangeRequest> | null;
  readonly reviewRequestedList: ReadonlyArray<ChangeRequest> | null;
  readonly involvementSupported: boolean;
  readonly search: PullRequestsSearch;
  /** Folded list groups; their rows leave `ordered`, so J/K walks only what is visible. */
  readonly foldedGroups?: ReadonlyArray<string> | undefined;
}): Omit<PullRequestsListModel, "isLoading" | "isFetching" | "error"> {
  const { search } = input;
  const byNumber = mergeChangeRequestLists(
    input.stateList,
    input.authoredList,
    input.reviewRequestedList,
  );
  const all = [...byNumber.values()];
  const viewerLogin = input.authoredList?.find((entry) => entry.author)?.author ?? null;
  const isReviewRequested = reviewRequestedPredicate(input.reviewRequestedList);
  const labelFilter = new Set(search.label ?? []);
  const filtered = all.filter((entry) => {
    if (search.only === "review" && !isReviewRequested(entry)) return false;
    if (search.only === "mine" && (viewerLogin === null || entry.author !== viewerLogin)) {
      return false;
    }
    if (
      search.only === "failing" &&
      summarizeChangeRequestChecks(entry.checkRollup).overall !== "failing"
    ) {
      return false;
    }
    if (
      labelFilter.size > 0 &&
      !(entry.labels ?? []).some((label) => labelFilter.has(label.name))
    ) {
      return false;
    }
    return true;
  });
  let groups = rankChangeRequests(filtered, input.involvementSupported ? viewerLogin : null, {
    isReviewRequested,
    ...(search.q ? { query: search.q } : {}),
  });
  if (resolvePullRequestsSort(search) === "updated" && !search.q) {
    groups = groups.map((group) => ({
      ...group,
      entries: group.entries.toSorted(
        (left, right) => updatedMillis(right) - updatedMillis(left) || right.number - left.number,
      ),
    }));
  }
  // Stacks read as one unit (top layer first) in their most urgent group, and
  // `ordered` follows that display order.
  groups = arrangePullRequestStacks(groups);
  // A flat list (no involvement) has no group headers to fold.
  const folded = new Set(input.involvementSupported ? (input.foldedGroups ?? []) : []);
  const labels = new Map<string, SourceControlLabel>();
  for (const entry of all) for (const label of entry.labels ?? []) labels.set(label.name, label);
  return {
    groups,
    ordered: groups.filter((group) => !folded.has(group.key)).flatMap((group) => group.entries),
    byNumber,
    labels: [...labels.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    viewerLogin,
    involvementSupported: input.involvementSupported,
  };
}

/** Checks for the selected change request: the detail's rollup, else the list row's. */
export function derivePullRequestSelectionChecks(
  detail: SourceControlChangeRequestDetail | null,
  summary: ChangeRequest | null,
): ChangeRequestChecksSummary {
  return summarizeChangeRequestChecks(detail?.checkRollup ?? summary?.checkRollup);
}

/** The review-thread index; the empty index until activity loads. */
export function derivePullRequestSelectionThreads(
  activity: ChangeRequestActivity | null,
): ReviewThreadIndex {
  return activity ? indexReviewThreads(activity.reviewThreads) : EMPTY_THREADS;
}

/** The next action; null until the detail loads. */
export function derivePullRequestSelectionNextAction(
  detail: SourceControlChangeRequestDetail | null,
  activity: ChangeRequestActivity | null,
  checks: ChangeRequestChecksSummary,
): ChangeRequestNextAction | null {
  return detail ? deriveChangeRequestNextAction(detail, activity, checks) : null;
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

/**
 * Refresh cadence for the selected change request's detail and activity: the
 * active cadence while checks run on an open change request, the slower
 * `watching` cadence while it is open otherwise (so new comments and reviews
 * arrive without a window focus; `watching-slow` on hosts whose reads spawn
 * many CLI processes, see `ChangeRequestIdleRefresh`), and none once it is
 * closed or merged. The keyed-query lifecycle pauses every cadence while the
 * app is in the background.
 */
export function pullRequestSelectionRefreshPhase(input: {
  readonly detail: SourceControlChangeRequestDetail | null;
  readonly summary: ChangeRequest | null;
  /** The host's `idleRefresh` (default `standard`). */
  readonly idleRefresh?: ChangeRequestIdleRefresh | undefined;
}): "active" | "watching" | "watching-slow" | "settled" {
  const state = input.detail?.state ?? input.summary?.state;
  if (state !== "open") return "settled";
  if (derivePullRequestSelectionChecks(input.detail, input.summary).overall === "pending") {
    return "active";
  }
  return input.idleRefresh === "slow" ? "watching-slow" : "watching";
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

/**
 * Turns a provider failure into the one sentence the list shows. Raw RPC
 * errors name internal operations ("detectProvider"); the reader needs to know
 * what to do next.
 */
export function describePullRequestsListError(raw: string): string {
  const message = raw.toLowerCase();
  if (message.includes("detectprovider") || message.includes("failed to detect source control")) {
    return "This checkout has no remote Ryco recognises, or it no longer exists. Pick another repository.";
  }
  if (
    message.includes("gh auth login") ||
    message.includes("not logged") ||
    message.includes("authentication")
  ) {
    return "GitHub CLI is not signed in on this machine. Run `gh auth login`, then try again.";
  }
  if (message.includes("rate limit")) {
    return "GitHub's rate limit was reached. The list refreshes on its own shortly.";
  }
  if (message.includes("enoent") && message.includes("gh")) {
    return "GitHub CLI (`gh`) is not installed on this machine.";
  }
  return raw;
}
