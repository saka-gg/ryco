/**
 * "Add a device" on the direct pairing path: what the dialog shows for the one
 * code it minted, and which code "New code" may withdraw.
 *
 * The dialog only ever touches its own code. It mints one client-role,
 * one-time code per opening (the node's default lifetime, 5 minutes), keeps it
 * when it closes (it stays listed and revocable under Authorized clients), and
 * "New code" revokes the code on screen only while that code can still be
 * used. Nothing here revokes another link, a client session or an E2EE record:
 * a redeemed or withdrawn code only changes what the dialog shows.
 */
import type { AdvertisedEndpoint } from "@ryco/contracts";

import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "@ryco/client-runtime/connection";

/** A code the dialog minted. */
export interface AddDeviceCode {
  readonly id: string;
  readonly credential: string;
  readonly label: string | null;
  /** ISO instant. */
  readonly expiresAt: string;
}

/**
 * Everything the dialog may do to the node. The parent passes the real pairing
 * calls; the dialog has no way to reach sessions or other links.
 */
export interface AddDeviceOperations {
  /** Mints one client-role, one-time pairing code. */
  readonly createCode: (label: string | null) => Promise<AddDeviceCode>;
  /** Revokes one pairing link: only ever the code the dialog shows. */
  readonly revokeCode: (id: string) => Promise<void>;
}

export interface AddDeviceDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Counts openings; each one mints its own code. */
  readonly opening: number;
  readonly operations: AddDeviceOperations;
  /** From the parent's access subscription: the dialog opens none of its own. */
  readonly pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  readonly clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
  /**
   * Opens the parent's network-access confirmation. Null where this app cannot
   * change it (a browser-served node is configured where it is launched).
   */
  readonly onTurnOnNetworkAccess: (() => void) | null;
}

/** The dialog's code and what the node's access stream said about it since. */
export interface ShownCode {
  readonly code: AddDeviceCode;
  /** The node's creation time, from the listing; null until the link was listed. */
  readonly createdAt: string | null;
  /** The link left the listing after it was listed: redeemed or revoked. */
  readonly removed: boolean;
  /** The client session that joined after the code was removed. */
  readonly joinedSessionId: string | null;
}

export function showCode(code: AddDeviceCode): ShownCode {
  return { code, createdAt: null, removed: false, joinedSessionId: null };
}

/** Milliseconds of an ISO instant; NaN (never in range) when malformed. */
function parseMs(value: string): number {
  return Date.parse(value);
}

/**
 * The client session the shown code most likely created: a client-role
 * session, not this one, issued at or after the code (`issuedAt >=
 * createdAt`). A label the code carried narrows it; the newest wins.
 */
function findJoinedSession(
  shown: ShownCode,
  createdAtMs: number,
  clientSessions: ReadonlyArray<ServerClientSessionRecord>,
): ServerClientSessionRecord | null {
  const candidates = clientSessions.filter(
    (session) =>
      session.role === "client" && !session.current && parseMs(session.issuedAt) >= createdAtMs,
  );
  const labelled =
    shown.code.label === null
      ? []
      : candidates.filter((session) => session.client.label === shown.code.label);
  const pool = labelled.length > 0 ? labelled : candidates;
  return (
    pool.toSorted((left, right) => parseMs(right.issuedAt) - parseMs(left.issuedAt))[0] ?? null
  );
}

/**
 * Folds the parent's latest listing into the shown code. Returns `shown`
 * itself when nothing changed, so a React state update can bail out.
 */
export function observeAccess(
  shown: ShownCode,
  access: {
    readonly pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
    readonly clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  },
): ShownCode {
  let next = shown;
  const listed = access.pairingLinks.find((link) => link.id === shown.code.id);
  if (listed) {
    if (next.createdAt === null) next = { ...next, createdAt: listed.createdAt };
  } else if (next.createdAt !== null && !next.removed) {
    next = { ...next, removed: true };
  }
  if (next.removed && next.joinedSessionId === null && next.createdAt !== null) {
    const joined = findJoinedSession(next, parseMs(next.createdAt), access.clientSessions);
    if (joined) next = { ...next, joinedSessionId: joined.sessionId };
  }
  return next;
}

/** Whether the shown code can still pair a device. */
export function isCodeLive(shown: ShownCode, nowMs: number): boolean {
  return !shown.removed && nowMs < parseMs(shown.code.expiresAt);
}

/**
 * The only code "New code" may revoke: the one on screen, and only while it is
 * live. An expired, redeemed or withdrawn code is already unusable.
 */
export function codeToRevokeOnNewCode(shown: ShownCode | null, nowMs: number): string | null {
  return shown !== null && isCodeLive(shown, nowMs) ? shown.code.id : null;
}

export type ReplaceCodeResult =
  | { readonly kind: "minted"; readonly code: AddDeviceCode }
  /** The live code could not be withdrawn: it stays on screen, and nothing was minted. */
  | { readonly kind: "revoke-failed"; readonly error: unknown }
  /** The old code (if any) is gone, but the node minted no new one. */
  | { readonly kind: "mint-failed"; readonly error: unknown };

/**
 * "New code" (and the first code of an opening, with nothing shown): withdraw
 * the live code on screen first, so only the code on screen can be redeemed,
 * then mint the next one. A failed revoke stops before minting.
 */
export async function replaceCode(input: {
  readonly operations: AddDeviceOperations;
  readonly shown: ShownCode | null;
  readonly nowMs: number;
  readonly label: string | null;
}): Promise<ReplaceCodeResult> {
  const previousId = codeToRevokeOnNewCode(input.shown, input.nowMs);
  if (previousId !== null) {
    try {
      await input.operations.revokeCode(previousId);
    } catch (error) {
      return { kind: "revoke-failed", error };
    }
  }
  try {
    return { kind: "minted", code: await input.operations.createCode(input.label) };
  } catch (error) {
    return { kind: "mint-failed", error };
  }
}

/** "m:ss" until `expiresAt`, rounded up; null once it has passed. */
export function formatCodeCountdown(expiresAt: string, nowMs: number): string | null {
  const remaining = Math.max(0, Math.ceil((parseMs(expiresAt) - nowMs) / 1_000));
  if (!remaining) return null;
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
}

/** A 12-character code in groups of 4, as another computer types it. */
export function groupPairingCode(credential: string): ReadonlyArray<string> {
  const groups: string[] = [];
  for (let offset = 0; offset < credential.length; offset += 4) {
    groups.push(credential.slice(offset, offset + 4));
  }
  return groups;
}

const DEVICE_TYPE_NAMES: Record<ServerClientSessionRecord["client"]["deviceType"], string | null> =
  {
    desktop: "The computer",
    mobile: "The phone",
    tablet: "The tablet",
    bot: null,
    unknown: null,
  };

/** "<label or device type>" for "… is connected". */
export function joinedDeviceName(session: ServerClientSessionRecord): string {
  return session.client.label ?? DEVICE_TYPE_NAMES[session.client.deviceType] ?? "The device";
}

export type AddDeviceView =
  /** No endpoint another device can reach: nothing to pair through. */
  | { readonly kind: "unreachable" }
  /** The live code, or none yet while it is minted (or minting failed). */
  | { readonly kind: "code"; readonly countdown: string | null }
  | { readonly kind: "expired" }
  /** Redeemed, but the session it made is gone again. */
  | { readonly kind: "used" }
  /** Revoked somewhere else before anyone used it. */
  | { readonly kind: "withdrawn" }
  | { readonly kind: "joined"; readonly deviceName: string };

/** What the dialog shows: the outcome of its code first, then reachability. */
export function resolveAddDeviceView(input: {
  readonly shown: ShownCode | null;
  readonly reachable: boolean;
  readonly clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  readonly nowMs: number;
}): AddDeviceView {
  const { shown } = input;
  if (shown?.removed) {
    if (shown.joinedSessionId === null) return { kind: "withdrawn" };
    const session = input.clientSessions.find(
      (candidate) => candidate.sessionId === shown.joinedSessionId,
    );
    return session ? { kind: "joined", deviceName: joinedDeviceName(session) } : { kind: "used" };
  }
  if (!input.reachable) return { kind: "unreachable" };
  if (shown === null) return { kind: "code", countdown: null };
  const countdown = formatCodeCountdown(shown.code.expiresAt, input.nowMs);
  return countdown === null ? { kind: "expired" } : { kind: "code", countdown };
}
