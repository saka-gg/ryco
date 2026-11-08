/**
 * The addresses a node advertises, and which one a pairing link or QR code
 * goes through. Shared by the web's Connections settings and "Add a device"
 * dialog and the phone's machine access screen.
 */
import type { AdvertisedEndpoint } from "@ryco/contracts";
import { isHostUnreachableFromAnotherDevice } from "@ryco/shared/pairingQr";

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
  // The web links an HTTPS endpoint the hosted app can use to the hosted app.
  if (
    endpoint.compatibility.hostedHttpsApp === "compatible" &&
    endpoint.httpBaseUrl.startsWith("https:")
  ) {
    return "Opens the hosted app, no install needed";
  }
  return endpointReachabilityHint(endpoint);
}

/**
 * Who can reach an endpoint at all, from its reported reachability. `machine`
 * names the node for a loopback endpoint: the web describes the computer it
 * runs on, the phone a machine elsewhere.
 */
export function endpointReachabilityHint(
  endpoint: AdvertisedEndpoint,
  machine: string = "this computer",
): string {
  switch (endpoint.reachability) {
    case "lan":
      return "Devices on the same network";
    case "private-network":
      return "Devices on your private network";
    case "public":
      return "Reachable from anywhere";
    case "loopback":
      return `Clients on ${machine}`;
  }
}
