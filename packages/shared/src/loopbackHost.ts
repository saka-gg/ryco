/**
 * Whether a host names this machine: one rule for every package, with the few deliberate
 * differences spelled out as options at the call site.
 *
 * @module loopbackHost
 */

export interface LoopbackHostnameOptions {
  /**
   * Which IPv4 hosts count:
   * - `"range"` (the default): any 127/8 address.
   * - `"127.0.0.1"`: only that address, for checks written against it.
   * - `"127-prefix"`: any host that starts with `127.`, which includes DNS names such as
   *   `127.example.com`. Kept only where callers answered that way before this module existed;
   *   see each call site.
   */
  readonly ipv4?: "range" | "127.0.0.1" | "127-prefix";
  /** Also count the unspecified address `0.0.0.0`, which a client on this machine reaches. */
  readonly unspecified?: boolean;
  /** Also count names under `localhost` (`app.localhost`), which resolve to loopback. */
  readonly localhostSubdomains?: boolean;
}

/**
 * Whether `hostname` is a loopback host: `localhost`, a 127/8 address or `::1`. Case and
 * surrounding whitespace are ignored, and IPv6 may be bracketed the way URL hostnames are
 * (`[::1]`) or bare (`::1`). An empty host is not loopback; callers that treat a missing host
 * as "the local listener" say so themselves.
 */
export function isLoopbackHostname(
  hostname: string,
  options: LoopbackHostnameOptions = {},
): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1");
  if (host === "localhost" || host === "::1") return true;
  if (isIpv4Loopback(host, options.ipv4 ?? "range")) return true;
  if (options.unspecified === true && host === "0.0.0.0") return true;
  return options.localhostSubdomains === true && host.endsWith(".localhost");
}

function isIpv4Loopback(host: string, mode: NonNullable<LoopbackHostnameOptions["ipv4"]>): boolean {
  switch (mode) {
    case "127.0.0.1":
      return host === "127.0.0.1";
    case "127-prefix":
      return host.startsWith("127.");
    case "range":
      return /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u.test(host);
  }
}
