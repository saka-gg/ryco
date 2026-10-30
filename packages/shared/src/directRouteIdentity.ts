import { encode, rfc8949EncodeOptions } from "cborg";

import { verifyE2eeSignature } from "./relayE2eeKeys.ts";

/**
 * The identity proof a Hub machine's direct address gives before a client sends
 * it any credential (`docs/environment-routes.md`, "Identity").
 *
 * A linked direct grant is issued only over an E2EE relay channel, and it names
 * the node identity key that channel's handshake verified. Before a client
 * redeems the grant's code or presents its bearer at a direct address, it sends
 * a fresh random challenge there, with the origin it contacted; the node signs
 * this transcript with that same identity key, and only for an origin it
 * advertises itself:
 *
 * ```text
 * ["ryco.direct-route-identity.proof.v1", directEnvironmentId, origin, challengeBytes]
 * ```
 *
 * The origin is what makes a reused address useless to whoever holds it now (a
 * Tailscale or DHCP address given to another device, a hostname or tunnel name
 * handed on): passing the challenge through, or redirecting it, to the real
 * machine gets no signature, because the machine no longer advertises that
 * origin, and rewriting the origin gets a signature the client's check refuses.
 *
 * The domain string is the first element, as in every other node-signed
 * transcript (`nodeIdentity.ts`, the relay E2EE transcripts), so a signature
 * made here can never verify as any of them, and theirs never as this.
 *
 * What it proves: the machine holding the identity key answers for the origin
 * the client contacted, now. What it cannot prove on its own: that nobody sits
 * between the client and that origin, because the socket after it is not bound
 * to the key. The transport rules that out (HTTPS names the host, WireGuard the
 * peer), which is why direct routes stay limited to those transports.
 *
 * Free of Node built-ins: the node, Desktop's renderer and the phone (Hermes)
 * all load it.
 */

export const DIRECT_ROUTE_IDENTITY_TRANSCRIPT_DOMAIN = "ryco.direct-route-identity.proof.v1";
export const DIRECT_ROUTE_IDENTITY_CHALLENGE_BYTES = 32;

/** A URL's origin exactly as both sides write it into the transcript; `null` for anything else. */
export function directRouteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function encodeDirectRouteIdentityTranscript(input: {
  readonly environmentId: string;
  readonly origin: string;
  readonly challenge: Uint8Array;
}): Uint8Array {
  if (
    typeof input.environmentId !== "string" ||
    input.environmentId.length === 0 ||
    input.environmentId.length > 128 ||
    typeof input.origin !== "string" ||
    input.origin.length > 512 ||
    directRouteOrigin(input.origin) !== input.origin ||
    !(input.challenge instanceof Uint8Array) ||
    input.challenge.byteLength !== DIRECT_ROUTE_IDENTITY_CHALLENGE_BYTES
  ) {
    throw new Error("Direct route identity input is invalid.");
  }
  return Uint8Array.from(
    encode(
      [
        DIRECT_ROUTE_IDENTITY_TRANSCRIPT_DOMAIN,
        input.environmentId,
        input.origin,
        Uint8Array.from(input.challenge),
      ],
      rfc8949EncodeOptions,
    ),
  );
}

/**
 * Whether `signature` is the node identity key's signature over this client's
 * own challenge for `environmentId` at the `origin` it contacted. False for
 * every failure, never throws: the signature is bytes from the network.
 */
export function verifyDirectRouteIdentityProof(input: {
  readonly nodeIdentityPublicKey: Uint8Array;
  readonly environmentId: string;
  readonly origin: string;
  readonly challenge: Uint8Array;
  readonly signature: Uint8Array;
}): boolean {
  let message: Uint8Array;
  try {
    message = encodeDirectRouteIdentityTranscript(input);
  } catch {
    return false;
  }
  return verifyE2eeSignature({
    algorithm: "ed25519",
    publicKey: input.nodeIdentityPublicKey,
    message,
    signature: input.signature,
  });
}
