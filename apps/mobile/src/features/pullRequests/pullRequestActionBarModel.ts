import type { PullRequestActions } from "./pullRequestActionsModel";

export interface PullRequestMergeMenuItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly checked: boolean;
  readonly disabled: boolean;
}

export interface PullRequestActionBarModel {
  readonly review: boolean;
  /** A one-tap approve: the host takes approvals and the viewer may give one. */
  readonly approve: boolean;
  readonly merge: {
    readonly label: string;
    /** The method choice and Update branch; empty when there is nothing to pick. */
    readonly menu: ReadonlyArray<PullRequestMergeMenuItem>;
  } | null;
}

/**
 * What the bottom bar offers, from the actions the shared rules allow. Null
 * when nothing applies (a merged or closed pull request, a viewer role).
 * Update branch without a merge action shows as the bar's merge-side button.
 */
export function pullRequestActionBarModel(
  actions: Pick<PullRequestActions, "review" | "merge" | "updateBranch">,
): PullRequestActionBarModel | null {
  const review = actions.review !== null;
  const approve =
    actions.review?.options.some((option) => option.event === "approve" && !option.disabled) ===
    true;
  const menu: PullRequestMergeMenuItem[] = [];
  if (actions.merge?.methods) {
    for (const option of actions.merge.methods) {
      menu.push({
        id: `method:${option.method}`,
        title: option.label,
        ...(option.disabledReason ? { subtitle: option.disabledReason } : {}),
        checked: option.method === actions.merge.method,
        disabled: option.disabledReason !== null,
      });
    }
  }
  if (actions.updateBranch && actions.merge) {
    menu.push({
      id: "update-branch",
      title: actions.updateBranch.method === "rebase" ? "Rebase branch" : "Update branch",
      checked: false,
      disabled: false,
    });
  }
  const merge = actions.merge
    ? { label: actions.merge.label, menu }
    : actions.updateBranch
      ? {
          label: actions.updateBranch.method === "rebase" ? "Rebase branch" : "Update branch",
          menu: [],
        }
      : null;
  if (!review && merge === null) return null;
  return { review, approve, merge };
}
