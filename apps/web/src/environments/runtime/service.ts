import {
  type AuthSessionRole,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationThreadHistoryCollection,
  type OrchestrationThreadHistoryPageInfo,
  type MessageId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type ServerConfig,
  type ServerSettingsPatch,
  type TerminalEvent,
  ThreadId,
} from "@ryco/contracts";
import { Throttler } from "@tanstack/react-pacer";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  createKnownEnvironment,
  getKnownEnvironmentWsBaseUrl,
} from "@ryco/client-runtime/knownEnvironment";
import {
  createEnvironmentConnectionSupervisor,
  createDeviceFrameSource,
  type ReleaseThreadDetailSubscription,
  SavedEnvironmentConnectionCancelledError,
} from "@ryco/client-runtime/connection";
export {
  classifyProjectionSnapshot,
  shouldApplyProjectionEvent,
  shouldApplyProjectionSnapshot,
} from "@ryco/client-runtime/connection";

import { markPromotedDraftThreadByRef, useComposerDraftStore } from "~/composerDraftStore";
import { ensureLocalApi } from "~/localApi";
import { deriveOrchestrationBatchEffects } from "~/orchestrationEventEffects";
import { invalidateProjectSearchEntries } from "~/rpc/projectAtoms";
import { invalidateAllCheckpointDiffs } from "~/rpc/providerAtoms";
import { getPrimaryKnownEnvironment } from "../primary";
import { issuePrimaryWebSocketToken } from "../primary/auth";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl,
} from "../remote/api";
import { resolveRemotePairingTarget } from "../remote/target";
import {
  getSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated,
  listSavedEnvironmentRecords,
  persistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
  toPersistedSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken,
} from "./catalog";
import { createEnvironmentConnection, type EnvironmentConnection } from "./connection";
import { useStore, selectSidebarThreadSummaryByRef, selectThreadByRef } from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import type { WsProtocolCloseContext } from "@ryco/client-runtime/rpc";
import { createDeviceRpcClient } from "@ryco/client-runtime/rpc";
import {
  environmentQueryRefresh,
  isHostedEnvironmentQueryRefreshReady,
} from "../../rpc/environmentQueryRefresh";
import { applySettingsUpdated, getServerConfig } from "../../rpc/serverState";
import { DeviceWsTransport, HostedWsTransport, WsTransport } from "../../rpc/wsTransport";
import { createWsRpcClient, type WsRpcClient } from "../../rpc/wsRpcClient";
import { appendVersionMismatchHint, resolveServerConfigVersionMismatch } from "../../versionSkew";
import { markStartupPhase, measureStartupPhase } from "~/perf/startupInstrumentation";
import { isHostedHubMode } from "~/env";
import {
  markHostedSessionReady,
  markHostedSessionReplaying,
  reportHostedShellSnapshotFailure,
  useHostedHubStore,
} from "~/hostedHub/state";
import { getHostedRelayAttemptFactory } from "~/hostedHub/transport";
import { createWebEnvironmentStateSink } from "./environmentStateSink";
import { webSocket } from "../../platform";
import { DesktopWorkspaceIpcSocketFactory } from "../../platform/desktopWorkspaceSocket";

function isSavedEnvironmentConnectionCancelledError(
  error: unknown,
): error is SavedEnvironmentConnectionCancelledError {
  return error instanceof SavedEnvironmentConnectionCancelledError;
}

let needsProviderInvalidation = false;
const environmentStateSink = createWebEnvironmentStateSink({
  markProviderInvalidationNeeded: () => {
    needsProviderInvalidation = true;
    getEnvironmentSupervisor().requestProviderInvalidation();
  },
  flushProviderInvalidation: () => {
    needsProviderInvalidation = false;
    invalidateAllCheckpointDiffs();
    invalidateProjectSearchEntries();
  },
  supervisor: getEnvironmentSupervisor,
});
const INITIAL_SERVER_CONFIG_SNAPSHOT_WAIT_MS = 150;
const NOOP = () => undefined;
const SSH_HTTP_STATUS_RE = /^\[ssh_http:(\d+)\]\s/u;
let lastBrowserHiddenAt: number | null = null;

let primaryShellSnapshotApplied = false;
let resolvePrimaryShellSnapshotApplied: (() => void) | null = null;
let primaryShellSnapshotAppliedPromise = new Promise<void>((resolve) => {
  resolvePrimaryShellSnapshotApplied = resolve;
});
let environmentSupervisor: ReturnType<
  typeof createEnvironmentConnectionSupervisor<SavedEnvironmentRecord>
> | null = null;

function getEnvironmentSupervisor() {
  if (environmentSupervisor) {
    return environmentSupervisor;
  }

  environmentSupervisor = createEnvironmentConnectionSupervisor({
    isHostedMode: isHostedHubMode,
    now: Date.now,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
    createInvalidationThrottle: () =>
      new Throttler(
        () => {
          if (needsProviderInvalidation) {
            environmentStateSink.flushProviderInvalidation();
          }
        },
        { wait: 100, leading: false, trailing: true },
      ),
    resetProviderInvalidation: () => {
      needsProviderInvalidation = false;
    },
    createPrimaryConnection: () =>
      getPrimaryKnownEnvironment()?.environmentId ? createPrimaryEnvironmentConnection() : null,
    listSavedEnvironmentRecords,
    hasSavedEnvironmentRegistryHydrated,
    waitForSavedEnvironmentRegistryHydration,
    subscribeSavedEnvironmentRegistry: useSavedEnvironmentRegistryStore.subscribe,
    connectSavedEnvironment: (record, isCancelled) =>
      connectSavedEnvironment(record, undefined, isCancelled),
    disconnectSavedEnvironment,
    waitForPrimaryShellSnapshotApplied,
    subscribeBrowserResume: subscribeBrowserResumeReconnects,
    isThreadDetailSubscriptionNonIdle: (environmentId, threadId) =>
      isNonIdleThreadDetailSubscription({ environmentId, threadId }),
    syncThreadDetailSnapshot: (environmentId, snapshot) =>
      useStore
        .getState()
        .syncServerThreadDetail((snapshot as { readonly thread: never }).thread, environmentId),
    syncThreadWindowSnapshot: (environmentId, snapshot) =>
      useStore.getState().syncServerThreadWindow(snapshot, environmentId),
    syncThreadHistoryPage: (environmentId, threadId, page) =>
      useStore.getState().syncServerThreadHistoryPage(page, threadId, environmentId),
    setThreadHistoryRequestState: (input) =>
      useStore.getState().setServerThreadHistoryLoadState({
        ...input,
        loadState: {
          status: input.status,
          cursor: input.cursor,
          error: input.error,
        },
      }),
    applyThreadDetailEvent: (environmentId, event) =>
      applyEnvironmentThreadDetailEvent(event as OrchestrationEvent, environmentId),
    stateSink: environmentStateSink,
    onShellSnapshotReceived: (environmentId) => {
      if (environmentId === getPrimaryKnownEnvironment()?.environmentId) {
        markStartupPhase("primary-shell-snapshot-received");
      }
    },
    onShellSnapshotCurrent: () => undefined,
    onShellSnapshotApplied: (environmentId) => {
      if (environmentId !== getPrimaryKnownEnvironment()?.environmentId) return;
      markStartupPhase("primary-shell-snapshot-applied");
      measureStartupPhase(
        "primary-shell-snapshot",
        "primary-shell-snapshot-received",
        "primary-shell-snapshot-applied",
      );
      markStartupPhase("primary-shell-usable");
      measureStartupPhase("primary-shell-ready", "root-before-load-ready", "primary-shell-usable");
      markPrimaryShellSnapshotApplied();
    },
    onShellSnapshotReady: () => undefined,
  });
  return environmentSupervisor;
}

function createDeferredPromise<T>() {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value);
      resolve = null;
    },
  };
}

function markPrimaryShellSnapshotApplied(): void {
  if (primaryShellSnapshotApplied) {
    return;
  }
  primaryShellSnapshotApplied = true;
  resolvePrimaryShellSnapshotApplied?.();
  resolvePrimaryShellSnapshotApplied = null;
}

async function waitForPrimaryShellSnapshotApplied(timeoutMs: number): Promise<void> {
  if (primaryShellSnapshotApplied || !getPrimaryKnownEnvironment()?.environmentId) {
    return;
  }

  await Promise.race([
    primaryShellSnapshotAppliedPromise,
    new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, timeoutMs);
    }),
  ]);
}

async function waitForConfigSnapshot(
  promise: Promise<ServerConfig>,
  timeoutMs: number,
): Promise<ServerConfig | null> {
  return await new Promise<ServerConfig | null>((resolve) => {
    const timeoutId = globalThis.setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (config) => {
        clearTimeout(timeoutId);
        resolve(config);
      },
      () => {
        clearTimeout(timeoutId);
        resolve(null);
      },
    );
  });
}

function isNonIdleThreadDetailSubscription(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): boolean {
  const threadRef = scopeThreadRef(input.environmentId, input.threadId);
  const state = useStore.getState();
  const sidebarThread = selectSidebarThreadSummaryByRef(state, threadRef);

  // Prefer shell/sidebar state first because it carries the coarse thread
  // readiness flags used throughout the UI (pending approvals/input/plan).
  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan
    ) {
      return true;
    }

    const orchestrationStatus = sidebarThread.session?.orchestrationStatus;
    if (
      orchestrationStatus &&
      orchestrationStatus !== "idle" &&
      orchestrationStatus !== "stopped"
    ) {
      return true;
    }

    if (sidebarThread.latestTurn?.state === "running") {
      return true;
    }
  }

  const thread = selectThreadByRef(state, threadRef);
  if (!thread) {
    return false;
  }

  const orchestrationStatus = thread.session?.orchestrationStatus;
  return (
    Boolean(
      orchestrationStatus && orchestrationStatus !== "idle" && orchestrationStatus !== "stopped",
    ) ||
    thread.latestTurn?.state === "running" ||
    thread.pendingSourceProposedPlan !== undefined
  );
}

function disposeThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  getEnvironmentSupervisor().disposeThreadDetailSubscriptionsForEnvironment(environmentId);
}

export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReleaseThreadDetailSubscription {
  return getEnvironmentSupervisor().retainThreadDetailSubscription(environmentId, threadId);
}

export function loadOlderThreadHistory(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly collection: OrchestrationThreadHistoryCollection;
  readonly page: OrchestrationThreadHistoryPageInfo;
  readonly limit: number;
}) {
  return getEnvironmentSupervisor().loadOlderThreadHistory(input);
}

export function loadThreadHistoryAroundMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly limit: number;
}) {
  return getEnvironmentSupervisor().loadThreadHistoryAroundMessage(input);
}

function getRuntimeErrorFields(error: unknown) {
  return {
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorAt: new Date().toISOString(),
  } as const;
}

function isoNow(): string {
  return new Date().toISOString();
}

function readSshHttpErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = SSH_HTTP_STATUS_RE.exec(error.message);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function isSshHttpAuthError(error: unknown, status: number): boolean {
  return readSshHttpErrorStatus(error) === status;
}

function isDesktopSshTargetEqual(
  left: DesktopSshEnvironmentTarget | undefined,
  right: DesktopSshEnvironmentTarget | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.alias === right.alias &&
    left.hostname === right.hostname &&
    left.username === right.username &&
    left.port === right.port
  );
}

function findSavedEnvironmentRecordByDesktopSshTarget(
  target: DesktopSshEnvironmentTarget | undefined,
): SavedEnvironmentRecord | null {
  if (!target) {
    return null;
  }

  return (
    listSavedEnvironmentRecords().find((record) =>
      isDesktopSshTargetEqual(record.desktopSsh, target),
    ) ?? null
  );
}

function buildSavedEnvironmentRegistryById(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): Record<EnvironmentId, SavedEnvironmentRecord> {
  return Object.fromEntries(records.map((record) => [record.environmentId, record])) as Record<
    EnvironmentId,
    SavedEnvironmentRecord
  >;
}

type SavedEnvironmentRegistrySnapshot = ReadonlyMap<EnvironmentId, SavedEnvironmentRecord | null>;

function snapshotSavedEnvironmentRegistry(
  environmentIds: ReadonlyArray<EnvironmentId>,
): SavedEnvironmentRegistrySnapshot {
  return new Map(
    environmentIds.map((environmentId) => [
      environmentId,
      getSavedEnvironmentRecord(environmentId) ?? null,
    ]),
  );
}

async function persistSavedEnvironmentRegistryRollback(
  snapshot: SavedEnvironmentRegistrySnapshot,
): Promise<void> {
  const byId = buildSavedEnvironmentRegistryById(listSavedEnvironmentRecords());
  for (const [environmentId, record] of snapshot) {
    if (record) {
      byId[environmentId] = record;
      continue;
    }
    delete byId[environmentId];
  }
  const records = Object.values(byId);
  await ensureLocalApi().persistence.setSavedEnvironmentRegistry(
    records.map((entry) => toPersistedSavedEnvironmentRecord(entry)),
  );
  useSavedEnvironmentRegistryStore.setState({
    byId,
  });
}

async function resolveDesktopSshEnvironmentBootstrap(
  target: DesktopSshEnvironmentTarget,
  options?: { readonly issuePairingToken?: boolean },
): Promise<DesktopSshEnvironmentBootstrap> {
  const desktopBridge = window.desktopBridge;
  if (!desktopBridge) {
    throw new Error("SSH launch is only available in the desktop app.");
  }

  return await desktopBridge.ensureSshEnvironment(target, options);
}

function getDesktopSshBridge() {
  const desktopBridge = window.desktopBridge;
  if (!desktopBridge) {
    throw new Error("SSH launch is only available in the desktop app.");
  }
  return desktopBridge;
}

async function fetchDesktopSshEnvironmentDescriptor(httpBaseUrl: string) {
  return await getDesktopSshBridge().fetchSshEnvironmentDescriptor(httpBaseUrl);
}

async function bootstrapDesktopSshBearerSession(httpBaseUrl: string, credential: string) {
  return await getDesktopSshBridge().bootstrapSshBearerSession(httpBaseUrl, credential);
}

async function fetchDesktopSshSessionState(httpBaseUrl: string, bearerToken: string) {
  return await getDesktopSshBridge().fetchSshSessionState(httpBaseUrl, bearerToken);
}

async function resolveDesktopSshWebSocketConnectionUrl(
  wsBaseUrl: string,
  httpBaseUrl: string,
  bearerToken: string,
) {
  const issued = await getDesktopSshBridge().issueSshWebSocketToken(httpBaseUrl, bearerToken);
  const url = new URL(wsBaseUrl, window.location.origin);
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}

async function prepareSavedEnvironmentRecordForConnection(
  record: SavedEnvironmentRecord,
  options?: { readonly issuePairingToken?: boolean },
): Promise<{
  readonly record: SavedEnvironmentRecord;
  readonly pairingToken: string | null;
  readonly remotePort: number | null;
  readonly remoteServerKind: "external" | "managed" | null;
}> {
  if (!record.desktopSsh) {
    return {
      record,
      pairingToken: null,
      remotePort: null,
      remoteServerKind: null,
    };
  }

  const bootstrap = await resolveDesktopSshEnvironmentBootstrap(record.desktopSsh, options);
  const nextRecord: SavedEnvironmentRecord = {
    ...record,
    httpBaseUrl: bootstrap.httpBaseUrl,
    wsBaseUrl: bootstrap.wsBaseUrl,
    desktopSsh: bootstrap.target,
  };

  if (
    nextRecord.httpBaseUrl !== record.httpBaseUrl ||
    nextRecord.wsBaseUrl !== record.wsBaseUrl ||
    !isDesktopSshTargetEqual(nextRecord.desktopSsh, record.desktopSsh)
  ) {
    await persistSavedEnvironmentRecord(nextRecord);
    useSavedEnvironmentRegistryStore.getState().upsert(nextRecord);
  }

  return {
    record: nextRecord,
    pairingToken: bootstrap.pairingToken,
    remotePort: bootstrap.remotePort ?? null,
    remoteServerKind: bootstrap.remoteServerKind ?? null,
  };
}

async function issueDesktopSshBearerSession(record: SavedEnvironmentRecord): Promise<{
  readonly record: SavedEnvironmentRecord;
  readonly bearerToken: string;
  readonly role: AuthSessionRole | null;
}> {
  const registrySnapshot = snapshotSavedEnvironmentRegistry([record.environmentId]);
  const prepared = await prepareSavedEnvironmentRecordForConnection(record, {
    issuePairingToken: true,
  });
  if (!prepared.pairingToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Desktop SSH launch did not return a pairing token.");
  }

  const bearerSession = await bootstrapDesktopSshBearerSession(
    prepared.record.httpBaseUrl,
    prepared.pairingToken,
  ).catch(async (error) => {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
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
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    prepared.record.environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Unable to persist saved environment credentials.");
  }

  return {
    record: prepared.record,
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role ?? null,
  };
}

function setRuntimeConnecting(environmentId: EnvironmentId) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connecting",
    lastError: null,
    lastErrorAt: null,
  });
}

function setRuntimeConnected(environmentId: EnvironmentId) {
  const connectedAt = isoNow();
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connected",
    authState: "authenticated",
    connectedAt,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  useSavedEnvironmentRegistryStore.getState().markConnected(environmentId, connectedAt);
}

function setRuntimeDisconnected(environmentId: EnvironmentId, reason?: string | null) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "disconnected",
    disconnectedAt: isoNow(),
    ...(reason && reason.trim().length > 0
      ? {
          lastError: reason,
          lastErrorAt: isoNow(),
        }
      : {}),
  });
}

function setRuntimeError(environmentId: EnvironmentId, error: unknown) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "error",
    ...getRuntimeErrorFields(error),
  });
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

export function shouldApplyTerminalEvent(input: {
  serverThreadArchivedAt: string | null | undefined;
  hasDraftThread: boolean;
}): boolean {
  if (input.serverThreadArchivedAt !== undefined) {
    return input.serverThreadArchivedAt === null;
  }

  return input.hasDraftThread;
}

function applyRecoveredEventBatch(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
) {
  if (events.length === 0) {
    return;
  }

  const batchEffects = deriveOrchestrationBatchEffects(events);
  const uiEvents = coalesceOrchestrationUiEvents(events);
  const needsProjectUiSync = events.some(
    (event) =>
      event.type === "project.created" ||
      event.type === "project.meta-updated" ||
      event.type === "project.deleted",
  );

  if (batchEffects.needsProviderInvalidation) {
    environmentStateSink.markProviderInvalidationNeeded();
  }

  environmentStateSink.applyOrchestrationEvents(environmentId, uiEvents);
  if (needsProjectUiSync) {
    environmentStateSink.syncProjects(environmentId);
  }

  const needsThreadUiSync = events.some(
    (event) => event.type === "thread.created" || event.type === "thread.deleted",
  );
  if (needsThreadUiSync) {
    environmentStateSink.syncThreads(environmentId);
  }

  for (const threadId of batchEffects.promoteDraftThreadIds) {
    markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
  }
  for (const threadId of batchEffects.clearDeletedThreadIds) {
    environmentStateSink.clearThreadDraft(scopeThreadRef(environmentId, threadId));
  }
  for (const event of events) {
    if (event.type === "project.deleted") {
      environmentStateSink.clearProjectDraftThread(
        scopeProjectRef(environmentId, event.payload.projectId),
      );
    }
  }
  for (const threadId of batchEffects.removeTerminalStateThreadIds) {
    environmentStateSink.clearTerminalState(scopeThreadRef(environmentId, threadId));
  }

  getEnvironmentSupervisor().reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
}

export function applyEnvironmentThreadDetailEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
) {
  applyRecoveredEventBatch([event], environmentId);
}

function createEnvironmentConnectionHandlers(
  hostedGeneration: number | null = null,
  initialRefreshEnvironmentId?: EnvironmentId,
) {
  const acceptsEvent = () =>
    hostedGeneration === null || useHostedHubStore.getState().generation === hostedGeneration;
  let queryRefreshGeneration = initialRefreshEnvironmentId
    ? environmentQueryRefresh.begin(initialRefreshEnvironmentId)
    : null;
  const beginQueryRefresh = (environmentId: EnvironmentId) => {
    if (!acceptsEvent()) return;
    queryRefreshGeneration = environmentQueryRefresh.begin(environmentId);
  };
  const completeQueryRefresh = (environmentId: EnvironmentId) => {
    const refreshGeneration = queryRefreshGeneration;
    if (refreshGeneration === null) return;
    const isAuthoritativelyReady = () => {
      if (hostedGeneration === null) return true;
      return isHostedEnvironmentQueryRefreshReady(
        useHostedHubStore.getState(),
        environmentId,
        hostedGeneration,
      );
    };
    void environmentQueryRefresh
      .ready(environmentId, refreshGeneration, isAuthoritativelyReady)
      .catch(() => undefined);
  };
  return {
    onResubscribe: (environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      beginQueryRefresh(environmentId);
      if (hostedGeneration !== null) {
        markHostedSessionReplaying(environmentId, hostedGeneration);
      }
    },
    onShellError: (environmentId: EnvironmentId) => {
      if (hostedGeneration !== null && acceptsEvent()) {
        reportHostedShellSnapshotFailure(environmentId, hostedGeneration);
      }
    },
    resetShellProjection: (environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      getEnvironmentSupervisor().resetShellProjection(environmentId);
    },
    applyShellEvent: (event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      getEnvironmentSupervisor().applyShellEvent(event, environmentId);
    },
    syncShellSnapshot: (snapshot: OrchestrationShellSnapshot, environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      getEnvironmentSupervisor().syncShellSnapshot(snapshot, environmentId, {
        onCurrent: () => {
          if (hostedGeneration !== null) markHostedSessionReady(environmentId, hostedGeneration);
          completeQueryRefresh(environmentId);
        },
        onReady: () => {
          if (hostedGeneration !== null) markHostedSessionReady(environmentId, hostedGeneration);
          completeQueryRefresh(environmentId);
        },
      });
    },
    applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
      const serverThread = selectThreadByRef(useStore.getState(), threadRef);
      const hasDraftThread =
        useComposerDraftStore.getState().getDraftThreadByRef(threadRef) !== null;
      if (
        !shouldApplyTerminalEvent({
          serverThreadArchivedAt: serverThread?.archivedAt,
          hasDraftThread,
        })
      ) {
        return;
      }
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, event);
    },
  };
}

function createPrimaryEnvironmentClient(
  knownEnvironment: ReturnType<typeof getPrimaryKnownEnvironment>,
) {
  const wsBaseUrl = getKnownEnvironmentWsBaseUrl(knownEnvironment);
  if (!wsBaseUrl) {
    throw new Error(
      `Unable to resolve websocket URL for ${knownEnvironment?.label ?? "primary environment"}.`,
    );
  }
  const connectionLabel = knownEnvironment?.label ?? null;

  if (isHostedHubMode()) {
    const attemptFactory = getHostedRelayAttemptFactory();
    const hostedHandlers = attemptFactory.lifecycleHandlers();
    const transport = new HostedWsTransport(() => attemptFactory.nextUrl(), {
      ...hostedHandlers,
      getConnectionLabel: () => connectionLabel,
      getEnvironmentId: () => knownEnvironment?.environmentId ?? null,
      onOpen: () => {
        hostedHandlers.onOpen?.();
        markStartupPhase("primary-ws-open");
      },
    });
    return createWsRpcClient(
      transport,
      createDeviceRpcClient(transport, { manageTransport: false }),
    );
  }

  const authenticatedSocketUrl = async (pathname: "/ws" | "/ws/device" | "/ws/device-frames") => {
    const issued = await issuePrimaryWebSocketToken();
    const url = new URL(wsBaseUrl, window.location.origin);
    url.pathname = pathname;
    url.searchParams.set("wsToken", issued.token);
    return url.toString();
  };
  return createWsRpcClient(
    new WsTransport(() => authenticatedSocketUrl("/ws"), {
      getConnectionLabel: () => connectionLabel,
      getEnvironmentId: () => knownEnvironment?.environmentId ?? null,
      getVersionMismatchHint: () =>
        resolveServerConfigVersionMismatch(getServerConfig())?.hint ?? null,
      onOpen: () => {
        markStartupPhase("primary-ws-open");
      },
    }),
    createDeviceRpcClient(
      new DeviceWsTransport(() => authenticatedSocketUrl("/ws/device"), {
        getConnectionLabel: () => connectionLabel,
      }),
      {
        openFrameSource: (udid, handlers) =>
          createDeviceFrameSource({
            udid,
            handlers,
            socket: webSocket,
            resolveUrl: () => authenticatedSocketUrl("/ws/device-frames"),
          }),
      },
    ),
  );
}

async function resolveSavedEnvironmentSocketUrl(
  environmentId: EnvironmentId,
  bearerToken: string,
  pathname: "/ws" | "/ws/device" | "/ws/device-frames",
): Promise<string> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) throw new Error(`Saved environment ${environmentId} not found.`);
  const rawUrl = record.desktopSsh
    ? await resolveDesktopSshWebSocketConnectionUrl(
        record.wsBaseUrl,
        record.httpBaseUrl,
        bearerToken,
      )
    : await resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: record.wsBaseUrl,
        httpBaseUrl: record.httpBaseUrl,
        bearerToken,
      });
  const url = new URL(rawUrl, window.location.origin);
  url.pathname = pathname;
  return url.toString();
}

function createSavedEnvironmentClient(
  environmentId: EnvironmentId,
  bearerToken: string,
): WsRpcClient {
  useSavedEnvironmentRuntimeStore.getState().ensure(environmentId);

  return createWsRpcClient(
    new WsTransport(() => resolveSavedEnvironmentSocketUrl(environmentId, bearerToken, "/ws"), {
      getConnectionLabel: () => getSavedEnvironmentRecord(environmentId)?.label ?? null,
      getEnvironmentId: () => environmentId,
      getVersionMismatchHint: () =>
        resolveServerConfigVersionMismatch(
          useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
        )?.hint ?? null,
      onAttempt: () => {
        setRuntimeConnecting(environmentId);
      },
      onOpen: () => {
        setRuntimeConnected(environmentId);
      },
      onError: (message: string) => {
        const mismatch = resolveServerConfigVersionMismatch(
          useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
        );
        useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
          connectionState: "error",
          lastError: appendVersionMismatchHint(message, mismatch),
          lastErrorAt: isoNow(),
        });
      },
      onClose: (
        details: { readonly code: number; readonly reason: string },
        context: WsProtocolCloseContext,
      ) => {
        if (context.intentional) {
          return;
        }
        setRuntimeDisconnected(
          environmentId,
          appendVersionMismatchHint(
            details.reason,
            resolveServerConfigVersionMismatch(
              useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
            ),
          ),
        );
      },
    }),
    createDeviceRpcClient(
      new DeviceWsTransport(
        () => resolveSavedEnvironmentSocketUrl(environmentId, bearerToken, "/ws/device"),
        {
          getConnectionLabel: () => getSavedEnvironmentRecord(environmentId)?.label ?? null,
        },
      ),
      {
        openFrameSource: (udid, handlers) =>
          createDeviceFrameSource({
            udid,
            handlers,
            socket: webSocket,
            resolveUrl: () =>
              resolveSavedEnvironmentSocketUrl(environmentId, bearerToken, "/ws/device-frames"),
          }),
      },
    ),
  );
}

async function refreshSavedEnvironmentMetadata(
  environmentId: EnvironmentId,
  bearerToken: string,
  client: WsRpcClient,
  roleHint?: AuthSessionRole | null,
  configHint?: ServerConfig | null,
): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error(`Saved environment ${environmentId} not found.`);
  }

  const [serverConfig, sessionState] = await Promise.all([
    configHint ? Promise.resolve(configHint) : client.server.getConfig(),
    record.desktopSsh
      ? fetchDesktopSshSessionState(record.httpBaseUrl, bearerToken)
      : fetchRemoteSessionState({
          httpBaseUrl: record.httpBaseUrl,
          bearerToken,
        }),
  ]);

  useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
    authState: sessionState.authenticated ? "authenticated" : "requires-auth",
    descriptor: serverConfig.environment,
    serverConfig,
    role: sessionState.authenticated ? (sessionState.role ?? roleHint ?? null) : null,
  });
  useSavedEnvironmentRegistryStore
    .getState()
    .rename(record.environmentId, serverConfig.environment.label);
}

function registerConnection(connection: EnvironmentConnection): EnvironmentConnection {
  return getEnvironmentSupervisor().register(connection);
}

async function removeConnection(environmentId: EnvironmentId): Promise<boolean> {
  return await getEnvironmentSupervisor().remove(environmentId);
}

function createPrimaryEnvironmentConnection(): EnvironmentConnection {
  const knownEnvironment = getPrimaryKnownEnvironment();
  if (!knownEnvironment?.environmentId) {
    throw new Error("Unable to resolve the primary environment.");
  }

  const existing = getEnvironmentSupervisor().read(knownEnvironment.environmentId);
  if (existing) {
    return existing;
  }

  const hostedGeneration = isHostedHubMode() ? useHostedHubStore.getState().generation : null;
  return registerConnection(
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment,
      client: createPrimaryEnvironmentClient(knownEnvironment),
      ...createEnvironmentConnectionHandlers(
        hostedGeneration,
        hostedGeneration !== null ? knownEnvironment.environmentId : undefined,
      ),
    }),
  );
}

function maybeCreatePrimaryEnvironmentConnection(): EnvironmentConnection | null {
  return getPrimaryKnownEnvironment()?.environmentId
    ? getEnvironmentSupervisor().connectPrimary()
    : null;
}

export async function disconnectPrimaryEnvironment(): Promise<void> {
  await getEnvironmentSupervisor().disconnectPrimary();
}

export function connectPrimaryEnvironment(): EnvironmentConnection | null {
  return maybeCreatePrimaryEnvironmentConnection();
}

/** Connect one exact native-verified Hub node through Desktop main's opaque relay transport. */
export async function connectDesktopWorkspaceEnvironment(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): Promise<EnvironmentConnection> {
  const bridge = globalThis.window?.desktopBridge;
  if (!bridge?.prepareDesktopWorkspaceTransport) {
    throw new Error("Desktop workspace transport is unavailable.");
  }
  const existing = getEnvironmentSupervisor().read(input.environmentId);
  if (existing) {
    await existing.reconnect();
    await existing.ensureBootstrapped();
    return existing;
  }
  const socketFactory = new DesktopWorkspaceIpcSocketFactory(input.environmentId, bridge);
  const transport = new HostedWsTransport(() => socketFactory.nextUrl(), {
    preserveSocketPath: true,
    webSocketConstructor: (url) => socketFactory.createSocket(url) as unknown as WebSocket,
    retryTransientErrors: false,
    reconnectMaxRetries: 1_000_000,
    getConnectionLabel: () => input.label,
    getEnvironmentId: () => input.environmentId,
  });
  const knownEnvironment = createKnownEnvironment({
    id: input.environmentId,
    label: input.label,
    source: "hub-hosted",
    target: {
      httpBaseUrl: "http://desktop-workspace.invalid",
      wsBaseUrl: "ws://desktop-workspace.invalid",
    },
  });
  const connection = registerConnection(
    createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: { ...knownEnvironment, environmentId: input.environmentId },
      client: createWsRpcClient(transport),
      onConfigUpdated: (config) => {
        useSavedEnvironmentRuntimeStore.getState().ensure(input.environmentId);
        useSavedEnvironmentRuntimeStore.getState().patch(input.environmentId, {
          descriptor: config.environment,
          serverConfig: config,
          connectionState: "connected",
        });
      },
      onWelcome: (payload) => {
        useSavedEnvironmentRuntimeStore.getState().ensure(input.environmentId);
        useSavedEnvironmentRuntimeStore.getState().patch(input.environmentId, {
          descriptor: payload.environment,
        });
      },
      ...createEnvironmentConnectionHandlers(),
    }),
  );
  try {
    await connection.ensureBootstrapped();
    return connection;
  } catch (error) {
    await removeConnection(input.environmentId).catch(() => undefined);
    throw error;
  }
}

async function ensureSavedEnvironmentConnection(
  record: SavedEnvironmentRecord,
  options?: {
    readonly client?: WsRpcClient;
    readonly bearerToken?: string;
    readonly role?: AuthSessionRole | null;
    readonly serverConfig?: ServerConfig | null;
  },
): Promise<EnvironmentConnection> {
  return await getEnvironmentSupervisor().ensureSavedEnvironmentConnection(record, (isCancelled) =>
    connectSavedEnvironment(record, options, isCancelled),
  );
}

async function connectSavedEnvironment(
  record: SavedEnvironmentRecord,
  options?: {
    readonly client?: WsRpcClient;
    readonly bearerToken?: string;
    readonly role?: AuthSessionRole | null;
    readonly serverConfig?: ServerConfig | null;
  },
  isCancelled: () => boolean = () => false,
): Promise<EnvironmentConnection> {
  let activeRecord = record;
  let roleHint = options?.role ?? null;
  let bearerToken =
    options?.bearerToken ?? (await readSavedEnvironmentBearerToken(record.environmentId));
  let clientOverride = options?.client;

  for (;;) {
    if (!bearerToken) {
      if (record.desktopSsh) {
        const issued = await issueDesktopSshBearerSession(activeRecord);
        activeRecord = issued.record;
        bearerToken = issued.bearerToken;
        roleHint = issued.role;
      } else {
        await removeSavedEnvironmentBearerToken(record.environmentId).catch(() => undefined);
        useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
          authState: "requires-auth",
          role: null,
          connectionState: "disconnected",
          lastError: "Saved environment is missing its saved credential. Pair it again.",
          lastErrorAt: isoNow(),
        });
        throw new Error("Saved environment is missing its saved credential.");
      }
    }
    const prepared = await prepareSavedEnvironmentRecordForConnection(activeRecord);
    activeRecord = prepared.record;

    const activeBearerToken = bearerToken;
    const client =
      clientOverride ?? createSavedEnvironmentClient(activeRecord.environmentId, activeBearerToken);
    const initialConfigSnapshot = createDeferredPromise<ServerConfig>();
    const knownEnvironment = createKnownEnvironment({
      id: activeRecord.environmentId,
      label: activeRecord.label,
      source: "manual",
      target: {
        httpBaseUrl: activeRecord.httpBaseUrl,
        wsBaseUrl: activeRecord.wsBaseUrl,
      },
    });
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        ...knownEnvironment,
        environmentId: activeRecord.environmentId,
      },
      client,
      refreshMetadata: async () => {
        await refreshSavedEnvironmentMetadata(
          activeRecord.environmentId,
          activeBearerToken,
          client,
        );
      },
      onConfigUpdated: (config) => {
        initialConfigSnapshot.resolve(config);
        useSavedEnvironmentRuntimeStore.getState().patch(activeRecord.environmentId, {
          descriptor: config.environment,
          serverConfig: config,
        });
      },
      onWelcome: (payload) => {
        useSavedEnvironmentRuntimeStore.getState().patch(activeRecord.environmentId, {
          descriptor: payload.environment,
        });
      },
      ...createEnvironmentConnectionHandlers(),
    });

    try {
      try {
        const initialServerConfig =
          options?.serverConfig ??
          (await waitForConfigSnapshot(
            initialConfigSnapshot.promise,
            INITIAL_SERVER_CONFIG_SNAPSHOT_WAIT_MS,
          ));
        await refreshSavedEnvironmentMetadata(
          activeRecord.environmentId,
          activeBearerToken,
          client,
          roleHint,
          initialServerConfig,
        );
      } catch (error) {
        const isAuthError = activeRecord.desktopSsh
          ? isSshHttpAuthError(error, 401)
          : isRemoteEnvironmentAuthHttpError(error) && error.status === 401;
        if (!isAuthError) {
          throw error;
        }
        if (!activeRecord.desktopSsh) {
          await removeSavedEnvironmentBearerToken(activeRecord.environmentId);
          throw new Error("Saved environment credential expired. Pair it again.", {
            cause: error,
          });
        }

        const issued = await issueDesktopSshBearerSession(activeRecord);
        activeRecord = issued.record;
        bearerToken = issued.bearerToken;
        roleHint = issued.role;
        await connection.dispose().catch(() => undefined);
        clientOverride = undefined;
        continue;
      }
      if (isCancelled()) {
        await connection.dispose().catch(() => undefined);
        throw new SavedEnvironmentConnectionCancelledError(activeRecord.environmentId);
      }
      registerConnection(connection);
      return connection;
    } catch (error) {
      if (error instanceof SavedEnvironmentConnectionCancelledError) {
        throw error;
      }
      setRuntimeError(activeRecord.environmentId, error);
      const removed = await removeConnection(activeRecord.environmentId).catch(() => false);
      if (!removed) {
        await connection.dispose().catch(() => undefined);
      }
      throw error;
    }
  }
}

function subscribeBrowserResumeReconnects(listener: (reason: string) => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return NOOP;
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      lastBrowserHiddenAt = Date.now();
      return;
    }
    if (document.visibilityState === "visible" && lastBrowserHiddenAt !== null) {
      lastBrowserHiddenAt = null;
      listener("visibilitychange");
    }
  };

  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted || lastBrowserHiddenAt !== null) {
      lastBrowserHiddenAt = null;
      listener("pageshow");
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);
  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pageshow", handlePageShow);
  };
}

export function subscribeEnvironmentConnections(listener: () => void): () => void {
  return getEnvironmentSupervisor().subscribe(listener);
}

export function listEnvironmentConnections(): ReadonlyArray<EnvironmentConnection> {
  return getEnvironmentSupervisor().list();
}

export function readEnvironmentConnection(
  environmentId: EnvironmentId,
): EnvironmentConnection | null {
  return getEnvironmentSupervisor().read(environmentId);
}

export function requireEnvironmentConnection(environmentId: EnvironmentId): EnvironmentConnection {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new Error(`No websocket client registered for environment ${environmentId}.`);
  }
  return connection;
}

/** Persist a node-owned setting through that node's existing live connection. */
export async function updateEnvironmentServerSettings(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
): Promise<void> {
  const connection = requireEnvironmentConnection(environmentId);
  const settings = await connection.client.server.updateSettings(patch);
  if (getPrimaryKnownEnvironment()?.environmentId === environmentId) {
    applySettingsUpdated(settings);
    return;
  }
  const current = useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig;
  if (current) {
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      serverConfig: { ...current, settings },
    });
  }
}

export function getPrimaryEnvironmentConnection(): EnvironmentConnection {
  return createPrimaryEnvironmentConnection();
}

export async function disconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  getEnvironmentSupervisor().cancelPendingSavedEnvironmentConnection(environmentId);
  const connection = getEnvironmentSupervisor().read(environmentId);

  if (connection?.kind === "saved") {
    await removeConnection(environmentId).catch(() => false);
  }
  setRuntimeDisconnected(environmentId);

  if (record?.desktopSsh && typeof window !== "undefined") {
    await window.desktopBridge?.disconnectSshEnvironment(record.desktopSsh);
    await removeSavedEnvironmentBearerToken(environmentId);
  }
}

export async function reconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error("Saved environment not found.");
  }

  const connection = getEnvironmentSupervisor().read(environmentId);
  if (!connection) {
    setRuntimeConnecting(environmentId);
    try {
      await ensureSavedEnvironmentConnection(record);
      return;
    } catch (error) {
      if (isSavedEnvironmentConnectionCancelledError(error)) {
        return;
      }
      setRuntimeError(environmentId, error);
      throw error;
    }
  }

  setRuntimeConnecting(environmentId);
  try {
    if (record.desktopSsh) {
      await prepareSavedEnvironmentRecordForConnection(record);
    }
    await connection.reconnect();
  } catch (error) {
    if (record.desktopSsh) {
      try {
        const issued = await issueDesktopSshBearerSession(
          getSavedEnvironmentRecord(environmentId) ?? record,
        );
        await removeConnection(environmentId).catch(() => false);
        await ensureSavedEnvironmentConnection(issued.record, {
          bearerToken: issued.bearerToken,
          role: issued.role,
        });
        return;
      } catch (recoveryError) {
        if (isSavedEnvironmentConnectionCancelledError(recoveryError)) {
          return;
        }
        setRuntimeError(environmentId, recoveryError);
        throw recoveryError;
      }
    }
    setRuntimeError(environmentId, error);
    throw error;
  }
}

export async function removeSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  await disconnectSavedEnvironment(environmentId);
  disposeThreadDetailSubscriptionsForEnvironment(environmentId);
  useSavedEnvironmentRegistryStore.getState().remove(environmentId);
  useSavedEnvironmentRuntimeStore.getState().clear(environmentId);
  useStore.getState().removeEnvironmentState(environmentId);
  await removeSavedEnvironmentBearerToken(environmentId);
}

export async function addSavedEnvironment(input: {
  readonly label: string;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly desktopSsh?: DesktopSshEnvironmentTarget;
}): Promise<SavedEnvironmentRecord> {
  const resolvedTarget = resolveRemotePairingTarget({
    ...(input.pairingUrl !== undefined ? { pairingUrl: input.pairingUrl } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.pairingCode !== undefined ? { pairingCode: input.pairingCode } : {}),
  });
  const descriptor = input.desktopSsh
    ? await fetchDesktopSshEnvironmentDescriptor(resolvedTarget.httpBaseUrl)
    : await fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: resolvedTarget.httpBaseUrl,
      });
  const environmentId = descriptor.environmentId;
  const registrySnapshot = snapshotSavedEnvironmentRegistry([environmentId]);
  const existingRecord =
    getSavedEnvironmentRecord(environmentId) ??
    findSavedEnvironmentRecordByDesktopSshTarget(input.desktopSsh);
  const staleDesktopSshRecord =
    existingRecord && existingRecord.environmentId !== environmentId ? existingRecord : null;

  const bearerSession = input.desktopSsh
    ? await bootstrapDesktopSshBearerSession(resolvedTarget.httpBaseUrl, resolvedTarget.credential)
    : await bootstrapRemoteBearerSession({
        httpBaseUrl: resolvedTarget.httpBaseUrl,
        credential: resolvedTarget.credential,
      });

  const record: SavedEnvironmentRecord = {
    environmentId,
    label: input.label.trim() || existingRecord?.label || descriptor.label,
    wsBaseUrl: resolvedTarget.wsBaseUrl,
    httpBaseUrl: resolvedTarget.httpBaseUrl,
    createdAt: existingRecord?.createdAt ?? isoNow(),
    lastConnectedAt: isoNow(),
    ...((input.desktopSsh ?? existingRecord?.desktopSsh)
      ? { desktopSsh: input.desktopSsh ?? existingRecord?.desktopSsh }
      : {}),
  };

  await persistSavedEnvironmentRecord(record);
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Unable to persist saved environment credentials.");
  }
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  if (staleDesktopSshRecord) {
    await removeSavedEnvironment(staleDesktopSshRecord.environmentId);
  }
  await removeConnection(environmentId).catch(() => false);
  await ensureSavedEnvironmentConnection(record, {
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role,
  });
  return record;
}

export async function connectDesktopSshEnvironment(
  target: DesktopSshEnvironmentTarget,
  options?: { label?: string },
): Promise<SavedEnvironmentRecord> {
  const bootstrap = await resolveDesktopSshEnvironmentBootstrap(target, {
    issuePairingToken: true,
  });
  if (!bootstrap.pairingToken) {
    throw new Error("Desktop SSH launch did not return a pairing token.");
  }

  return await addSavedEnvironment({
    label: options?.label?.trim() || bootstrap.target.alias,
    host: bootstrap.httpBaseUrl,
    pairingCode: bootstrap.pairingToken,
    desktopSsh: bootstrap.target,
  }).catch((error) => {
    const detail = [
      `local ${bootstrap.httpBaseUrl}`,
      `remote port ${bootstrap.remotePort ?? "unknown"}`,
      bootstrap.remoteServerKind ? `remote server ${bootstrap.remoteServerKind}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (${detail})`);
  });
}

export async function ensureEnvironmentConnectionBootstrapped(
  environmentId: EnvironmentId,
): Promise<void> {
  await getEnvironmentSupervisor().read(environmentId)?.ensureBootstrapped();
}

export function startEnvironmentConnectionService(): () => void {
  return getEnvironmentSupervisor().start();
}

export async function resetEnvironmentServiceForTests(): Promise<void> {
  await getEnvironmentSupervisor().resetForTests();
  environmentSupervisor = null;
  lastBrowserHiddenAt = null;
  primaryShellSnapshotApplied = false;
  primaryShellSnapshotAppliedPromise = new Promise<void>((resolve) => {
    resolvePrimaryShellSnapshotApplied = resolve;
  });
}
