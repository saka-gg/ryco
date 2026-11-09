import type { VcsListRefsInput, VcsListRefsResult } from "@ryco/contracts";

import { taskBranchSlug } from "./logic.ts";
import { localRefNames, taskWorktreeBranch } from "./placement.ts";

/** How long the check for branches a task's name already has may take. */
export const TASK_REF_READ_TIMEOUT_MS = 5_000;

export interface TaskRefReader {
  readonly listRefs: (input: VcsListRefsInput) => Promise<VcsListRefsResult>;
}

/**
 * The branches in `cwd` that already carry the task's slug; none when the
 * check fails or takes too long (the node then refuses a clash itself).
 */
export function readTaskRefNames(
  vcs: TaskRefReader,
  cwd: string,
  title: string,
  timeoutMs: number = TASK_REF_READ_TIMEOUT_MS,
): Promise<string[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), timeoutMs);
    const settle = (names: string[]) => {
      clearTimeout(timer);
      resolve(names);
    };
    try {
      vcs.listRefs({ cwd, query: `task/${taskBranchSlug(title)}`, limit: 100 }).then(
        (result) => settle(localRefNames(result.refs)),
        () => settle([]),
      );
    } catch {
      settle([]);
    }
  });
}

/**
 * The branch a task's next worktree gets in `cwd` (`taskWorktreeBranch`),
 * moved past the branches that exist there already.
 */
export async function nextFreeTaskBranch(
  vcs: TaskRefReader,
  input: {
    readonly cwd: string;
    readonly title: string;
    readonly startBranches: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  },
): Promise<string> {
  const existingRefNames = await readTaskRefNames(vcs, input.cwd, input.title, input.timeoutMs);
  return taskWorktreeBranch({
    title: input.title,
    startBranches: input.startBranches,
    existingRefNames,
  });
}
