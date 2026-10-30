import type {
  ChangeRequest,
  ChangeRequestActivity,
  SourceControlChangeRequestDetail,
  SourceControlLabel,
  SourceControlProviderInfo,
} from "@ryco/contracts";
import {
  getChangeRequestHostCapabilities,
  type ChangeRequestHostCapabilities,
  type ChangeRequestIdleRefresh,
} from "@ryco/shared/changeRequestHostCapabilities";
import { readSourceControlPause, type SourceControlPause } from "@ryco/shared/sourceControlFailure";

import { summarizeChangeRequestChecks, type ChangeRequestChecksSummary } from "./checks.ts";
import { epochMillis } from "./internal.ts";
import { resolvePullRequestsSort, type PullRequestListFilters } from "./listFilters.ts";
import { arrangePullRequestStacks } from "./listStacks.ts";
import { deriveChangeRequestNextAction, type ChangeRequestNextAction } from "./nextAction.ts";
import {
  rankChangeRequests,
  reviewRequestedPredicate,
  type ChangeRequestListGroup,
} from "./readiness.ts";
import { indexReviewThreads, type ReviewThreadIndex } from "./reviewThreads.ts";

/**
 * Pure derivations behind every client's pull request list for one
 * repository: the grouped list from the state read and the two involvement
 * reads, the selected change request's checks, thread index and next action,
 * and when to refresh it. The web page, its test provider and the phone all
 * build on these, so they run the exact same rules.
 */

export const PULL_REQUESTS_LIST_LIMIT = 100;

/** The list as derived from the reads (load and error state belong to the client). */
export interface PullRequestsListDerivation {
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

/**
 * Whether to read the "authored" and "review requested" lists. They start with
 * the state list instead of one git status round trip later: until the host
 * is known they are read anyway (the server answers a host without
 * involvement filters with an error, and one without a host with nothing),
 * and their rows count only once the host's capabilities allow them.
 */
export function shouldReadInvolvementLists(input: {
  readonly listEnabled: boolean;
  readonly provider: Pick<SourceControlProviderInfo, "kind"> | null;
  readonly capabilities: Pick<ChangeRequestHostCapabilities, "involvementFilters">;
}): boolean {
  return input.listEnabled && (input.provider === null || input.capabilities.involvementFilters);
}

/**
 * Whether the involvement reads can group the list. A host without the
 * filters answers them with an error (one flat list); a read that keeps its
 * rows through a rate-limit pause still groups, so the rows stay where they are.
 */
export function involvementReadsUsable(
  supported: boolean,
  reads: ReadonlyArray<{ readonly data: unknown; readonly error: unknown }>,
): boolean {
  return (
    supported &&
    reads.every(
      (read) =>
        read.error === null || (read.data !== null && readSourceControlPause(read.error) !== null),
    )
  );
}

/**
 * The pause behind the list reads that failed because the host is rate
 * limiting this account: the one that ends last (they share the host's pause,
 * and a later refusal may carry its extension), else any without a known end.
 */
export function findSourceControlPause(errors: ReadonlyArray<unknown>): SourceControlPause | null {
  let found: SourceControlPause | null = null;
  for (const error of errors) {
    const pause = readSourceControlPause(error);
    if (pause === null) continue;
    if (found === null || (pause.retryAt ?? -1) > (found.retryAt ?? -1)) found = pause;
  }
  return found;
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
  return epochMillis(entry.updatedAt) ?? 0;
}

/**
 * The list's "only" and label filters, shared by one repository's list and the list
 * across repositories; each says who the viewer is in its own terms.
 */
export function pullRequestListFilter<T extends ChangeRequest>(
  search: Pick<PullRequestListFilters, "only" | "label">,
  viewer: {
    readonly isReviewRequested: (entry: T) => boolean;
    readonly isOwn: (entry: T) => boolean;
  },
): (entry: T) => boolean {
  const labelFilter = new Set(search.label ?? []);
  return (entry) => {
    if (search.only === "review" && !viewer.isReviewRequested(entry)) return false;
    if (search.only === "mine" && !viewer.isOwn(entry)) return false;
    if (
      search.only === "failing" &&
      summarizeChangeRequestChecks(entry.checkRollup).overall !== "failing"
    ) {
      return false;
    }
    return (
      labelFilter.size === 0 || (entry.labels ?? []).some((label) => labelFilter.has(label.name))
    );
  };
}

/** "Recently updated" orders each group by last activity; readiness (or relevance) otherwise. */
export function sortPullRequestGroups<T extends ChangeRequest>(
  groups: ReadonlyArray<ChangeRequestListGroup<T>>,
  search: Pick<PullRequestListFilters, "sort" | "q">,
): ReadonlyArray<ChangeRequestListGroup<T>> {
  if (resolvePullRequestsSort(search) !== "updated" || search.q) return groups;
  return groups.map((group) => ({
    ...group,
    entries: group.entries.toSorted(
      (left, right) => updatedMillis(right) - updatedMillis(left) || right.number - left.number,
    ),
  }));
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
  readonly search: PullRequestListFilters;
  /** Folded list groups; their rows leave `ordered`, so J/K walks only what is visible. */
  readonly foldedGroups?: ReadonlyArray<string> | undefined;
}): PullRequestsListDerivation {
  const { search } = input;
  const byNumber = mergeChangeRequestLists(
    input.stateList,
    input.authoredList,
    input.reviewRequestedList,
  );
  const all = [...byNumber.values()];
  const viewerLogin = input.authoredList?.find((entry) => entry.author)?.author ?? null;
  const isReviewRequested = reviewRequestedPredicate(input.reviewRequestedList);
  const filtered = all.filter(
    pullRequestListFilter(search, {
      isReviewRequested,
      isOwn: (entry) => viewerLogin !== null && entry.author === viewerLogin,
    }),
  );
  let groups = sortPullRequestGroups(
    rankChangeRequests(filtered, input.involvementSupported ? viewerLogin : null, {
      isReviewRequested,
      ...(search.q ? { query: search.q } : {}),
    }),
    search,
  );
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
 * Refresh cadence for the selected change request's detail and activity: the
 * active cadence while checks run on an open change request, the slower
 * `watching` cadence while it is open otherwise (so new comments and reviews
 * arrive without a window focus; `watching-slow` on hosts whose reads spawn
 * many CLI processes, see `ChangeRequestIdleRefresh`), and none once it is
 * closed or merged. Clients pause every cadence while the app is in the
 * background.
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
