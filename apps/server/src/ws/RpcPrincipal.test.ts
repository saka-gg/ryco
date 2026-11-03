import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AuthSessionId } from "@ryco/contracts";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import {
  directConnectionOf,
  directRpcPrincipal,
  RELAY_UNIDENTIFIED_OWNER_KEY,
  type RelayChannelAuthority,
  relayRpcPrincipal,
  rpcPrincipalOwnerKey,
  turnOriginOfPrincipal,
} from "./RpcPrincipal.ts";

it.effect("enforces viewer, operator, owner, and direct-owner access", () =>
  Effect.gen(function* () {
    const viewer = relayRpcPrincipal("viewer", "channel-viewer");
    const operator = relayRpcPrincipal("operator", "channel-operator");
    const relayOwner = relayRpcPrincipal("owner", "channel-owner");
    const directOwner = directRpcPrincipal({
      sessionId: AuthSessionId.make("session-owner"),
      chainId: AuthSessionId.make("session-owner"),
      subject: "owner",
      method: "browser-session-cookie",
      role: "owner",
    });

    expect((yield* authorizeRpcPrincipal(viewer, "viewer", "read").pipe(Effect.result))._tag).toBe(
      "Success",
    );
    expect(
      (yield* authorizeRpcPrincipal(viewer, "operator", "write").pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* authorizeRpcPrincipal(operator, "operator", "write").pipe(Effect.result))._tag,
    ).toBe("Success");
    expect(
      (yield* authorizeRpcPrincipal(operator, "owner", "settings").pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* authorizeRpcPrincipal(relayOwner, "direct_owner", "access").pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* authorizeRpcPrincipal(directOwner, "direct_owner", "access").pipe(Effect.result))
        ._tag,
    ).toBe("Success");
  }),
);

it("keys work that outlives a connection by pairing, by device, or as unidentified", () => {
  const fingerprint = Uint8Array.of(0x01, 0x02, 0xfe);
  const enrolled = (): RelayChannelAuthority => ({
    trustSource: "account-enrolled",
    enrollmentId: "enrollment-1",
    clientIdentityFingerprint: fingerprint,
    role: "operator",
  });
  const locallyVerified = (): RelayChannelAuthority => ({
    trustSource: "locally-verified",
    clientIdentityFingerprint: fingerprint,
    role: "operator",
  });
  const otherDevice = (): RelayChannelAuthority => ({
    trustSource: "locally-verified",
    clientIdentityFingerprint: Uint8Array.of(0x09),
    role: "operator",
  });
  const relayKey = (channelId: string, authority?: () => RelayChannelAuthority) =>
    rpcPrincipalOwnerKey(relayRpcPrincipal("operator", channelId, authority));

  // A reconnect opens a new channel: the device stays the owner, whichever trust source
  // vouched for it this time.
  expect(relayKey("channel-a", enrolled)).toBe("relay-device:0102fe");
  expect(relayKey("channel-b", enrolled)).toBe(relayKey("channel-a", enrolled));
  expect(relayKey("channel-b", locallyVerified)).toBe(relayKey("channel-a", enrolled));
  expect(relayKey("channel-b", otherDevice)).not.toBe(relayKey("channel-a", enrolled));
  // Channels that identify no device share one owner.
  expect(relayKey("channel-a")).toBe(RELAY_UNIDENTIFIED_OWNER_KEY);
  expect(relayKey("channel-b", () => ({ trustSource: "none" }))).toBe(relayKey("channel-a"));

  // A bearer renewal issues a new session in the same pairing: the owner stays.
  const session = (sessionId: string, chainId: string) =>
    directRpcPrincipal({
      sessionId: AuthSessionId.make(sessionId),
      chainId: AuthSessionId.make(chainId),
      subject: "one-time-token",
      method: "bearer-session-token",
      role: "client",
    });
  expect(rpcPrincipalOwnerKey(session("session-1", "pairing-1"))).toBe("direct:pairing-1");
  expect(rpcPrincipalOwnerKey(session("session-2", "pairing-1"))).toBe(
    rpcPrincipalOwnerKey(session("session-1", "pairing-1")),
  );
  expect(rpcPrincipalOwnerKey(session("session-3", "pairing-2"))).not.toBe(
    rpcPrincipalOwnerKey(session("session-1", "pairing-1")),
  );
});

it("keeps a device one owner whether it reaches the node over the relay or a linked address", () => {
  const fingerprint = Uint8Array.of(0x01, 0x02, 0xfe);
  const relay = rpcPrincipalOwnerKey(
    relayRpcPrincipal("operator", "channel-a", () => ({
      trustSource: "account-enrolled",
      enrollmentId: "enrollment-1",
      clientIdentityFingerprint: fingerprint,
      role: "operator",
    })),
  );
  const linked = directRpcPrincipal({
    sessionId: AuthSessionId.make("session-linked"),
    chainId: AuthSessionId.make("chain-linked"),
    subject: "linked",
    method: "bearer-session-token",
    role: "client",
    link: {
      trustSource: "account-enrolled",
      enrollmentId: "enrollment-1",
      clientFingerprint: Buffer.from(fingerprint).toString("base64url"),
      role: "operator",
    },
  });
  // A Git action started over the relay is resumed or cancelled over the linked route.
  expect(rpcPrincipalOwnerKey(linked)).toBe(relay);
  expect(linked.canManageLocalAccess).toBe(false);
});

type UpgradeRequest = Parameters<typeof directConnectionOf>[0];
const upgrade = (
  remoteAddress: string | undefined,
  headers: Record<string, string | ReadonlyArray<string>> = {},
  socket: { readonly localAddress?: string; readonly encrypted?: boolean } = {},
) => ({ source: { socket: { remoteAddress, ...socket }, headers } }) as unknown as UpgradeRequest;
const peerOf = (request: UpgradeRequest) => directConnectionOf(request).peer;

it("derives where a turn comes from the connection, never the payload", () => {
  expect(peerOf(upgrade("127.0.0.1"))).toBe("local");
  expect(peerOf(upgrade("::ffff:127.0.0.1"))).toBe("local");
  expect(peerOf(upgrade("::1"))).toBe("local");
  // A local reverse proxy (Tailscale Serve) relays a remote client.
  expect(peerOf(upgrade("127.0.0.1", { "x-forwarded-for": "100.64.0.9" }))).toBe("remote");
  expect(peerOf(upgrade("192.168.1.20"))).toBe("remote");
  expect(directConnectionOf(upgrade(undefined))).toEqual({});
  expect(directConnectionOf({ source: {} } as unknown as UpgradeRequest)).toEqual({});

  const direct = directRpcPrincipal({
    sessionId: AuthSessionId.make("session-owner"),
    chainId: AuthSessionId.make("session-owner"),
    subject: "owner",
    method: "browser-session-cookie",
    role: "owner",
  });
  expect(turnOriginOfPrincipal(direct)).toBeUndefined();
  expect(turnOriginOfPrincipal({ ...direct, peer: "local" })).toEqual({ connection: "local" });
  expect(turnOriginOfPrincipal({ ...direct, peer: "remote" })).toEqual({ connection: "remote" });
  expect(turnOriginOfPrincipal(relayRpcPrincipal("owner", "channel"))).toEqual({
    connection: "relay",
  });
});

it("records a direct socket's own addresses, TLS state and forwarding headers", () => {
  expect(
    directConnectionOf(
      upgrade(
        "127.0.0.1",
        { "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https", host: "node.ts.net" },
        { localAddress: "127.0.0.1" },
      ),
    ).connection,
  ).toEqual({
    kind: "direct",
    remote: "loopback",
    remoteAddress: "127.0.0.1",
    localAddress: "127.0.0.1",
    tls: false,
    forwarding: {
      forwardedFor: "100.64.0.9",
      forwarded: undefined,
      forwardedProto: "https",
      realIp: undefined,
    },
  });
  const tls = directConnectionOf(
    upgrade("192.168.1.20", { forwarded: ["for=a", "for=b"] }, { encrypted: true }),
  ).connection;
  expect(tls).toMatchObject({
    kind: "direct",
    remote: "other",
    remoteAddress: "192.168.1.20",
    localAddress: undefined,
    tls: true,
    forwarding: { forwarded: "for=a, for=b" },
  });
  // The peer's address is recorded by kind too: IPv4-mapped loopback, Tailscale over IPv4 and
  // IPv6. The node's own end stays as the runtime reports it, for the lazy classification.
  const recorded = (remoteAddress: string, localAddress: string) => {
    const connection = directConnectionOf(upgrade(remoteAddress, {}, { localAddress })).connection;
    return connection?.kind === "direct"
      ? [connection.remote, connection.remoteAddress, connection.localAddress]
      : undefined;
  };
  expect(recorded("::ffff:127.0.0.1", "::ffff:127.0.0.1")).toEqual([
    "loopback",
    "::ffff:127.0.0.1",
    "::ffff:127.0.0.1",
  ]);
  expect(recorded("::ffff:100.101.102.103", "100.64.0.7")).toEqual([
    "tailscale",
    "::ffff:100.101.102.103",
    "100.64.0.7",
  ]);
  expect(recorded("fd7a:115c:a1e0::5", "192.168.1.10")).toEqual([
    "tailscale",
    "fd7a:115c:a1e0::5",
    "192.168.1.10",
  ]);
});

it("reads a relay channel's encryption per request, and none by default", () => {
  let encrypted = false;
  const principal = relayRpcPrincipal("owner", "channel", undefined, () => encrypted);
  const connection = principal.connection;
  expect(connection?.kind).toBe("relay");
  if (connection?.kind !== "relay") return;
  expect(connection.endToEndEncrypted()).toBe(false);
  encrypted = true;
  expect(connection.endToEndEncrypted()).toBe(true);
  const fallback = relayRpcPrincipal("owner", "channel").connection;
  expect(fallback?.kind === "relay" && fallback.endToEndEncrypted()).toBe(false);
});
