import {
  buildTaskStartPrompt,
  taskDraftPlacement,
  type LocalTaskView,
} from "@ryco/client-runtime/state/tasks";
import type { ProjectId, ThreadId } from "@ryco/contracts";

/** What the New Task sheet opens with for a task. */
export interface TaskChatSeed {
  readonly taskId: string;
  readonly title: string;
  readonly projectId: ProjectId | null;
  readonly prompt: string;
  /** The new worktree's branch. */
  readonly branch: string;
  /** The branch it starts from; empty for the project's current one. */
  readonly baseBranch: string;
}

/** The phone sends a turn that creates its worktree from a branch; no PR or issue worktrees. */
export function taskChatSeed(
  task: Pick<
    LocalTaskView,
    "taskId" | "title" | "notes" | "links" | "projectId" | "delegations" | "optimisticStarts"
  >,
  describeThread: (threadId: ThreadId) => string | null,
): TaskChatSeed {
  const startBranches = [...task.delegations, ...task.optimisticStarts].flatMap((start) =>
    start.branch ? [start.branch] : [],
  );
  const placement = taskDraftPlacement({
    title: task.title,
    links: task.links,
    projectRepository: null,
    startBranches,
    sourceWorktrees: false,
  });
  return {
    taskId: task.taskId,
    title: task.title,
    projectId: task.projectId,
    prompt: buildTaskStartPrompt({
      title: task.title,
      notes: task.notes,
      links: task.links,
      describeThread,
    }),
    branch: placement.worktreeBranchName ?? "",
    baseBranch: placement.baseBranch ?? "",
  };
}
