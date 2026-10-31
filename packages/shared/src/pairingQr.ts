/**
 * Which pairing links another device can open, so a QR code is drawn only for
 * those: the CLI's terminal codes and the web's. A module of its own because
 * `pairingUrl` is in the web boot graph and this rule is not.
 *
 * @module pairingQr
 */

/**
 * A loopback host: the local machine only. An unset or empty host counts, the way a listener
 * given no host is reached through `localhost`.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/** The unspecified address: a listener bound to every interface, never a host to dial. */
export function isWildcardHost(host: string | undefined): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/**
 * A URL hostname another device cannot reach this node at: loopback in any spelling the URL
 * parser leaves (127/8, `::1`, IPv4-mapped `::ffff:7f..`, `localhost` and its subdomains, with or
 * without a trailing dot) and the unspecified addresses. A phone scanning a QR code for one of
 * these would reach itself.
 */
export function isHostUnreachableFromAnotherDevice(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    isLoopbackHost(host) ||
    host.endsWith(".localhost") ||
    isWildcardHost(host) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(host) ||
    host.startsWith("[::ffff:127.")
  );
}

/**
 * The pairing link to draw as a QR code, or null when another device could not reach it. The
 * one rule for every pairing QR code: the CLI's terminal codes and the web's.
 */
export function pairingQrUrl(pairingUrl: string): string | null {
  try {
    return isHostUnreachableFromAnotherDevice(new URL(pairingUrl).hostname) ? null : pairingUrl;
  } catch {
    return null;
  }
}
