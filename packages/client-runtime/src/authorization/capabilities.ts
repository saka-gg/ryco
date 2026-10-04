import type { RelayEffectiveRole } from "@ryco/contracts";
import { hostedRoleAllows, rpcDeliveryEffectFor } from "@ryco/shared/rpcAccessPolicy";

import type { HostedRycoSessionStatus } from "./types.ts";

export interface HostedRpcCapability {
  readonly hosted: boolean;
  readonly allowed: boolean;
  readonly reason: string | null;
}

export interface HostedSessionAdmissionState {
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly sessionRecoveredAfterUnknown: boolean;
}

/**
 * Whether the hosted Ryco session admits `method` right now.
 *
 * A session that recovered after uncertain delivery keeps refusing mutations
 * until the user has seen the uncertainty, because Ryco cannot tell them whether
 * the earlier action ran. Reads only observe node state, so the replacement
 * session's accepted snapshot is all they need: gating them would freeze every
 * file, diff, and history view over an action they had nothing to do with.
 */
export function hostedSessionAdmits(state: HostedSessionAdmissionState, method: string): boolean {
  if (state.sessionStatus === "ready") return true;
  return (
    state.sessionStatus === "delivery-unknown" &&
    state.sessionRecoveredAfterUnknown &&
    rpcDeliveryEffectFor(method) === "read"
  );
}

export function resolveHostedRpcCapability(input: {
  readonly hosted: boolean;
  readonly role: RelayEffectiveRole | null;
  readonly fresh: boolean;
  readonly browserCurrent?: boolean;
  readonly sessionReady?: boolean;
  readonly method: string;
}): HostedRpcCapability {
  if (!input.hosted) return { hosted: false, allowed: true, reason: null };
  if (!input.fresh || input.browserCurrent === false || input.sessionReady === false) {
    return {
      hosted: true,
      allowed: false,
      reason: "This action is unavailable while Hub authorization or the relay is stale.",
    };
  }
  if (hostedRoleAllows(input.role, input.method, true)) {
    return { hosted: true, allowed: true, reason: null };
  }
  return {
    hosted: true,
    allowed: false,
    reason: "This action is unavailable for your role on the selected node.",
  };
}
