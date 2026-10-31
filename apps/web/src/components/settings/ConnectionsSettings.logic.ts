import { SAVED_SESSION_LIFETIME_MS } from "@ryco/client-runtime/connection";
import { BROWSER_SAVED_ENVIRONMENT_BEARER_TOKEN_MAX_AGE_MS } from "@ryco/client-runtime/state/settings";
import type { AdvertisedEndpoint } from "@ryco/contracts";
import { isHostUnreachableFromAnotherDevice } from "@ryco/shared/pairingQr";

import type {
  SavedEnvironmentRecord,
  SavedEnvironmentRuntimeState,
} from "~/environments/runtime/catalog";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

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

export function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

/**
 * The saved "default endpoint" preference for an endpoint: stable per kind of
 * endpoint, so several endpoints can share one.
 */
export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:") || endpoint.id.startsWith("server-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:") || endpoint.id.startsWith("server-network:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (isTailscaleHttpsEndpoint(endpoint)) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

/**
 * The endpoint pairing links and "Reachable at" use: the saved default, else
 * the one the node marks default, else the first one that is not loopback.
 * It can be loopback (an owner may pick that default); a QR code goes through
 * `selectQrEndpoint` instead.
 */
export function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

/** The pairing link for an endpoint: the hosted-app link for an HTTPS endpoint it can open. */
export function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

export function isHostedAppPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
}

/**
 * Whether another device can open a node at `baseUrl`: an HTTP(S) address that
 * is not loopback in any spelling (the CLI's QR rule, `pairingQrUrl`).
 */
export function isQrShareableBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !isHostUnreachableFromAnotherDevice(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * A QR code for a loopback endpoint makes the scanning device dial itself, so
 * loopback endpoints stay copyable but never become a QR code. The address is
 * checked as well as the reachability the node reported.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return (
    endpoint.status !== "unavailable" &&
    endpoint.reachability !== "loopback" &&
    isQrShareableBaseUrl(endpoint.httpBaseUrl)
  );
}

export interface QrEndpointSelection {
  readonly endpoint: AdvertisedEndpoint;
  /** False for an endpoint another device cannot reach: it gets "No QR for this endpoint". */
  readonly qrShareable: boolean;
}

/**
 * The endpoint a pairing QR code uses: the owner's explicit pick (by endpoint
 * id, any available endpoint), else the saved default, else the endpoint the
 * node marks default, else the first one another device can reach. Only an
 * explicit pick can land on an endpoint that is not shareable, and it comes
 * back with `qrShareable: false`; a stale pick falls back. Null when no
 * endpoint another device can reach exists.
 */
export function selectQrEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  input: { readonly selectedId?: string | null; readonly defaultEndpointKey?: string | null } = {},
): QrEndpointSelection | null {
  const available = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  const picked =
    input.selectedId == null
      ? undefined
      : available.find((endpoint) => endpoint.id === input.selectedId);
  if (picked) {
    return { endpoint: picked, qrShareable: isQrShareableEndpoint(picked) };
  }
  const shareable = available.filter(isQrShareableEndpoint);
  const endpoint =
    (input.defaultEndpointKey
      ? shareable.find(
          (candidate) => endpointDefaultPreferenceKey(candidate) === input.defaultEndpointKey,
        )
      : undefined) ??
    shareable.find((candidate) => candidate.isDefault) ??
    shareable[0];
  return endpoint ? { endpoint, qrShareable: true } : null;
}

/** Who can open an endpoint's pairing link, under its label in an endpoint choice. */
export function endpointShareHint(endpoint: AdvertisedEndpoint): string {
  // `resolveAdvertisedEndpointPairingUrl` links an HTTPS endpoint the hosted app can use there.
  if (
    endpoint.compatibility.hostedHttpsApp === "compatible" &&
    endpoint.httpBaseUrl.startsWith("https:")
  ) {
    return "Opens the hosted app, no install needed";
  }
  switch (endpoint.reachability) {
    case "lan":
      return "Devices on the same network";
    case "private-network":
      return "Devices on your private network";
    case "public":
      return "Reachable from anywhere";
    case "loopback":
      return "Clients on this computer";
  }
}
