// A task started from a pull request, issue or Jira item: the node makes the worktree and its
// thread first (`git.createWorktreeForProject`), then the task's first turn goes into that thread
// through the same launch as any other task.
import type { ThreadId } from "@ryco/contracts/base-schemas";

import type { NewTaskAttempt } from "./newTaskController";

/** The attempt for the thread the node made: its turn goes into that thread, in its worktree. */
export function newTaskSourceAttempt(base: NewTaskAttempt, threadId: ThreadId): NewTaskAttempt {
  return {
    ...base,
    ids: { ...base.ids, threadId },
    threadId,
    worktree: { kind: "local" },
    threadCommandAccepted: true,
    threadReady: true,
    worktreeAttached: true,
    // The node made the thread in full access and default modes: the chosen ones are written
    // to it before the first turn.
    threadSettingsPending: true,
  };
}

/**
 * Has the node make the worktree and its thread, then launches the task into it. The caller
 * builds `attempt` (its files' upload tokens included) before this runs, so a draft that cannot
 * start fails before the node makes anything. Whatever fails here, the worktree call or the
 * launch, reaches `onFailure`, never an unhandled rejection; a retry under the same thread id
 * finds what the node made. Resolves with the launched attempt, or null after `onFailure`.
 */
export async function startNewTaskFromSource(input: {
  readonly attempt: NewTaskAttempt;
  readonly createWorktree: () => Promise<{ readonly sessionId: ThreadId }>;
  readonly launch: (attempt: NewTaskAttempt) => void;
  readonly onFailure: (error: unknown) => void;
}): Promise<NewTaskAttempt | null> {
  try {
    const created = await input.createWorktree();
    const attempt = newTaskSourceAttempt(input.attempt, created.sessionId);
    input.launch(attempt);
    return attempt;
  } catch (error) {
    input.onFailure(error);
    return null;
  }
}
