import * as Schema from "effect/Schema";

// Pure pairing-URL / QR-payload helpers (§Task 6). Ported from the upstream
// connection/pairing.ts, renaming the upstream QR scheme to B1's shipped
// per-variant plain schemes (`ryco:` / `ryco-dev:` / `ryco-preview:`) and dropping
// the hosted-pairing branch (C-gated: readHostedPairingRequest is inert here).

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";
const PAIRING_TOKEN_PARAM = "token";
const RYCO_PAIRING_SCHEMES = new Set(["ryco:", "ryco-dev:", "ryco-preview:"]);

export class PairingQrPayloadEmptyError extends Schema.TaggedError<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return "Scanned QR code did not contain a pairing URL.";
  }
}

export function buildPairingUrl(host: string, code: string): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  if (!c) return h;

  try {
    const url = new URL(h.includes("://") ? h : `https://${h}`);
    url.hash = new URLSearchParams([["token", c]]).toString();
    return url.toString();
  } catch {
    return `${h}#token=${c}`;
  }
}

/**
 * Extract a pairing token from a deep-link/QR URL. The token is carried in the
 * URL fragment (`#token=...`), matching the web take-once invariant, and falls
 * back to the query string.
 */
export function extractPairingToken(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashToken = new URLSearchParams(hash).get(PAIRING_TOKEN_PARAM)?.trim();
  if (hashToken) return hashToken;
  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim();
  return searchToken ? searchToken : null;
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new PairingQrPayloadEmptyError({});
  }

  try {
    const url = new URL(trimmed);
    if (RYCO_PAIRING_SCHEMES.has(url.protocol)) {
      const pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
      if (pairingUrl.length > 0) {
        return pairingUrl;
      }
    }
  } catch {
    // Non-URL payloads pass through as raw pairing-url text for normal validation.
  }

  return trimmed;
}
