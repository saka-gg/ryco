/**
 * A node's direct access list, as its owner manages it: the pairing links it
 * will still accept and the client sessions paired with it.
 *
 * The node streams the list (`subscribeAuthAccess`, direct owner sessions
 * only); this folds that stream into rows and says how each row reads. Shared
 * by the web's Connections settings and the phone's machine access screen, so
 * the two list, sort and name the same sessions the same way.
 */
import type {
  AuthAccessStreamEvent,
  AuthClientSession,
  AuthPairingLink,
  AuthSessionId,
} from "@ryco/contracts";
import * as DateTime from "effect/DateTime";

import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "../connection/primaryAuth.ts";

export interface AuthAccessList {
  readonly pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  readonly clientSessions: ReadonlyArray<ServerClientSessionRecord>;
}

export const EMPTY_AUTH_ACCESS_LIST: AuthAccessList = Object.freeze({
  pairingLinks: Object.freeze([]),
  clientSessions: Object.freeze([]),
});

/** Newest link first. */
export function sortPairingLinks(
  links: ReadonlyArray<ServerPairingLinkRecord>,
): ReadonlyArray<ServerPairingLinkRecord> {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

/** This client first, then connected ones, then the most recently paired. */
export function sortClientSessions(
  sessions: ReadonlyArray<ServerClientSessionRecord>,
): ReadonlyArray<ServerClientSessionRecord> {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

export function toServerPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

export function toServerClientSessionRecord(
  clientSession: AuthClientSession,
): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

export function upsertPairingLink(
  current: ReadonlyArray<ServerPairingLinkRecord>,
  next: ServerPairingLinkRecord,
): ReadonlyArray<ServerPairingLinkRecord> {
  const existingIndex = current.findIndex((pairingLink) => pairingLink.id === next.id);
  if (existingIndex === -1) {
    return sortPairingLinks([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortPairingLinks(updated);
}

export function removePairingLink(
  current: ReadonlyArray<ServerPairingLinkRecord>,
  id: string,
): ReadonlyArray<ServerPairingLinkRecord> {
  return current.filter((pairingLink) => pairingLink.id !== id);
}

export function upsertClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  next: ServerClientSessionRecord,
): ReadonlyArray<ServerClientSessionRecord> {
  const existingIndex = current.findIndex(
    (clientSession) => clientSession.sessionId === next.sessionId,
  );
  if (existingIndex === -1) {
    return sortClientSessions([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortClientSessions(updated);
}

export function removeClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  sessionId: AuthSessionId,
): ReadonlyArray<ServerClientSessionRecord> {
  return current.filter((clientSession) => clientSession.sessionId !== sessionId);
}

/** Folds one event of the node's access stream into the list it describes. */
export function applyAuthAccessEvent(
  current: AuthAccessList,
  event: AuthAccessStreamEvent,
): AuthAccessList {
  switch (event.type) {
    case "snapshot":
      return {
        pairingLinks: sortPairingLinks(event.payload.pairingLinks.map(toServerPairingLinkRecord)),
        clientSessions: sortClientSessions(
          event.payload.clientSessions.map(toServerClientSessionRecord),
        ),
      };
    case "pairingLinkUpserted":
      return {
        ...current,
        pairingLinks: upsertPairingLink(
          current.pairingLinks,
          toServerPairingLinkRecord(event.payload),
        ),
      };
    case "pairingLinkRemoved":
      return {
        ...current,
        pairingLinks: removePairingLink(current.pairingLinks, event.payload.id),
      };
    case "clientUpserted":
      return {
        ...current,
        clientSessions: upsertClientSession(
          current.clientSessions,
          toServerClientSessionRecord(event.payload),
        ),
      };
    case "clientRemoved":
      return {
        ...current,
        clientSessions: removeClientSession(current.clientSessions, event.payload.sessionId),
      };
  }
}

export function accessRoleLabel(role: "owner" | "client"): string {
  return role === "owner" ? "Owner" : "Client";
}

/** The link's own label, else "<role> link". */
export function pairingLinkPrimaryLabel(pairingLink: ServerPairingLinkRecord): string {
  return pairingLink.label ?? `${accessRoleLabel(pairingLink.role)} link`;
}

/**
 * Whether a link may be shown and shared. An owner link grants full access to
 * the node. It is created in a terminal (`ryco auth pairing create --role
 * owner`, `ryco setup`) and stays there: it is listed only so it can be
 * revoked, never shown or shared again.
 */
export function pairingLinkCanShare(pairingLink: ServerPairingLinkRecord): boolean {
  return pairingLink.role !== "owner";
}

/** Connected now: this client, or another one with an open connection. */
export function clientSessionIsLive(clientSession: ServerClientSessionRecord): boolean {
  return clientSession.current || clientSession.connected;
}

/** The client's label, else its OS and browser, else the session subject. */
export function clientSessionPrimaryLabel(clientSession: ServerClientSessionRecord): string {
  return (
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject)
  );
}

/** "Role · Device type · OS · Browser · IP", leaving out what the node does not know. */
export function clientSessionDetail(clientSession: ServerClientSessionRecord): string {
  const deviceInfoBits = [
    clientSession.client.deviceType !== "unknown"
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  return [accessRoleLabel(clientSession.role), ...deviceInfoBits].join(" · ");
}
