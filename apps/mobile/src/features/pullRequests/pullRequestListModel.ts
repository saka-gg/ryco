import type {
  ChangeRequest,
  ChangeRequestInvolvement,
  ChangeRequestState,
  SourceControlProviderInfo,
} from "@ryco/contracts";
import {
  availablePullRequestOnlyOptions,
  derivePullRequestsCapabilities,
  derivePullRequestsList,
  describePullRequestReadiness,
  describePullRequestsListError,
  findSourceControlPause,
  involvementReadsUsable,
  PULL_REQUEST_STATE_OPTIONS,
  PULL_REQUESTS_LIST_LIMIT,
  resolvePullRequestsStateFilter,
  shouldReadInvolvementLists,
  summarizeChangeRequestChecks,
  type ChangeRequestChecksOverall,
  type ChangeRequestListGroupKey,
  type PullRequestListFilters,
  type PullRequestReadinessTone,
  type PullRequestsOnlyFilter,
  type PullRequestsStateFilter,
} from "@ryco/client-runtime/state/pull-request-review";
import { epochMillis } from "@ryco/shared/changeRequestChecks";

import { formatPullRequestDiffStat } from "./pullRequestDiffModel";

/**
 * The phone's pull request list for one repository: the same three reads as
 * the web's list (the state list plus the "authored" and "review requested"
 * involvement lists, so the groups are complete on first paint), merged,
 * filtered, grouped and ranked by the shared rules, then shaped into sections
 * of rows.
 */

type Provider = Pick<SourceControlProviderInfo, "kind">;

export interface PullRequestListReadInput {
  readonly state: PullRequestsStateFilter;
  readonly involvement?: ChangeRequestInvolvement | undefined;
  readonly limit: number;
  readonly enabled: boolean;
}

export interface PullRequestListReadInputs {
  readonly state: PullRequestListReadInput;
  readonly authored: PullRequestListReadInput;
  readonly reviewRequested: PullRequestListReadInput;
}

/** Which reads the list issues for these filters, before and after the host is known. */
export function pullRequestListReadInputs(input: {
  readonly checkoutKnown: boolean;
  readonly provider: Provider | null;
  readonly filters: Pick<PullRequestListFilters, "state">;
}): PullRequestListReadInputs {
  const state = resolvePullRequestsStateFilter(input.filters);
  const involvementEnabled = shouldReadInvolvementLists({
    listEnabled: input.checkoutKnown,
    provider: input.provider,
    capabilities: derivePullRequestsCapabilities(input.provider),
  });
  const limit = PULL_REQUESTS_LIST_LIMIT;
  return {
    state: { state, limit, enabled: input.checkoutKnown },
    authored: { state, involvement: "authored", limit, enabled: involvementEnabled },
    reviewRequested: {
      state,
      involvement: "review-requested",
      limit,
      enabled: involvementEnabled,
    },
  };
}

export interface PullRequestListRead {
  readonly data: ReadonlyArray<ChangeRequest> | null;
  readonly error: unknown;
  readonly isLoading: boolean;
}

export interface PullRequestListRow {
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly state: ChangeRequestState;
  readonly isDraft: boolean;
  /** Another author's login; null for the viewer's own pull requests. */
  readonly author: string | null;
  readonly readinessLabel: string;
  readonly readinessTone: PullRequestReadinessTone;
  /** `none` when the host reports no checks on its rows. */
  readonly checks: ChangeRequestChecksOverall;
  readonly updatedAtMs: number | null;
  /** "+12 −3", or null when the row does not say. */
  readonly diffStat: string | null;
}

export interface PullRequestListSection {
  readonly key: ChangeRequestListGroupKey;
  /** Null for the one flat group of a host without involvement filters. */
  readonly title: string | null;
  readonly rows: ReadonlyArray<PullRequestListRow>;
}

export interface PullRequestFilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface PullRequestListScreen {
  readonly status: "loading" | "error" | "empty" | "ready";
  readonly sections: ReadonlyArray<PullRequestListSection>;
  /** The sentence for a failed state read (rows may still be on screen). */
  readonly error: string | null;
  /** The host is rate limiting this account; the rows on screen are the last ones read. */
  readonly paused: boolean;
  readonly stateOptions: ReadonlyArray<PullRequestFilterOption<PullRequestsStateFilter>>;
  readonly onlyOptions: ReadonlyArray<PullRequestFilterOption<PullRequestsOnlyFilter>>;
  readonly emptyTitle: string;
  readonly emptyDetail: string;
}

function errorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return describePullRequestsListError(error.message);
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return describePullRequestsListError(error.message);
  }
  return describePullRequestsListError(String(error));
}

function toRow(
  entry: ChangeRequest,
  context: {
    readonly viewerLogin: string | null;
    readonly readiness: ReturnType<typeof derivePullRequestsCapabilities>["listReadiness"];
    readonly checkRollup: boolean;
  },
): PullRequestListRow {
  const readiness = describePullRequestReadiness(entry, {
    viewerLogin: context.viewerLogin,
    readiness: context.readiness,
  });
  const own =
    context.viewerLogin !== null &&
    entry.author?.toLowerCase() === context.viewerLogin.toLowerCase();
  const diffStat =
    entry.additions === undefined && entry.deletions === undefined
      ? null
      : formatPullRequestDiffStat(entry.additions ?? 0, entry.deletions ?? 0) || null;
  return {
    key: String(entry.number),
    number: entry.number,
    title: entry.title,
    state: entry.state,
    isDraft: entry.isDraft === true,
    author: own ? null : (entry.author ?? null),
    readinessLabel: readiness.label,
    readinessTone: readiness.tone,
    checks: context.checkRollup ? summarizeChangeRequestChecks(entry.checkRollup).overall : "none",
    updatedAtMs: epochMillis(entry.updatedAt),
    diffStat,
  };
}

function emptyCopy(filters: PullRequestListFilters): {
  readonly title: string;
  readonly detail: string;
} {
  if (filters.only !== undefined || (filters.label?.length ?? 0) > 0) {
    return { title: "No matches", detail: "No pull request here matches these filters." };
  }
  switch (resolvePullRequestsStateFilter(filters)) {
    case "open":
      return { title: "No open pull requests", detail: "Nothing is waiting in this repository." };
    case "merged":
      return { title: "No merged pull requests", detail: "Nothing has been merged here yet." };
    case "closed":
      return { title: "No closed pull requests", detail: "Nothing here was closed unmerged." };
    case "all":
      return { title: "No pull requests", detail: "This repository has no pull requests yet." };
  }
}

export function derivePullRequestListScreen(input: {
  readonly reads: {
    readonly state: PullRequestListRead;
    readonly authored: PullRequestListRead;
    readonly reviewRequested: PullRequestListRead;
  };
  readonly provider: Provider | null;
  readonly filters: PullRequestListFilters;
}): PullRequestListScreen {
  const { reads, filters } = input;
  const capabilities = derivePullRequestsCapabilities(input.provider);
  const involvementSupported = involvementReadsUsable(capabilities.involvementFilters, [
    reads.authored,
    reads.reviewRequested,
  ]);
  const list = derivePullRequestsList({
    stateList: reads.state.data,
    authoredList: reads.authored.data,
    reviewRequestedList: reads.reviewRequested.data,
    involvementSupported,
    search: filters,
  });
  const context = {
    viewerLogin: list.viewerLogin,
    readiness: capabilities.listReadiness,
    checkRollup: capabilities.listCheckRollup,
  };
  const sections = list.groups
    .filter((group) => group.entries.length > 0)
    .map((group): PullRequestListSection => ({
      key: group.key,
      title: involvementSupported ? group.label : null,
      rows: group.entries.map((entry) => toRow(entry, context)),
    }));
  const error = errorText(reads.state.error);
  const paused =
    findSourceControlPause([
      reads.state.error,
      reads.authored.error,
      reads.reviewRequested.error,
    ]) !== null;
  const hasRows = sections.length > 0;
  const status: PullRequestListScreen["status"] =
    reads.state.data === null
      ? error !== null
        ? "error"
        : "loading"
      : hasRows
        ? "ready"
        : "empty";
  const empty = emptyCopy(filters);
  return {
    status,
    sections,
    error,
    paused,
    stateOptions: PULL_REQUEST_STATE_OPTIONS,
    onlyOptions: availablePullRequestOnlyOptions({
      involvementSupported,
      checkRollup: capabilities.listCheckRollup,
    }),
    emptyTitle: empty.title,
    emptyDetail: empty.detail,
  };
}
