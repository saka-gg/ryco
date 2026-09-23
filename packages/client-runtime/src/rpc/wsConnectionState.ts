import type { EnvironmentId } from "@ryco/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { AppLifecycleService } from "../platform/index.ts";
import { appAtomRegistry } from "./atomRegistry.ts";

export type WsConnectionUiState = "connected" | "connecting" | "error" | "offline" | "reconnecting";
export type WsReconnectPhase = "attempting" | "exhausted" | "idle" | "waiting";

export const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const WS_RECONNECT_BACKOFF_FACTOR = 2;
export const WS_RECONNECT_MAX_DELAY_MS = 64_000;
export const WS_RECONNECT_MAX_RETRIES = 7;
export const WS_RECONNECT_MAX_ATTEMPTS = WS_RECONNECT_MAX_RETRIES + 1;

export interface WsConnectionStatus {
  readonly attemptCount: number;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly connectionLabel: string | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly hasConnected: boolean;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly nextRetryAt: string | null;
  readonly online: boolean;
  readonly phase: "idle" | "connecting" | "connected" | "disconnected";
  readonly reconnectAttemptCount: number;
  readonly reconnectMaxAttempts: number;
  readonly reconnectPhase: WsReconnectPhase;
  readonly socketUrl: string | null;
}

const INITIAL_WS_CONNECTION_STATUS = Object.freeze<WsConnectionStatus>({
  attemptCount: 0,
  closeCode: null,
  closeReason: null,
  connectionLabel: null,
  connectedAt: null,
  disconnectedAt: null,
  hasConnected: false,
  lastError: null,
  lastErrorAt: null,
  nextRetryAt: null,
  online: true,
  phase: "idle",
  reconnectAttemptCount: 0,
  reconnectMaxAttempts: WS_RECONNECT_MAX_ATTEMPTS,
  reconnectPhase: "idle",
  socketUrl: null,
});

export const wsConnectionStatusAtom = Atom.make(INITIAL_WS_CONNECTION_STATUS).pipe(
  Atom.keepAlive,
  Atom.withLabel("ws-connection-status"),
);

// Per-environment WS status, written alongside the global whenever a record call
// carries its owning EnvironmentId. The global atom stays the "most recent
// writer" view for single-connection consumers; anything deciding on behalf of a
// SPECIFIC environment (e.g. the mobile outbox drain gate) must read its slot
// here — with several environments connected the global races and the last
// writer wins.
const knownWsConnectionEnvironmentIds = new Set<EnvironmentId>();

export const wsConnectionStatusForEnvironmentAtom = Atom.family((environmentId: EnvironmentId) => {
  knownWsConnectionEnvironmentIds.add(environmentId);
  return Atom.make<WsConnectionStatus>({
    ...INITIAL_WS_CONNECTION_STATUS,
    // Device-level online state predates the slot; seed it from the global.
    online: getWsConnectionStatus().online,
  }).pipe(Atom.keepAlive, Atom.withLabel(`ws-connection-status:${environmentId}`));
});

/**
 * Bumped on every socket open, from any environment. The global phase can sit at
 * "connected" while a second environment's socket opens, so consumers that must
 * react to EVERY open (the mobile outbox drain) watch this instead of a global
 * phase edge.
 */
export const wsConnectionOpenedCountAtom = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("ws-connection-opened-count"),
);

function isoNow() {
  return new Date().toISOString();
}

function updateWsConnectionStatus(
  updater: (current: WsConnectionStatus) => WsConnectionStatus,
): WsConnectionStatus {
  const nextStatus = updater(getWsConnectionStatus());
  appAtomRegistry.set(wsConnectionStatusAtom, nextStatus);
  return nextStatus;
}

function updateWsConnectionStatusForEnvironment(
  environmentId: EnvironmentId | null | undefined,
  updater: (current: WsConnectionStatus) => WsConnectionStatus,
): void {
  if (!environmentId) return;
  const atom = wsConnectionStatusForEnvironmentAtom(environmentId);
  appAtomRegistry.set(atom, updater(appAtomRegistry.get(atom)));
}

export interface WsConnectionMetadata {
  readonly connectionLabel?: string | null;
  /** When present, the record call also writes this environment's keyed slot. */
  readonly environmentId?: EnvironmentId | null;
  readonly versionMismatchHint?: string | null;
}

function normalizeConnectionLabel(label: string | null | undefined): string | null {
  const normalized = label?.trim();
  return normalized ? normalized : null;
}

export function getWsConnectionStatus(): WsConnectionStatus {
  return appAtomRegistry.get(wsConnectionStatusAtom);
}

export function getWsConnectionStatusForEnvironment(
  environmentId: EnvironmentId,
): WsConnectionStatus {
  return appAtomRegistry.get(wsConnectionStatusForEnvironmentAtom(environmentId));
}

/**
 * Forget an environment's keyed slot. Must run when its connection is disposed
 * for good (node switch, environment removal): the transport drops close events
 * for inactive sessions, so nothing else would ever move a disposed
 * environment's slot off "connected". The known-set guard keeps this a true
 * no-op for sockets that never recorded per-environment status, so disposal
 * allocates no unused status slots.
 */
export function clearWsConnectionStatusForEnvironment(environmentId: EnvironmentId): void {
  if (!knownWsConnectionEnvironmentIds.has(environmentId)) return;
  updateWsConnectionStatusForEnvironment(environmentId, (current) => ({
    ...INITIAL_WS_CONNECTION_STATUS,
    online: current.online,
  }));
}

export function getWsConnectionUiState(status: WsConnectionStatus): WsConnectionUiState {
  if (status.phase === "connected") {
    return "connected";
  }

  if (!status.online && (status.disconnectedAt !== null || status.phase === "disconnected")) {
    return "offline";
  }

  if (!status.hasConnected) {
    return status.phase === "disconnected" ? "error" : "connecting";
  }

  return "reconnecting";
}

export function recordWsConnectionAttempt(
  socketUrl: string,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  const transition = (current: WsConnectionStatus): WsConnectionStatus => ({
    ...current,
    attemptCount: current.attemptCount + 1,
    connectionLabel: connectionLabel ?? current.connectionLabel,
    nextRetryAt: null,
    phase: "connecting",
    reconnectAttemptCount: current.phase === "connected" ? 1 : current.reconnectAttemptCount + 1,
    reconnectPhase: "attempting",
    socketUrl,
  });
  updateWsConnectionStatusForEnvironment(metadata?.environmentId, transition);
  return updateWsConnectionStatus(transition);
}

export function recordWsConnectionOpened(metadata?: WsConnectionMetadata): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  const transition = (current: WsConnectionStatus): WsConnectionStatus => ({
    ...current,
    closeCode: null,
    closeReason: null,
    connectionLabel: connectionLabel ?? current.connectionLabel,
    connectedAt: isoNow(),
    disconnectedAt: null,
    hasConnected: true,
    nextRetryAt: null,
    phase: "connected",
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  });
  updateWsConnectionStatusForEnvironment(metadata?.environmentId, transition);
  appAtomRegistry.set(
    wsConnectionOpenedCountAtom,
    appAtomRegistry.get(wsConnectionOpenedCountAtom) + 1,
  );
  return updateWsConnectionStatus(transition);
}

function appendHint(message: string | null | undefined, hint: string | null | undefined) {
  const normalizedMessage = message?.trim();
  const normalizedHint = hint?.trim();
  if (!normalizedMessage) {
    return normalizedHint ? `Hint: ${normalizedHint}` : null;
  }
  return normalizedHint ? `${normalizedMessage} Hint: ${normalizedHint}` : normalizedMessage;
}

export function recordWsConnectionErrored(
  message?: string | null,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const transition = (current: WsConnectionStatus): WsConnectionStatus =>
    applyDisconnectState(current, {
      lastError:
        appendHint(message, metadata?.versionMismatchHint) ??
        appendHint(current.lastError, metadata?.versionMismatchHint),
      lastErrorAt: isoNow(),
    });
  updateWsConnectionStatusForEnvironment(metadata?.environmentId, transition);
  return updateWsConnectionStatus(transition);
}

export function recordWsConnectionClosed(
  details?: {
    readonly code?: number;
    readonly reason?: string;
  },
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const connectionLabel = normalizeConnectionLabel(metadata?.connectionLabel);
  const transition = (current: WsConnectionStatus): WsConnectionStatus =>
    applyDisconnectState(
      current,
      {
        closeCode: details?.code ?? current.closeCode,
        closeReason:
          appendHint(details?.reason, metadata?.versionMismatchHint) ??
          appendHint(current.closeReason, metadata?.versionMismatchHint),
      },
      connectionLabel === null ? undefined : { connectionLabel },
    );
  updateWsConnectionStatusForEnvironment(metadata?.environmentId, transition);
  return updateWsConnectionStatus(transition);
}

export function setBrowserOnlineStatus(online: boolean): WsConnectionStatus {
  // Device-level connectivity applies to every environment's slot alike.
  for (const environmentId of knownWsConnectionEnvironmentIds) {
    updateWsConnectionStatusForEnvironment(environmentId, (current) => ({ ...current, online }));
  }
  return updateWsConnectionStatus((current) => ({
    ...current,
    online,
  }));
}

export function resetWsReconnectBackoff(): WsConnectionStatus {
  return updateWsConnectionStatus((current) => ({
    ...current,
    nextRetryAt: null,
    reconnectAttemptCount: 0,
    reconnectPhase: "idle",
  }));
}

export function resetWsConnectionStateForTests(): void {
  appAtomRegistry.set(wsConnectionStatusAtom, INITIAL_WS_CONNECTION_STATUS);
  appAtomRegistry.set(wsConnectionOpenedCountAtom, 0);
  for (const environmentId of knownWsConnectionEnvironmentIds) {
    appAtomRegistry.set(
      wsConnectionStatusForEnvironmentAtom(environmentId),
      INITIAL_WS_CONNECTION_STATUS,
    );
  }
}

export function seedWsConnectionOnlineStatus(
  appLifecycle: AppLifecycleService,
): WsConnectionStatus {
  return setBrowserOnlineStatus(appLifecycle.isOnline());
}

export function getWsReconnectDelayMsForRetry(retryIndex: number): number | null {
  if (!Number.isInteger(retryIndex) || retryIndex < 0 || retryIndex >= WS_RECONNECT_MAX_RETRIES) {
    return null;
  }

  return Math.min(
    Math.round(WS_RECONNECT_INITIAL_DELAY_MS * WS_RECONNECT_BACKOFF_FACTOR ** retryIndex),
    WS_RECONNECT_MAX_DELAY_MS,
  );
}

function applyDisconnectState(
  current: WsConnectionStatus,
  updates: Partial<
    Pick<WsConnectionStatus, "closeCode" | "closeReason" | "lastError" | "lastErrorAt">
  >,
  metadata?: WsConnectionMetadata,
): WsConnectionStatus {
  const disconnectedAt = current.disconnectedAt ?? isoNow();
  const nextRetryDelayMs =
    current.nextRetryAt !== null || current.reconnectPhase === "exhausted"
      ? null
      : getWsReconnectDelayMsForRetry(Math.max(0, current.reconnectAttemptCount - 1));

  return {
    ...current,
    ...updates,
    connectionLabel: normalizeConnectionLabel(metadata?.connectionLabel) ?? current.connectionLabel,
    disconnectedAt,
    nextRetryAt:
      nextRetryDelayMs === null
        ? current.nextRetryAt
        : new Date(Date.now() + nextRetryDelayMs).toISOString(),
    phase: "disconnected",
    reconnectPhase:
      current.reconnectPhase === "waiting" || current.reconnectPhase === "exhausted"
        ? current.reconnectPhase
        : nextRetryDelayMs === null
          ? "exhausted"
          : "waiting",
  };
}
