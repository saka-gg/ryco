import type { AuthSessionRole, EnvironmentId } from "@ryco/contracts";

import { isElectron, isHostedHubMode } from "../env";
import { fetchSessionState } from "./primary";

/**
 * This page's own session role on its primary node, which decides whether the
 * page holds that node as its owner (the node catalog's owner-held nodes, the
 * node settings a page may write). The Desktop app's session is its owner's.
 * A browser asks the node once, remembers the answer for that node and tells
 * its listeners; it asks again, on the next request, only after asking failed
 * or found the page not signed in yet. A hosted page has no primary session:
 * the Hub states its role on every node.
 */

let known: { readonly environmentId: EnvironmentId; readonly role: AuthSessionRole | null } | null =
  null;
let requesting = false;
/** Bumped by the test reset, so an answer to an earlier request is dropped. */
let generation = 0;
const listeners = new Set<() => void>();

/** The role on the primary; null for a session without one; undefined until this page knows it. */
export function readPrimarySessionRole(
  environmentId: EnvironmentId,
): AuthSessionRole | null | undefined {
  if (isElectron) return "owner";
  return known?.environmentId === environmentId ? known.role : undefined;
}

/** Asks the primary for this page's role, unless the answer is known or on its way. */
export function requestPrimarySessionRole(environmentId: EnvironmentId): void {
  if (isElectron || isHostedHubMode() || requesting) return;
  if (known?.environmentId === environmentId) return;
  requesting = true;
  const requestGeneration = generation;
  void fetchSessionState().then(
    (session) => {
      if (requestGeneration !== generation) return;
      requesting = false;
      // Not signed in yet: nothing to remember, the next request asks again.
      if (!session.authenticated) return;
      known = { environmentId, role: session.role ?? null };
      for (const listener of Array.from(listeners)) listener();
    },
    () => {
      // Asked again on the next request, never in a loop.
      if (requestGeneration === generation) requesting = false;
    },
  );
}

/** Notifies once this page learns its role on the primary. */
export function subscribePrimarySessionRole(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPrimarySessionRoleForTests(): void {
  generation += 1;
  known = null;
  requesting = false;
}
