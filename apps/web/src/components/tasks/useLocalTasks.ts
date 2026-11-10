import {
  createLocalTaskWriter,
  LOCAL_TASKS_FOCUS_REFRESH_MS,
  LOCAL_TASK_WRITE_FAILED_FALLBACK,
  localTaskErrorMessage,
  localTaskThreadSummaryReader,
  localTaskWriteFailureTitle,
  retainConnectedLocalTasks,
  type LocalTaskThreadSummaryReader,
  type LocalTaskWriter,
  type LocalTasksConnections,
  type LocalTasksRefreshTriggers,
} from "@ryco/client-runtime/state/tasks";
import type { AppState } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import { useEffect } from "react";

import { readEnvironmentApi, readEnvironmentApiForConnection } from "~/environmentApi";
import { readEnvironmentConnection, subscribeEnvironmentConnections } from "~/environments/runtime";
import { useStore } from "~/store";

import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * The data side of the Tasks page and the sidebar badge: one environment's
 * tasks kept live in `useLocalTasksStore` (client-runtime `state/tasks`)
 * while anything shows them, and the one writer every change goes through.
 */

/** The window regaining focus re-reads the tasks, at most once per 15 s. */
const refreshOnWindowFocus: LocalTasksRefreshTriggers = (refresh) => {
  const onFocus = () => refresh({ staleAfterMs: LOCAL_TASKS_FOCUS_REFRESH_MS });
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
};

/** A thread of the tasks' environment as the task rules read it; archived stubs read as unknown. */
export function taskThreadSummaryReader(
  state: AppState,
  environmentId: EnvironmentId,
): LocalTaskThreadSummaryReader {
  return localTaskThreadSummaryReader(state, environmentId);
}

const connections: LocalTasksConnections = {
  read: readEnvironmentConnection,
  subscribe: subscribeEnvironmentConnections,
  readApi: (environmentId, client) =>
    readEnvironmentApiForConnection(environmentId, client)?.server,
};

/**
 * Keeps `environmentId`'s tasks retained until the returned release is
 * called (`retainConnectedLocalTasks`): bound to the environment's current
 * connection, re-read when it comes back and when the window regains focus.
 */
export function retainLocalTasksFor(environmentId: EnvironmentId): () => void {
  // The Desktop paints the machine's saved list until its first read lands.
  if (window.desktopBridge?.getDesktopTaskList) {
    void import("~/platform/desktopTaskListCache")
      .then((cache) => {
        cache.installDesktopTaskListCache();
        return cache.hydrateDesktopTaskList(environmentId);
      })
      .catch(() => undefined);
  }
  return retainConnectedLocalTasks(environmentId, {
    connections,
    threads: useStore,
    triggers: refreshOnWindowFocus,
  });
}

/** Keeps `environmentId`'s tasks retained while mounted and `enabled` (`retainLocalTasksFor`). */
export function useLocalTasksSync(environmentId: EnvironmentId | null, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !environmentId) return;
    return retainLocalTasksFor(environmentId);
  }, [enabled, environmentId]);
}

const writers = new Map<EnvironmentId, LocalTaskWriter>();

/**
 * The environment's one task writer, shared by every surface so a task's
 * saves queue behind each other. It sends on the current connection (looked
 * up per write), and each failure, already rolled back, becomes a toast.
 */
export function localTaskWriterFor(environmentId: EnvironmentId): LocalTaskWriter {
  let writer = writers.get(environmentId);
  if (!writer) {
    writer = createLocalTaskWriter({
      api: () => readEnvironmentApi(environmentId)?.server,
      environmentId,
      onError: (cause, operation) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: localTaskWriteFailureTitle(operation),
            description: localTaskErrorMessage(cause, LOCAL_TASK_WRITE_FAILED_FALLBACK),
          }),
        ),
    });
    writers.set(environmentId, writer);
  }
  return writer;
}
