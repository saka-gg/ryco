import { Data, Effect } from "effect";
import type { ProjectId } from "@ryco/contracts";

import type { GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import { worktreeIdentity } from "../orchestration/cwdRelocation.ts";

export class CheckoutRecreationError extends Data.TaggedError("CheckoutRecreationError")<{
  /** `branch-missing`: the branch was deleted; `unexpected-result`: Git checked out something else. */
  readonly reason: "branch-missing" | "unexpected-result";
  readonly detail: string;
}> {}

/**
 * The one way Ryco checks a recorded checkout out again at its recorded path: Restore and
 * Recreate checkout (the workspace lifecycle, also for approved Agent Control plans) and a
 * turn start that finds its checkout missing (the provider command reactor).
 *
 * The branch must still exist locally: given a branch name it does not find, `git worktree
 * add` would create a new branch from a same-named remote branch instead. A Git registration
 * of exactly this missing path, which storage cleanup keeps and a directory deleted outside
 * Ryco leaves too, is replaced by the add itself. Nothing prunes the repository's other
 * registrations: an interrupted storage cleanup keeps its quarantine's Git metadata, and
 * storage admission still refuses a path whose cleanup is pending.
 *
 * Both callers load this module with `import()` when they recreate a checkout, which keeps it
 * off the server's boot path (`serverBundleBoundaries.test.ts`).
 */
export const recreateRecordedCheckout = Effect.fn("recreateRecordedCheckout")(function* (
  git: Pick<GitWorkflowServiceShape, "listLocalBranchNames" | "createWorktree">,
  input: {
    readonly projectId: ProjectId;
    readonly repositoryRoot: string;
    readonly path: string;
    readonly branch: string;
  },
) {
  const branches = yield* git.listLocalBranchNames(input.repositoryRoot);
  if (!branches.includes(input.branch))
    return yield* new CheckoutRecreationError({
      reason: "branch-missing",
      detail: `Branch ${input.branch} no longer exists.`,
    });
  const created = yield* git.createWorktree({
    projectId: input.projectId,
    cwd: input.repositoryRoot,
    path: input.path,
    refName: input.branch,
    dependencyHydration: "none",
    replaceMissingRegistration: true,
  });
  if (
    worktreeIdentity(created.worktree.path) !== worktreeIdentity(input.path) ||
    created.worktree.refName !== input.branch
  )
    return yield* new CheckoutRecreationError({
      reason: "unexpected-result",
      detail: `Git returned unexpected metadata for ${input.path} and branch ${input.branch}.`,
    });
  return created;
});
