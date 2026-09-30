/**
 * Pairing links: `<endpoint>/pair#token=…` for a server reached directly, and
 * `<hosted app>/pair?host=<endpoint>#token=…` for a server reached from the
 * hosted web app. The token always travels in the fragment, so it never
 * reaches a server log or a `Referer` header.
 */

const PAIRING_TOKEN_PARAM = "token";

function readHashParams(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
}

export function getPairingTokenFromUrl(url: URL): string | null {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
}

export function stripPairingTokenFromUrl(url: URL): URL {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);
  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
}

export function setPairingTokenOnUrl(url: URL, credential: string): URL {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
}

/** `<endpoint>/pair#token=…`, for a client that reaches the endpoint directly. */
export function buildDirectPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  url.search = "";
  return setPairingTokenOnUrl(url, credential).toString();
}

/** `<hosted app>/pair?host=<endpoint>#token=…`, which the hosted app saves and connects to. */
export function buildHostedPairingUrl(input: {
  readonly hostedAppOrigin: string;
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  const url = new URL("/pair", input.hostedAppOrigin);
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}
