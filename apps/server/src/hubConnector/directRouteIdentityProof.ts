/**
 * The direct-route identity proof's answer (`directRouteIdentityHttp.ts`),
 * loaded on the first request. It imports no values: the route hands it the
 * node's own direct id and the connector's signer, so it adds nothing to boot.
 */

const PROOF_BURST = 10;
export const PROOF_REFILL_MS = 3_000;
const BASE64URL = /^[A-Za-z0-9_-]{1,64}$/u;

/** A bucket of `burst` proofs, one more every `refillMs`. */
export function makeProofPacer(input?: {
  readonly burst?: number;
  readonly refillMs?: number;
  readonly now?: () => number;
}): () => boolean {
  const burst = input?.burst ?? PROOF_BURST;
  const refillMs = input?.refillMs ?? PROOF_REFILL_MS;
  const now = input?.now ?? Date.now;
  let tokens = burst;
  let refilledAt = now();
  return () => {
    const at = now();
    const refills = Math.floor((at - refilledAt) / refillMs);
    if (refills > 0) {
      tokens = Math.min(burst, tokens + refills);
      refilledAt = tokens === burst ? at : refilledAt + refills * refillMs;
    }
    if (tokens === 0) return false;
    tokens -= 1;
    return true;
  };
}

const processPacer = makeProofPacer();

export interface DirectRouteIdentityProofAnswer {
  readonly status: 200 | 400 | 404 | 429;
  /** `{ signature }` on 200; empty otherwise, so a refusal says nothing about the node. */
  readonly body: { readonly signature?: string };
}

/**
 * Validate the request body, pace, and sign. Every proof reads the identity key
 * from the OS credential store, and the route runs before any credential, so
 * the bucket turns a flood into 429s instead of keychain reads; a client checks
 * a route at most once per connection attempt.
 */
export async function answerDirectRouteIdentityProof(input: {
  readonly body: unknown;
  /** The node's own direct id, never one the caller names. */
  readonly environmentId: string;
  readonly prove: (proof: {
    readonly environmentId: string;
    readonly challenge: Uint8Array;
  }) => Promise<Uint8Array | undefined>;
  readonly pace?: () => boolean;
}): Promise<DirectRouteIdentityProofAnswer> {
  const challenge =
    typeof input.body === "object" && input.body !== null && !Array.isArray(input.body)
      ? (input.body as { readonly challenge?: unknown }).challenge
      : undefined;
  if (typeof challenge !== "string" || !BASE64URL.test(challenge)) {
    return { status: 400, body: {} };
  }
  if (!(input.pace ?? processPacer)()) return { status: 429, body: {} };
  let signature: Uint8Array | undefined;
  try {
    signature = await input.prove({
      environmentId: input.environmentId,
      challenge: Uint8Array.from(Buffer.from(challenge, "base64url")),
    });
  } catch {
    // A challenge of the wrong size, a standby backend, a locked key store.
    return { status: 404, body: {} };
  }
  if (signature === undefined) return { status: 404, body: {} };
  return { status: 200, body: { signature: Buffer.from(signature).toString("base64url") } };
}
