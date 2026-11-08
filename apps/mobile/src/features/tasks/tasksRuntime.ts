import { createEnvironmentApi } from "@ryco/client-runtime/connection";
import {
  createLocalTaskWriter,
  LOCAL_TASK_WRITE_FAILED_FALLBACK,
  LOCAL_TASKS_FOCUS_REFRESH_MS,
  localTaskErrorMessage,
  localTaskWriteFailureTitle,
  retainConnectedLocalTasks,
  type LocalTaskWriter,
  type LocalTasksConnections,
  type LocalTasksRefreshTriggers,
} from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId } from "@ryco/contracts";
import { Alert } from "react-native";

import { subscribeAppStateResume } from "../../connection/appStateResume";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { useStore } from "../../state/threadsRuntime";
import { hydrateTaskCache, installTaskCache } from "./taskCache";

/**
 * The phone's side of a node's tasks: the shared task sync
 * (`retainConnectedLocalTasks`, the same the web Tasks page uses) bound to
 * the phone's connection supervisor and thread store, and one task writer per
 * machine. Tasks live in memory only (`useLocalTasksStore`): titles, notes and
 * links are the node's content; the only copy on the device is the offline
 * one `taskCache.ts` keeps under the "keep recent conversations" setting.
 */

/** Coming back to the foreground re-reads the tasks, at most once per 15 s. */
const refreshOnForeground: LocalTasksRefreshTriggers = (refresh) =>
  subscribeAppStateResume(() => refresh({ staleAfterMs: LOCAL_TASKS_FOCUS_REFRESH_MS }));

let connections: LocalTasksConnections | null = null;

// Built on first use: the registry's driver imports modules that import this one.
function mobileConnections(): LocalTasksConnections {
  if (connections) return connections;
  const supervisor = createMobileConnectionRegistry().driver.supervisor;
  connections = {
    read: (environmentId) => supervisor.read(environmentId),
    subscribe: (listener) => supervisor.subscribe(listener),
    readApi: (_environmentId, client) => (client ? createEnvironmentApi(client).server : undefined),
  };
  return connections;
}

/**
 * Keeps a machine's tasks live until the returned release is called. Until
 * its first read lands (or while it is offline) its last copy on this device
 * shows, read-only (`taskCache.ts`).
 */
export function retainMobileLocalTasks(environmentId: EnvironmentId): () => void {
  installTaskCache();
  void hydrateTaskCache(environmentId).catch(() => undefined);
  return retainConnectedLocalTasks(environmentId, {
    connections: mobileConnections(),
    threads: useStore,
    triggers: refreshOnForeground,
  });
}

const writers = new Map<EnvironmentId, LocalTaskWriter>();

/**
 * The machine's one task writer, shared by every screen so a task's saves
 * queue behind each other. It sends on the current connection, and a failure
 * (already rolled back on screen) is said once, in the node's own words.
 */
export function mobileLocalTaskWriter(environmentId: EnvironmentId): LocalTaskWriter {
  let writer = writers.get(environmentId);
  if (!writer) {
    writer = createLocalTaskWriter({
      api: () => readEnvironmentApi(environmentId)?.server,
      environmentId,
      onError: (cause, operation) =>
        Alert.alert(
          localTaskWriteFailureTitle(operation),
          localTaskErrorMessage(cause, LOCAL_TASK_WRITE_FAILED_FALLBACK),
        ),
    });
    writers.set(environmentId, writer);
  }
  return writer;
}
