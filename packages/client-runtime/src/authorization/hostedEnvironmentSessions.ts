import type { EnvironmentId, RelayEffectiveRole } from "@ryco/contracts";

import type {
  HostedBrowserStatus,
  HostedHubNode,
  HostedRelayFailure,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
  HostedSelectionStatus,
} from "./types.ts";

/**
 * How long a requested (or recovered) environment session may take to accept
 * its shell snapshot before it fails instead of waiting forever.
 */
export const HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS = 30_000;

/**
 * One hosted environment's session, kept per environment so several node
 * connections can live side by side.
 *
 * The registry only records and fences: it never decides when to connect. Every
 * relay callback names the record generation it belongs to, and a callback of a
 * superseded generation changes nothing, so a stale connection can never
 * publish readiness, role, a snapshot or mutation authority into another
 * generation's — or another environment's — record.
 */
export interface HostedEnvironmentSessionRecord {
  readonly environmentId: EnvironmentId;
  readonly nodeId: string;
  readonly label: string;
  /** {@link hostedNodeEntryKey} of the directory entry this record last saw. */
  readonly nodeKey: string;
  /** Drawn from the registry's one monotonic counter, shared by every environment. */
  readonly generation: number;
  readonly lastAccessedAt: number;
  /** A connection was requested for this generation. */
  readonly connectRequested: boolean;
  readonly transportStatus: HostedRelayTransportStatus;
  /** The transport reached `online` since this generation's connection last (re)opened. */
  readonly transportReachedOnline: boolean;
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly effectiveRole: RelayEffectiveRole | null;
  readonly sessionEstablished: boolean;
  readonly sessionRecoveredAfterUnknown: boolean;
  readonly failure: HostedRelayFailure | null;
  /** The {@link nodeKey} a terminal failure happened under; it blocks reconnecting until it changes. */
  readonly terminalNodeKey: string | null;
  /** The record's own session-sync deadline expired, or its shell snapshot failed. */
  readonly syncFailed: boolean;
  readonly snapshotAcceptedAt: number | null;
  /** Suspended or withdrawn since its last accepted snapshot. */
  readonly suspended: boolean;
  /** An unintentional close whose replacement channel has not authenticated yet. */
  readonly relayGap: boolean;
}

export interface HostedEnvironmentSessionsSnapshot {
  /** Increases with every published change. */
  readonly revision: number;
  readonly records: ReadonlyMap<EnvironmentId, HostedEnvironmentSessionRecord>;
  /**
   * Environments whose earlier action could not be confirmed. Kept across
   * releases, so the environment's next session starts `delivery-unknown`
   * until the user acknowledges it.
   */
  readonly deliveryUnknown: ReadonlySet<EnvironmentId>;
}

/** Platform clock and timers. Pass bound wrappers, never unbound browser methods. */
export interface HostedEnvironmentSessionPorts {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  /** Receives exactly what {@link setTimeout} returned. */
  clearTimeout(timer: unknown): void;
  readonly syncDeadlineMs?: number | undefined;
}

/** A record generation that {@link HostedEnvironmentSessions.suspendAll} replaced. */
export interface HostedEnvironmentSuspension {
  readonly environmentId: EnvironmentId;
  readonly previousGeneration: number;
}

export interface HostedEnvironmentRecordOptions {
  /**
   * Whether this call is an access of the environment (the default). A
   * directory refresh passes `false`: it refreshes the entry's fields without
   * reordering {@link HostedEnvironmentSessions.list}, and publishes nothing
   * when the entry did not change.
   */
  readonly access?: boolean | undefined;
}

export interface HostedEnvironmentSuspendOptions {
  readonly exceptSuspended?: boolean | undefined;
}

export interface HostedEnvironmentSessions {
  readonly read: (environmentId: EnvironmentId) => HostedEnvironmentSessionRecord | undefined;
  /** Every record, most recently accessed first. */
  readonly list: () => ReadonlyArray<HostedEnvironmentSessionRecord>;
  /** Frozen; replaced only when something changed. */
  readonly getSnapshot: () => HostedEnvironmentSessionsSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly isCurrentGeneration: (environmentId: EnvironmentId, generation: number) => boolean;

  /**
   * The environment's record, created with a fresh generation when it has none.
   * An existing record keeps its generation and takes the directory entry's
   * node, label and role; when that entry changed since a terminal failure, the
   * failure no longer blocks reconnecting. The record never reconnects on its
   * own: a connection keeps the node it was opened for until the caller renews
   * or releases the record.
   */
  readonly ensureRecord: (
    node: HostedHubNode,
    options?: HostedEnvironmentRecordOptions,
  ) => HostedEnvironmentSessionRecord;
  /**
   * A connection was requested for this generation: arms its session-sync
   * deadline. A repeated request joins the deadline already running for the
   * generation instead of extending it.
   */
  readonly markConnectRequested: (environmentId: EnvironmentId, generation: number) => void;
  /**
   * Start the environment over with a fresh generation and reset session
   * state; callbacks of the replaced generation are ignored from here on.
   */
  readonly renew: (environmentId: EnvironmentId) => HostedEnvironmentSessionRecord | undefined;
  /**
   * Forget the environment. Requests its connection still had in flight leave
   * the environment's delivery uncertain for its next session.
   */
  readonly release: (environmentId: EnvironmentId) => void;
  /**
   * Suspend every record: each takes a fresh generation, so callbacks already
   * in flight are ignored, and none stays adoptable. Requests a replaced
   * connection still had in flight leave its environment's delivery uncertain.
   * Returns the replaced generations, whose connections the caller suspends.
   * `exceptSuspended` leaves a record that is suspended already as it is: no
   * connection was requested for its generation, so it has none to suspend.
   */
  readonly suspendAll: (
    options?: HostedEnvironmentSuspendOptions,
  ) => ReadonlyArray<HostedEnvironmentSuspension>;
  /** {@link suspendAll}, and every record also loses its role and closes its session. */
  readonly withdrawAll: () => ReadonlyArray<HostedEnvironmentSuspension>;
  /** Sign-out: drop every record, timer and uncertain delivery. */
  readonly clear: () => void;

  readonly transportStatus: (
    environmentId: EnvironmentId,
    generation: number,
    status: HostedRelayTransportStatus,
  ) => void;
  readonly sessionStatus: (
    environmentId: EnvironmentId,
    generation: number,
    status: HostedRycoSessionStatus,
  ) => void;
  readonly role: (
    environmentId: EnvironmentId,
    generation: number,
    role: RelayEffectiveRole | null,
  ) => void;
  readonly failure: (
    environmentId: EnvironmentId,
    generation: number,
    failure: HostedRelayFailure,
  ) => void;
  readonly markDeliveryUnknown: (environmentId: EnvironmentId, generation: number) => void;
  readonly connectionClosed: (environmentId: EnvironmentId, generation: number) => void;
  readonly connectionRecovered: (environmentId: EnvironmentId, generation: number) => void;
  readonly markSessionReady: (environmentId: EnvironmentId, generation: number) => void;
  readonly markSessionReplaying: (environmentId: EnvironmentId, generation: number) => void;
  readonly reportShellSnapshotFailure: (environmentId: EnvironmentId, generation: number) => void;
  readonly registerPendingRequestReader: (
    environmentId: EnvironmentId,
    generation: number,
    hasPendingRequests: () => boolean,
  ) => void;

  /** An action on this environment could not be confirmed, whatever the generation. */
  readonly markEnvironmentDeliveryUnknown: (environmentId: EnvironmentId) => void;
  readonly acknowledgeDeliveryUnknown: (environmentId: EnvironmentId) => void;
}

/**
 * Whether selecting this environment may adopt its session as it is.
 *
 * The record completed its own fresh relay attempt and accepted its own current
 * shell snapshot and has not been suspended or interrupted since; replace this
 * function to change the adoption policy.
 */
export function canAdoptHostedEnvironmentSession(record: HostedEnvironmentSessionRecord): boolean {
  return (
    record.transportStatus === "online" &&
    record.sessionEstablished &&
    !record.suspended &&
    !record.relayGap &&
    record.snapshotAcceptedAt !== null &&
    (record.sessionStatus === "ready" ||
      (record.sessionStatus === "delivery-unknown" && record.sessionRecoveredAfterUnknown))
  );
}

/**
 * A connection was already requested for this generation and is still on its
 * way, in any transport phase — including `idle` right after the request. A
 * second request joins it instead of starting another attempt.
 */
export function isJoinableHostedEnvironmentSession(
  record: HostedEnvironmentSessionRecord,
): boolean {
  return (
    record.connectRequested &&
    !record.suspended &&
    record.transportStatus !== "terminal-failure" &&
    !canAdoptHostedEnvironmentSession(record)
  );
}

/**
 * A terminal failure blocks reconnecting until the environment's directory
 * entry changes or an explicit retry renews the record.
 */
export function isHostedEnvironmentConnectBlocked(record: HostedEnvironmentSessionRecord): boolean {
  return (
    record.transportStatus === "terminal-failure" &&
    record.terminalNodeKey !== null &&
    record.terminalNodeKey === record.nodeKey
  );
}

/** Whether the environment counts as connected: requested or running, not suspended or failed. */
export function isHostedEnvironmentSessionLive(
  record: HostedEnvironmentSessionRecord | undefined,
): boolean {
  return (
    record !== undefined &&
    !record.suspended &&
    record.transportStatus !== "terminal-failure" &&
    (record.connectRequested || record.transportStatus !== "idle")
  );
}

/** The directory fields whose change lifts a terminal failure's block. */
export function hostedNodeEntryKey(node: HostedHubNode): string {
  return JSON.stringify([
    node.id,
    node.presence.online,
    node.clientVersion,
    node.effectiveRole,
    node.revokedAt,
    node.capabilities?.nativeClientRequired === true,
  ]);
}

/**
 * The account and directory were checked in this browser lifecycle. A
 * `synchronizing` browser has done that and only waits for the selected
 * environment, so it is as good as `current` for every other one.
 */
export function hostedBrowserRevalidated(status: HostedBrowserStatus): boolean {
  return status === "current" || status === "synchronizing";
}

/** What the selected environment's session reports as the shared error. */
export type HostedSelectedSessionError =
  | { readonly kind: "session-sync" }
  | { readonly kind: "relay"; readonly failure: HostedRelayFailure };

/** The shared session fields that describe the selected environment. */
export interface HostedSelectedSessionProjection {
  readonly transportStatus: HostedRelayTransportStatus;
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly sessionEstablished: boolean;
  readonly sessionRecoveredAfterUnknown: boolean;
  readonly effectiveRole: RelayEffectiveRole | null;
  readonly selectionStatus: HostedSelectionStatus;
  /** `null` also for a spent transfer budget: its reconnect is a routine rotation. */
  readonly error: HostedSelectedSessionError | null;
  /**
   * The session is not established yet and has not failed for good — no
   * record, suspended, connecting or synchronizing — so a revalidated browser
   * is still synchronizing the selection.
   */
  readonly establishing: boolean;
}

/**
 * Project the selected environment's record onto the shared session fields.
 * Without a record the environment shows what a fresh session would: idle and
 * synchronizing, or `delivery-unknown` while an earlier action is unconfirmed.
 * The role needs a current directory; the record's own role wins over the
 * directory entry's once it has one.
 */
export function selectedProjectionFields(
  record: HostedEnvironmentSessionRecord | undefined,
  node: HostedHubNode,
  context: { readonly directoryReady: boolean; readonly deliveryUnknown: boolean },
): HostedSelectedSessionProjection {
  const failure = record?.failure ?? null;
  const selectionStatus: HostedSelectionStatus =
    failure?.kind === "revoked"
      ? "revoked"
      : failure?.kind === "authorization-removed"
        ? "authorization-removed"
        : failure?.kind === "incompatible"
          ? "incompatible"
          : node.presence.online
            ? "online"
            : "offline";
  return {
    transportStatus: record?.transportStatus ?? "idle",
    sessionStatus:
      record?.sessionStatus ?? (context.deliveryUnknown ? "delivery-unknown" : "synchronizing"),
    sessionEstablished: record?.sessionEstablished ?? false,
    sessionRecoveredAfterUnknown: record?.sessionRecoveredAfterUnknown ?? false,
    effectiveRole: context.directoryReady
      ? record
        ? record.effectiveRole
        : node.effectiveRole
      : null,
    selectionStatus,
    error: record?.syncFailed
      ? { kind: "session-sync" }
      : failure === null || (failure.retryable && failure.kind === "budget")
        ? null
        : { kind: "relay", failure },
    establishing:
      record === undefined ||
      (!record.sessionEstablished && record.transportStatus !== "terminal-failure"),
  };
}

function unchangedRecord(
  current: HostedEnvironmentSessionRecord,
  next: HostedEnvironmentSessionRecord,
): boolean {
  return (Object.keys(current) as Array<keyof HostedEnvironmentSessionRecord>).every((key) =>
    Object.is(current[key], next[key]),
  );
}

function freezeSnapshot(
  revision: number,
  records: ReadonlyMap<EnvironmentId, HostedEnvironmentSessionRecord>,
  deliveryUnknown: ReadonlySet<EnvironmentId>,
): HostedEnvironmentSessionsSnapshot {
  return Object.freeze({
    revision,
    records: new Map(records),
    deliveryUnknown: new Set(deliveryUnknown),
  });
}

type RecordChanges = Partial<Omit<HostedEnvironmentSessionRecord, "environmentId" | "generation">>;

export function createHostedEnvironmentSessions(
  ports: HostedEnvironmentSessionPorts,
): HostedEnvironmentSessions {
  const records = new Map<EnvironmentId, HostedEnvironmentSessionRecord>();
  const deliveryUnknown = new Set<EnvironmentId>();
  const deadlines = new Map<EnvironmentId, { timer: unknown; readonly generation: number }>();
  const pendingRequestReaders = new Map<
    EnvironmentId,
    { readonly generation: number; readonly read: () => boolean }
  >();
  const listeners = new Set<() => void>();
  let lastGeneration = 0;
  let snapshot = freezeSnapshot(0, records, deliveryUnknown);
  let listed: {
    readonly snapshot: HostedEnvironmentSessionsSnapshot;
    readonly records: ReadonlyArray<HostedEnvironmentSessionRecord>;
  } | null = null;

  const publish = () => {
    snapshot = freezeSnapshot(snapshot.revision + 1, records, deliveryUnknown);
    for (const listener of Array.from(listeners)) listener();
  };

  /** Store `next`; whether anything changed. */
  const write = (next: HostedEnvironmentSessionRecord): boolean => {
    const current = records.get(next.environmentId);
    if (current !== undefined && unchangedRecord(current, next)) return false;
    records.set(next.environmentId, next);
    return true;
  };

  /** Apply `update` to the record only while `generation` is still its own. */
  const patch = (
    environmentId: EnvironmentId,
    generation: number,
    update: (current: HostedEnvironmentSessionRecord) => RecordChanges | null,
  ): boolean => {
    const current = records.get(environmentId);
    if (current === undefined || current.generation !== generation) return false;
    const changes = update(current);
    return changes !== null && write({ ...current, ...changes });
  };

  const stickyDeliveryUnknown = (current: HostedEnvironmentSessionRecord) =>
    current.sessionStatus === "delivery-unknown" ? "delivery-unknown" : "stale";

  const clearDeadline = (environmentId: EnvironmentId) => {
    const deadline = deadlines.get(environmentId);
    if (deadline === undefined) return;
    deadlines.delete(environmentId);
    ports.clearTimeout(deadline.timer);
  };

  const sessionSyncFailure = (current: HostedEnvironmentSessionRecord): RecordChanges => ({
    transportStatus: "terminal-failure",
    sessionStatus: stickyDeliveryUnknown(current),
    sessionRecoveredAfterUnknown: false,
    syncFailed: true,
    terminalNodeKey: current.nodeKey,
  });

  const armDeadline = (environmentId: EnvironmentId, generation: number) => {
    clearDeadline(environmentId);
    const current = records.get(environmentId);
    if (current === undefined || current.generation !== generation || current.sessionEstablished) {
      return;
    }
    const deadline: { timer: unknown; readonly generation: number } = { timer: null, generation };
    deadline.timer = ports.setTimeout(() => {
      if (deadlines.get(environmentId) !== deadline) return;
      deadlines.delete(environmentId);
      // Fenced: a deadline of a replaced generation, or of a session that
      // established meanwhile, fails nothing.
      if (
        patch(environmentId, generation, (record) =>
          record.sessionEstablished ? null : sessionSyncFailure(record),
        )
      ) {
        publish();
      }
    }, ports.syncDeadlineMs ?? HOSTED_ENVIRONMENT_SESSION_SYNC_DEADLINE_MS);
    deadlines.set(environmentId, deadline);
  };

  /**
   * The record's connection is going away. What it still had in flight may or
   * may not have reached the node, so the environment's delivery becomes
   * uncertain. Returns whether this call made it uncertain.
   */
  const carryPendingRequests = (current: HostedEnvironmentSessionRecord): boolean => {
    const reader = pendingRequestReaders.get(current.environmentId);
    pendingRequestReaders.delete(current.environmentId);
    if (reader?.generation !== current.generation || deliveryUnknown.has(current.environmentId)) {
      return false;
    }
    let pending: boolean;
    try {
      pending = reader.read();
    } catch {
      // A broken reader cannot vouch for its requests: treat them as in flight.
      pending = true;
    }
    if (pending) deliveryUnknown.add(current.environmentId);
    return pending;
  };

  const replaceGenerations = (
    changes: (current: HostedEnvironmentSessionRecord) => RecordChanges,
    exceptSuspended = false,
  ): ReadonlyArray<HostedEnvironmentSuspension> => {
    const replaced: HostedEnvironmentSuspension[] = [];
    for (const current of Array.from(records.values())) {
      if (exceptSuspended && current.suspended) continue;
      clearDeadline(current.environmentId);
      // The caller suspends or tears down the replaced connection next, which
      // drops what it still had in flight, so read its requests first.
      const carried: HostedEnvironmentSessionRecord = carryPendingRequests(current)
        ? { ...current, sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false }
        : current;
      replaced.push({
        environmentId: current.environmentId,
        previousGeneration: current.generation,
      });
      records.set(current.environmentId, {
        ...carried,
        ...changes(carried),
        generation: ++lastGeneration,
      });
    }
    if (replaced.length > 0) publish();
    return replaced;
  };

  /**
   * `current` under a fresh generation with its session state reset. Callbacks
   * of the replaced generation are ignored from here on, and what its
   * connection had in flight leaves the environment's delivery uncertain.
   */
  const freshGeneration = (
    current: HostedEnvironmentSessionRecord,
  ): HostedEnvironmentSessionRecord => {
    carryPendingRequests(current);
    clearDeadline(current.environmentId);
    return {
      ...current,
      generation: ++lastGeneration,
      connectRequested: false,
      transportStatus: "idle",
      transportReachedOnline: false,
      sessionStatus: deliveryUnknown.has(current.environmentId)
        ? "delivery-unknown"
        : "synchronizing",
      sessionEstablished: false,
      sessionRecoveredAfterUnknown: false,
      failure: null,
      terminalNodeKey: null,
      syncFailed: false,
      snapshotAcceptedAt: null,
      suspended: false,
      relayGap: false,
    };
  };

  const suspendedChanges = (current: HostedEnvironmentSessionRecord): RecordChanges => ({
    suspended: true,
    connectRequested: false,
    transportStatus: "idle",
    transportReachedOnline: false,
    sessionStatus: stickyDeliveryUnknown(current),
    sessionEstablished: false,
    sessionRecoveredAfterUnknown: false,
    relayGap: false,
  });

  return {
    read: (environmentId) => records.get(environmentId),
    list() {
      if (listed?.snapshot !== snapshot) {
        listed = {
          snapshot,
          records: Array.from(snapshot.records.values()).toSorted(
            (left, right) => right.lastAccessedAt - left.lastAccessedAt,
          ),
        };
      }
      return listed.records;
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isCurrentGeneration: (environmentId, generation) =>
      records.get(environmentId)?.generation === generation,

    ensureRecord(node, options) {
      const nodeKey = hostedNodeEntryKey(node);
      const current = records.get(node.environmentId);
      if (current !== undefined) {
        const refreshed: HostedEnvironmentSessionRecord = {
          ...current,
          nodeId: node.id,
          label: node.label,
          effectiveRole: node.effectiveRole,
          nodeKey,
          lastAccessedAt: options?.access === false ? current.lastAccessedAt : ports.now(),
        };
        // The directory entry changed since the terminal failure: it no longer
        // blocks reconnecting. A failed channel has nothing left to replace, so
        // whatever connects next starts outside a relay gap.
        const lifted = current.terminalNodeKey !== null && current.nodeKey !== nodeKey;
        const next: HostedEnvironmentSessionRecord = lifted
          ? {
              ...refreshed,
              terminalNodeKey: null,
              relayGap: current.transportStatus === "terminal-failure" ? false : current.relayGap,
            }
          : refreshed;
        if (!write(next)) return current;
        publish();
        return next;
      }
      const created: HostedEnvironmentSessionRecord = {
        environmentId: node.environmentId,
        nodeId: node.id,
        label: node.label,
        nodeKey,
        generation: ++lastGeneration,
        lastAccessedAt: ports.now(),
        connectRequested: false,
        transportStatus: "idle",
        transportReachedOnline: false,
        sessionStatus: deliveryUnknown.has(node.environmentId)
          ? "delivery-unknown"
          : "synchronizing",
        effectiveRole: node.effectiveRole,
        sessionEstablished: false,
        sessionRecoveredAfterUnknown: false,
        failure: null,
        terminalNodeKey: null,
        syncFailed: false,
        snapshotAcceptedAt: null,
        suspended: false,
        relayGap: false,
      };
      records.set(node.environmentId, created);
      publish();
      return created;
    },

    markConnectRequested(environmentId, generation) {
      const changed = patch(environmentId, generation, () => ({
        connectRequested: true,
        suspended: false,
      }));
      if (records.get(environmentId)?.generation !== generation) return;
      // A repeated request joins the running deadline; it never postpones it.
      if (deadlines.get(environmentId)?.generation !== generation) {
        armDeadline(environmentId, generation);
      }
      if (changed) publish();
    },

    renew(environmentId) {
      const current = records.get(environmentId);
      if (current === undefined) return undefined;
      const renewed = freshGeneration(current);
      records.set(environmentId, renewed);
      publish();
      return renewed;
    },

    release(environmentId) {
      const current = records.get(environmentId);
      clearDeadline(environmentId);
      if (current === undefined) {
        pendingRequestReaders.delete(environmentId);
        return;
      }
      carryPendingRequests(current);
      records.delete(environmentId);
      publish();
    },

    suspendAll: (options) =>
      replaceGenerations(suspendedChanges, options?.exceptSuspended === true),

    withdrawAll: () =>
      replaceGenerations((current) => ({
        ...suspendedChanges(current),
        effectiveRole: null,
        transportStatus: "reconnecting",
        sessionStatus: "closed",
      })),

    clear() {
      for (const environmentId of Array.from(deadlines.keys())) clearDeadline(environmentId);
      pendingRequestReaders.clear();
      if (records.size === 0 && deliveryUnknown.size === 0) return;
      records.clear();
      deliveryUnknown.clear();
      publish();
    },

    transportStatus(environmentId, generation, status) {
      if (
        patch(environmentId, generation, (current) => ({
          transportStatus: status,
          transportReachedOnline: status === "online" || current.transportReachedOnline,
        }))
      ) {
        publish();
      }
    },

    sessionStatus(environmentId, generation, status) {
      if (
        patch(environmentId, generation, (current) =>
          // An unconfirmed action stays visible until the session closes.
          current.sessionStatus === "delivery-unknown" && status !== "closed"
            ? { sessionRecoveredAfterUnknown: false }
            : { sessionStatus: status, sessionRecoveredAfterUnknown: false },
        )
      ) {
        publish();
      }
    },

    role(environmentId, generation, role) {
      if (patch(environmentId, generation, () => ({ effectiveRole: role }))) publish();
    },

    failure(environmentId, generation, failure) {
      if (records.get(environmentId)?.generation !== generation) return;
      if (!failure.retryable) clearDeadline(environmentId);
      if (
        patch(environmentId, generation, (current) =>
          failure.retryable
            ? {
                failure,
                transportStatus: "reconnecting",
                sessionStatus: stickyDeliveryUnknown(current),
              }
            : {
                failure,
                transportStatus: "terminal-failure",
                effectiveRole: null,
                sessionStatus: stickyDeliveryUnknown(current),
                terminalNodeKey: current.nodeKey,
              },
        )
      ) {
        publish();
      }
    },

    markDeliveryUnknown(environmentId, generation) {
      if (records.get(environmentId)?.generation !== generation) return;
      const added = !deliveryUnknown.has(environmentId);
      deliveryUnknown.add(environmentId);
      const changed = patch(environmentId, generation, () => ({
        sessionStatus: "delivery-unknown",
        sessionRecoveredAfterUnknown: false,
      }));
      if (added || changed) publish();
    },

    connectionClosed(environmentId, generation) {
      if (
        patch(environmentId, generation, (current) =>
          // A terminal failure already ended the channel; no replacement follows.
          current.transportStatus === "terminal-failure"
            ? null
            : {
                relayGap: true,
                // Keep the validated role for the read-only session-sync streams
                // that make the replacement session ready; the stale session and
                // transport still deny every mutation.
                transportStatus: "reconnecting",
                transportReachedOnline: false,
                sessionStatus: stickyDeliveryUnknown(current),
                sessionRecoveredAfterUnknown: false,
              },
        )
      ) {
        publish();
      }
    },

    connectionRecovered(environmentId, generation) {
      const current = records.get(environmentId);
      if (
        current?.generation !== generation ||
        !current.relayGap ||
        current.transportStatus === "terminal-failure"
      ) {
        return;
      }
      // The replacement channel is adopted, but the session is established
      // again only by its own accepted snapshot, under a fresh deadline.
      patch(environmentId, generation, () => ({
        relayGap: false,
        sessionEstablished: false,
        sessionRecoveredAfterUnknown: false,
      }));
      armDeadline(environmentId, generation);
      publish();
    },

    markSessionReady(environmentId, generation) {
      const current = records.get(environmentId);
      // A snapshot that lands between an unintentional close and its
      // replacement channel can only have come from the lost channel, and one
      // that lands after a terminal failure from a channel that has ended.
      if (
        current?.generation !== generation ||
        current.relayGap ||
        current.transportStatus === "terminal-failure"
      ) {
        return;
      }
      clearDeadline(environmentId);
      const snapshotAcceptedAt = ports.now();
      // An earlier sync failure or terminal block of this generation is settled:
      // its transport has come back since, or this snapshot was refused above.
      const established = {
        sessionEstablished: true,
        snapshotAcceptedAt,
        suspended: false,
        syncFailed: false,
        terminalNodeKey: null,
      } as const;
      if (
        patch(environmentId, generation, (record) =>
          record.sessionStatus === "delivery-unknown"
            ? { ...established, sessionRecoveredAfterUnknown: true }
            : { ...established, sessionStatus: "ready", sessionRecoveredAfterUnknown: false },
        )
      ) {
        publish();
      }
    },

    markSessionReplaying(environmentId, generation) {
      if (
        patch(environmentId, generation, (current) =>
          current.sessionStatus === "delivery-unknown"
            ? { sessionRecoveredAfterUnknown: false }
            : { sessionStatus: "replaying" },
        )
      ) {
        publish();
      }
    },

    reportShellSnapshotFailure(environmentId, generation) {
      const current = records.get(environmentId);
      // An established session keeps running on its accepted snapshot.
      if (current?.generation !== generation || current.sessionEstablished) return;
      clearDeadline(environmentId);
      if (patch(environmentId, generation, sessionSyncFailure)) publish();
    },

    registerPendingRequestReader(environmentId, generation, hasPendingRequests) {
      if (records.get(environmentId)?.generation !== generation) return;
      pendingRequestReaders.set(environmentId, { generation, read: hasPendingRequests });
    },

    markEnvironmentDeliveryUnknown(environmentId) {
      const added = !deliveryUnknown.has(environmentId);
      deliveryUnknown.add(environmentId);
      const current = records.get(environmentId);
      const changed =
        current !== undefined &&
        current.sessionStatus !== "delivery-unknown" &&
        write({
          ...current,
          sessionStatus: "delivery-unknown",
          // A current session only needs the acknowledgement; any other still
          // waits for its snapshot first.
          sessionRecoveredAfterUnknown: current.sessionStatus === "ready",
        });
      if (added || changed) publish();
    },

    acknowledgeDeliveryUnknown(environmentId) {
      const current = records.get(environmentId);
      if (
        current === undefined ||
        current.sessionStatus !== "delivery-unknown" ||
        !current.sessionRecoveredAfterUnknown
      ) {
        return;
      }
      records.set(environmentId, {
        ...current,
        sessionStatus: "ready",
        sessionRecoveredAfterUnknown: false,
      });
      deliveryUnknown.delete(environmentId);
      publish();
    },
  };
}

const defaultPorts: HostedEnvironmentSessionPorts = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

let configuredPorts: HostedEnvironmentSessionPorts = defaultPorts;
let sessions: HostedEnvironmentSessions | null = null;

/**
 * The registry consults whichever ports are configured when it reads the clock
 * or arms a timer; a timer is always cleared through the ports that armed it.
 */
const delegatingPorts: HostedEnvironmentSessionPorts = {
  now: () => configuredPorts.now(),
  setTimeout(callback, delayMs) {
    const owner = configuredPorts;
    return { owner, timer: owner.setTimeout(callback, delayMs) };
  },
  clearTimeout(handle) {
    const { owner, timer } = handle as {
      readonly owner: HostedEnvironmentSessionPorts;
      readonly timer: unknown;
    };
    owner.clearTimeout(timer);
  },
  get syncDeadlineMs() {
    return configuredPorts.syncDeadlineMs;
  },
};

/** The application's one registry, created on first use. */
export function getHostedEnvironmentSessions(): HostedEnvironmentSessions {
  sessions ??= createHostedEnvironmentSessions(delegatingPorts);
  return sessions;
}

/**
 * Give the application's registry the platform's clock and timers. Safe to
 * call again: later calls only replace the ports, never the records.
 */
export function configureHostedEnvironmentSessions(
  ports: HostedEnvironmentSessionPorts,
): HostedEnvironmentSessions {
  configuredPorts = ports;
  return getHostedEnvironmentSessions();
}

export function resetHostedEnvironmentSessionsForTests(): void {
  sessions?.clear();
  sessions = null;
  configuredPorts = defaultPorts;
}
