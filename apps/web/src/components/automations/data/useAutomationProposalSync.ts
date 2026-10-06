import { EnvironmentId } from "@ryco/contracts";
import {
  startAgentControlProposalSync,
  useAgentControlStore,
} from "@ryco/client-runtime/state/agentControl";
import { useEffect } from "react";

import { readEnvironmentApiForConnection } from "../../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../../environments/runtime";
import {
  clearScheduleProposalHistory,
  proposalsOfStreamEvent,
  recordScheduleProposals,
} from "./scheduleProposalHistory";

/**
 * Keeps one environment's Agent Control queue flowing into the shared store
 * for as long as its connection lives. It re-binds whenever the environment's
 * connection is (re)registered, following the gitStatusState pattern, so
 * late-connecting saved environments and reconnects keep the queue live.
 *
 * The Agent Control setting is enforced by the TARGET environment's server
 * (which may not be the primary node whose settings the web client mirrors):
 * the subscription is simply attempted whenever a connection exists, and a
 * server with the feature disabled refuses it — so nothing renders and no
 * policy is decided client-side.
 */
function bindEnvironmentProposalSync(environmentId: EnvironmentId): () => void {
  let currentClient: unknown = null;
  let stopSync: (() => void) | null = null;

  const syncSubscription = () => {
    const client = readEnvironmentConnection(environmentId)?.client ?? null;
    if (client === currentClient) return;
    stopSync?.();
    stopSync = null;
    currentClient = client;
    const source = client
      ? readEnvironmentApiForConnection(environmentId, client)?.agentControl
      : undefined;
    if (!source) return;
    const store = useAgentControlStore.getState();
    stopSync = startAgentControlProposalSync({
      environmentId,
      source,
      sink: {
        // Finished schedule proposals also go to the session history, which
        // outlives the queue's short list of finished proposals.
        applyStreamEvent: (id, event) => {
          store.applyStreamEvent(id, event);
          recordScheduleProposals(id, proposalsOfStreamEvent(event));
        },
        clearEnvironment: (id) => {
          store.clearEnvironment(id);
          clearScheduleProposalHistory(id);
        },
      },
    });
  };

  const unsubscribeRegistry = subscribeEnvironmentConnections(syncSubscription);
  syncSubscription();
  return () => {
    unsubscribeRegistry();
    stopSync?.();
  };
}

interface RetainedSync {
  count: number;
  stop: () => void;
  /** A release left the sync unused; it stops at the end of the task unless retained again. */
  teardownScheduled: boolean;
}

const retainedSyncs = new Map<EnvironmentId, RetainedSync>();

/**
 * One queue subscription per environment however many surfaces show it (the
 * chat's approvals, the Automations dialog, the sidebar badge). The last
 * release stops it once the current task ends, so a surface that re-renders
 * with a different set of environments — or React re-running an effect —
 * hands the subscription over instead of tearing it down and opening a new one.
 */
export function retainAgentControlProposalSync(environmentId: EnvironmentId): () => void {
  let entry = retainedSyncs.get(environmentId);
  if (!entry) {
    entry = {
      count: 0,
      stop: bindEnvironmentProposalSync(environmentId),
      teardownScheduled: false,
    };
    retainedSyncs.set(environmentId, entry);
  }
  entry.count += 1;
  const retained = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retained.count -= 1;
    if (retained.count > 0 || retained.teardownScheduled) return;
    retained.teardownScheduled = true;
    queueMicrotask(() => {
      retained.teardownScheduled = false;
      if (retained.count > 0 || retainedSyncs.get(environmentId) !== retained) return;
      retainedSyncs.delete(environmentId);
      retained.stop();
    });
  };
}

/** Test-only: whether an environment's queue subscription is currently held. */
export function isAgentControlProposalSyncRetained(environmentId: EnvironmentId): boolean {
  return retainedSyncs.has(environmentId);
}

/** A stable dependency for a list of environments: order and duplicates do not matter. */
export function proposalSyncKey(environmentIds: readonly EnvironmentId[]): string {
  return JSON.stringify([...new Set(environmentIds)].toSorted());
}

/** The environments a `proposalSyncKey` names. */
export function environmentIdsOfKey(key: string): EnvironmentId[] {
  const parsed: unknown = JSON.parse(key);
  return Array.isArray(parsed)
    ? parsed
        .filter((id): id is string => typeof id === "string")
        .map((id) => EnvironmentId.make(id))
    : [];
}

/**
 * Keeps the Agent Control queue of every listed environment live in
 * `useAgentControlStore` while the caller is mounted. Several callers may
 * name the same environment; they share one subscription.
 */
export function useAutomationProposalSync(environmentIds: readonly EnvironmentId[]): void {
  const key = proposalSyncKey(environmentIds);
  useEffect(() => {
    const releases = environmentIdsOfKey(key).map(retainAgentControlProposalSync);
    return () => {
      for (const release of releases) release();
    };
  }, [key]);
}
