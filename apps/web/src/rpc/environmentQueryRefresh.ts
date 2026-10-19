import type { EnvironmentId } from "@ryco/contracts";
import {
  fenceActiveKeyedQueriesForEnvironment,
  refreshActiveKeyedQueriesForEnvironment,
} from "@ryco/client-runtime/rpc";
import type { HostedHubState } from "@ryco/client-runtime/authorization";
import type { HostedEnvironmentSessionRecord } from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";

import { defaultQueryClient } from "./queryClient";

export interface EnvironmentQueryRefreshBackend {
  readonly fence: (environmentId: EnvironmentId) => void;
  readonly refresh: (environmentId: EnvironmentId) => Promise<void>;
}

export interface EnvironmentQueryRefreshCoordinator {
  readonly begin: (environmentId: EnvironmentId) => number;
  readonly ready: (
    environmentId: EnvironmentId,
    generation: number,
    isAuthoritativelyReady?: () => boolean,
  ) => Promise<boolean>;
  readonly resetForTests: () => void;
}

export interface HostedEnvironmentQueryRefreshState {
  readonly generation: number;
  readonly selectedNode: { readonly environmentId: EnvironmentId } | null;
  readonly directoryStatus: HostedHubState["directoryStatus"];
  readonly selectionStatus: HostedHubState["selectionStatus"];
  readonly transportStatus: HostedHubState["transportStatus"];
  readonly sessionStatus: HostedHubState["sessionStatus"];
  readonly sessionEstablished: boolean;
  readonly browserStatus: HostedHubState["browserStatus"];
}

export function isHostedEnvironmentQueryRefreshReady(
  state: HostedEnvironmentQueryRefreshState,
  environmentId: EnvironmentId,
  generation: number,
): boolean {
  return (
    state.generation === generation &&
    state.selectedNode?.environmentId === environmentId &&
    state.directoryStatus === "ready" &&
    state.selectionStatus === "online" &&
    state.transportStatus === "online" &&
    state.sessionStatus === "ready" &&
    state.sessionEstablished &&
    state.browserStatus === "current"
  );
}

/** What a retained environment session's query refresh is fenced by. */
export interface HostedRecordQueryRefreshState {
  /** The environment's session record, if it has one. */
  readonly record:
    | Pick<
        HostedEnvironmentSessionRecord,
        "environmentId" | "generation" | "transportStatus" | "sessionStatus" | "sessionEstablished"
      >
    | null
    | undefined;
  readonly shared: Pick<HostedHubState, "directoryStatus" | "browserStatus">;
}

/**
 * The account and directory were checked in this browser lifecycle. The same
 * rule as the session registry's `hostedBrowserRevalidated`, restated here
 * because standard builds load this module and must not bundle the registry;
 * a test keeps the two in step.
 */
function browserRevalidated(status: HostedHubState["browserStatus"]): boolean {
  return status === "current" || status === "synchronizing";
}

/**
 * Retained environment sessions: the environment's own record of this
 * generation has accepted its snapshot on a live relay. The selection and the
 * shared generation play no part, so an environment that is not selected
 * refreshes its fenced queries as soon as its own session is current again.
 */
export function isHostedRecordQueryRefreshReady(
  state: HostedRecordQueryRefreshState,
  environmentId: EnvironmentId,
  generation: number,
): boolean {
  const { record, shared } = state;
  return (
    record != null &&
    record.environmentId === environmentId &&
    record.generation === generation &&
    record.transportStatus === "online" &&
    record.sessionStatus === "ready" &&
    record.sessionEstablished &&
    shared.directoryStatus === "ready" &&
    browserRevalidated(shared.browserStatus)
  );
}

export function createEnvironmentQueryRefreshCoordinator(
  backend: EnvironmentQueryRefreshBackend,
): EnvironmentQueryRefreshCoordinator {
  const generations = new Map<EnvironmentId, number>();
  const completed = new Map<EnvironmentId, number>();
  const refreshes = new Map<EnvironmentId, { generation: number; promise: Promise<boolean> }>();

  return {
    begin(environmentId) {
      const generation = (generations.get(environmentId) ?? 0) + 1;
      generations.set(environmentId, generation);
      refreshes.delete(environmentId);
      backend.fence(environmentId);
      return generation;
    },
    ready(environmentId, generation, isAuthoritativelyReady = () => true) {
      if (generations.get(environmentId) !== generation || !isAuthoritativelyReady()) {
        return Promise.resolve(false);
      }
      const active = refreshes.get(environmentId);
      if (active?.generation === generation) return active.promise;
      if (completed.get(environmentId) === generation) return Promise.resolve(true);

      const promise = backend.refresh(environmentId).then(() => {
        if (generations.get(environmentId) !== generation) return false;
        completed.set(environmentId, generation);
        return true;
      });
      refreshes.set(environmentId, { generation, promise });
      const clearRefresh = () => {
        if (refreshes.get(environmentId)?.promise === promise) refreshes.delete(environmentId);
      };
      void promise.then(clearRefresh, clearRefresh);
      return promise;
    },
    resetForTests() {
      generations.clear();
      completed.clear();
      refreshes.clear();
    },
  };
}

export const environmentQueryRefresh = createEnvironmentQueryRefreshCoordinator({
  fence: (environmentId) => {
    defaultQueryClient.fenceActiveQueriesForEnvironment(environmentId);
    fenceActiveKeyedQueriesForEnvironment(environmentId);
  },
  refresh: async (environmentId) => {
    await Promise.all([
      defaultQueryClient.refreshActiveQueriesForEnvironment(environmentId),
      refreshActiveKeyedQueriesForEnvironment(environmentId),
    ]);
  },
});
