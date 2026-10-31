import type * as Http from "node:http";
import type { AuthSessionId, RelayEffectiveRole, TurnOrigin } from "@ryco/contracts";
import { isTailscaleAddress } from "@ryco/tailscale";
import type { HttpServerRequest } from "effect/http";

import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { isDirectLoopbackUpgrade, isLoopbackRangeAddress } from "../webSocketCompression.ts";

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
      /** The Hub account the channel's verified grant names: one person's devices share it. */
      readonly accountId?: string;
      readonly clientIdentityFingerprint: Uint8Array;
      readonly role: RpcPrincipalRole;
      /**
       * The node identity key this channel's handshake advertised and the
       * client verified; a linked direct grant names it so a direct address
       * can be made to prove it (`@ryco/shared/directRouteIdentity`).
       */
      readonly nodeIdentityPublicKey?: Uint8Array;
    }
  | {
      readonly trustSource: "locally-verified";
      readonly clientIdentityFingerprint: Uint8Array;
      readonly role: RpcPrincipalRole;
      /**
       * The node identity key this channel's handshake advertised and the
       * client verified; a linked direct grant names it so a direct address
       * can be made to prove it (`@ryco/shared/directRouteIdentity`).
       */
      readonly nodeIdentityPublicKey?: Uint8Array;
    }
  | { readonly trustSource: "none" };

/**
 * How a request reached the node, as the node itself saw it: its own relay channel state, or the
 * direct socket's addresses and TLS state. Never a client's claim. Captured when the connection
 * is built and classified on demand by `rpcConnectionPath` (`ws/rpcConnectionPath.ts`, loaded
 * with the first answer that needs it).
 */
export type RpcConnectionFacts =
  | {
      readonly kind: "relay";
      /**
       * Whether the channel's E2EE handshake completed (`e2ee` mode, native IK or web NX), read
       * per request. A channel that locked `legacy` never becomes `e2ee`, so a request read as
       * encrypted arrived as an authenticated E2EE record.
       */
      readonly endToEndEncrypted: () => boolean;
    }
  | {
      readonly kind: "direct";
      /** What the peer's socket address is. */
      readonly remote: RpcSocketAddressKind;
      /** What the node's own end of the socket is; absent when the runtime does not say. */
      readonly local: RpcSocketAddressKind | undefined;
      /** The socket itself is TLS. */
      readonly tls: boolean;
      /**
       * The upgrade request's forwarding headers, as sent. They are believed only from a
       * loopback peer, where they come from a reverse proxy on this machine.
       */
      readonly forwarding: {
        readonly forwardedFor: string | undefined;
        readonly forwarded: string | undefined;
        readonly forwardedProto: string | undefined;
        readonly realIp: string | undefined;
      };
    };

/**
 * What a socket address is: anywhere in the loopback range (IPv4-mapped forms included; the
 * network cannot deliver a loopback source), a Tailscale address, or anything else.
 */
export type RpcSocketAddressKind = "loopback" | "tailscale" | "other";

const socketAddressKind = (address: string): RpcSocketAddressKind =>
  isLoopbackRangeAddress(address)
    ? "loopback"
    : isTailscaleAddress(address)
      ? "tailscale"
      : "other";

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
  /**
   * Hub-linked direct sessions only: the hex fingerprint of the device whose relay channel the
   * link was issued on. That device's work keeps one owner whichever route it reaches the node
   * by (see {@link rpcPrincipalOwnerKey}).
   */
  readonly linkedDeviceFingerprintHex?: string;
  /** Relay channels only; see {@link RelayChannelAuthority}. */
  readonly relayAuthority?: () => RelayChannelAuthority;
  /** How requests reach the node; absent when unknown, which nothing reads as encrypted. */
  readonly connection?: RpcConnectionFacts;
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
        linkedDeviceFingerprintHex: Buffer.from(
          session.link.clientFingerprint,
          "base64url",
        ).toString("hex"),
      };

export const relayRpcPrincipal = (
  effectiveRole: RelayEffectiveRole,
  channelId: string,
  relayAuthority: () => RelayChannelAuthority = () => ({ trustSource: "none" }),
  endToEndEncrypted: () => boolean = () => false,
): RpcPrincipal => ({
  transport: "relay",
  role: effectiveRole,
  scopeId: channelId,
  canManageLocalAccess: false,
  relayAuthority,
  connection: { kind: "relay", endToEndEncrypted },
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
  // A device that reaches the node over its Hub relay and over a linked direct address is one
  // owner: a Git action started on one route is resumed or cancelled on the other.
  if (principal.transport === "direct" && principal.linkedDeviceFingerprintHex) {
    return `relay-device:${principal.linkedDeviceFingerprintHex}`;
  }
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

const headerText = (value: string | ReadonlyArray<string> | undefined): string | undefined =>
  typeof value === "string" ? value : value === undefined ? undefined : value.join(", ");

/**
 * A direct connection's peer and transport, from its upgrade request's socket. The locality: a
 * loopback connection without forwarding headers is a process on this machine; a local reverse
 * proxy (Tailscale Serve, say) that relays a remote client marks it with forwarding headers.
 * Nothing when the runtime gives no socket address.
 */
export const directConnectionOf = (
  request: HttpServerRequest.HttpServerRequest,
): Pick<RpcPrincipal, "peer" | "connection"> => {
  const source = request.source as Partial<Http.IncomingMessage> | undefined;
  const socket = source?.socket as
    | (Http.IncomingMessage["socket"] & { encrypted?: boolean })
    | undefined;
  const remoteAddress = socket?.remoteAddress;
  const headers = source?.headers;
  if (remoteAddress === undefined || headers === undefined) return {};
  return {
    peer: isDirectLoopbackUpgrade(source as Http.IncomingMessage) ? "local" : "remote",
    connection: {
      kind: "direct",
      remote: socketAddressKind(remoteAddress),
      local:
        socket?.localAddress === undefined ? undefined : socketAddressKind(socket.localAddress),
      tls: socket?.encrypted === true,
      forwarding: {
        forwardedFor: headerText(headers["x-forwarded-for"]),
        forwarded: headerText(headers.forwarded),
        forwardedProto: headerText(headers["x-forwarded-proto"]),
        realIp: headerText(headers["x-real-ip"]),
      },
    },
  };
};
