/**
 * directRouteIdentity - A Hub machine's direct address proving it is the
 * machine, before this client sends it a linked code or bearer
 * (`@ryco/shared/directRouteIdentity`, `docs/environment-routes.md`).
 *
 * Its own subpath, so the signature verifier loads with the route code that
 * needs it and never with the app's first paint.
 *
 * @module connection/directRouteIdentity
 */
import { DIRECT_ROUTE_IDENTITY_PATH } from "@ryco/contracts/direct-route-identity";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  DIRECT_ROUTE_IDENTITY_CHALLENGE_BYTES,
  verifyDirectRouteIdentityProof,
} from "@ryco/shared/directRouteIdentity";

import type { HttpClientService } from "../platform/index.ts";
import { decodeBase64Url, encodeBase64Url } from "../relay/base64url.ts";
import { fetchWithDeadline, REMOTE_CONTROL_PLANE_REQUEST_TIMEOUT_MS } from "./fetchWithDeadline.ts";

export type DirectRouteIdentityOutcome =
  /** The address signed this client's fresh challenge with the machine's identity key. */
  | "proven"
  /**
   * It answered, but not as the machine: another key, a bad signature, no
   * proof at all. Nothing is sent there until the link is renewed over the relay.
   */
  | "refused"
  /** No answer this time; the relay carries the machine meanwhile. */
  | "unreachable";

/** A direct address's answer to an identity challenge, before its signature is checked. */
export type DirectRouteIdentityProofAnswer =
  | { readonly kind: "signed"; readonly signature: string }
  /** It answered, but with no proof: no identity, a node older than the proof, or not a node. */
  | { readonly kind: "refused" }
  /** No answer this time: the network, a timeout, or the node pacing proofs. */
  | { readonly kind: "unreachable" };

/**
 * `@ryco/shared/directRouteIdentity`: ask a direct address to sign `challenge`.
 * Sends no credential.
 */
export async function requestDirectRouteIdentityProof(
  httpClient: HttpClientService,
  input: {
    readonly httpBaseUrl: string;
    readonly challenge: string;
    readonly signal?: AbortSignal;
  },
): Promise<DirectRouteIdentityProofAnswer> {
  let response: Awaited<ReturnType<HttpClientService["fetch"]>>;
  let text: string;
  try {
    response = await fetchWithDeadline(
      httpClient,
      new URL(DIRECT_ROUTE_IDENTITY_PATH, input.httpBaseUrl).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: input.challenge }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      REMOTE_CONTROL_PLANE_REQUEST_TIMEOUT_MS,
    );
    text = await response.text();
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 429 || response.status >= 500) return { kind: "unreachable" };
  if (!response.ok) return { kind: "refused" };
  try {
    const signature = (JSON.parse(text) as { readonly signature?: unknown }).signature;
    return typeof signature === "string" ? { kind: "signed", signature } : { kind: "refused" };
  } catch {
    return { kind: "refused" };
  }
}

/**
 * Challenge `httpBaseUrl` and check its answer against the node identity key
 * the linked grant named (base64url), for the machine's direct id. A fresh
 * challenge each time, so no earlier answer can be replayed. `requestProof` is
 * {@link requestDirectRouteIdentityProof} with the platform's HTTP client.
 */
export async function proveDirectRouteIdentity(input: {
  readonly httpBaseUrl: string;
  readonly environmentId: string;
  readonly nodeIdentityPublicKey: string;
  readonly requestProof: (request: {
    readonly httpBaseUrl: string;
    readonly challenge: string;
    readonly signal?: AbortSignal;
  }) => Promise<DirectRouteIdentityProofAnswer>;
  readonly signal?: AbortSignal;
  /** Test seam; production draws from the platform's CSPRNG and fails closed without one. */
  readonly randomBytes?: (length: number) => Uint8Array;
}): Promise<DirectRouteIdentityOutcome> {
  let nodeIdentityPublicKey: Uint8Array;
  try {
    nodeIdentityPublicKey = decodeBase64Url(input.nodeIdentityPublicKey);
  } catch {
    return "refused";
  }
  const challenge = (input.randomBytes ?? randomBytes)(DIRECT_ROUTE_IDENTITY_CHALLENGE_BYTES);
  const answer = await input.requestProof({
    httpBaseUrl: input.httpBaseUrl,
    challenge: encodeBase64Url(challenge),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (answer.kind !== "signed") return answer.kind;
  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(answer.signature);
  } catch {
    return "refused";
  }
  return verifyDirectRouteIdentityProof({
    nodeIdentityPublicKey,
    environmentId: input.environmentId,
    challenge,
    signature,
  })
    ? "proven"
    : "refused";
}
