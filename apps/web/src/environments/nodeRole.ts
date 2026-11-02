import type { AuthSessionRole, EnvironmentId } from "@ryco/contracts";
import type { RelayEffectiveRole } from "@ryco/contracts/relay";
import { useSyncExternalStore } from "react";

import { isElectron, isHostedHubMode } from "../env";
import { useHostedHubStore } from "../hostedHub/state";
import {
  readDesktopWorkspaceState,
  subscribeDesktopWorkspaceState,
} from "../platform/desktopWorkspace";
import { fetchSessionState, getPrimaryKnownEnvironment } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * The role this client holds on a node: a Hub role, or a direct session's
 * (`owner` or `client`). Null when the client holds none; undefined while
 * the primary's is still being asked.
 */
export type NodeRole = RelayEffectiveRole | AuthSessionRole | null | undefined;

/**
 * This page's own session role on the primary node, once asked. The desktop
 * app's session is its owner's; a browser asks the node once per page (again
 * only after asking failed) and tells its listeners the answer.
 */
let primarySessionRole: {
  readonly environmentId: EnvironmentId;
  readonly role: AuthSessionRole | null;
} | null = null;
let primarySessionRequest: Promise<void> | null = null;
const primarySessionRoleListeners = new Set<() => void>();

function readPrimarySessionRole(environmentId: EnvironmentId): NodeRole {
  if (isElectron) return "owner";
  if (primarySessionRole?.environmentId === environmentId) return primarySessionRole.role;
  primarySessionRequest ??= fetchSessionState().then(
    (session) => {
      primarySessionRequest = null;
      primarySessionRole = {
        environmentId,
        role: session.authenticated ? (session.role ?? null) : null,
      };
      for (const listener of Array.from(primarySessionRoleListeners)) listener();
    },
    () => {
      // Asked again on the next check, not in a loop.
      primarySessionRequest = null;
    },
  );
  return undefined;
}

/** Called once the primary's session role is known. */
export function subscribePrimarySessionRole(listener: () => void): () => void {
  primarySessionRoleListeners.add(listener);
  return () => {
    primarySessionRoleListeners.delete(listener);
  };
}

/**
 * The role this client holds on a node: a hosted node's own role, a Desktop
 * workspace machine's, a saved environment's session role, or this page's own
 * session on the primary.
 */
export function readNodeRole(environmentId: EnvironmentId): NodeRole {
  if (isHostedHubMode()) {
    return (
      useHostedHubStore.getState().nodes.find((node) => node.environmentId === environmentId)
        ?.effectiveRole ?? null
    );
  }
  if (environmentId === getPrimaryKnownEnvironment()?.environmentId) {
    return readPrimarySessionRole(environmentId);
  }
  const machine = readDesktopWorkspaceState().machines.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  if (machine) return machine.canConnect ? machine.effectiveRole : null;
  return useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.role ?? null;
}

/**
 * The role in the Hub's terms, which the shared access policy
 * (`hostedRoleAllows`) judges: a direct session that is not the owner's is a
 * viewer there, as the node treats it.
 */
export const relayRoleOf = (role: NodeRole): RelayEffectiveRole | null =>
  role === "client" ? "viewer" : (role ?? null);

/** Calls `listener` whenever {@link readNodeRole} may answer differently for some node. */
export const subscribeNodeRoles = (listener: () => void) => {
  const unsubscribers = [
    subscribePrimarySessionRole(listener),
    subscribeDesktopWorkspaceState(listener),
    useSavedEnvironmentRuntimeStore.subscribe(listener),
    useHostedHubStore.subscribe(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
};

/** {@link readNodeRole}, following it as it changes. */
export function useNodeRole(environmentId: EnvironmentId | null): NodeRole {
  return useSyncExternalStore(subscribeNodeRoles, () =>
    environmentId === null ? null : readNodeRole(environmentId),
  );
}
