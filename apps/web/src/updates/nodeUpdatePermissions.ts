import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";

import { isHostedHubMode } from "../env";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { readHostedRpcCapability, subscribeHostedRpcCapabilities } from "../hostedHub/capabilities";

/**
 * Whether this client may call an owner-only method on a node now. Hosted mode
 * asks the node's own session (role and readiness); otherwise only a saved
 * environment this client paired with as a `client` is known to refuse it. The
 * node still checks every call.
 */
export function mayCallNodeOwnerMethod(method: string, environmentId: EnvironmentId): boolean {
  if (isHostedHubMode()) return readHostedRpcCapability(method, environmentId).allowed;
  return useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.role !== "client";
}

/** Whether this session may follow the node's update stream (any role may read it). */
export function mayFollowNodeUpdate(environmentId: EnvironmentId): boolean {
  return (
    !isHostedHubMode() ||
    readHostedRpcCapability(WS_METHODS.serverSubscribeNodeUpdate, environmentId).allowed
  );
}

/** Whether "Update everything" may update this node and its providers now. */
export function canMutateNodeUpdates(environmentId: EnvironmentId): boolean {
  return (
    mayCallNodeOwnerMethod(WS_METHODS.serverUpdateNode, environmentId) &&
    mayCallNodeOwnerMethod(WS_METHODS.serverUpdateProvider, environmentId)
  );
}

/** Notifies when the answers above may change; returns the unsubscribe. */
export function subscribeNodeMethodPermissions(listener: () => void): () => void {
  const unsubscribeHosted = subscribeHostedRpcCapabilities(listener);
  const unsubscribeSaved = useSavedEnvironmentRuntimeStore.subscribe(() => listener());
  return () => {
    unsubscribeHosted();
    unsubscribeSaved();
  };
}
