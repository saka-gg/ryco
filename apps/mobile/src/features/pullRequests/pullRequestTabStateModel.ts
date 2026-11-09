import type {
  PullRequestsSort,
  PullRequestsStateFilter,
} from "@ryco/client-runtime/state/pull-request-review";

import type { PullRequestsSegment, PullRequestTabFilters } from "./pullRequestListModel";

/**
 * What the PRs tab remembers on this device: the repository last picked and
 * the segment and filters last used. Display preferences only; no pull
 * request content.
 */
export interface PullRequestTabState {
  readonly repositoryKey: string | null;
  readonly filters: Omit<PullRequestTabFilters, "q">;
}

export const PULL_REQUEST_TAB_STATE_KEY = "ryco.pullRequests.tab.v1";

export const DEFAULT_PULL_REQUEST_TAB_STATE: PullRequestTabState = {
  repositoryKey: null,
  filters: { segment: "all" },
};

const SEGMENTS: ReadonlySet<string> = new Set<PullRequestsSegment>(["mine", "review", "all"]);
const STATES: ReadonlySet<string> = new Set<PullRequestsStateFilter>([
  "open",
  "merged",
  "closed",
  "all",
]);
const SORTS: ReadonlySet<string> = new Set<PullRequestsSort>(["readiness", "updated"]);
const MAX_LABELS = 20;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The saved state, keeping only fields it understands. */
export function sanitizePullRequestTabState(parsed: unknown): PullRequestTabState {
  const root = record(parsed);
  if (root === null) return DEFAULT_PULL_REQUEST_TAB_STATE;
  const filters = record(root.filters) ?? {};
  const segment =
    typeof filters.segment === "string" && SEGMENTS.has(filters.segment)
      ? (filters.segment as PullRequestsSegment)
      : "all";
  const state =
    typeof filters.state === "string" && STATES.has(filters.state)
      ? (filters.state as PullRequestsStateFilter)
      : undefined;
  const sort =
    typeof filters.sort === "string" && SORTS.has(filters.sort)
      ? (filters.sort as PullRequestsSort)
      : undefined;
  const label = Array.isArray(filters.label)
    ? filters.label
        .filter((name): name is string => typeof name === "string" && name.length > 0)
        .slice(0, MAX_LABELS)
    : [];
  return {
    repositoryKey:
      typeof root.repositoryKey === "string" && root.repositoryKey.length > 0
        ? root.repositoryKey
        : null,
    filters: {
      segment,
      ...(state !== undefined ? { state } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(label.length > 0 ? { label } : {}),
      ...(filters.failingOnly === true ? { failingOnly: true } : {}),
      ...(filters.hideDrafts === true ? { hideDrafts: true } : {}),
    },
  };
}

/** Labels belong to one repository: switching repositories drops them. */
export function selectPullRequestRepository(
  state: PullRequestTabState,
  repositoryKey: string,
): PullRequestTabState {
  if (state.repositoryKey === repositoryKey) return state;
  const { label: _label, ...filters } = state.filters;
  return { repositoryKey, filters };
}
