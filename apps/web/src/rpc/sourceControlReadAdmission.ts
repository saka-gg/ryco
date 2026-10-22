import {
  resolveHostedEnvironmentRpcCapability,
  selectHostedSharedCapabilityState,
} from "@ryco/client-runtime/authorization/capabilities";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";
import type { KeyedQueryAdmission } from "@ryco/client-runtime/rpc";
import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import { isHostedHubMode } from "~/env";
import { getHostedEnvironmentSessions, hostedHubStore } from "~/hostedHub/state";

/**
 * Source-control queries share read authority from the canonical RPC policy.
 *
 * Each environment is judged by its own session: the selected one mirrors it
 * into the shared hosted state, any other one has its own session record. A
 * warm environment the cursor is not on is admitted once its own session is
 * ready, and its key carries that session's generation so a new session fences
 * the reads of the old one.
 */
export function sourceControlReadAdmission(environmentId: EnvironmentId): KeyedQueryAdmission {
  if (!isHostedHubMode()) return { key: "direct", scope: "direct" };
  const state = hostedHubStore.getState();
  const method = WS_METHODS.sourceControlGetChangeRequestDetail;
  const node = state.nodes.find((candidate) => candidate.environmentId === environmentId);
  const selected = state.selectedNode?.environmentId === environmentId;
  const record = selected ? undefined : getHostedEnvironmentSessions().read(environmentId);
  const sessionRole = selected ? state.effectiveRole : (record?.effectiveRole ?? null);
  const generation = selected ? state.generation : (record?.generation ?? null);
  const presence = selected ? state.selectedNode?.presence : node?.presence;
  const role = sessionRole ?? node?.effectiveRole ?? null;
  // The selected environment mirrors a revoking relay close into the shared
  // selection status; any other one carries it on its own record.
  const revokedByRelay = selected
    ? state.selectionStatus === "revoked" || state.selectionStatus === "authorization-removed"
    : record?.failure?.kind === "revoked" || record?.failure?.kind === "authorization-removed";
  const scope =
    state.account &&
    state.session &&
    node &&
    node.revokedAt === null &&
    !revokedByRelay &&
    state.accountStatus !== "signed-out" &&
    state.accountStatus !== "signing-out" &&
    state.accountStatus !== "session-expired" &&
    hostedRoleAllows(role, method, true)
      ? JSON.stringify([
          state.account.id,
          state.session.id,
          state.session.activeSpaceId,
          environmentId,
        ])
      : null;
  if (
    scope === null ||
    state.accountStatus !== "authenticated" ||
    !presence?.online ||
    !resolveHostedEnvironmentRpcCapability({
      hosted: true,
      method,
      shared: selectHostedSharedCapabilityState(state, environmentId),
      record,
      environmentId,
    }).allowed
  )
    return { key: null, scope };
  return { key: JSON.stringify([scope, generation, sessionRole]), scope };
}

/** Admission follows the shared hosted state and every environment's session record. */
export function subscribeSourceControlReadAdmission(listener: () => void): () => void {
  const unsubscribeHub = hostedHubStore.subscribe(listener);
  const unsubscribeSessions = getHostedEnvironmentSessions().subscribe(listener);
  return () => {
    unsubscribeHub();
    unsubscribeSessions();
  };
}
