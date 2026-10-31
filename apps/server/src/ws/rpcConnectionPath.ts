/**
 * How a request reached the node, classified from the facts the node captured itself when the
 * connection was built (`RpcConnectionFacts` on the principal): never from a client's claim.
 *
 * - `relay-e2ee`: a Hub relay channel whose E2EE handshake completed, on any tier. Web NX counts:
 *   its records are sealed between the browser and this node, so the Hub relays ciphertext
 *   (docs/relay-e2ee-protocol.md §2.2; the Hub still serves the web code, a ceiling no transport
 *   check can lift).
 * - `relay-plaintext`: a relay channel without E2EE (`legacy`, still negotiating, or closed).
 * - `direct-loopback`: a process on this machine, without forwarding headers. An SSH port
 *   forward arrives this way too, encrypted by SSH.
 * - `direct-tls`: a TLS socket, or a reverse proxy on this machine (Tailscale Serve, say) that
 *   says it took the request over HTTPS (`X-Forwarded-Proto` or `Forwarded` `proto`).
 * - `direct-tailscale`: both ends of the socket are Tailscale addresses, so WireGuard carried it.
 * - `direct-plain`: plain `ws://` from another machine, or a local proxy relaying plain HTTP or
 *   saying nothing about its protocol.
 * - `unknown`: no facts (a socket without an address, a principal built without them).
 *
 * Forwarding headers are believed only from a loopback peer: another machine can send any header
 * it likes. Loaded with the first answer that needs it, never at boot; the addresses were
 * classified when the connection was built (`RpcSocketAddressKind`), so nothing here imports a
 * boot module.
 *
 * @module ws/rpcConnectionPath
 */
import type { RpcConnectionFacts } from "./RpcPrincipal.ts";

export type RpcConnectionPath =
  | "relay-e2ee"
  | "relay-plaintext"
  | "direct-loopback"
  | "direct-tls"
  | "direct-tailscale"
  | "direct-plain"
  | "unknown";

type DirectFacts = Extract<RpcConnectionFacts, { readonly kind: "direct" }>;

const TLS_PROTOCOLS: ReadonlySet<string> = new Set(["https", "wss"]);

/** The last entry of a comma-separated header: the one the nearest proxy wrote. */
const lastEntry = (value: string): string => value.slice(value.lastIndexOf(",") + 1).trim();

/** The `proto` parameter of a `Forwarded` header's last element (RFC 7239), unquoted. */
const forwardedProto = (value: string): string | undefined => {
  for (const pair of lastEntry(value).split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim().toLowerCase() !== "proto") continue;
    return pair
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/u, "$1");
  }
  return undefined;
};

/**
 * Whether a local proxy took the request over TLS: every protocol header it sent names HTTPS in
 * its last entry, and it sent at least one. A proxy that appends to a client's forged header
 * leaves its own value last; one that passes a client's header through untouched is outside
 * what the node can tell (docs/agent-control.md, "Secret requests").
 */
const forwardedOverTls = (forwarding: DirectFacts["forwarding"]): boolean => {
  const protocols: Array<string | undefined> = [];
  if (forwarding.forwardedProto !== undefined) {
    protocols.push(lastEntry(forwarding.forwardedProto));
  }
  if (forwarding.forwarded !== undefined) protocols.push(forwardedProto(forwarding.forwarded));
  return (
    protocols.length > 0 &&
    protocols.every(
      (protocol) => protocol !== undefined && TLS_PROTOCOLS.has(protocol.toLowerCase()),
    )
  );
};

const isForwarded = (forwarding: DirectFacts["forwarding"]): boolean =>
  forwarding.forwardedFor !== undefined ||
  forwarding.forwarded !== undefined ||
  forwarding.forwardedProto !== undefined ||
  forwarding.realIp !== undefined;

export function rpcConnectionPath(facts: RpcConnectionFacts | undefined): RpcConnectionPath {
  if (facts === undefined) return "unknown";
  if (facts.kind === "relay") return facts.endToEndEncrypted() ? "relay-e2ee" : "relay-plaintext";
  if (facts.tls) return "direct-tls";
  if (facts.remote === "loopback") {
    if (!isForwarded(facts.forwarding)) return "direct-loopback";
    return forwardedOverTls(facts.forwarding) ? "direct-tls" : "direct-plain";
  }
  // The local end too: a Tailscale-range source alone could be carrier-grade NAT on a LAN.
  if (facts.remote === "tailscale" && facts.local === "tailscale") return "direct-tailscale";
  return "direct-plain";
}

/** Paths a secret's value may travel: encrypted end to end, or never on a network in the clear. */
const ENCRYPTED_PATHS: ReadonlySet<RpcConnectionPath> = new Set([
  "relay-e2ee",
  "direct-loopback",
  "direct-tls",
  "direct-tailscale",
]);

export const isEncryptedConnectionPath = (path: RpcConnectionPath): boolean =>
  ENCRYPTED_PATHS.has(path);
