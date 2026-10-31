import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { directConnectionOf, type RpcConnectionFacts } from "./RpcPrincipal.ts";
import {
  isEncryptedConnectionPath,
  readRpcConnectionPath,
  rpcConnectionPath,
  type RpcConnectionPath,
} from "./rpcConnectionPath.ts";

type UpgradeRequest = Parameters<typeof directConnectionOf>[0];

/** The facts the node records for a direct socket, built the way `/ws` builds them. */
const direct = (
  remoteAddress: string,
  options: {
    readonly localAddress?: string;
    readonly tls?: boolean;
    readonly forwarding?: {
      readonly forwardedFor?: string;
      readonly forwarded?: string;
      readonly forwardedProto?: string;
      readonly realIp?: string;
    };
  } = {},
): RpcConnectionFacts => {
  const forwarding = options.forwarding ?? {};
  const headers = Object.fromEntries(
    [
      ["x-forwarded-for", forwarding.forwardedFor],
      ["forwarded", forwarding.forwarded],
      ["x-forwarded-proto", forwarding.forwardedProto],
      ["x-real-ip", forwarding.realIp],
    ].filter(([, value]) => value !== undefined),
  );
  const connection = directConnectionOf({
    source: {
      socket: { remoteAddress, localAddress: options.localAddress, encrypted: options.tls },
      headers,
    },
  } as unknown as UpgradeRequest).connection;
  if (connection === undefined) throw new Error("no connection facts");
  return connection;
};

/** This node's own Tailscale addresses, as `tailscale status` lists them. */
const NODE_TAILSCALE = ["100.64.0.7", "fd7a:115c:a1e0::1"];

const relay = (encrypted: boolean): RpcConnectionFacts => ({
  kind: "relay",
  endToEndEncrypted: () => encrypted,
});

describe("rpcConnectionPath", () => {
  it("classifies each way a request reaches the node", () => {
    const cases: ReadonlyArray<
      readonly [string, RpcConnectionFacts | undefined, RpcConnectionPath]
    > = [
      ["relay channel with E2EE", relay(true), "relay-e2ee"],
      ["relay channel without E2EE", relay(false), "relay-plaintext"],
      ["loopback IPv4", direct("127.0.0.1", { localAddress: "127.0.0.1" }), "direct-loopback"],
      ["loopback range", direct("127.0.0.2"), "direct-loopback"],
      ["loopback IPv6", direct("::1", { localAddress: "::1" }), "direct-loopback"],
      ["IPv4-mapped loopback", direct("::ffff:127.0.0.1"), "direct-loopback"],
      ["TLS socket", direct("192.168.1.20", { tls: true }), "direct-tls"],
      [
        "Tailscale Serve over HTTPS",
        direct("127.0.0.1", {
          forwarding: { forwardedFor: "100.101.102.103", forwardedProto: "https" },
        }),
        "direct-tls",
      ],
      [
        "a local proxy using Forwarded",
        direct("::1", { forwarding: { forwarded: 'for=192.168.1.20;proto="https"' } }),
        "direct-tls",
      ],
      [
        "Tailscale both ends",
        direct("100.101.102.103", { localAddress: "100.64.0.7" }),
        "direct-tailscale",
      ],
      [
        "Tailscale both ends, IPv4-mapped",
        direct("::ffff:100.101.102.103", { localAddress: "::ffff:100.64.0.7" }),
        "direct-tailscale",
      ],
      [
        "Tailscale IPv6 both ends",
        direct("fd7a:115c:a1e0::5", { localAddress: "fd7a:115c:a1e0::1" }),
        "direct-tailscale",
      ],
      [
        "plain ws:// on the LAN",
        direct("192.168.1.20", { localAddress: "192.168.1.10" }),
        "direct-plain",
      ],
      ["plain ws:// from the internet", direct("203.0.113.9"), "direct-plain"],
      [
        "this machine on its own LAN address",
        direct("192.168.1.10", { localAddress: "192.168.1.10" }),
        "direct-loopback",
      ],
      [
        "this machine on its own address, IPv4-mapped",
        direct("::ffff:192.168.1.10", { localAddress: "192.168.1.10" }),
        "direct-loopback",
      ],
      [
        "a proxy on this machine's LAN address relaying plain HTTP",
        direct("192.168.1.10", {
          localAddress: "192.168.1.10",
          forwarding: { forwardedFor: "192.168.1.20", forwardedProto: "http" },
        }),
        "direct-plain",
      ],
      [
        "a local proxy relaying plain HTTP",
        direct("127.0.0.1", {
          forwarding: { forwardedFor: "192.168.1.20", forwardedProto: "http" },
        }),
        "direct-plain",
      ],
      [
        "a local proxy that names no protocol",
        direct("127.0.0.1", { forwarding: { forwardedFor: "192.168.1.20" } }),
        "direct-plain",
      ],
      [
        "a local proxy that sends only X-Real-IP",
        direct("127.0.0.1", { forwarding: { realIp: "192.168.1.20" } }),
        "direct-plain",
      ],
      ["no facts", undefined, "unknown"],
    ];
    for (const [name, facts, expected] of cases) {
      expect(rpcConnectionPath(facts, NODE_TAILSCALE), name).toBe(expected);
    }
  });

  it("reads a relay channel's mode per request", () => {
    let encrypted = false;
    const facts: RpcConnectionFacts = { kind: "relay", endToEndEncrypted: () => encrypted };
    expect(rpcConnectionPath(facts)).toBe("relay-plaintext");
    encrypted = true;
    expect(rpcConnectionPath(facts)).toBe("relay-e2ee");
  });

  it("never believes forwarding headers from another machine", () => {
    for (const forwarding of [
      { forwardedProto: "https" },
      { forwarded: "proto=https" },
      { forwardedFor: "127.0.0.1", forwardedProto: "https" },
      { forwardedFor: "100.101.102.103" },
      { realIp: "127.0.0.1" },
    ]) {
      expect(
        rpcConnectionPath(direct("192.168.1.20", { localAddress: "192.168.1.10", forwarding })),
        JSON.stringify(forwarding),
      ).toBe("direct-plain");
    }
  });

  it("takes a local proxy's own protocol, not a client's forged one in front of it", () => {
    // A proxy that appends leaves its own value last.
    expect(
      rpcConnectionPath(
        direct("127.0.0.1", {
          forwarding: { forwardedFor: "1.2.3.4, 192.168.1.20", forwardedProto: "https, http" },
        }),
      ),
    ).toBe("direct-plain");
    expect(
      rpcConnectionPath(
        direct("127.0.0.1", {
          forwarding: { forwarded: "for=1.2.3.4;proto=https, for=192.168.1.20" },
        }),
      ),
    ).toBe("direct-plain");
    // Two protocol headers must both say HTTPS.
    expect(
      rpcConnectionPath(
        direct("127.0.0.1", { forwarding: { forwardedProto: "https", forwarded: "proto=http" } }),
      ),
    ).toBe("direct-plain");
    expect(
      rpcConnectionPath(
        direct("127.0.0.1", { forwarding: { forwardedProto: " HTTPS ", forwarded: "Proto=wss" } }),
      ),
    ).toBe("direct-tls");
  });

  it("needs the node's own Tailscale address as the local end, not the range alone", () => {
    expect(
      rpcConnectionPath(
        direct("100.101.102.103", { localAddress: "192.168.1.10" }),
        NODE_TAILSCALE,
      ),
    ).toBe("direct-plain");
    expect(rpcConnectionPath(direct("100.101.102.103"), NODE_TAILSCALE)).toBe("direct-plain");
    expect(
      rpcConnectionPath(direct("192.168.1.20", { localAddress: "100.64.0.7" }), NODE_TAILSCALE),
    ).toBe("direct-plain");
    // A pod network numbered in 100.64.0.0/10 (kops, EKS) carries plain ws:// between pods.
    expect(
      rpcConnectionPath(direct("100.96.1.2", { localAddress: "100.96.1.3" }), NODE_TAILSCALE),
    ).toBe("direct-plain");
    // Unknown node addresses fail closed; none (Tailscale off) too.
    const tailscale = direct("100.101.102.103", { localAddress: "100.64.0.7" });
    expect(rpcConnectionPath(tailscale)).toBe("direct-plain");
    expect(rpcConnectionPath(tailscale, [])).toBe("direct-plain");
    expect(rpcConnectionPath(tailscale, NODE_TAILSCALE)).toBe("direct-tailscale");
  });

  it("never reads a wildcard address as this machine", () => {
    expect(rpcConnectionPath(direct("0.0.0.0", { localAddress: "0.0.0.0" }))).toBe("direct-plain");
    expect(rpcConnectionPath(direct("::", { localAddress: "::" }))).toBe("direct-plain");
  });

  it("reads the node's Tailscale addresses only for a Tailscale peer, and fails closed", async () => {
    const tailscale = direct("100.101.102.103", { localAddress: "100.64.0.7" });
    let reads = 0;
    const reader = (addresses: ReadonlyArray<string> | undefined) =>
      Effect.sync(() => {
        reads += 1;
        return addresses;
      });
    const read = (
      facts: RpcConnectionFacts | undefined,
      from: Effect.Effect<ReadonlyArray<string> | undefined>,
    ) => Effect.runPromise(readRpcConnectionPath(facts, from));

    expect(await read(tailscale, reader(NODE_TAILSCALE))).toBe("direct-tailscale");
    expect(await read(tailscale, reader(undefined))).toBe("direct-plain");
    expect(await read(tailscale, Effect.die(new Error("no tailscale CLI")))).toBe("direct-plain");
    expect(reads).toBe(2);
    for (const facts of [
      relay(true),
      direct("127.0.0.1"),
      direct("192.168.1.20", { localAddress: "192.168.1.10" }),
      direct("100.101.102.103", { localAddress: "100.64.0.7", tls: true }),
      direct("100.101.102.103", { localAddress: "100.101.102.103" }),
      direct("100.101.102.103"),
      undefined,
    ]) {
      await read(facts, reader(NODE_TAILSCALE));
    }
    expect(reads).toBe(2);
  });

  it("counts only encrypted or on-machine paths as fit for a secret", () => {
    const fit: Record<RpcConnectionPath, boolean> = {
      "relay-e2ee": true,
      "relay-plaintext": false,
      "direct-loopback": true,
      "direct-tls": true,
      "direct-tailscale": true,
      "direct-plain": false,
      unknown: false,
    };
    for (const [path, expected] of Object.entries(fit)) {
      expect(isEncryptedConnectionPath(path as RpcConnectionPath), path).toBe(expected);
    }
  });
});
