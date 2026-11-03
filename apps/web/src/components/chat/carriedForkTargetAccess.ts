// FILE: carriedForkTargetAccess.ts
// Purpose: what lets this session take a carried fork to each connected
//          machine (`CarriedForkTargetAccess`), read from the shared role,
//          connection and hosted capability state the settings fan-out reads.
// Layer: Web, in the fork dialog's lazy chunk only. The policy itself is the
//        client runtime's (`carriedForkTargetAllowed`).

import {
  appAtomRegistry,
  getWsConnectionStatusForEnvironment,
  wsConnectionStatusForEnvironmentAtom,
} from "@ryco/client-runtime/rpc";
import type { CarriedForkTargetAccess } from "@ryco/client-runtime/state/threads/carriedFork";
import { type EnvironmentId, WS_METHODS } from "@ryco/contracts";

import { isHostedHubMode } from "../../env";
import { readNodeRole, relayRoleOf, subscribeNodeRoles } from "../../environments/nodeRole";
import {
  readHostedRpcCapability,
  subscribeHostedRpcCapabilities,
} from "../../hostedHub/capabilities";

/**
 * Hosted: the shared hosted capability policy's answer for the machine. Direct: this session's
 * role there (a paired device that is not the owner's counts as a viewer) and its connection's
 * phase.
 */
export function readCarriedForkTargetAccess(environmentId: EnvironmentId): CarriedForkTargetAccess {
  if (isHostedHubMode()) {
    return {
      hosted: true,
      allowed: readHostedRpcCapability(WS_METHODS.threadsForkCarried, environmentId).allowed,
    };
  }
  return {
    hosted: false,
    role: relayRoleOf(readNodeRole(environmentId)),
    phase: getWsConnectionStatusForEnvironment(environmentId).phase,
  };
}

/** The last answer, kept while nothing in it changed so it keeps its identity. */
let cached: { key: string; value: ReadonlyArray<CarriedForkTargetAccess> } = {
  key: "[]",
  value: [],
};

/** {@link readCarriedForkTargetAccess} for each machine, the same array while nothing changed. */
export function readCarriedForkTargetsAccess(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<CarriedForkTargetAccess> {
  const value = environmentIds.map(readCarriedForkTargetAccess);
  const key = JSON.stringify(value);
  if (key !== cached.key) cached = { key, value };
  return cached.value;
}

/** Calls `listener` whenever an answer of {@link readCarriedForkTargetsAccess} may change. */
export function subscribeCarriedForkTargetsAccess(
  environmentIds: ReadonlyArray<EnvironmentId>,
  listener: () => void,
): () => void {
  const unsubscribers = [
    subscribeHostedRpcCapabilities(listener),
    subscribeNodeRoles(listener),
    ...environmentIds.map((environmentId) =>
      appAtomRegistry.subscribe(wsConnectionStatusForEnvironmentAtom(environmentId), listener),
    ),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
