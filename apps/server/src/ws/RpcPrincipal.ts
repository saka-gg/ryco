import type * as Http from "node:http";
import type { AuthSessionId, RelayEffectiveRole, TurnOrigin } from "@ryco/contracts";
import type { HttpServerRequest } from "effect/http";

import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { isDirectLoopbackUpgrade } from "../webSocketCompression.ts";

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
  /** The direct session's pairing (rotation chain); every renewal of the pairing shares it. */
  readonly directChainId?: AuthSessionId;
  /**
   * Direct connections only: a process on this machine (`local`: a loopback connection without
   * forwarding headers) or another machine (`remote`). Absent when the address is unknown.
   */
  readonly peer?: "local" | "remote";
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
        directChainId: session.chainId,
        canManageLocalAccess: session.role === "owner",
      }
    : {
        transport: "direct",
        role: session.link.role,
        scopeId: session.sessionId,
        directSessionId: session.sessionId,
        directChainId: session.chainId,
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

/** The owner key of a direct pairing's work: see {@link rpcPrincipalOwnerKey}. */
export const directPairingOwnerKey = (chainId: string): string => `direct:${chainId}`;

/** The one owner of relay channels that identify no device: see {@link rpcPrincipalOwnerKey}. */
export const RELAY_UNIDENTIFIED_OWNER_KEY = "relay-unidentified";

/**
 * Who owns work that outlives one connection, stable across reconnects: a direct client's
 * pairing (its rotation chain, so a bearer renewal keeps the owner), a relay channel's
 * authenticated device (by its identity key, whichever trust source vouched for it), or one
 * bucket for relay channels that identify no device (hosted web). Never the channel or session
 * id of a relay connection, which changes on every reconnect. Read per request: a relay
 * channel's authority is set after its handshake. This is an owner, not an authorization:
 * every request is still authorized on its own.
 */
export function rpcPrincipalOwnerKey(principal: RpcPrincipal): string {
  if (principal.transport === "direct") {
    return directPairingOwnerKey(
      principal.directChainId ?? principal.directSessionId ?? principal.scopeId,
    );
  }
  const authority = principal.relayAuthority?.() ?? { trustSource: "none" as const };
  return authority.trustSource === "none"
    ? RELAY_UNIDENTIFIED_OWNER_KEY
    : `relay-device:${Buffer.from(authority.clientIdentityFingerprint).toString("hex")}`;
}

/** Where a turn sent over this connection comes from; undefined when the peer is unknown. */
export const turnOriginOfPrincipal = (principal: RpcPrincipal): TurnOrigin | undefined =>
  principal.transport === "relay"
    ? { connection: "relay" }
    : principal.peer === undefined
      ? undefined
      : { connection: principal.peer };

/**
 * The locality of a direct connection's peer, from its upgrade request: a loopback connection
 * without forwarding headers is a process on this machine; a local reverse proxy (Tailscale
 * Serve, say) that relays a remote client marks it with forwarding headers. Nothing when the
 * runtime gives no socket address.
 */
export const directPeerOf = (
  request: HttpServerRequest.HttpServerRequest,
): Pick<RpcPrincipal, "peer"> => {
  const source = request.source as Partial<Http.IncomingMessage> | undefined;
  if (source?.socket?.remoteAddress === undefined || source.headers === undefined) return {};
  return { peer: isDirectLoopbackUpgrade(source as Http.IncomingMessage) ? "local" : "remote" };
};
