import type { SourceControlLabel } from "@ryco/contracts";

/**
 * The pull request list's filters (state, "only", labels, sort) as menu
 * options and as the chips shown while any of them is off its default, for
 * every client's list. Defaults stay unset (out of the web URL), so "not set"
 * and "default" are the same thing here.
 */

export type PullRequestsStateFilter = "open" | "closed" | "merged" | "all";
/** Quick narrowing of the list: review requested from you, failing checks, or authored by you. */
export type PullRequestsOnlyFilter = "review" | "failing" | "mine";
export type PullRequestsSort = "readiness" | "updated";

/** The list-shaping part of a client's pull request page state (the web keeps it in the URL). */
export interface PullRequestListFilters {
  readonly state?: PullRequestsStateFilter | undefined;
  readonly q?: string | undefined;
  readonly only?: PullRequestsOnlyFilter | undefined;
  readonly label?: readonly string[] | undefined;
  readonly sort?: PullRequestsSort | undefined;
}

export function resolvePullRequestsStateFilter(
  filters: Pick<PullRequestListFilters, "state">,
): PullRequestsStateFilter {
  return filters.state ?? "open";
}

export function resolvePullRequestsSort(
  filters: Pick<PullRequestListFilters, "sort">,
): PullRequestsSort {
  return filters.sort ?? "readiness";
}

export const PULL_REQUEST_STATE_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestsStateFilter;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export const PULL_REQUEST_ONLY_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestsOnlyFilter;
  readonly label: string;
  /** Needs the host's involvement reads (review requested / authored). */
  readonly needsInvolvement: boolean;
  /** Needs check rollups on list rows (`capabilities.listCheckRollup`). */
  readonly needsCheckRollup: boolean;
}> = [
  { value: "review", label: "Review requested", needsInvolvement: true, needsCheckRollup: false },
  { value: "mine", label: "Yours", needsInvolvement: true, needsCheckRollup: false },
  { value: "failing", label: "Failing checks", needsInvolvement: false, needsCheckRollup: true },
];

/** The "only" filters this list can apply (the others would always come up empty). */
export function availablePullRequestOnlyOptions(input: {
  readonly involvementSupported: boolean;
  readonly checkRollup: boolean;
}): typeof PULL_REQUEST_ONLY_OPTIONS {
  return PULL_REQUEST_ONLY_OPTIONS.filter(
    (option) =>
      (!option.needsInvolvement || input.involvementSupported) &&
      (!option.needsCheckRollup || input.checkRollup),
  );
}

export const PULL_REQUEST_SORT_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestsSort;
  readonly label: string;
}> = [
  { value: "readiness", label: "Readiness" },
  { value: "updated", label: "Recently updated" },
];

/** Patch that puts every list filter back to its default. */
export const PULL_REQUEST_FILTER_RESET: Partial<PullRequestListFilters> = {
  state: undefined,
  only: undefined,
  label: undefined,
  sort: undefined,
};

export interface PullRequestFilterChip {
  readonly key: string;
  readonly label: string;
  /** Label colour (hex without `#`), for label chips. */
  readonly color?: string | undefined;
  /** Patch that removes just this filter. */
  readonly clear: Partial<PullRequestListFilters>;
}

export function pullRequestFilterChips(
  search: Pick<PullRequestListFilters, "state" | "only" | "label" | "sort">,
  labels: ReadonlyArray<SourceControlLabel> = [],
): ReadonlyArray<PullRequestFilterChip> {
  const chips: PullRequestFilterChip[] = [];
  if (search.state !== undefined && search.state !== "open") {
    const option = PULL_REQUEST_STATE_OPTIONS.find((entry) => entry.value === search.state);
    chips.push({
      key: "state",
      label: search.state === "all" ? "All states" : (option?.label ?? search.state),
      clear: { state: undefined },
    });
  }
  if (search.only !== undefined) {
    const option = PULL_REQUEST_ONLY_OPTIONS.find((entry) => entry.value === search.only);
    chips.push({ key: "only", label: option?.label ?? search.only, clear: { only: undefined } });
  }
  const selected = search.label ?? [];
  for (const name of selected) {
    const rest = selected.filter((other) => other !== name);
    chips.push({
      key: `label:${name}`,
      label: name,
      color: labels.find((label) => label.name === name)?.color,
      clear: { label: rest.length > 0 ? rest : undefined },
    });
  }
  if (search.sort !== undefined && search.sort !== "readiness") {
    chips.push({ key: "sort", label: "Recently updated", clear: { sort: undefined } });
  }
  return chips;
}

/** Toggles one label in the URL's sorted label list. */
export function togglePullRequestLabelFilter(
  current: ReadonlyArray<string> | undefined,
  name: string,
): ReadonlyArray<string> | undefined {
  const next = new Set(current ?? []);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next.size > 0 ? [...next].toSorted() : undefined;
}
