import type {
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestReviewerState,
} from "@ryco/contracts";

/**
 * Reviewers and labels on the pull request screen: what each shows, and the
 * add/remove edit a picker sends (`updateChangeRequest` list edits).
 */

export interface PullRequestListEdit {
  readonly add: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}

/**
 * The title/description edit from what the sheet opened with to what it
 * holds now: only the fields the reader changed, so a field someone else
 * changed meanwhile is left as they made it. Null when nothing changed.
 */
export function pullRequestDetailsEdit(
  start: { readonly title: string; readonly body: string },
  now: { readonly title: string; readonly body: string },
): { readonly kind: "edit"; readonly title?: string; readonly body?: string } | null {
  const title = now.title.trim();
  const titleChanged = title !== start.title;
  const bodyChanged = now.body !== start.body;
  if (!titleChanged && !bodyChanged) return null;
  return {
    kind: "edit",
    ...(titleChanged ? { title } : {}),
    ...(bodyChanged ? { body: now.body } : {}),
  };
}

/** The edit that turns `current` into `chosen`; null when nothing changed. */
export function pullRequestListEdit(
  current: ReadonlyArray<string>,
  chosen: ReadonlyArray<string>,
): PullRequestListEdit | null {
  const before = new Set(current);
  const after = new Set(chosen);
  const add = [...after].filter((name) => !before.has(name)).toSorted();
  const remove = [...before].filter((name) => !after.has(name)).toSorted();
  return add.length === 0 && remove.length === 0 ? null : { add, remove };
}

export type PullRequestReviewerState = "approved" | "changes-requested" | "commented" | "pending";

export interface PullRequestReviewerRow {
  readonly login: string;
  readonly state: PullRequestReviewerState;
}

const REVIEWER_STATE: Readonly<
  Record<SourceControlChangeRequestReviewerState, PullRequestReviewerState>
> = {
  approved: "approved",
  changes_requested: "changes-requested",
  commented: "commented",
  dismissed: "pending",
  requested: "pending",
};

/**
 * Everyone asked or reviewing: the host's per-reviewer states, then requested
 * reviewers it lists without a state. Sorted by login.
 */
export function derivePullRequestReviewers(
  detail: Pick<SourceControlChangeRequestDetail, "reviewers" | "reviewerStates"> | null,
): ReadonlyArray<PullRequestReviewerRow> {
  if (detail === null) return [];
  const rows = new Map<string, PullRequestReviewerRow>();
  for (const reviewer of detail.reviewerStates ?? []) {
    rows.set(reviewer.login, { login: reviewer.login, state: REVIEWER_STATE[reviewer.state] });
  }
  for (const login of detail.reviewers ?? []) {
    if (!rows.has(login)) rows.set(login, { login, state: "pending" });
  }
  return [...rows.values()].toSorted((left, right) => left.login.localeCompare(right.login));
}

/** The requested reviewers a picker starts from: everyone not yet done reviewing. */
export function requestedReviewerLogins(
  detail: Pick<SourceControlChangeRequestDetail, "reviewers"> | null,
): ReadonlyArray<string> {
  return detail?.reviewers ?? [];
}
