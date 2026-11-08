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
import { readEnvironmentApi, subscribeEnvironmentApis } from "../../connection/environmentApi";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { useStore } from "../../state/threadsRuntime";
import { hydrateTaskCache, installTaskCache } from "./taskCache";
import { isTaskMachineReachable, promoteTaskMachine } from "./taskConnectionDemand";

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

/** How long a write to a Hub machine waits for its connection to come up. */
const CONNECT_WAIT_MS = 20_000;

/**
 * The machine's task methods on its current connection. A Hub machine that is
 * online but whose connection slot went to another machine is asked for
 * (`promoteTaskMachine`), and the write waits for it; any other machine
 * without a connection fails the write at once.
 */
type TaskApi = NonNullable<ReturnType<typeof readEnvironmentApi>>["server"];

function taskApi(environmentId: EnvironmentId): TaskApi | undefined | Promise<TaskApi | undefined> {
  const reachable = isTaskMachineReachable(environmentId);
  // Writing keeps it live, so the next write in the queue finds it connected.
  if (reachable) promoteTaskMachine(environmentId);
  const current: TaskApi | undefined = readEnvironmentApi(environmentId)?.server;
  if (current || !reachable) return current;
  return new Promise<TaskApi | undefined>((resolve) => {
    const finish = (api: TaskApi | undefined) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(api);
    };
    const timer = setTimeout(() => finish(undefined), CONNECT_WAIT_MS);
    const unsubscribe = subscribeEnvironmentApis(() => {
      const api = readEnvironmentApi(environmentId)?.server;
      if (api) finish(api);
    });
  });
}

/**
 * The machine's one task writer, shared by every screen so a task's saves
 * queue behind each other. It sends on the current connection (waiting for a
 * Hub machine's to come up, see `taskApi`), and a failure
 * (already rolled back on screen) is said once, in the node's own words.
 */
export function mobileLocalTaskWriter(environmentId: EnvironmentId): LocalTaskWriter {
  let writer = writers.get(environmentId);
  if (!writer) {
    writer = createLocalTaskWriter({
      api: () => taskApi(environmentId),
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
