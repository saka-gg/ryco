/**
 * CLIProxyAPI hub addresses, shared by the server (requests, routing, key binding) and clients
 * (hub forms, hub identity across nodes).
 *
 * @module cliProxyHubUrl
 */

import { isLoopbackHostname, type LoopbackHostnameOptions } from "./loopbackHost.ts";

/**
 * Which hub URL hostnames name the local machine (`isLoopbackHostname` options). `0.0.0.0`
 * counts: a hub bound to every interface is reached here. IPv4 is `127.0.0.1` only, as these
 * checks answered before `loopbackHost` existed.
 */
export const HUB_LOOPBACK_HOST = {
  ipv4: "127.0.0.1",
  unspecified: true,
} as const satisfies LoopbackHostnameOptions;

/**
 * The hub's base URL, or null when unusable. Accepts a pasted management URL
 * (`…/v0/management`) or Management Center URL (`…/management.html`) as the base. Rejects
 * embedded credentials: the management key authenticates, and settings are visible to clients.
 */
export function normalizeHubBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const path = url.pathname
    .replace(/\/management\.html$/i, "")
    .replace(/\/v[08]\/management(\/.*)?$/i, "")
    .replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/**
 * The address a stored management key is bound to: scheme, host and port, with loopback hosts
 * interchangeable. Credentials in the URL are not part of the address. A saved key is never sent
 * to a different address unless it is entered again.
 */
export function hubKeyAddress(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isLoopbackHostname(url.hostname, HUB_LOOPBACK_HOST)) url.hostname = "localhost";
  return `${url.protocol}//${url.host}`;
}
