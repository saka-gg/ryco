import { encode, rfc8949EncodeOptions } from "cborg";

import { verifyE2eeSignature } from "./relayE2eeKeys.ts";

/**
 * The identity proof a Hub machine's direct address gives before a client sends
 * it any credential (`docs/environment-routes.md`, "Identity").
 *
 * A linked direct grant is issued only over an E2EE relay channel, and it names
 * the node identity key that channel's handshake verified. Before a client
 * redeems the grant's code or presents its bearer at a direct address, it sends
 * a fresh random challenge there; the node signs this transcript with that same
 * identity key:
 *
 * ```text
 * ["ryco.direct-route-identity.proof.v1", directEnvironmentId, challengeBytes]
 * ```
 *
 * The domain string is the first element, as in every other node-signed
 * transcript (`nodeIdentity.ts`, the relay E2EE transcripts), so a signature
 * made here can never verify as any of them, and theirs never as this.
 *
 * What it proves: the address answered from a process holding the machine's
 * identity key, now. What it cannot prove on its own: that nobody relays the
 * conversation in between, because the socket after it is not bound to that key.
 * The transport rules out a relay (HTTPS names the host, WireGuard the peer),
 * which is why direct routes stay limited to those transports.
 *
 * Free of Node built-ins: the node, Desktop's renderer and the phone (Hermes)
 * all load it.
 */

export const DIRECT_ROUTE_IDENTITY_TRANSCRIPT_DOMAIN = "ryco.direct-route-identity.proof.v1";
export const DIRECT_ROUTE_IDENTITY_CHALLENGE_BYTES = 32;

export function encodeDirectRouteIdentityTranscript(input: {
  readonly environmentId: string;
  readonly challenge: Uint8Array;
}): Uint8Array {
  if (
    typeof input.environmentId !== "string" ||
    input.environmentId.length === 0 ||
    input.environmentId.length > 128 ||
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
        Uint8Array.from(input.challenge),
      ],
      rfc8949EncodeOptions,
    ),
  );
}

/**
 * Whether `signature` is the node identity key's signature over this client's
 * own challenge for `environmentId`. False for every failure, never throws: the
 * signature is bytes from the network.
 */
export function verifyDirectRouteIdentityProof(input: {
  readonly nodeIdentityPublicKey: Uint8Array;
  readonly environmentId: string;
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
