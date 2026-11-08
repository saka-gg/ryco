import type {
  ChangeRequest,
  ChangeRequestInvolvement,
  ChangeRequestState,
  SourceControlProviderInfo,
} from "@ryco/contracts";
import {
  availablePullRequestOnlyOptions,
  buildPullRequestListItems,
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
  stackFootParts,
  summarizeChangeRequestChecks,
  type ChangeRequestChecksOverall,
  type ChangeRequestListGroupKey,
  type PullRequestListFilters,
  type PullRequestReadinessTone,
  type PullRequestRowSpine,
  type PullRequestsOnlyFilter,
  type StackFootPartTone,
  type PullRequestsStateFilter,
} from "@ryco/client-runtime/state/pull-request-review";
import { epochMillis } from "@ryco/shared/changeRequestChecks";
import type { SourceControlLabel } from "@ryco/contracts";

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
  readonly additions: number | null;
  readonly deletions: number | null;
  /** The check ring's counts; null when the host reports no checks on its rows. */
  readonly checkCounts: PullRequestCheckCounts | null;
  /** The host's review verdict; null when it reports none. */
  readonly review: PullRequestRowReview | null;
  /** The first labels, for the row; `moreLabels` counts the rest. */
  readonly labels: ReadonlyArray<SourceControlLabel>;
  readonly moreLabels: number;
  /** Where it sits in a host-native stack, bottom layer 1. */
  readonly stack: { readonly position: number; readonly size: number } | null;
  /** The host says it conflicts with its base. */
  readonly conflict: boolean;
  readonly commentsCount: number;
  readonly headRefName: string;
  readonly baseRefName: string;
  /** The pull request on its host. */
  readonly url: string;
  /** Open and clear to merge on its own (the stack spine's landable stretch). */
  readonly landable: boolean;
}

export interface PullRequestCheckCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly running: number;
}

export type PullRequestRowReview = "approved" | "changes-requested" | "review-required";

/** The PRs tab's three views of one repository. */
export type PullRequestsSegment = "mine" | "review" | "all";

export const PULL_REQUEST_SEGMENTS: ReadonlyArray<{
  readonly value: PullRequestsSegment;
  readonly label: string;
}> = [
  { value: "mine", label: "Mine" },
  { value: "review", label: "To review" },
  { value: "all", label: "All" },
];

/** The tab's filters on top of the shared ones: a segment and two local narrowings. */
export interface PullRequestTabFilters {
  readonly segment: PullRequestsSegment;
  readonly state?: PullRequestListFilters["state"];
  readonly sort?: PullRequestListFilters["sort"];
  readonly label?: PullRequestListFilters["label"];
  readonly q?: string | undefined;
  readonly failingOnly?: boolean | undefined;
  readonly hideDrafts?: boolean | undefined;
}

/** The shared filters a tab filter reads: the segment becomes the shared "only". */
export function pullRequestTabListFilters(filters: PullRequestTabFilters): PullRequestListFilters {
  const only: PullRequestsOnlyFilter | undefined =
    filters.segment === "mine" ? "mine" : filters.segment === "review" ? "review" : undefined;
  return {
    ...(filters.state !== undefined ? { state: filters.state } : {}),
    ...(filters.sort !== undefined ? { sort: filters.sort } : {}),
    ...(filters.label !== undefined && filters.label.length > 0 ? { label: filters.label } : {}),
    ...(filters.q !== undefined && filters.q.trim().length > 0 ? { q: filters.q.trim() } : {}),
    ...(only !== undefined ? { only } : {}),
  };
}

/** How many of the filter sheet's settings are off their defaults (the filter icon's badge). */
export function countPullRequestTabFilters(filters: PullRequestTabFilters): number {
  return (
    (filters.state !== undefined && filters.state !== "open" ? 1 : 0) +
    (filters.sort !== undefined && filters.sort !== "readiness" ? 1 : 0) +
    (filters.label?.length ?? 0) +
    (filters.failingOnly === true ? 1 : 0) +
    (filters.hideDrafts === true ? 1 : 0)
  );
}

/** One line of the list: a group heading, a pull request, or a stack's foot. */
export type PullRequestListItemModel =
  | {
      readonly kind: "heading";
      readonly key: string;
      readonly title: string;
      readonly count: number;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly row: PullRequestListRow;
      readonly spine: PullRequestRowSpine | null;
    }
  | {
      readonly kind: "foot";
      readonly key: string;
      readonly baseRefName: string;
      readonly parts: ReadonlyArray<{ readonly text: string; readonly tone: StackFootPartTone }>;
    };

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
  /** The sections as one flat list, stacks drawn as units with a foot. */
  readonly items: ReadonlyArray<PullRequestListItemModel>;
  /** Rows each segment would show, before the local narrowings; null while unknown. */
  readonly segmentCounts: Readonly<Record<PullRequestsSegment, number | null>>;
  /** The host's involvement reads work, so "Mine" and "To review" can be offered. */
  readonly involvementSupported: boolean;
  /** Every label on the loaded rows, for the filter sheet. */
  readonly labels: ReadonlyArray<SourceControlLabel>;
}

function errorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return describePullRequestsListError(error.message);
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return describePullRequestsListError(error.message);
  }
  return describePullRequestsListError(String(error));
}

const ROW_LABELS = 2;

const REVIEW: Readonly<Record<string, PullRequestRowReview>> = {
  approved: "approved",
  changes_requested: "changes-requested",
  review_required: "review-required",
};

function checkCounts(entry: ChangeRequest): PullRequestCheckCounts | null {
  const summary = summarizeChangeRequestChecks(entry.checkRollup);
  if (summary.counts.total === 0) return null;
  const groups = summary.groups;
  return {
    total: summary.counts.total,
    passed: summary.counts.success + summary.counts.neutral + summary.counts.skipped,
    failed: groups.attention.length,
    running: groups.running.length,
  };
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
  const labels = entry.labels ?? [];
  const reviewDecision = entry.reviewDecision ?? null;
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
    additions: entry.additions ?? null,
    deletions: entry.deletions ?? null,
    checkCounts: context.checkRollup ? checkCounts(entry) : null,
    review: reviewDecision === null ? null : (REVIEW[reviewDecision] ?? null),
    labels: labels.slice(0, ROW_LABELS),
    moreLabels: Math.max(0, labels.length - ROW_LABELS),
    stack: entry.stackSummary
      ? { position: entry.stackSummary.position, size: entry.stackSummary.size }
      : null,
    conflict: entry.state === "open" && entry.mergeability === "conflicting",
    commentsCount: entry.commentsCount ?? 0,
    headRefName: entry.headRefName,
    baseRefName: entry.baseRefName,
    url: entry.url,
    landable: readiness.landable,
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

function isOpenRow(entry: ChangeRequest): boolean {
  return entry.state === "open";
}

/** Rows each segment would show: "Mine" and "To review" count open rows only. */
function segmentCounts(input: {
  readonly reads: {
    readonly state: PullRequestListRead;
    readonly authored: PullRequestListRead;
    readonly reviewRequested: PullRequestListRead;
  };
  readonly involvementSupported: boolean;
  readonly stateCount: number | null;
}): Readonly<Record<PullRequestsSegment, number | null>> {
  const { reads } = input;
  return {
    mine:
      input.involvementSupported && reads.authored.data !== null
        ? reads.authored.data.filter(isOpenRow).length
        : null,
    review:
      input.involvementSupported && reads.reviewRequested.data !== null
        ? reads.reviewRequested.data.filter(isOpenRow).length
        : null,
    all: input.stateCount,
  };
}

/** The sections as one list: headings where more than one group shows, stacks as units. */
function listItems(
  sections: ReadonlyArray<{
    readonly key: string;
    readonly title: string | null;
    readonly entries: ReadonlyArray<ChangeRequest>;
    readonly rows: ReadonlyMap<number, PullRequestListRow>;
  }>,
  allRows: ReadonlyArray<ChangeRequest>,
  landable: (entry: ChangeRequest) => boolean,
): ReadonlyArray<PullRequestListItemModel> {
  const items: PullRequestListItemModel[] = [];
  const headed = sections.length > 1;
  for (const section of sections) {
    if (headed && section.title !== null) {
      items.push({
        kind: "heading",
        key: `heading:${section.key}`,
        title: section.title,
        count: section.entries.length,
      });
    }
    for (const item of buildPullRequestListItems(section.entries, {
      isLandable: landable,
      allRows,
    })) {
      if (item.kind === "row") {
        const row = section.rows.get(item.entry.number);
        if (row === undefined) continue;
        items.push({ kind: "row", key: `${section.key}:${item.key}`, row, spine: item.spine });
      } else {
        items.push({
          kind: "foot",
          key: `${section.key}:${item.key}`,
          baseRefName: item.foot.baseRefName,
          parts: stackFootParts(item.foot),
        });
      }
    }
  }
  return items;
}

export function derivePullRequestListScreen(input: {
  readonly reads: {
    readonly state: PullRequestListRead;
    readonly authored: PullRequestListRead;
    readonly reviewRequested: PullRequestListRead;
  };
  readonly provider: Provider | null;
  readonly filters: PullRequestListFilters;
  /** The tab's local narrowings, applied after the shared filters. */
  readonly narrow?: {
    readonly failingOnly?: boolean | undefined;
    readonly hideDrafts?: boolean | undefined;
  };
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
  const failingOnly = input.narrow?.failingOnly === true && capabilities.listCheckRollup;
  const hideDrafts = input.narrow?.hideDrafts === true;
  const keep = (entry: ChangeRequest) =>
    (!hideDrafts || entry.isDraft !== true) &&
    (!failingOnly || summarizeChangeRequestChecks(entry.checkRollup).overall === "failing");
  const shaped = list.groups
    .map((group) => {
      const entries = group.entries.filter(keep);
      return {
        key: group.key,
        title: involvementSupported ? group.label : null,
        entries,
        rows: new Map(entries.map((entry) => [entry.number, toRow(entry, context)])),
      };
    })
    .filter((group) => group.entries.length > 0);
  const sections = shaped.map((group): PullRequestListSection => ({
    key: group.key,
    title: group.title,
    rows: [...group.rows.values()],
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
  const narrowed = failingOnly || hideDrafts;
  const empty = emptyCopy(narrowed ? { ...filters, only: filters.only ?? "failing" } : filters);
  const allRows = [...list.byNumber.values()];
  const landable = (entry: ChangeRequest) =>
    describePullRequestReadiness(entry, { readiness: capabilities.listReadiness }).landable;
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
    items: listItems(shaped, allRows, landable),
    segmentCounts: segmentCounts({
      reads,
      involvementSupported,
      stateCount: reads.state.data === null ? null : reads.state.data.length,
    }),
    involvementSupported,
    labels: list.labels,
  };
}
