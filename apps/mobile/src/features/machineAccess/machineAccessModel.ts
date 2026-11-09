import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "@ryco/client-runtime/connection";
import {
  accessRoleLabel,
  clientSessionDetail,
  clientSessionIsLive,
  clientSessionPrimaryLabel,
  pairingLinkCanShare,
  pairingLinkPrimaryLabel,
} from "@ryco/client-runtime/machineAccess/authAccess";
import {
  endpointReachabilityHint,
  isQrShareableEndpoint,
  isTailscaleHttpsEndpoint,
  selectPairingEndpoint,
  selectQrEndpoint,
} from "@ryco/client-runtime/machineAccess/advertisedEndpoints";
import type { AddDeviceView } from "@ryco/client-runtime/machineAccess/addDeviceCode";
import type {
  AdvertisedEndpoint,
  AuthSessionRole,
  RelayEffectiveRole,
  ServerAuthPolicy,
} from "@ryco/contracts";
import { buildDirectPairingUrl } from "@ryco/shared/pairingUrl";

/**
 * The phone's machine access screen, as data: what this client may manage on
 * one machine, and how each list row reads.
 *
 * Who may do what is the node's and the Hub's decision; this only mirrors it so
 * the screen never offers a control the node would refuse, and says why when it
 * does not. Pairing links and clients go through the node's owner-only routes
 * over a direct connection (the Hub relay never carries them), and revoking a
 * node goes to the Hub with the account's owner role.
 */

/** What the direct half of the screen can show. */
export type DirectAccessAvailability =
  | { readonly kind: "available" }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "hub-only"
        | "not-owner"
        | "switched-off"
        | "needs-pairing"
        | "not-connected";
      readonly title: string;
      readonly detail: string;
    };

export interface DirectPairingInput {
  readonly label: string;
  readonly role: AuthSessionRole | null;
  readonly connected: boolean;
  readonly switchedOff: boolean;
  readonly requiresAuth: boolean;
}

/**
 * Whether this phone can manage the machine's pairing links and clients.
 *
 * The node lists them only to an owner session connected directly
 * (`subscribeAuthAccess` is direct-owner only, and the pairing routes check the
 * owner role), so a Hub-only machine and a client pairing are explained rather
 * than offered.
 */
export function deriveDirectAccessAvailability(
  direct: DirectPairingInput | null,
  machineLabel: string,
): DirectAccessAvailability {
  if (direct === null) {
    return {
      kind: "unavailable",
      reason: "hub-only",
      title: "Reached through the Hub only",
      detail:
        "Pairing links and paired clients are managed over a direct connection with owner access. " +
        `Pair ${machineLabel} directly with an owner pairing link to manage them here.`,
    };
  }
  if (direct.switchedOff) {
    return {
      kind: "unavailable",
      reason: "switched-off",
      title: "Switched off",
      detail: `Switch ${direct.label} on in Machines to manage its pairing links and clients.`,
    };
  }
  if (direct.requiresAuth) {
    return {
      kind: "unavailable",
      reason: "needs-pairing",
      title: "Pair again",
      detail: `${direct.label} no longer accepts this phone's pairing. Pair it again to manage its access.`,
    };
  }
  if (direct.role !== null && direct.role !== "owner") {
    return {
      kind: "unavailable",
      reason: "not-owner",
      title: "This phone is paired as a client",
      detail:
        "Only an owner pairing can create pairing links or remove clients. On the machine, " +
        "create an owner link with “ryco auth pairing create --role owner” and pair this phone with it.",
    };
  }
  if (!direct.connected || direct.role === null) {
    return {
      kind: "unavailable",
      reason: "not-connected",
      title: "Not connected",
      detail: `Connect to ${direct.label} to see its pairing links and clients.`,
    };
  }
  return { kind: "available" };
}

/** What the Hub half of the screen can show for a node in the directory. */
export type HubRevokeAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly detail: string };

export function deriveHubRevokeAvailability(input: {
  readonly node: Pick<HostedHubNode, "revokedAt">;
  readonly signedIn: boolean;
  /** The Hub account's role (`account.role`), which is what the Hub checks. */
  readonly accountRole: RelayEffectiveRole | null;
}): HubRevokeAvailability {
  if (!input.signedIn) {
    return { kind: "unavailable", detail: "Sign in to your Hub to manage this node." };
  }
  if (input.node.revokedAt !== null) {
    return {
      kind: "unavailable",
      detail: "This node is already revoked on the Hub. There is nothing left to revoke.",
    };
  }
  if (input.accountRole !== "owner") {
    return { kind: "unavailable", detail: "Only an owner of this Hub can revoke a node." };
  }
  return { kind: "available" };
}

const HUB_ROLE_LABELS: Record<RelayEffectiveRole, string> = {
  viewer: "viewer",
  operator: "operator",
  owner: "owner",
};

/** The screen's heading: the machine's name and how this phone reaches it. */
export function machineAccessHeader(input: {
  readonly directLabel: string | null;
  readonly directRole: AuthSessionRole | null;
  readonly hubNode: Pick<HostedHubNode, "label" | "effectiveRole"> | null;
}): { readonly title: string; readonly subtitle: string; readonly known: boolean } {
  const parts: string[] = [];
  if (input.directLabel !== null) {
    parts.push(
      input.directRole === null
        ? "Paired directly"
        : `Paired directly as ${accessRoleLabel(input.directRole).toLowerCase()}`,
    );
  }
  if (input.hubNode !== null) {
    parts.push(`On your Hub as ${HUB_ROLE_LABELS[input.hubNode.effectiveRole]}`);
  }
  const known = parts.length > 0;
  return {
    title: input.directLabel ?? (input.hubNode === null ? "Machine" : input.hubNode.label),
    subtitle: known ? parts.join(" · ") : "This phone has no pairing for this machine.",
    known,
  };
}

const PLATFORM_LABELS: Record<HostedHubNode["platformOs"], string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  unknown: "Unknown platform",
};

export function hubNodePlatformLabel(node: Pick<HostedHubNode, "platformOs" | "platformArch">) {
  return `${PLATFORM_LABELS[node.platformOs]} · ${node.platformArch}`;
}

/** "Expires in 4m" — coarse, because the row is read, not timed. */
export function expiresInLabel(expiresAt: string, nowMs: number): string {
  const remainingMs = Date.parse(expiresAt) - nowMs;
  if (!(remainingMs > 0)) return "Expired";
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Expires in ${hours}h`;
  return `Expires in ${Math.floor(hours / 24)}d`;
}

/** "3h ago" from an ISO instant; "just now" under a minute. */
export function agoLabel(iso: string, nowMs: number): string {
  const elapsedMs = nowMs - Date.parse(iso);
  if (!(elapsedMs >= 60_000)) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface PairingLinkRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** The credential to share; null for an owner link, which is listed only so it can be revoked. */
  readonly credential: string | null;
  readonly note: string | null;
}

/** The links the node still accepts, newest first; expired ones drop out on their own. */
export function pairingLinkRows(
  links: ReadonlyArray<ServerPairingLinkRecord>,
  nowMs: number,
): ReadonlyArray<PairingLinkRow> {
  return links
    .filter((link) => Date.parse(link.expiresAt) > nowMs)
    .map((link) => {
      const canShare = pairingLinkCanShare(link);
      return {
        id: link.id,
        title: pairingLinkPrimaryLabel(link),
        detail: `${accessRoleLabel(link.role)} · ${expiresInLabel(link.expiresAt, nowMs)}`,
        credential: canShare ? link.credential : null,
        note: canShare ? null : "Grants full access to this machine, so its link is not shown.",
      };
    });
}

export interface ClientSessionRow {
  readonly sessionId: ServerClientSessionRecord["sessionId"];
  readonly title: string;
  readonly detail: string;
  /** "This device", "Connected", "Last connected 3h ago" or "Not connected yet". */
  readonly status: string;
  readonly live: boolean;
  readonly current: boolean;
  /** This phone's own session is never offered for removal: it would cut the screen off. */
  readonly canRevoke: boolean;
}

export function clientSessionRows(
  sessions: ReadonlyArray<ServerClientSessionRecord>,
  nowMs: number,
): ReadonlyArray<ClientSessionRow> {
  return sessions.map((session) => {
    const live = clientSessionIsLive(session);
    const status = session.current
      ? "This device"
      : live
        ? "Connected"
        : session.lastConnectedAt === null
          ? "Not connected yet"
          : `Last connected ${agoLabel(session.lastConnectedAt, nowMs)}`;
    return {
      sessionId: session.sessionId,
      title: clientSessionPrimaryLabel(session),
      detail: clientSessionDetail(session),
      status,
      live,
      current: session.current,
      canRevoke: !session.current,
    };
  });
}

/** Whether "Remove all other clients" has anything to remove. */
export function hasOtherClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return sessions.some((session) => !session.current);
}

export interface ConfirmCopy {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
}

export function revokePairingLinkConfirm(row: Pick<PairingLinkRow, "title">): ConfirmCopy {
  return {
    title: `Revoke ${row.title}?`,
    message:
      "Nobody can pair with this link any more. Devices that already paired with it stay paired.",
    confirmText: "Revoke link",
  };
}

export function revokeClientSessionConfirm(
  row: Pick<ClientSessionRow, "title">,
  machineLabel: string,
): ConfirmCopy {
  return {
    title: `Remove ${row.title}?`,
    message: `It is disconnected from ${machineLabel} now and needs a new pairing link to come back.`,
    confirmText: "Remove client",
  };
}

export function revokeOtherClientSessionsConfirm(machineLabel: string): ConfirmCopy {
  return {
    title: "Remove all other clients?",
    message:
      `Every client paired with ${machineLabel} except this phone is disconnected and needs a ` +
      "new pairing link before it reconnects.",
    confirmText: "Remove others",
  };
}

export function revokedOthersNotice(count: number): string {
  return count === 1 ? "Removed 1 other client." : `Removed ${count} other clients.`;
}

export interface NetworkEndpointRow {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly hint: string;
  readonly status: "Available" | "Unavailable" | "Unknown";
  readonly isDefault: boolean;
}

export interface NetworkExposureView {
  /** One sentence on whether the node listens beyond itself, when the node said. */
  readonly summary: string | null;
  readonly endpoints: ReadonlyArray<NetworkEndpointRow>;
  readonly tailscaleHttps: "on" | "off" | null;
  readonly footnote: string;
}

const STATUS_LABELS: Record<AdvertisedEndpoint["status"], NetworkEndpointRow["status"]> = {
  available: "Available",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The machine's reach, read-only. Network access and Tailscale HTTPS are changed
 * through the desktop app's own bridge on that machine (or the flags it was
 * started with); no node route changes them, so the phone only reports them.
 */
export function deriveNetworkExposure(input: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly authPolicy: ServerAuthPolicy | null;
}): NetworkExposureView {
  const pairingDefault = selectPairingEndpoint(input.endpoints);
  const tailscale = input.endpoints.find(isTailscaleHttpsEndpoint) ?? null;
  const summary =
    input.authPolicy === "remote-reachable"
      ? "Network access is on: other devices can reach this machine."
      : input.authPolicy === "desktop-managed-local" || input.authPolicy === "loopback-browser"
        ? "Network access is off: the machine only accepts connections from itself."
        : input.authPolicy === "unsafe-no-auth"
          ? "This machine accepts connections without pairing."
          : null;
  return {
    summary,
    endpoints: input.endpoints.map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.label,
      url: hostOf(endpoint.httpBaseUrl),
      hint: endpointReachabilityHint(endpoint, "that machine"),
      status: STATUS_LABELS[endpoint.status],
      isDefault: pairingDefault?.id === endpoint.id,
    })),
    tailscaleHttps: tailscale === null ? null : tailscale.status === "available" ? "on" : "off",
    footnote:
      "Network access and Tailscale HTTPS are changed on the machine itself, in Ryco Desktop's " +
      "Connections settings, so they are shown here read-only.",
  };
}

export interface PairingShareView {
  /** The link to share, or null while there is no endpoint another device can reach. */
  readonly url: string | null;
  /** The QR payload: never a loopback address, which would make the scanner dial itself. */
  readonly qrUrl: string | null;
  readonly selectedEndpointId: string | null;
  /** The endpoint's address, for a computer that enters the code by hand. */
  readonly address: string | null;
  readonly choices: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly hint: string;
  }>;
}

/**
 * The link a minted code travels in: `<endpoint>/pair#token=…`, the direct
 * pairing link every Ryco client and the node's own web app open. The phone
 * does not mint hosted-app links: which hosted app a recipient uses is the
 * desktop's setting, not this phone's.
 */
export function derivePairingShare(input: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly selectedEndpointId: string | null;
  readonly credential: string | null;
}): PairingShareView {
  const selection = selectQrEndpoint(input.endpoints, { selectedId: input.selectedEndpointId });
  const shareable = input.endpoints.filter(isQrShareableEndpoint);
  const url =
    selection !== null && input.credential !== null
      ? buildDirectPairingUrl(selection.endpoint.httpBaseUrl, input.credential)
      : null;
  return {
    url,
    qrUrl: selection !== null && selection.qrShareable ? url : null,
    selectedEndpointId: selection === null ? null : selection.endpoint.id,
    address: selection === null ? null : endpointAddress(selection.endpoint.httpBaseUrl),
    choices:
      shareable.length >= 2
        ? shareable.map((endpoint) => ({
            id: endpoint.id,
            label: endpoint.label,
            hint: endpointReachabilityHint(endpoint, "that machine"),
          }))
        : [],
  };
}

/** The link for one listed pairing link, for its Share action. */
export function pairingLinkShareUrl(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  credential: string,
): string | null {
  return derivePairingShare({ endpoints, selectedEndpointId: null, credential }).url;
}

/** The add-a-device sheet's heading, for the code's state. */
export function addDeviceTitle(view: AddDeviceView, machineLabel: string): string {
  switch (view.kind) {
    case "unreachable":
      return `Only ${machineLabel} can reach Ryco now`;
    case "joined":
      return `${view.deviceName} is connected`;
    default:
      return "Add a device";
  }
}

export function addDeviceDescription(view: AddDeviceView, machineLabel: string): string {
  switch (view.kind) {
    case "unreachable":
      return (
        `${machineLabel} advertises no address another device can reach. Turn on network access ` +
        "or Tailscale HTTPS on the machine, in Ryco Desktop's Connections settings, then try again."
      );
    case "joined":
      return `It is paired with ${machineLabel} as a client and listed under Clients.`;
    default:
      return `Pair a phone or another computer with ${machineLabel} as a client. The code works once and expires in a few minutes.`;
  }
}

/** The headline over a code that can no longer pair anything. */
export function deadCodeTitle(view: AddDeviceView): string {
  switch (view.kind) {
    case "used":
      return "This code was used";
    case "withdrawn":
      return "This code was withdrawn";
    default:
      return "This code expired";
  }
}

export function deadCodeHint(view: AddDeviceView): string {
  switch (view.kind) {
    case "used":
      return "Create a new code to connect another device.";
    case "withdrawn":
      return "It was revoked before a device used it.";
    default:
      return "Create a new code to try again.";
  }
}

/** `http://host:port` without the trailing slash, as another computer types it. */
export function endpointAddress(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/\/$/u, "");
}
