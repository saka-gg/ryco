import type { EnvironmentId, LocalTaskLink, ProjectId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

/**
 * Asks the app's one capture sheet (`TaskCaptureHost`, mounted at the app's
 * root) to open: from the Tasks tab's +, from a chat ("New task" linked to
 * it) or from a pull request (linked to it).
 */
export interface TaskCaptureRequest {
  /** The machine the task should go to (a chat's, a pull request's); else the last used. */
  readonly environmentId?: EnvironmentId | null;
  /** The project it should go to; else the list's filter or the last used one. */
  readonly projectId?: ProjectId | null;
  /** A link the new task starts with. */
  readonly link?: LocalTaskLink | null;
  /** How that link reads: the chat's title, "#1138 Fix the queue". */
  readonly linkLabel?: string | null;
  /** Opens the new task's sheet ("Details"); the opener's navigation does it. */
  readonly openDetails: (environmentId: EnvironmentId, taskId: string) => void;
}

let request: TaskCaptureRequest | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openTaskCapture(next: TaskCaptureRequest): void {
  request = next;
  generation += 1;
  emit();
}

export function closeTaskCapture(): void {
  if (request === null) return;
  request = null;
  emit();
}

const snapshot = () => request;
const generationSnapshot = () => generation;

export function useTaskCaptureRequest(): TaskCaptureRequest | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Changes on every open, so the sheet starts fresh even when reopened with the same request. */
export function useTaskCaptureGeneration(): number {
  return useSyncExternalStore(subscribe, generationSnapshot, generationSnapshot);
}
