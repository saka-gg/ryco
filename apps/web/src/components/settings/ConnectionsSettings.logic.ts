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

/**
 * The row's connection button. Next to Re-pair it reads "Retry": the node's
 * rejection may have been a passing fault on its side, and a retry checks the
 * saved pairing again without replacing it.
 */
export function savedBackendConnectionActionLabel(input: {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly isDisconnecting: boolean;
  readonly needsRepair: boolean;
}): string {
  if (input.isConnected) return input.isDisconnecting ? "Disconnecting…" : "Disconnect";
  if (input.isConnecting) return "Connecting…";
  return input.needsRepair ? "Retry" : "Connect";
}
