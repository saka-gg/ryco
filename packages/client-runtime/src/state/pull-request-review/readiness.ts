import type { ChangeRequest } from "@ryco/contracts";

import { summarizeChangeRequestChecks } from "./checks.ts";
import { epochMillis, sameLogin } from "./internal.ts";

export type ChangeRequestListGroupKey = "needs-your-review" | "yours" | "others";

export interface ChangeRequestListGroup<T> {
  readonly key: ChangeRequestListGroupKey;
  readonly label: string;
  /** Ranked by merge readiness (or by search relevance while searching). */
  readonly entries: ReadonlyArray<T>;
}

/**
 * Merge-readiness tiers, best first. A known conflict is never ready, whatever
 * its checks or reviews say, so it always sorts last.
 */
export type ChangeRequestReadinessTier =
  | "ready" // open, green, approved
  | "green" // open, green, still waiting on a verdict
  | "open" // everything else that is open and not a draft
  | "draft"
  | "finished" // merged or closed
  | "conflicting";

const TIER_RANK: Record<ChangeRequestReadinessTier, number> = {
  ready: 0,
  green: 1,
  open: 2,
  draft: 3,
  finished: 4,
  conflicting: 5,
};

const GROUP_LABELS: Record<ChangeRequestListGroupKey, string> = {
  "needs-your-review": "Needs your review",
  yours: "Yours",
  others: "Others",
};

type RankableChangeRequest = Pick<
  ChangeRequest,
  | "number"
  | "state"
  | "isDraft"
  | "mergeability"
  | "reviewDecision"
  | "checkRollup"
  | "additions"
  | "deletions"
  | "updatedAt"
  | "createdAt"
>;

type SearchableChangeRequest = Pick<
  ChangeRequest,
  "number" | "title" | "headRefName" | "baseRefName" | "author" | "labels"
>;

export function changeRequestReadinessTier(
  entry: RankableChangeRequest,
): ChangeRequestReadinessTier {
  if (entry.mergeability === "conflicting") return "conflicting";
  if (entry.state !== "open") return "finished";
  if (entry.isDraft === true) return "draft";
  // No checks reported is not a failure: a repository without CI is green.
  const overall = summarizeChangeRequestChecks(entry.checkRollup).overall;
  const green = overall === "passing" || overall === "none";
  if (green && entry.reviewDecision === "approved") return "ready";
  if (green && entry.reviewDecision !== "changes_requested") return "green";
  return "open";
}

function diffSize(entry: RankableChangeRequest): number | null {
  if (entry.additions === undefined && entry.deletions === undefined) return null;
  const size = (entry.additions ?? 0) + (entry.deletions ?? 0);
  return size > 0 ? size : null;
}

function recency(entry: RankableChangeRequest): number {
  return epochMillis(entry.updatedAt) ?? epochMillis(entry.createdAt) ?? 0;
}

/**
 * Tier first; within a tier measured diffs before unknown sizes, smaller diffs
 * first, then the most recently updated.
 */
export function compareByMergeReadiness(
  left: RankableChangeRequest,
  right: RankableChangeRequest,
): number {
  const byTier =
    TIER_RANK[changeRequestReadinessTier(left)] - TIER_RANK[changeRequestReadinessTier(right)];
  if (byTier !== 0) return byTier;
  const leftSize = diffSize(left);
  const rightSize = diffSize(right);
  if (leftSize === null && rightSize !== null) return 1;
  if (leftSize !== null && rightSize === null) return -1;
  if (leftSize !== null && rightSize !== null && leftSize !== rightSize) {
    return leftSize - rightSize;
  }
  return recency(right) - recency(left) || right.number - left.number;
}

export function rankChangeRequestsByMergeReadiness<T extends RankableChangeRequest>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return entries.toSorted(compareByMergeReadiness);
}

export interface RankChangeRequestsOptions<T> {
  /**
   * Whether the viewer's review is requested. The list rows do not carry this,
   * so callers derive it, e.g. from a parallel `involvement: "review-requested"`
   * list query (see `reviewRequestedPredicate`).
   */
  readonly isReviewRequested?: (entry: T) => boolean;
  /** When set, rows are filtered by and ranked on relevance to this query. */
  readonly query?: string;
}

/**
 * Groups a list for the viewer — needs your review, yours (drafts included,
 * ranked below ready work), others — and ranks each group by merge readiness.
 * Empty groups are omitted. Without a viewer login every row lands in others.
 */
export function rankChangeRequests<T extends RankableChangeRequest & SearchableChangeRequest>(
  list: ReadonlyArray<T>,
  viewerLogin: string | null | undefined,
  options?: RankChangeRequestsOptions<T>,
): ReadonlyArray<ChangeRequestListGroup<T>> {
  const query = options?.query?.trim() ?? "";
  const buckets: Record<ChangeRequestListGroupKey, T[]> = {
    "needs-your-review": [],
    yours: [],
    others: [],
  };
  const candidates =
    query.length > 0 ? list.filter((entry) => scoreChangeRequestMatch(entry, query) > 0) : list;
  for (const entry of candidates) {
    if (sameLogin(entry.author, viewerLogin)) buckets.yours.push(entry);
    else if (options?.isReviewRequested?.(entry) === true) buckets["needs-your-review"].push(entry);
    else buckets.others.push(entry);
  }
  const rank = (entries: ReadonlyArray<T>): ReadonlyArray<T> =>
    query.length > 0
      ? entries.toSorted(
          (left, right) =>
            scoreChangeRequestMatch(right, query) - scoreChangeRequestMatch(left, query) ||
            compareByMergeReadiness(left, right),
        )
      : rankChangeRequestsByMergeReadiness(entries);
  return (["needs-your-review", "yours", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: rank(buckets[key]) }));
}

/** Membership test built from a review-requested list, for `isReviewRequested`. */
export function reviewRequestedPredicate(
  reviewRequested: ReadonlyArray<Pick<ChangeRequest, "number">> | null | undefined,
): (entry: Pick<ChangeRequest, "number">) => boolean {
  const numbers = new Set((reviewRequested ?? []).map((entry) => entry.number));
  return (entry) => numbers.has(entry.number);
}

// ── Search ──────────────────────────────────────────────────────────────

export interface ChangeRequestSearchQuery {
  /** Set when the query names one change request: `#123`, `123`, or a pasted URL. */
  readonly number: number | null;
  /** Lower-cased free-text terms; every term must match somewhere. */
  readonly terms: ReadonlyArray<string>;
  readonly text: string;
}

const CHANGE_REQUEST_URL_PATTERNS: ReadonlyArray<RegExp> = [
  /\/pulls?\/(\d+)(?:[/?#]|$)/u, // GitHub, Forgejo/Gitea
  /\/-\/merge_requests\/(\d+)(?:[/?#]|$)/u, // GitLab
  /\/merge_requests\/(\d+)(?:[/?#]|$)/u,
  /\/pull-requests\/(\d+)(?:[/?#]|$)/u, // Bitbucket
  /\/pullrequest\/(\d+)(?:[/?#]|$)/iu, // Azure DevOps
];

export function parseChangeRequestSearchQuery(raw: string): ChangeRequestSearchQuery {
  const text = raw.trim();
  if (/^https?:\/\//iu.test(text)) {
    for (const pattern of CHANGE_REQUEST_URL_PATTERNS) {
      const match = pattern.exec(text);
      if (match?.[1]) return { number: Number(match[1]), terms: [], text };
    }
  }
  const numberMatch = /^#?(\d+)$/u.exec(text);
  if (numberMatch?.[1]) return { number: Number(numberMatch[1]), terms: [], text };
  return {
    number: null,
    terms: text
      .toLowerCase()
      .split(/\s+/u)
      .filter((term) => term.length > 0),
    text,
  };
}

/**
 * Relevance of a row to a query, 0 for no match. Coarse on purpose: "this is
 * the one" (number / exact title), "the title says so", "every word appears
 * somewhere the row shows".
 */
export function scoreChangeRequestMatch(entry: SearchableChangeRequest, raw: string): number {
  const query = parseChangeRequestSearchQuery(raw);
  if (query.number !== null) return entry.number === query.number ? 100 : 0;
  if (query.terms.length === 0) return 1;
  const needle = query.terms.join(" ");
  const title = entry.title.toLowerCase();
  const head = entry.headRefName.toLowerCase();
  const author = entry.author?.toLowerCase() ?? "";
  const labels = (entry.labels ?? []).map((label) => label.name.toLowerCase());
  const haystack = [
    `#${entry.number}`,
    title,
    head,
    entry.baseRefName.toLowerCase(),
    author,
    ...labels,
  ];
  if (!query.terms.every((term) => haystack.some((field) => field.includes(term)))) return 0;
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  if (query.terms.every((term) => title.includes(term))) return 70;
  if (head.includes(needle)) return 60;
  if (author === needle || author.includes(needle)) return 50;
  if (labels.some((label) => label === needle)) return 40;
  return 20;
}

export function matchesChangeRequestQuery(entry: SearchableChangeRequest, query: string): boolean {
  return scoreChangeRequestMatch(entry, query) > 0;
}

/** Filters by query and orders by relevance, then merge readiness. */
export function searchChangeRequests<T extends SearchableChangeRequest & RankableChangeRequest>(
  list: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  if (query.trim().length === 0) return list;
  return list
    .map((entry) => ({ entry, score: scoreChangeRequestMatch(entry, query) }))
    .filter(({ score }) => score > 0)
    .toSorted(
      (left, right) => right.score - left.score || compareByMergeReadiness(left.entry, right.entry),
    )
    .map(({ entry }) => entry);
}
