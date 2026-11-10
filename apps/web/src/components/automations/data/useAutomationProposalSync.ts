import { EnvironmentId } from "@ryco/contracts";
import {
  createAgentControlSyncRegistry,
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
 * The web app's Agent Control queue subscriptions: the shared, reference
 * counted registry bound to this client's environment connections, so
 * late-connecting saved environments and reconnects keep the queue live.
 *
 * The Agent Control setting is enforced by the TARGET environment's server
 * (which may not be the primary node whose settings the web client mirrors):
 * the subscription is simply attempted whenever a connection exists, and a
 * server with the feature disabled refuses it — so nothing renders and no
 * policy is decided client-side.
 */
const proposalSyncs = createAgentControlSyncRegistry({
  readSource: (environmentId) => {
    const client = readEnvironmentConnection(environmentId)?.client ?? null;
    if (!client) return null;
    const source = readEnvironmentApiForConnection(environmentId, client)?.agentControl;
    // The api is built per read; the rpc client is what identifies the connection.
    return source ? { source, connection: client } : null;
  },
  subscribeSourceChanges: subscribeEnvironmentConnections,
  sink: {
    // Finished schedule proposals also go to the session history, which
    // outlives the queue's short list of finished proposals.
    applyStreamEvent: (id, event) => {
      useAgentControlStore.getState().applyStreamEvent(id, event);
      recordScheduleProposals(id, proposalsOfStreamEvent(event));
    },
    clearEnvironment: (id) => {
      useAgentControlStore.getState().clearEnvironment(id);
      clearScheduleProposalHistory(id);
    },
  },
});

/**
 * One queue subscription per environment however many surfaces show it (the
 * chat's approvals, the Automations dialog, the sidebar badge). See
 * `createAgentControlSyncRegistry` for the hand-over and refusal rules.
 */
export function retainAgentControlProposalSync(environmentId: EnvironmentId): () => void {
  return proposalSyncs.retain(environmentId);
}

/** Test-only: whether an environment's queue subscription is currently held. */
export function isAgentControlProposalSyncRetained(environmentId: EnvironmentId): boolean {
  return proposalSyncs.isRetained(environmentId);
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
