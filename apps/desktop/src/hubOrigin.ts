import { canonicalizeHubOrigin } from "@ryco/shared/nodeIdentity";
import { isLoopbackHostname } from "@ryco/shared/loopbackHost";

/**
 * Why a typed Hub address was rejected.
 *
 * `canonicalizeHubOrigin` is a protocol validator: it answers yes or no, which
 * is exactly right for the connector and unusable for a text field. A person who
 * pasted a URL with a path deserves to be told that, not "invalid".
 */
export type HubOriginRejection =
  | "empty"
  | "too_long"
  | "not_a_url"
  | "insecure_scheme"
  | "has_credentials"
  | "has_path"
  | "invalid";

export type HubOriginValidation =
  | { readonly ok: true; readonly origin: string; readonly normalized: boolean }
  | { readonly ok: false; readonly reason: HubOriginRejection; readonly suggestion?: string };

const MAX_INPUT_LENGTH = 512;

/**
 * Canonicalize before validating, so ordinary typing survives.
 *
 * A trailing slash, a stray space, an uppercase host, and a missing scheme are
 * all things a person reasonably types; none of them is a different Hub. A path,
 * a query, or embedded credentials are not typos — those change what is being
 * addressed, so they are reported rather than silently stripped, with the bare
 * origin offered as a one-click fix.
 */
export function validateHubOrigin(raw: string): HubOriginValidation {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_INPUT_LENGTH) return { ok: false, reason: "too_long" };

  // A bare host is the single most common thing typed into a field like this.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "has_credentials" };
  }

  const isLoopback = isLoopbackHostname(url.hostname, { ipv4: "127.0.0.1" });
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    return { ok: false, reason: "insecure_scheme" };
  }

  const hasExtra =
    (url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "";
  if (hasExtra) {
    let suggestion: string | undefined;
    try {
      suggestion = canonicalizeHubOrigin(url.origin);
    } catch {
      suggestion = undefined;
    }
    return suggestion === undefined
      ? { ok: false, reason: "has_path" }
      : { ok: false, reason: "has_path", suggestion };
  }

  try {
    const origin = canonicalizeHubOrigin(url.origin);
    return { ok: true, origin, normalized: origin !== raw };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
