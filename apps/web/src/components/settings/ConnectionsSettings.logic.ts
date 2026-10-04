import { SAVED_SESSION_LIFETIME_MS } from "@ryco/client-runtime/connection";
import { BROWSER_SAVED_ENVIRONMENT_BEARER_TOKEN_MAX_AGE_MS } from "@ryco/client-runtime/state/settings";

import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "~/environments/runtime/catalog";

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * What a saved pairing's credential lasts on this client. The node renews a
 * pairing in use up to a year after pairing, and one left unused for 30 days
 * lapses. A plain browser keeps the token in local storage, which drops it a
 * week after it was last written — at pairing or a renewal — so there the
 * browser's limit is the one that applies.
 */
export function savedPairingLifetimeNote(credentialStore: "desktop" | "browser"): string {
  const idleDays = Math.round(
    (credentialStore === "browser"
      ? Math.min(BROWSER_SAVED_ENVIRONMENT_BEARER_TOKEN_MAX_AGE_MS, SAVED_SESSION_LIFETIME_MS)
      : SAVED_SESSION_LIFETIME_MS) / DAY_MS,
  );
  const holder = credentialStore === "browser" ? "this browser" : "this app";
  return (
    `The pairing code is not kept; ${holder} stores a session token that renews itself ` +
    `while in use. Pair again after ${idleDays} days without use, or one year after pairing.`
  );
}
