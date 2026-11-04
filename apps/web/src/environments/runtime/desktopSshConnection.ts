import type {
  AuthSessionRole,
  AuthSessionState,
  DesktopSshEnsureEnvironmentOptions,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@ryco/contracts";
import {
  isSavedEnvironmentSwitchedOff,
  SavedEnvironmentConnectionCancelledError,
  SavedEnvironmentSwitchedOffError,
} from "@ryco/client-runtime/connection";
import { createDesktopSshOwnerRepairTracker } from "@ryco/client-runtime/connection/desktopSshOwnerPairing";

import {
  getSavedEnvironmentRecord,
  persistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  writeSavedEnvironmentBearerToken,
} from "./catalog";
import type { EnvironmentConnection } from "./connection";
import {
  bootstrapDesktopSshBearerSession,
  fetchDesktopSshEnvironmentDescriptor,
  isDesktopSshTargetEqual,
  readEnvironmentConnection,
  readSavedEnvironmentSession,
  resolveDesktopSshEnvironmentBootstrap,
} from "./service";

/*
 * Connecting a Desktop SSH machine: its tunnel, the record's address, the
 * bearer it mints through the tunnel, and its re-pair as owner while it holds
 * a client bearer. Desktop-only, so loaded on an SSH machine's first connect
 * rather than with the app.
 */

export interface DesktopSshConnectOptions {
  readonly issuePairingToken?: boolean;
  /** With `issuePairingToken`: an owner token or none, never a client one. */
  readonly requireOwnerPairing?: boolean;
  /** The connect attempt was given up (a disconnect, a switch-off, a new pairing). */
  readonly isCancelled?: () => boolean;
}

export interface PreparedSavedEnvironmentRecord {
  readonly record: SavedEnvironmentRecord;
  readonly pairingToken: string | null;
  /** The role the pairing token grants; null without a token. */
  readonly pairingRole: AuthSessionRole | null;
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
  const ensureOptions: DesktopSshEnsureEnvironmentOptions = {
    ...(options?.issuePairingToken === undefined
      ? {}
      : { issuePairingToken: options.issuePairingToken }),
    ...(options?.requireOwnerPairing === undefined
      ? {}
      : { requireOwnerPairing: options.requireOwnerPairing }),
  };
  const bootstrap = await resolveDesktopSshEnvironmentBootstrap(
    target,
    Object.keys(ensureOptions).length === 0 ? undefined : ensureOptions,
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
    pairingRole: bootstrap.pairingToken === null ? null : (bootstrap.pairingRole ?? null),
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
  const issued = await mintDesktopSshBearerSession(
    record,
    { issuePairingToken: true },
    isCancelled,
  );
  if (issued === null) throw new Error("Desktop SSH launch did not return a pairing token.");
  // The pairing script asks for owner first: a client bearer means the remote
  // CLI cannot mint owner credentials yet.
  await recordDesktopSshPairedRole(issued.record, issued.role);
  return issued;
}

/**
 * Asks the tunnel for a pairing token, redeems it and stores the bearer.
 * Resolves null, with the address put back, when no token (or, with
 * `requireOwnerPairing`, no owner token) came back.
 */
async function mintDesktopSshBearerSession(
  record: SavedEnvironmentRecord,
  options: Pick<DesktopSshConnectOptions, "issuePairingToken" | "requireOwnerPairing">,
  isCancelled: () => boolean,
): Promise<IssuedDesktopSshBearerSession | null> {
  // A failed issue puts the address back as it was, into the live record only.
  const before = getSavedEnvironmentRecord(record.environmentId);
  const rollBack = async () => {
    if (before) await writeDesktopSshAddress(record.environmentId, before, isCancelled);
  };
  const prepared = record.desktopSsh
    ? await prepareDesktopSshRecordForConnection(record, record.desktopSsh, {
        ...options,
        isCancelled,
      })
    : null;
  if (
    !prepared?.pairingToken ||
    (options.requireOwnerPairing === true && prepared.pairingRole !== "owner")
  ) {
    await rollBack();
    return null;
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

/**
 * The owner re-pair state of each Desktop SSH machine since the app started;
 * see `shouldRepairDesktopSshAsOwner`. A remote CLI that cannot mint owner
 * credentials is asked again once the node reports another Ryco version; a
 * failed attempt then too, or once its retry delay has passed, which re-pairs
 * a connected node in place.
 */
const desktopSshOwnerRepairs = createDesktopSshOwnerRepairTracker({
  onRetryDue: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId);
    // Without a connection, the machine's next connect asks again.
    if (connection) {
      repairConnectedDesktopSshAsOwner(
        environmentId,
        connection,
        reportedDesktopSshServerVersion(environmentId),
      );
    }
  },
});

/** The next connect pairs afresh, owner first, and records what it gets. */
export function forgetDesktopSshOwnerRepair(environmentId: EnvironmentId): void {
  desktopSshOwnerRepairs.record(environmentId, undefined);
}

export function resetDesktopSshOwnerRepairsForTests(): void {
  desktopSshOwnerRepairs.reset();
}

/** The Ryco version the machine's node last reported, or null. */
function reportedDesktopSshServerVersion(environmentId: EnvironmentId): string | null {
  return (
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor?.serverVersion ??
    null
  );
}

function throwIfCancelled(environmentId: EnvironmentId, isCancelled: () => boolean): void {
  if (isCancelled()) throw new SavedEnvironmentConnectionCancelledError(environmentId);
}

/** A re-pair that must stop: the attempt was given up, or the machine switched off. */
function isDesktopSshRepairStop(error: unknown): boolean {
  return (
    error instanceof SavedEnvironmentConnectionCancelledError ||
    error instanceof SavedEnvironmentSwitchedOffError
  );
}

/**
 * Records the role a Desktop SSH pairing, which asks for owner first, got: a
 * client bearer means the remote CLI cannot mint owner credentials on the
 * Ryco version the node reports now.
 */
export async function recordDesktopSshPairedRole(
  record: SavedEnvironmentRecord,
  role: AuthSessionRole | null,
  /** The node's version, when already in hand; otherwise it is read over the tunnel. */
  knownServerVersion?: string,
): Promise<void> {
  if (role !== "client") {
    desktopSshOwnerRepairs.record(record.environmentId, undefined);
    return;
  }
  const serverVersion =
    knownServerVersion ??
    (await fetchDesktopSshEnvironmentDescriptor(record.httpBaseUrl).then(
      (descriptor) => descriptor.serverVersion ?? null,
      () => null,
    ));
  desktopSshOwnerRepairs.record(record.environmentId, { kind: "unsupported", serverVersion });
}

/**
 * Runs one owner re-pair of a Desktop SSH machine; see
 * `DesktopSshOwnerRepairTracker.run`. Resolves null, and changes no
 * credential, when it fails: an SSH hiccup, a busy node or a refused redeem
 * says nothing about the remote CLI, so the client bearer stays and the retry
 * asks again. A cancelled one, or one whose machine was switched off,
 * rethrows.
 */
async function runDesktopSshOwnerRepair(
  environmentId: EnvironmentId,
  /** The version the node reported when the re-pair was decided. */
  serverVersion: string | null,
  repair: () => Promise<IssuedDesktopSshBearerSession | null>,
): Promise<IssuedDesktopSshBearerSession | null> {
  return await desktopSshOwnerRepairs
    .run(environmentId, serverVersion, repair)
    .catch((error: unknown) => {
      if (isDesktopSshRepairStop(error)) throw error;
      return null;
    });
}

/**
 * Re-pairs a Desktop SSH machine that holds a client bearer as owner, over the
 * tunnel it already has, and records what came of it. The owner bearer is
 * stored before the client session it replaces is revoked. Returns null, and
 * changes no credential, when the remote CLI cannot mint owner credentials
 * yet. Run it through {@link runDesktopSshOwnerRepair}.
 */
async function repairDesktopSshBearerAsOwner(
  record: SavedEnvironmentRecord,
  replacedSession: AuthSessionState,
  isCancelled: () => boolean,
): Promise<IssuedDesktopSshBearerSession | null> {
  const issued = await mintDesktopSshBearerSession(
    record,
    { issuePairingToken: true, requireOwnerPairing: true },
    isCancelled,
  );
  if (issued === null) {
    await recordDesktopSshPairedRole(record, "client");
    return null;
  }
  await recordDesktopSshPairedRole(issued.record, issued.role);
  const revoke =
    typeof window === "undefined" ? undefined : window.desktopBridge?.revokeSshClientSession;
  if (
    issued.role === "owner" &&
    replacedSession.sessionId !== undefined &&
    revoke &&
    !isCancelled()
  ) {
    // Best effort: a client session left behind only lingers until it expires.
    await revoke(issued.record.httpBaseUrl, issued.bearerToken, replacedSession.sessionId).catch(
      () => undefined,
    );
  }
  return issued;
}

/**
 * A connect that found a Desktop SSH node on a client session re-pairs it as
 * owner when it may now mint owner credentials. Resolves the owner bearer to
 * connect on, or null to go on with the client bearer it has.
 */
export async function repairDesktopSshAsOwnerOnConnect(input: {
  readonly record: SavedEnvironmentRecord;
  readonly session: AuthSessionState;
  /** The bearer was minted by this connect (or handed in freshly minted). */
  readonly bearerIssuedThisConnect: boolean;
  readonly isCancelled: () => boolean;
}): Promise<IssuedDesktopSshBearerSession | null> {
  const { record, session, isCancelled } = input;
  const serverVersion = reportedDesktopSshServerVersion(record.environmentId);
  if (
    !desktopSshOwnerRepairs.shouldRepair(record.environmentId, {
      sessionRole: session.role,
      bearerIssuedThisConnect: input.bearerIssuedThisConnect,
      serverVersion,
    })
  ) {
    return null;
  }
  return await runDesktopSshOwnerRepair(record.environmentId, serverVersion, () =>
    repairDesktopSshBearerAsOwner(record, session, isCancelled),
  );
}

/**
 * A connected Desktop SSH node still on a client session re-pairs as owner in
 * place when it may now mint owner credentials (see
 * `shouldRepairDesktopSshAsOwner`): when its socket (re)connects, since
 * updating Ryco there restarts its server and the socket reconnects on its
 * own, on the bearer it has, and when a failed re-pair's retry is due, since a
 * healthy socket never reconnects. The connection then reconnects on the owner
 * bearer.
 */
export function repairConnectedDesktopSshAsOwner(
  environmentId: EnvironmentId,
  connection: EnvironmentConnection,
  serverVersion: string | null,
): void {
  const isCurrent = () => readEnvironmentConnection(environmentId) === connection;
  if (
    !isCurrent() ||
    !desktopSshOwnerRepairs.shouldRepair(environmentId, {
      sessionRole: useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.role,
      bearerIssuedThisConnect: false,
      serverVersion,
    })
  ) {
    return;
  }
  const isCancelled = () => !isCurrent();
  void (async () => {
    const repaired = await runDesktopSshOwnerRepair(environmentId, serverVersion, async () => {
      const record = getSavedEnvironmentRecord(environmentId);
      const bearerToken = await readSavedEnvironmentBearerToken(environmentId);
      throwIfCancelled(environmentId, isCancelled);
      if (!record?.desktopSsh || !bearerToken) return null;
      const session = await readSavedEnvironmentSession(record, bearerToken);
      throwIfCancelled(environmentId, isCancelled);
      // A rejected bearer is the socket's to report.
      if (session === null) return null;
      if (session.role !== "client") {
        await recordDesktopSshPairedRole(record, session.role ?? null);
        return null;
      }
      return await repairDesktopSshBearerAsOwner(record, session, isCancelled);
    });
    if (repaired && !isCancelled()) await connection.reconnect();
  })().catch((error: unknown) => {
    if (isDesktopSshRepairStop(error)) return;
    console.warn("Desktop SSH owner re-pair of a connected environment failed", {
      environmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
