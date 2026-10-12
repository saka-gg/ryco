import type { DpopProofInput, DpopSignerService } from "../platform/index.ts";
import { encodeBase64Url } from "./base64url.ts";

/**
 * DPoP proof construction (RFC 9449), shared by every platform that speaks
 * bearer mode. The signing key is hardware-backed and never leaves the
 * platform; this module owns only the claim assembly, the `ath`
 * present-on-authenticated / absent-on-mint branch, and the asymmetric
 * algorithm allow-list (the client half of the JWS-confusion defense).
 */

/** The only proof algorithms accepted: `alg:none` and any `HS*` are rejected. */
export type DpopAlgorithm = "ES256" | "RS256";

const ALLOWED_DPOP_ALGORITHMS: ReadonlySet<string> = new Set<DpopAlgorithm>(["ES256", "RS256"]);

/**
 * The public JWK embedded in the proof header. Only public members are
 * permitted; a JWK carrying any private field is rejected so a private key can
 * never be serialized into a proof.
 */
export interface DpopPublicJwk {
  readonly kty: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly n?: string;
  readonly e?: string;
}

/** Private JWK members that must never appear in a proof header. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"] as const;

/**
 * The low-level hardware key seam. `sign` receives the ASCII JWS signing input
 * (`base64url(header).base64url(payload)`) and returns the raw signature bytes;
 * the enclave/StrongBox owns the private key and the actual signing.
 */
export interface DpopSigningKey {
  readonly algorithm: DpopAlgorithm;
  readonly publicJwk: DpopPublicJwk;
  readonly sign: (signingInput: Uint8Array) => Promise<Uint8Array>;
}

/** Injected clock, unique-id, and digest primitives (no ambient crypto reads). */
export interface DpopProofContext {
  /** Milliseconds since the epoch; `iat` is derived as the floor of seconds. */
  readonly now: () => number;
  /** A fresh, unguessable proof id (single-use on state-changing requests). */
  readonly randomJti: () => string;
  /** SHA-256 of the bytes; used only to derive `ath` from the presented token. */
  readonly sha256: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Reject any private JWK material, then copy ONLY the allowed public members —
 * read as primitives — into a fresh object literal. The proof header serializes
 * this copy, never the caller's object, so a JWK with a custom `toJSON()` cannot
 * smuggle a private field such as `d` into the header even though the member
 * check (which sees only own-properties) passed.
 */
function sanitizePublicJwk(jwk: DpopPublicJwk): DpopPublicJwk {
  for (const member of PRIVATE_JWK_MEMBERS) {
    if (member in jwk) {
      throw new Error("DPoP proof JWK must not carry private key material.");
    }
  }
  const readString = (member: string, value: string | undefined): string => {
    if (typeof value !== "string") {
      throw new Error(`DPoP proof JWK member \`${member}\` must be a string.`);
    }
    return value;
  };
  const sanitized: {
    kty: string;
    crv?: string;
    x?: string;
    y?: string;
    n?: string;
    e?: string;
  } = { kty: readString("kty", jwk.kty) };
  if (jwk.crv !== undefined) sanitized.crv = readString("crv", jwk.crv);
  if (jwk.x !== undefined) sanitized.x = readString("x", jwk.x);
  if (jwk.y !== undefined) sanitized.y = readString("y", jwk.y);
  if (jwk.n !== undefined) sanitized.n = readString("n", jwk.n);
  if (jwk.e !== undefined) sanitized.e = readString("e", jwk.e);
  return sanitized;
}

/** `htu` is the request URL with any query and fragment stripped. */
function canonicalHttpUri(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function encodeSegment(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Build a compliant {@link DpopSignerService} from a hardware key and injected
 * crypto primitives. Rejects a non-asymmetric algorithm or a JWK with private
 * material up front, so a misconfigured signer fails closed at construction
 * rather than emitting an unsafe proof.
 */
export function createDpopProofSigner(
  key: DpopSigningKey,
  context: DpopProofContext,
): DpopSignerService {
  if (!ALLOWED_DPOP_ALGORITHMS.has(key.algorithm)) {
    throw new Error("DPoP proofs require an asymmetric ES256 or RS256 key.");
  }
  const publicJwk = sanitizePublicJwk(key.publicJwk);
  const headerSegment = encodeSegment({ typ: "dpop+jwt", alg: key.algorithm, jwk: publicJwk });
  // `ath` is a pure function of the access token, and every authenticated
  // request presents the same token until it rotates. Remembering the one
  // current pair spares a platform digest (a native bridge hop on mobile) per
  // request; a different token replaces it, so a rotated or cleared session
  // never reuses the previous hash. The per-proof signature is inherent to DPoP
  // (fresh `iat`/`jti`/`htu`) and is not affected.
  let athCache: { readonly token: string; readonly ath: Promise<string> } | null = null;
  const accessTokenHash = (token: string): Promise<string> => {
    if (athCache?.token === token) return athCache.ath;
    const ath = context
      .sha256(new TextEncoder().encode(token))
      .then((digest) => encodeBase64Url(digest));
    const entry = { token, ath };
    athCache = entry;
    // A failed digest must not be remembered for the token.
    ath.catch(() => {
      if (athCache === entry) athCache = null;
    });
    return ath;
  };
  return {
    sign: async ({ method, url, token }: DpopProofInput): Promise<string> => {
      const payload: Record<string, unknown> = {
        htm: method.toUpperCase(),
        htu: canonicalHttpUri(url),
        iat: Math.floor(context.now() / 1000),
        jti: context.randomJti(),
      };
      if (token !== undefined) {
        payload.ath = await accessTokenHash(token);
      }
      const signingInput = `${headerSegment}.${encodeSegment(payload)}`;
      const signature = await key.sign(new TextEncoder().encode(signingInput));
      return `${signingInput}.${encodeBase64Url(signature)}`;
    },
  };
}
