import type { AuthSessionId, RelayEffectiveRole } from "@ryco/contracts";

import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";

export type RpcPrincipalRole = "viewer" | "operator" | "owner";

/**
 * Who a relay channel's E2EE handshake authenticated, read when a request needs
 * it. `none` covers web NX, legacy plaintext, a handshake not yet complete, and
 * a channel whose lease has ended: only a native device is identified.
 */
export type RelayChannelAuthority =
  | {
      readonly trustSource: "account-enrolled";
      readonly enrollmentId: string;
      readonly clientIdentityFingerprint: Uint8Array;
      readonly role: RpcPrincipalRole;
    }
  | {
      readonly trustSource: "locally-verified";
      readonly clientIdentityFingerprint: Uint8Array;
      readonly role: RpcPrincipalRole;
    }
  | { readonly trustSource: "none" };

export interface RpcPrincipal {
  readonly transport: "direct" | "relay";
  readonly role: RpcPrincipalRole;
  readonly scopeId: string;
  readonly directSessionId?: AuthSessionId;
  readonly canManageLocalAccess: boolean;
  /** Relay channels only; see {@link RelayChannelAuthority}. */
  readonly relayAuthority?: () => RelayChannelAuthority;
}

/**
 * A Hub-linked session acts at the role its relay channel had, and never
 * manages local access: it cannot pair, list, or revoke other clients, or link
 * more devices. Every other direct session is an owner or a viewer.
 */
export const directRpcPrincipal = (session: AuthenticatedSession): RpcPrincipal =>
  session.link === undefined
    ? {
        transport: "direct",
        role: session.role === "owner" ? "owner" : "viewer",
        scopeId: session.sessionId,
        directSessionId: session.sessionId,
        canManageLocalAccess: session.role === "owner",
      }
    : {
        transport: "direct",
        role: session.link.role,
        scopeId: session.sessionId,
        directSessionId: session.sessionId,
        canManageLocalAccess: false,
      };

export const relayRpcPrincipal = (
  effectiveRole: RelayEffectiveRole,
  channelId: string,
  relayAuthority: () => RelayChannelAuthority = () => ({ trustSource: "none" }),
): RpcPrincipal => ({
  transport: "relay",
  role: effectiveRole,
  scopeId: channelId,
  canManageLocalAccess: false,
  relayAuthority,
});
