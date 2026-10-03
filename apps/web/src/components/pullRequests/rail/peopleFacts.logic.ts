import type {
  SourceControlChangeRequestReviewer,
  SourceControlChangeRequestReviewerState,
} from "@ryco/contracts";

/**
 * Pure helpers for the reviewers / assignees / labels fields: the rows they
 * show and the single `{ add, remove }` edit a picker applies when it closes.
 */

export interface ListEdit {
  readonly add: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}

/**
 * The edit that turns `before` into `after`. Order follows `after` for adds
 * and `before` for removes; duplicates collapse. Null when nothing changed, so
 * closing an untouched picker sends no request.
 */
export function diffPickerSelection(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ListEdit | null {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const add = [...afterSet].filter((value) => !beforeSet.has(value));
  const remove = [...beforeSet].filter((value) => !afterSet.has(value));
  return add.length === 0 && remove.length === 0 ? null : { add, remove };
}

export interface ReviewerRow {
  readonly login: string;
  readonly kind: SourceControlChangeRequestReviewer["kind"];
  readonly state: SourceControlChangeRequestReviewerState;
  readonly avatarUrl: string | undefined;
  readonly isCodeOwner: boolean;
  /** Already reviewed, so a review can be requested again. */
  readonly canRerequest: boolean;
}

const REVIEWER_STATE_RANK: Record<SourceControlChangeRequestReviewerState, number> = {
  changes_requested: 0,
  approved: 1,
  commented: 2,
  requested: 3,
  dismissed: 4,
};

/**
 * Reviewer rows from the host's per-reviewer states, falling back to the plain
 * requested-reviewer list on hosts that only report logins. Verdicts first,
 * then pending requests; teams after people within a state.
 */
export function reviewerRows(input: {
  readonly reviewerStates: ReadonlyArray<SourceControlChangeRequestReviewer> | undefined;
  readonly reviewers: ReadonlyArray<string> | undefined;
}): ReadonlyArray<ReviewerRow> {
  const states: ReadonlyArray<SourceControlChangeRequestReviewer> =
    input.reviewerStates && input.reviewerStates.length > 0
      ? input.reviewerStates
      : (input.reviewers ?? []).map((login) => ({
          login,
          kind: login.includes("/") ? ("team" as const) : ("user" as const),
          state: "requested" as const,
        }));
  return states
    .map((reviewer, index) => ({ reviewer, index }))
    .toSorted(
      (left, right) =>
        REVIEWER_STATE_RANK[left.reviewer.state] - REVIEWER_STATE_RANK[right.reviewer.state] ||
        Number(left.reviewer.kind === "team") - Number(right.reviewer.kind === "team") ||
        left.index - right.index,
    )
    .map(({ reviewer }) => ({
      login: reviewer.login,
      kind: reviewer.kind,
      state: reviewer.state,
      avatarUrl: reviewer.avatarUrl,
      isCodeOwner: reviewer.isCodeOwner === true,
      canRerequest: reviewer.state !== "requested" && reviewer.kind !== "team",
    }));
}

export const REVIEWER_STATE_LABEL: Record<SourceControlChangeRequestReviewerState, string> = {
  approved: "Approved",
  changes_requested: "Requested changes",
  commented: "Commented",
  dismissed: "Review dismissed",
  requested: "Review requested",
};

/**
 * Picker candidates: everyone the host offers plus whoever is already
 * selected (teams and people outside the candidate list stay removable),
 * minus `exclude` (the author cannot review their own pull request).
 */
export function pickerCandidates(input: {
  readonly offered: ReadonlyArray<string>;
  readonly selected: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const exclude = new Set(input.exclude ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...input.selected, ...input.offered]) {
    if (seen.has(value) || (exclude.has(value) && !input.selected.includes(value))) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Case-insensitive substring filter that keeps selected values pinned to the top. */
export function filterPickerCandidates(
  candidates: ReadonlyArray<string>,
  selected: ReadonlyArray<string>,
  query: string,
  describe: (value: string) => string = (value) => value,
): ReadonlyArray<string> {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? candidates.filter(
        (value) =>
          value.toLowerCase().includes(needle) || describe(value).toLowerCase().includes(needle),
      )
    : candidates;
  const selectedSet = new Set(selected);
  return [
    ...matches.filter((value) => selectedSet.has(value)),
    ...matches.filter((value) => !selectedSet.has(value)),
  ];
}
