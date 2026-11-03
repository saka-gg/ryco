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
 * app's session is its owner's. A browser asks the node once per page and
 * tells its listeners the answer; it asks again only after asking failed, or,
 * when the node catalog asks (`requestPrimarySessionRole`), after the answer
 * found the page not signed in yet. A hosted page has no primary session: the
 * Hub states its role on every node.
 */
let primarySessionRole: {
  readonly environmentId: EnvironmentId;
  readonly role: AuthSessionRole | null;
  /** False when the page was not signed in yet: `requestPrimarySessionRole` asks again. */
  readonly signedIn: boolean;
} | null = null;
let primarySessionRequest: Promise<void> | null = null;
/** Bumped by the test reset, so an answer to an earlier request is dropped. */
let primarySessionGeneration = 0;
const primarySessionRoleListeners = new Set<() => void>();

/**
 * The role on the primary as last answered: null for a session without one
 * (or before sign-in), undefined until this page knows it. Never asks.
 */
export function peekPrimarySessionRole(
  environmentId: EnvironmentId,
): AuthSessionRole | null | undefined {
  if (isElectron) return "owner";
  return primarySessionRole?.environmentId === environmentId ? primarySessionRole.role : undefined;
}

/**
 * Asks the primary for this page's role, unless a signed-in answer is known or
 * a request is on its way.
 */
export function requestPrimarySessionRole(environmentId: EnvironmentId): void {
  if (isElectron || isHostedHubMode() || primarySessionRequest !== null) return;
  if (primarySessionRole?.environmentId === environmentId && primarySessionRole.signedIn) return;
  const generation = primarySessionGeneration;
  primarySessionRequest = fetchSessionState().then(
    (session) => {
      if (generation !== primarySessionGeneration) return;
      primarySessionRequest = null;
      primarySessionRole = {
        environmentId,
        role: session.authenticated ? (session.role ?? null) : null,
        signedIn: session.authenticated,
      };
      for (const listener of Array.from(primarySessionRoleListeners)) listener();
    },
    () => {
      // Asked again on the next request, never in a loop.
      if (generation === primarySessionGeneration) primarySessionRequest = null;
    },
  );
}

function readPrimarySessionRole(environmentId: EnvironmentId): NodeRole {
  const role = peekPrimarySessionRole(environmentId);
  if (role === undefined) requestPrimarySessionRole(environmentId);
  return role;
}

/** Called once the primary's session role is known. */
export function subscribePrimarySessionRole(listener: () => void): () => void {
  primarySessionRoleListeners.add(listener);
  return () => {
    primarySessionRoleListeners.delete(listener);
  };
}

export function resetPrimarySessionRoleForTests(): void {
  primarySessionGeneration += 1;
  primarySessionRole = null;
  primarySessionRequest = null;
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
