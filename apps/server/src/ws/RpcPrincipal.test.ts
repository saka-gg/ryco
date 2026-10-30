import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AuthSessionId } from "@ryco/contracts";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import {
  directPeerOf,
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

it("derives where a turn comes from the connection, never the payload", () => {
  const request = (remoteAddress: string | undefined, headers: Record<string, string> = {}) =>
    ({ source: { socket: { remoteAddress }, headers } }) as unknown as Parameters<
      typeof directPeerOf
    >[0];
  expect(directPeerOf(request("127.0.0.1"))).toEqual({ peer: "local" });
  expect(directPeerOf(request("::ffff:127.0.0.1"))).toEqual({ peer: "local" });
  expect(directPeerOf(request("::1"))).toEqual({ peer: "local" });
  // A local reverse proxy (Tailscale Serve) relays a remote client.
  expect(directPeerOf(request("127.0.0.1", { "x-forwarded-for": "100.64.0.9" }))).toEqual({
    peer: "remote",
  });
  expect(directPeerOf(request("192.168.1.20"))).toEqual({ peer: "remote" });
  expect(directPeerOf(request(undefined))).toEqual({});
  expect(directPeerOf({ source: {} } as unknown as Parameters<typeof directPeerOf>[0])).toEqual({});

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
