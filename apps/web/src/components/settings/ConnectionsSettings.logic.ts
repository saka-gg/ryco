import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "~/environments/runtime/catalog";

/**
 * The node no longer accepts this saved environment's pairing. Reconnecting
 * cannot fix that, so the row offers pairing again instead. An SSH environment
 * mints a fresh credential through its own tunnel, so it never needs one.
 */
export function savedBackendNeedsRepair(
  runtime: SavedEnvironmentRuntimeState | null,
  record: SavedEnvironmentRecord,
): boolean {
  return runtime?.authState === "requires-auth" && !record.desktopSsh;
}

/** The host to prefill when pairing a saved environment again. */
export function savedBackendRepairHost(record: SavedEnvironmentRecord): string {
  const url = new URL(record.httpBaseUrl);
  return url.pathname === "/" && url.search === "" && url.hash === ""
    ? url.origin
    : record.httpBaseUrl;
}
