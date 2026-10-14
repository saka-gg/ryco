import type { NativeE2eeTrustSource } from "@ryco/contracts/native-e2ee";
import type { RelayEffectiveRole } from "@ryco/contracts/relay";
import type {
  E2eeAccountGrantAuthoritySnapshot,
  E2eeAdmittedAuthoritySnapshot,
} from "@ryco/shared/relayE2eeHandshake";

import type { RelayChannelAuthority, RpcPrincipalRole } from "../ws/RpcPrincipal.ts";

const ROLE_RANK: Readonly<Record<RpcPrincipalRole, number>> = {
  viewer: 0,
  operator: 1,
  owner: 2,
};

const asRole = (value: string): RpcPrincipalRole | undefined =>
  value === "viewer" || value === "operator" || value === "owner" ? value : undefined;

/** The lower of the channel's role and the device's own ceiling; no input widens another. */
function intersectRole(
  channelRole: RelayEffectiveRole,
  ceiling: string,
): RpcPrincipalRole | undefined {
  const bounded = asRole(ceiling);
  const channel = asRole(channelRole);
  if (bounded === undefined || channel === undefined) return undefined;
  return ROLE_RANK[bounded] < ROLE_RANK[channel] ? bounded : channel;
}

/**
 * The device a completed relay E2EE handshake authenticated, from the same
 * snapshot the channel's lease holds. Web NX, and any native channel whose
 * snapshot is missing or names an unknown role, identify no device.
 */
export function relayChannelAuthority(
  channelRole: RelayEffectiveRole,
  session: {
    readonly trustSource: NativeE2eeTrustSource;
    readonly admittedAuthority: E2eeAdmittedAuthoritySnapshot | undefined;
    readonly accountGrantAuthority: E2eeAccountGrantAuthoritySnapshot | undefined;
  },
): RelayChannelAuthority {
  if (session.trustSource === "account-enrolled" && session.accountGrantAuthority !== undefined) {
    const grant = session.accountGrantAuthority;
    const role = intersectRole(channelRole, grant.maximumRole);
    return role === undefined
      ? { trustSource: "none" }
      : {
          trustSource: "account-enrolled",
          enrollmentId: grant.enrollmentId,
          clientIdentityFingerprint: grant.clientIdentityFingerprint,
          role,
        };
  }
  if (
    session.trustSource === "locally-verified" &&
    session.admittedAuthority !== undefined &&
    session.admittedAuthority.status === "approved"
  ) {
    const local = session.admittedAuthority;
    const role = intersectRole(channelRole, local.maxRole);
    return role === undefined
      ? { trustSource: "none" }
      : {
          trustSource: "locally-verified",
          clientIdentityFingerprint: local.clientIdentityFingerprint,
          role,
        };
  }
  return { trustSource: "none" };
}
