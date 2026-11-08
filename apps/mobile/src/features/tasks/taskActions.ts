import { StackActions, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import type { LocalTaskPatch } from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { Alert } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import type { TaskCaptureInput } from "./TaskCaptureSheet";
import { mobileLocalTaskWriter } from "./tasksRuntime";
import { offerTaskUndo } from "./taskUndo";

// What the Tasks list and the task sheet do to a task, through the machine's
// one writer: each change shows at once and is rolled back if the node refuses.

type Navigation = Pick<NavigationProp<ParamListBase>, "navigate" | "dispatch">;

/** A task id the node accepts (`LocalTaskId`: letters, digits, `-` and `_`). */
export function newLocalTaskId(): string {
  return uuidv4();
}

export function addTasks(
  environmentId: EnvironmentId,
  inputs: ReadonlyArray<TaskCaptureInput>,
): ReadonlyArray<string> {
  const writer = mobileLocalTaskWriter(environmentId);
  return inputs.map((input) => {
    const taskId = newLocalTaskId();
    void writer.create({
      taskId,
      title: input.title,
      notes: "",
      priority: input.priority,
      dueAt: input.dueAt,
      projectId: input.projectId,
    });
    return taskId;
  });
}

export function updateTask(environmentId: EnvironmentId, taskId: string, patch: LocalTaskPatch) {
  mobileLocalTaskWriter(environmentId).update(taskId, patch);
}

/** Checks a task off (or reopens it) and offers Undo. */
export function setTaskDone(
  environmentId: EnvironmentId,
  task: { readonly taskId: string; readonly title: string },
  done: boolean,
): void {
  updateTask(environmentId, task.taskId, { state: done ? "done" : "todo" });
  offerTaskUndo(done ? `Completed “${task.title}”` : `Reopened “${task.title}”`, () =>
    updateTask(environmentId, task.taskId, { state: done ? "todo" : "done" }),
  );
}

/** Moves the due day and offers Undo. */
export function setTaskDue(
  environmentId: EnvironmentId,
  task: { readonly taskId: string; readonly title: string; readonly dueAt: string | null },
  dueAt: string | null,
): void {
  if (dueAt === task.dueAt) return;
  const previous = task.dueAt;
  updateTask(environmentId, task.taskId, { dueAt });
  offerTaskUndo(dueAt === null ? "Due date removed" : "Due date changed", () =>
    updateTask(environmentId, task.taskId, { dueAt: previous }),
  );
}

/**
 * Asks before deleting: the task, its notes and files go for good (its chats
 * stay). Resolves whether it was deleted.
 */
export function confirmDeleteTask(
  environmentId: EnvironmentId,
  task: { readonly taskId: string; readonly title: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Delete this task?",
      `“${task.title}” and its notes and files are deleted from the machine. Its chats stay.`,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void mobileLocalTaskWriter(environmentId).remove(task.taskId);
            resolve(true);
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function openTaskChat(
  navigation: Navigation,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  navigation.navigate("Thread", { environmentId, threadId });
}

/**
 * Starts one more chat for the task, like the desktop's Start: the New Task
 * sheet opens with the task as its message (title, notes, links) in the
 * task's project, and sending it starts the chat as the task's, so the node
 * records it there and hands it the task's files.
 */
export function startTaskChat(
  navigation: Navigation,
  environmentId: EnvironmentId,
  task: { readonly taskId: string; readonly projectId: ProjectId | null },
  options?: { readonly replace?: boolean },
): void {
  const params = {
    environmentId,
    localTaskId: task.taskId,
    ...(task.projectId === null ? {} : { projectId: task.projectId }),
  };
  if (options?.replace) navigation.dispatch(StackActions.replace("NewTask", params));
  else navigation.navigate("NewTask", params);
}

export function openTaskDetail(
  navigation: Navigation,
  environmentId: EnvironmentId,
  taskId: string,
): void {
  navigation.navigate("TaskDetail", { environmentId, taskId });
}
