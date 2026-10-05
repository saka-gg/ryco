import {
  hostedHubStore,
  hostedSessionAdmits,
  resolveHostedRpcCapability,
} from "@ryco/client-runtime/authorization";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";
import type { KeyedQueryAdmission } from "@ryco/client-runtime/rpc";
import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import { isHostedHubMode } from "~/env";

/** Source-control queries share read authority from the canonical RPC policy. */
export function sourceControlReadAdmission(environmentId: EnvironmentId): KeyedQueryAdmission {
  if (!isHostedHubMode()) return { key: "direct", scope: "direct" };
  const state = hostedHubStore.getState();
  const method = WS_METHODS.sourceControlGetChangeRequestDetail;
  const node = state.nodes.find((candidate) => candidate.environmentId === environmentId);
  const selected = state.selectedNode?.environmentId === environmentId;
  const role = selected
    ? (state.effectiveRole ?? node?.effectiveRole ?? null)
    : (node?.effectiveRole ?? null);
  const scope =
    state.account &&
    state.session &&
    node &&
    node.revokedAt === null &&
    !(
      selected &&
      (state.selectionStatus === "revoked" || state.selectionStatus === "authorization-removed")
    ) &&
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
    state.selectedNode?.environmentId !== environmentId ||
    !state.selectedNode.presence.online ||
    !resolveHostedRpcCapability({
      hosted: true,
      role: state.effectiveRole,
      fresh: state.directoryStatus === "ready" && state.transportStatus === "online",
      browserCurrent: state.browserStatus === "current",
      sessionReady: hostedSessionAdmits(state, method),
      method,
    }).allowed
  )
    return { key: null, scope };
  return { key: JSON.stringify([scope, state.generation, state.effectiveRole]), scope };
}

export const subscribeSourceControlReadAdmission = hostedHubStore.subscribe;
