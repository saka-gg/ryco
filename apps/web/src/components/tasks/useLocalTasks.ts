import {
  createLocalTaskWriter,
  LOCAL_TASKS_FOCUS_REFRESH_MS,
  retainLocalTasks,
  selectLocalTasksEnvironment,
  useLocalTasksStore,
  type LocalTaskThreadSummaryReader,
  type LocalTaskWriteOperation,
  type LocalTaskWriter,
  type LocalTasksRefreshTriggers,
  type LocalTasksThreadActivitySource,
} from "@ryco/client-runtime/state/tasks";
import { fullThreadEntry, type AppState } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import { isTagged } from "effect/Predicate";
import { useEffect } from "react";

import { readEnvironmentApi, readEnvironmentApiForConnection } from "~/environmentApi";
import { readEnvironmentConnection, subscribeEnvironmentConnections } from "~/environments/runtime";
import { selectEnvironmentState, useStore } from "~/store";

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

/**
 * The environment's connection delivering a fresh shell snapshot re-reads
 * the tasks: the same client reconnected, and tasks may have changed while
 * it was away (a new client swaps the reader, which reads by itself). The
 * first snapshot of a connection adds nothing to the read already under
 * way, unless that read failed.
 */
function refreshOnShellReadiness(environmentId: EnvironmentId): LocalTasksRefreshTriggers {
  return (refresh) => {
    let boundClient: unknown = undefined;
    let stopReadiness: (() => void) | null = null;
    const watch = () => {
      const connection = readEnvironmentConnection(environmentId);
      const client = connection?.client ?? null;
      if (client === boundClient) return;
      boundClient = client;
      stopReadiness?.();
      stopReadiness = null;
      if (!connection) return;
      let ready = connection.shellSnapshotReadiness.read();
      let seenReady = ready !== null;
      stopReadiness = connection.shellSnapshotReadiness.subscribe(() => {
        const next = connection.shellSnapshotReadiness.read();
        const status = selectLocalTasksEnvironment(
          useLocalTasksStore.getState(),
          environmentId,
        ).status;
        const reread = next !== null && next !== ready && (seenReady || status === "error");
        if (next !== null) seenReady = true;
        ready = next;
        if (reread) refresh();
      });
    };
    const unsubscribe = subscribeEnvironmentConnections(watch);
    watch();
    return () => {
      unsubscribe();
      stopReadiness?.();
    };
  };
}

/**
 * Every platform signal that re-reads one environment's tasks. The sync
 * installs the first retainer's once per environment, so however many
 * surfaces show the tasks, each signal reads once.
 */
function taskRefreshTriggers(environmentId: EnvironmentId): LocalTasksRefreshTriggers {
  const readiness = refreshOnShellReadiness(environmentId);
  return (refresh) => {
    const stopFocus = refreshOnWindowFocus(refresh);
    const stopReadiness = readiness(refresh);
    return () => {
      stopFocus();
      stopReadiness();
    };
  };
}

/** A thread of the tasks' environment as the task rules read it; archived stubs read as unknown. */
export function taskThreadSummaryReader(
  state: AppState,
  environmentId: EnvironmentId,
): LocalTaskThreadSummaryReader {
  const summaries = selectEnvironmentState(state, environmentId).sidebarThreadSummaryById;
  return (threadId) => fullThreadEntry(summaries[threadId]);
}

/**
 * The live thread store as the task sync watches it: only commits that
 * change the environment's summaries reach the sync, so streaming deltas and
 * other environments cost nothing.
 */
function threadActivityOf(environmentId: EnvironmentId): LocalTasksThreadActivitySource {
  return {
    subscribe: (listener) =>
      useStore.subscribe((state, previous) => {
        if (
          selectEnvironmentState(state, environmentId).sidebarThreadSummaryById !==
          selectEnvironmentState(previous, environmentId).sidebarThreadSummaryById
        )
          listener();
      }),
    getSummary: (threadId) => taskThreadSummaryReader(useStore.getState(), environmentId)(threadId),
  };
}

/**
 * Keeps `environmentId`'s tasks retained until the returned release is
 * called. The environment's current connection is bound: a new client swaps
 * the shared reader (and reads again), and the same client delivering a
 * fresh shell snapshot after a reconnect re-reads what changed while it was
 * away (`refreshOnShellReadiness`, once per environment). A lost connection
 * keeps the last tasks on screen until the next one.
 */
export function retainLocalTasksFor(environmentId: EnvironmentId): () => void {
  let release: (() => void) | null = null;
  let boundList: unknown = null;

  const bind = () => {
    const client = readEnvironmentConnection(environmentId)?.client ?? null;
    const api = readEnvironmentApiForConnection(environmentId, client)?.server;
    if (!api) return;
    // The api object is rebuilt per lookup; its methods tell connections apart.
    if (release && api.listLocalTasks === boundList) return;
    const previous = release;
    boundList = api.listLocalTasks;
    // Retained before the old one is released, so the tasks stay in the store.
    release = retainLocalTasks(api, environmentId, {
      triggers: taskRefreshTriggers(environmentId),
      threadActivity: threadActivityOf(environmentId),
    });
    previous?.();
  };

  const unsubscribe = subscribeEnvironmentConnections(bind);
  bind();
  return () => {
    unsubscribe();
    release?.();
  };
}

/** Keeps `environmentId`'s tasks retained while mounted and `enabled` (`retainLocalTasksFor`). */
export function useLocalTasksSync(environmentId: EnvironmentId | null, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !environmentId) return;
    return retainLocalTasksFor(environmentId);
  }, [enabled, environmentId]);
}

/** The node's own words for a task error; transport text never reaches a toast. */
export function localTaskErrorMessage(cause: unknown, fallback: string): string {
  const message = isTagged(cause, "LocalTaskError")
    ? (cause as { message?: unknown }).message
    : undefined;
  return typeof message === "string" && message ? message : fallback;
}

function writeFailureTitle(operation: LocalTaskWriteOperation): string {
  switch (operation.kind) {
    case "create":
      return "Couldn’t add the task";
    case "update":
      return "Couldn’t save the task";
    case "remove":
      return "Couldn’t delete the task";
    case "addFile":
      return `Couldn’t add ${operation.name}`;
    case "removeFile":
      return "Couldn’t remove the file";
  }
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
            title: writeFailureTitle(operation),
            description: localTaskErrorMessage(
              cause,
              "The node didn’t confirm the change. It was undone.",
            ),
          }),
        ),
    });
    writers.set(environmentId, writer);
  }
  return writer;
}
