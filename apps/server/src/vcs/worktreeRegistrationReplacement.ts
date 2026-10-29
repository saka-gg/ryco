/**
 * Whether recreating a recorded checkout may replace Git's registration of its missing path.
 * `GitVcsDriverCore.createWorktree` loads this only when it recreates a recorded checkout
 * (`replaceMissingRegistration`), and the checkout inspection only for a missing checkout Git
 * still registers, which keeps it off the server's boot path.
 */

/** One record of `git worktree list --porcelain -z`: its canonical path and its fields. */
export interface WorktreeRegistration {
  readonly path: string;
  readonly fields: readonly string[];
}

export interface MissingRegistrationReplacement {
  /** Git registers the missing `worktreePath`: the add must replace that entry (`--force`). */
  readonly registered: boolean;
  /** Why nothing may change, or null when the add may go ahead. */
  readonly refusal: string | null;
}

/**
 * Refuses, before anything changes, when another worktree has `branch` checked out (Git
 * refuses that add, and `--force` would check the branch out twice), or when replacing the
 * registration of `worktreePath` could lose work: it is locked, or has no branch (a detached
 * HEAD may be the only reference to its commit). The hints name only that one path: a
 * repository-wide prune would also drop the registration an interrupted storage cleanup's
 * quarantine still needs.
 *
 * `--force` also skips Git's check that another worktree is rebasing or bisecting `branch`,
 * which the listing cannot show. While the registration at `worktreePath` holds `branch` (the
 * case storage cleanup leaves), Git refuses to start either elsewhere; only a registration on
 * another branch (the checkout had switched branches) leaves that gap open.
 */
export function missingRegistrationReplacement(
  registrations: readonly WorktreeRegistration[],
  worktreePath: string,
  branch: string,
): MissingRegistrationReplacement {
  const stale = registrations.find((registration) => registration.path === worktreePath);
  const registered = stale !== undefined;
  const elsewhere = registrations.find(
    (registration) =>
      registration !== stale && registration.fields.includes(`branch refs/heads/${branch}`),
  );
  if (elsewhere)
    return {
      registered,
      refusal: elsewhere.fields.some((field) => field.startsWith("prunable"))
        ? `Branch ${branch} is still checked out at ${elsewhere.path}, which is missing.`
        : `Branch ${branch} is checked out at ${elsewhere.path}.`,
    };
  return {
    registered,
    refusal: stale ? staleRegistrationRefusal(stale.fields, worktreePath) : null,
  };
}

/**
 * Why Git's registration of the missing checkout `worktreePath` (its porcelain `fields`) may
 * not be replaced, or null: it is locked, or has no branch. The workspace lifecycle's review
 * applies it too (`checkoutInspection.ts`), so a reviewed Restore or Recreate checkout does not
 * fail here.
 */
export function staleRegistrationRefusal(
  fields: readonly string[],
  worktreePath: string,
): string | null {
  if (fields.some((field) => field === "locked" || field.startsWith("locked ")))
    return `Git has locked the missing checkout at ${worktreePath}. Unlock it with \`git worktree unlock\`, then retry.`;
  if (!fields.some((field) => field.startsWith("branch refs/heads/")))
    return `Git registers the missing checkout at ${worktreePath} on a detached commit. Keep that commit if you need it, run \`git worktree remove ${worktreePath}\` in the project, then retry.`;
  return null;
}
