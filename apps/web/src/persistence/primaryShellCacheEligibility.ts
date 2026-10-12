// Kept apart from `primaryShellCache.ts` so the boot path can decide without
// loading the store.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether this page keeps a last-known copy of the primary environment's shell:
 * only the desktop app or a page served on loopback, i.e. a page on the node's
 * own machine. A browser that merely paired with a node over the network
 * keeps no copy without asking (the hosted equivalent is opt-in).
 */
export function isPrimaryShellCacheEligible(input: {
  readonly hostname: string;
  readonly desktop: boolean;
}): boolean {
  return input.desktop || LOOPBACK_HOSTNAMES.has(input.hostname.toLowerCase());
}
