import { selectTaskView, useLocalTasksStore } from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useMemo } from "react";

import { selectEnvironmentState, useStore } from "../../state/threadsRuntime";
import { taskChatSeed, type TaskChatSeed } from "./taskChatSeedModel";
import { useRetainLocalTasks } from "./useMachineTasks";

/** The task a New Task draft starts a chat for, as the draft keeps it. */
export interface NewTaskTaskLink {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly title: string;
  /** The task's project; null when the chat's project becomes the task's. */
  readonly projectId: ProjectId | null;
}

/**
 * What a New Task draft opened for a task starts with (`taskChatSeed`), once
 * the machine's tasks are read; null without a task, or while it is unknown.
 */
export function useTaskChatSeed(
  environmentId: EnvironmentId | null,
  taskId: string | null,
): TaskChatSeed | null {
  const active = environmentId !== null && taskId !== null;
  useRetainLocalTasks(active ? [environmentId] : []);
  const task = useLocalTasksStore((state) =>
    active ? selectTaskView(state, environmentId, taskId) : undefined,
  );
  const summaries = useStore((state) =>
    active ? selectEnvironmentState(state, environmentId).sidebarThreadSummaryById : null,
  );
  return useMemo(
    () =>
      task === undefined
        ? null
        : taskChatSeed(task, (threadId) => summaries?.[threadId]?.title ?? null),
    [summaries, task],
  );
}

/**
 * Whether moving the draft keeps it the task's chat: the task lives on its
 * machine, and a task with a project starts its chats only there.
 */
export function keepsTaskLink(
  link: NewTaskTaskLink,
  target: { readonly environmentId: EnvironmentId | null; readonly projectId: ProjectId | null },
): boolean {
  return (
    target.environmentId === link.environmentId &&
    (link.projectId === null || target.projectId === link.projectId)
  );
}
