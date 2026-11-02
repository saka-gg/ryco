import type { AuthSessionRole, DesktopSshEnvironmentTarget, EnvironmentId } from "@ryco/contracts";
import {
  isSavedEnvironmentSwitchedOff,
  SavedEnvironmentConnectionCancelledError,
  SavedEnvironmentSwitchedOffError,
} from "@ryco/client-runtime/connection";

import {
  getSavedEnvironmentRecord,
  persistSavedEnvironmentRecord,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  writeSavedEnvironmentBearerToken,
} from "./catalog";
import {
  bootstrapDesktopSshBearerSession,
  isDesktopSshTargetEqual,
  resolveDesktopSshEnvironmentBootstrap,
} from "./service";

/*
 * Connecting a Desktop SSH machine: its tunnel, the record's address, and the
 * bearer it mints through the tunnel. Desktop-only, so loaded on an SSH
 * machine's first connect rather than with the app.
 */

export interface DesktopSshConnectOptions {
  readonly issuePairingToken?: boolean;
  /** The connect attempt was given up (a disconnect, a switch-off, a new pairing). */
  readonly isCancelled?: () => boolean;
}

export interface PreparedSavedEnvironmentRecord {
  readonly record: SavedEnvironmentRecord;
  readonly pairingToken: string | null;
  readonly remotePort: number | null;
  readonly remoteServerKind: "external" | "managed" | null;
}

export interface IssuedDesktopSshBearerSession {
  readonly record: SavedEnvironmentRecord;
  readonly bearerToken: string;
  readonly role: AuthSessionRole | null;
}

/**
 * The saved record an SSH connect may still write to, read now: never the copy
 * the attempt started with, which predates a switch-off, a rename or a removal
 * made while it waited for its tunnel. Writing that copy back switched a
 * machine on again behind the user's back.
 */
function readLiveDesktopSshRecord(
  environmentId: EnvironmentId,
  isCancelled: () => boolean,
): SavedEnvironmentRecord {
  const live = getSavedEnvironmentRecord(environmentId);
  if (isSavedEnvironmentSwitchedOff(live)) {
    throw new SavedEnvironmentSwitchedOffError(environmentId);
  }
  if (!live || isCancelled()) {
    throw new SavedEnvironmentConnectionCancelledError(environmentId);
  }
  return live;
}

/** Where an SSH machine is reached: its tunnel's local URLs and its SSH target. */
type DesktopSshAddress = Pick<SavedEnvironmentRecord, "httpBaseUrl" | "wsBaseUrl" | "desktopSsh">;

/**
 * Writes an SSH machine's address into its live record and nothing else, so
 * a rename made meanwhile stays. A machine switched off or removed, or an
 * attempt given up, is left as it is: the error says which.
 */
async function writeDesktopSshAddress(
  environmentId: EnvironmentId,
  address: DesktopSshAddress,
  isCancelled: () => boolean,
): Promise<SavedEnvironmentRecord> {
  const withAddress = (): SavedEnvironmentRecord => ({
    ...readLiveDesktopSshRecord(environmentId, isCancelled),
    httpBaseUrl: address.httpBaseUrl,
    wsBaseUrl: address.wsBaseUrl,
    ...(address.desktopSsh ? { desktopSsh: address.desktopSsh } : {}),
  });
  const live = readLiveDesktopSshRecord(environmentId, isCancelled);
  if (
    live.httpBaseUrl === address.httpBaseUrl &&
    live.wsBaseUrl === address.wsBaseUrl &&
    isDesktopSshTargetEqual(live.desktopSsh, address.desktopSsh)
  ) {
    return live;
  }
  await persistSavedEnvironmentRecord(withAddress());
  // Read again after the write: the machine may have been switched off since.
  const next = withAddress();
  useSavedEnvironmentRegistryStore.getState().upsert(next);
  return next;
}

/**
 * Ensures an SSH machine's tunnel (and its remote server) and points the
 * machine's record at the tunnel, which listens on a new local port each time
 * it is rebuilt.
 */
export async function prepareDesktopSshRecordForConnection(
  record: SavedEnvironmentRecord,
  target: DesktopSshEnvironmentTarget,
  options?: DesktopSshConnectOptions,
): Promise<PreparedSavedEnvironmentRecord> {
  const isCancelled = options?.isCancelled ?? (() => false);
  const bootstrap = await resolveDesktopSshEnvironmentBootstrap(
    target,
    options?.issuePairingToken === undefined
      ? undefined
      : { issuePairingToken: options.issuePairingToken },
  );
  let nextRecord: SavedEnvironmentRecord;
  try {
    // Each new tunnel listens on a new local port: the record follows it.
    nextRecord = await writeDesktopSshAddress(
      record.environmentId,
      {
        httpBaseUrl: bootstrap.httpBaseUrl,
        wsBaseUrl: bootstrap.wsBaseUrl,
        desktopSsh: bootstrap.target,
      },
      isCancelled,
    );
  } catch (error) {
    await closeDesktopSshTunnelOfMachineGone(record.environmentId, bootstrap.target);
    throw error;
  }

  return {
    record: nextRecord,
    pairingToken: bootstrap.pairingToken,
    remotePort: bootstrap.remotePort ?? null,
    remoteServerKind: bootstrap.remoteServerKind ?? null,
  };
}

/**
 * A tunnel that came up for a machine switched off or removed while it was
 * being built. The disconnect that switch-off or removal sent could only fail
 * the callers waiting for that tunnel, not stop the one building it, so it is
 * taken down here. Best effort; a machine still on (a cancelled attempt's
 * replacement may share the tunnel) keeps it.
 */
async function closeDesktopSshTunnelOfMachineGone(
  environmentId: EnvironmentId,
  target: DesktopSshEnvironmentTarget,
): Promise<void> {
  const live = getSavedEnvironmentRecord(environmentId);
  if (live && !isSavedEnvironmentSwitchedOff(live)) return;
  if (typeof window === "undefined") return;
  await window.desktopBridge?.disconnectSshEnvironment(target).catch(() => undefined);
}

/** Mints a fresh bearer for an SSH machine through its tunnel and stores it. */
export async function issueDesktopSshBearerSession(
  record: SavedEnvironmentRecord,
  isCancelled: () => boolean = () => false,
): Promise<IssuedDesktopSshBearerSession> {
  // A failed issue puts the address back as it was, into the live record only.
  const before = getSavedEnvironmentRecord(record.environmentId);
  const rollBack = async () => {
    if (before) await writeDesktopSshAddress(record.environmentId, before, isCancelled);
  };
  const prepared = record.desktopSsh
    ? await prepareDesktopSshRecordForConnection(record, record.desktopSsh, {
        issuePairingToken: true,
        isCancelled,
      })
    : null;
  if (!prepared?.pairingToken) {
    await rollBack();
    throw new Error("Desktop SSH launch did not return a pairing token.");
  }

  const bearerSession = await bootstrapDesktopSshBearerSession(
    prepared.record.httpBaseUrl,
    prepared.pairingToken,
  ).catch(async (error) => {
    await rollBack();
    const detail = [
      `local ${prepared.record.httpBaseUrl}`,
      `remote port ${prepared.remotePort ?? "unknown"}`,
      prepared.remoteServerKind ? `remote server ${prepared.remoteServerKind}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (${detail})`);
  });
  // Switched off while the bearer was issued: it is not stored, and the
  // record stays as it is now.
  const live = readLiveDesktopSshRecord(record.environmentId, isCancelled);
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    prepared.record.environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await rollBack();
    throw new Error("Unable to persist saved environment credentials.");
  }

  return {
    record: live,
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role ?? null,
  };
}
