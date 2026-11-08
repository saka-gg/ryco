import {
  refreshLocalTasks,
  selectLocalTasksEnvironment,
  selectTaskView,
  taskStartFailed,
  useLocalTasksStore,
} from "@ryco/client-runtime/state/tasks";
import { hasErrorTag } from "@ryco/client-runtime/rpc";
import type { EnvironmentId, LocalTaskDelegateInput } from "@ryco/contracts";

import { TaskChatStartError } from "./taskChatStartError";
import { whenTaskFilesSent } from "./taskFileUploads";
import { mobileLocalTaskWriter, retainMobileLocalTasks } from "./tasksRuntime";

/**
 * Starting a task's chat from the phone, the way the desktop's Start does: the
 * New Task sheet opens seeded with the task (its message, its project, a new
 * `task/<slug>` worktree or one from its linked branch), and its first turn
 * goes out as the task's (`server.delegateLocalTask`), so the machine records
 * the chat under the task and hands it the task's files.
 */

const readTask = (environmentId: EnvironmentId, taskId: string) =>
  selectTaskView(useLocalTasksStore.getState(), environmentId, taskId);

/**
 * The task a chat is about to start for, read first when this phone does not
 * have it: refused (sending nothing) when it is gone or done, so a send that
 * creates a thread or worktree first never leaves one behind for nothing.
 * The caller keeps the tasks retained meanwhile.
 */
async function requireStartableTask(environmentId: EnvironmentId, taskId: string): Promise<void> {
  if (!readTask(environmentId, taskId)) await refreshLocalTasks(environmentId);
  const task = readTask(environmentId, taskId);
  if (!task) {
    const read =
      selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId).readAt !== null;
    throw new TaskChatStartError(
      read
        ? "The task was deleted. Unlink it to start this as a plain chat."
        : "Couldn’t read the task. Check the connection and try again.",
      false,
    );
  }
  if (task.state === "done")
    throw new TaskChatStartError(
      "The task is done. Reopen it, or unlink it to start this as a plain chat.",
      false,
    );
}

/** Checks the task can take a chat before anything is sent for it. */
export async function preflightTaskChatStart(
  environmentId: EnvironmentId,
  taskId: string,
): Promise<void> {
  const release = retainMobileLocalTasks(environmentId);
  try {
    await requireStartableTask(environmentId, taskId);
  } finally {
    release();
  }
}

/**
 * The node refused the start (its typed answer), or this phone could not send
 * it: nothing was recorded, so a retry goes out as a new start, and the reason
 * is shown as it came. Anything else may have reached the node.
 */
function definiteStartRefusal(cause: unknown): TaskChatStartError | null {
  if (!hasErrorTag(cause, "LocalTaskError") && !hasErrorTag(cause, "LocalTasksUnsupportedError"))
    return null;
  const message = cause instanceof Error && cause.message ? cause.message : null;
  return new TaskChatStartError(message ?? "The machine refused to start the chat.", false);
}

async function sendTaskStart(
  environmentId: EnvironmentId,
  taskId: string,
  command: LocalTaskDelegateInput["command"],
) {
  try {
    return await mobileLocalTaskWriter(environmentId).delegate(taskId, command, {
      branch: command.bootstrap?.prepareWorktree?.branch ?? null,
    });
  } catch (cause) {
    throw definiteStartRefusal(cause) ?? cause;
  }
}

/**
 * Sends a task chat's first turn as the task's, with the machine's tasks kept
 * read meanwhile (reading them first when this phone does not have the task).
 * Waits for the task's files still uploading.
 */
export async function delegateTaskChatStart(
  environmentId: EnvironmentId,
  taskId: string,
  command: LocalTaskDelegateInput["command"],
): Promise<void> {
  const release = retainMobileLocalTasks(environmentId);
  try {
    await requireStartableTask(environmentId, taskId);
    await whenTaskFilesSent(taskId);
    const result = await sendTaskStart(environmentId, taskId, command);
    // The machine answers a start it recorded as failed with the task; its word decides.
    if (taskStartFailed(result, command.commandId)) {
      const start = result.delegations.find(
        (delegation) => delegation.commandId === command.commandId,
      );
      throw new TaskChatStartError(start?.error ?? "The machine didn’t start the chat.", true);
    }
  } finally {
    release();
  }
}
