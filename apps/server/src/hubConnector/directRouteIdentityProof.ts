/**
 * The direct-route identity proof's answer (`directRouteIdentityHttp.ts`),
 * loaded on the first request. It imports no values: the route hands it the
 * node's own direct id, its advertised origins and the connector's signer, so
 * it adds nothing to boot.
 */

const BASE64URL = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_ORIGIN_CHARS = 512;

interface Bucket {
  tokens: number;
  refilledAt: number;
}

/** A bucket of `burst` tokens, one more every `refillMs`. */
function takeToken(bucket: Bucket, at: number, burst: number, refillMs: number): boolean {
  const refills = Math.floor((at - bucket.refilledAt) / refillMs);
  if (refills > 0) {
    bucket.tokens = Math.min(burst, bucket.tokens + refills);
    bucket.refilledAt = bucket.tokens === burst ? at : bucket.refilledAt + refills * refillMs;
  }
  if (bucket.tokens === 0) return false;
  bucket.tokens -= 1;
  return true;
}

export const PROOF_RETRY_AFTER_SECONDS = 5;

/**
 * Proof pacing: every proof reads the identity key from the OS credential
 * store, and the route runs before any credential. Each remote address gets a
 * small bucket of its own, so one peer (or a web page in a browser on the
 * network) can only exhaust its own, and a global ceiling bounds the key reads
 * a crowd of addresses can cause. A client checks a route about once a minute.
 */
export function makeProofPacer(input?: {
  readonly perAddressBurst?: number;
  readonly perAddressRefillMs?: number;
  readonly globalBurst?: number;
  readonly globalRefillMs?: number;
  readonly maxAddresses?: number;
  readonly now?: () => number;
}): (remoteAddress: string) => boolean {
  const perAddressBurst = input?.perAddressBurst ?? 6;
  const perAddressRefillMs = input?.perAddressRefillMs ?? PROOF_RETRY_AFTER_SECONDS * 1000;
  const globalBurst = input?.globalBurst ?? 60;
  const globalRefillMs = input?.globalRefillMs ?? 1000;
  const maxAddresses = input?.maxAddresses ?? 512;
  const now = input?.now ?? Date.now;
  const global: Bucket = { tokens: globalBurst, refilledAt: now() };
  // Insertion-ordered: the address seen longest ago goes first when it is full.
  const byAddress = new Map<string, Bucket>();
  return (remoteAddress) => {
    const at = now();
    let bucket = byAddress.get(remoteAddress);
    if (bucket === undefined) {
      if (byAddress.size >= maxAddresses) {
        byAddress.delete(byAddress.keys().next().value!);
      }
      bucket = { tokens: perAddressBurst, refilledAt: at };
    } else {
      byAddress.delete(remoteAddress);
    }
    byAddress.set(remoteAddress, bucket);
    if (!takeToken(bucket, at, perAddressBurst, perAddressRefillMs)) return false;
    return takeToken(global, at, globalBurst, globalRefillMs);
  };
}

const processPacer = makeProofPacer();

export interface DirectRouteIdentityProofAnswer {
  readonly status: 200 | 400 | 404 | 429;
  /** `{ signature }` on 200; empty otherwise, so a refusal says nothing about the node. */
  readonly body: { readonly signature?: string };
}

/**
 * Validate the request body, pace by remote address, and sign. The node signs
 * only for an origin it advertises right now: an address that now belongs to
 * another device can pass a client's challenge through or redirect it here,
 * and gets nothing for it.
 */
export async function answerDirectRouteIdentityProof(input: {
  readonly body: unknown;
  /** The node's own direct id, never one the caller names. */
  readonly environmentId: string;
  /** The origins of the node's advertised endpoints, as `URL.origin` writes them. */
  readonly advertisedOrigins: ReadonlyArray<string>;
  readonly remoteAddress: string;
  readonly prove: (proof: {
    readonly environmentId: string;
    readonly origin: string;
    readonly challenge: Uint8Array;
  }) => Promise<Uint8Array | undefined>;
  readonly pace?: (remoteAddress: string) => boolean;
}): Promise<DirectRouteIdentityProofAnswer> {
  const body =
    typeof input.body === "object" && input.body !== null && !Array.isArray(input.body)
      ? (input.body as { readonly challenge?: unknown; readonly origin?: unknown })
      : {};
  const { challenge, origin } = body;
  if (
    typeof challenge !== "string" ||
    !BASE64URL.test(challenge) ||
    typeof origin !== "string" ||
    origin.length > MAX_ORIGIN_CHARS
  ) {
    return { status: 400, body: {} };
  }
  if (!(input.pace ?? processPacer)(input.remoteAddress)) return { status: 429, body: {} };
  if (!input.advertisedOrigins.includes(origin)) return { status: 404, body: {} };
  let signature: Uint8Array | undefined;
  try {
    signature = await input.prove({
      environmentId: input.environmentId,
      origin,
      challenge: Uint8Array.from(Buffer.from(challenge, "base64url")),
    });
  } catch {
    // A malformed challenge or origin, a standby backend, a locked key store.
    return { status: 404, body: {} };
  }
  if (signature === undefined) return { status: 404, body: {} };
  return { status: 200, body: { signature: Buffer.from(signature).toString("base64url") } };
}
