import type { EnvironmentId } from "@ryco/contracts";

import type { EnvironmentConnection } from "../../connection/connection.ts";
import { selectEnvironmentState, type AppState } from "../threads/store.ts";
import { fullThreadEntry } from "../threads/types.ts";
import { selectLocalTasksEnvironment, useLocalTasksStore } from "./store.ts";
import {
  retainLocalTasks,
  type LocalTasksApi,
  type LocalTasksRefreshTriggers,
  type LocalTasksThreadActivitySource,
} from "./sync.ts";
import type { LocalTaskThreadSummaryReader } from "./types.ts";

/**
 * Keeping a node's tasks live on any client: the task sync (`retainLocalTasks`)
 * bound to the node's current connection, re-read when that connection comes
 * back with a fresh shell snapshot, and following the live thread store so a
 * task's status moves with its chats. Each platform hands in its connection
 * supervisor, thread store and its own refresh signals (window focus, app
 * foreground); the rules are this module's.
 */

/** What the binding reads of an environment's connection. */
export type LocalTasksConnection = Pick<EnvironmentConnection, "client" | "shellSnapshotReadiness">;

/** The platform's connection supervisor and its api lookup, as far as tasks need them. */
export interface LocalTasksConnections {
  readonly read: (environmentId: EnvironmentId) => LocalTasksConnection | null;
  /** Notifies when any environment's connection is added, replaced or removed. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The task methods of the environment's api on exactly this connection's client. */
  readonly readApi: (
    environmentId: EnvironmentId,
    client: LocalTasksConnection["client"] | null,
  ) => LocalTasksApi | null | undefined;
}

/** The platform's thread store (web's and the phone's `useStore`). */
export interface LocalTasksThreadStore {
  readonly getState: () => AppState;
  readonly subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void;
}

/** Runs every trigger; stops them all together. */
export function combineLocalTasksRefreshTriggers(
  ...triggers: ReadonlyArray<LocalTasksRefreshTriggers>
): LocalTasksRefreshTriggers {
  return (refresh) => {
    const stops = triggers.map((trigger) => trigger(refresh));
    return () => {
      for (const stop of stops) stop();
    };
  };
}

/**
 * The environment's connection delivering a fresh shell snapshot re-reads
 * the tasks: the same client reconnected, and tasks may have changed while
 * it was away (a new client swaps the reader, which reads by itself). The
 * first snapshot of a connection adds nothing to the read already under
 * way, unless that read failed.
 */
export function localTasksShellReadinessTrigger(
  environmentId: EnvironmentId,
  connections: Pick<LocalTasksConnections, "read" | "subscribe">,
): LocalTasksRefreshTriggers {
  return (refresh) => {
    let boundClient: unknown = undefined;
    let stopReadiness: (() => void) | null = null;
    const watch = () => {
      const connection = connections.read(environmentId);
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
    const unsubscribe = connections.subscribe(watch);
    watch();
    return () => {
      unsubscribe();
      stopReadiness?.();
    };
  };
}

/** A thread of the tasks' environment as the task rules read it; archived stubs read as unknown. */
export function localTaskThreadSummaryReader(
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
export function localTasksThreadActivity(
  store: LocalTasksThreadStore,
  environmentId: EnvironmentId,
): LocalTasksThreadActivitySource {
  return {
    subscribe: (listener) =>
      store.subscribe((state, previous) => {
        if (
          selectEnvironmentState(state, environmentId).sidebarThreadSummaryById !==
          selectEnvironmentState(previous, environmentId).sidebarThreadSummaryById
        )
          listener();
      }),
    getSummary: (threadId) =>
      localTaskThreadSummaryReader(store.getState(), environmentId)(threadId),
  };
}

export interface RetainConnectedLocalTasksOptions {
  readonly connections: LocalTasksConnections;
  readonly threads: LocalTasksThreadStore;
  /** The platform's own refresh signals (window focus, app foreground). */
  readonly triggers?: LocalTasksRefreshTriggers;
}

/**
 * Keeps `environmentId`'s tasks retained until the returned release is
 * called. The environment's current connection is bound: a new client swaps
 * the shared reader (and reads again), and the same client delivering a
 * fresh shell snapshot after a reconnect re-reads what changed while it was
 * away (once per environment). A lost connection keeps the last tasks on
 * screen until the next one.
 */
export function retainConnectedLocalTasks(
  environmentId: EnvironmentId,
  options: RetainConnectedLocalTasksOptions,
): () => void {
  const { connections } = options;
  let release: (() => void) | null = null;
  let boundList: unknown = null;
  const readiness = localTasksShellReadinessTrigger(environmentId, connections);
  const triggers = options.triggers
    ? combineLocalTasksRefreshTriggers(options.triggers, readiness)
    : readiness;

  const bind = () => {
    const client = connections.read(environmentId)?.client ?? null;
    const api = connections.readApi(environmentId, client);
    if (!api) return;
    // The api object is rebuilt per lookup; its methods tell connections apart.
    if (release && api.listLocalTasks === boundList) return;
    const previous = release;
    boundList = api.listLocalTasks;
    // Retained before the old one is released, so the tasks stay in the store.
    release = retainLocalTasks(api, environmentId, {
      triggers,
      threadActivity: localTasksThreadActivity(options.threads, environmentId),
    });
    previous?.();
  };

  const unsubscribe = connections.subscribe(bind);
  bind();
  return () => {
    unsubscribe();
    release?.();
  };
}
