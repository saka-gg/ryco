import {
  type AuthSessionRole,
  type AuthSessionState,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  type SavedEnvironmentHubLink,
  type OrchestrationEvent,
  type OrchestrationThreadHistoryCollection,
  type OrchestrationThreadHistoryPageInfo,
  type MessageId,
  type OrchestrationStubbedShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellThreadPrioritiesItem,
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
  clearProjectIconCache,
  checkSavedEnvironmentSession,
  createEnvironmentConnectionSupervisor,
  createSavedSessionRenewal,
  createDeviceFrameSource,
  isSavedEnvironmentAwaitingRepair,
  isSavedEnvironmentCredentialRejection,
  type ReleaseThreadDetailSubscription,
  type ThreadDetailSubscriptionRetainOptions,
  awaitSavedEnvironmentConfig,
  SAVED_ENVIRONMENT_INITIAL_CONFIG_TIMEOUT_MS,
  SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE,
  SavedEnvironmentConnectionCancelledError,
  SavedEnvironmentCredentialError,
  savedEnvironmentRequiresAuthState,
  withSavedEnvironmentTimeout,
} from "@ryco/client-runtime/connection";
export {
  classifyProjectionSnapshot,
  shouldApplyProjectionEvent,
  shouldApplyProjectionSnapshot,
} from "@ryco/client-runtime/connection";

import { markPromotedDraftThreadByRef, useComposerDraftStore } from "~/composerDraftStore";
import { useMessageQueueStore } from "~/messageQueueStore";
import { ensureLocalApi } from "~/localApi";
import { deriveOrchestrationBatchEffects } from "~/orchestrationEventEffects";
import { createProjectSearchInvalidationQueue } from "~/rpc/projectSearchInvalidation";
import { invalidateAllCheckpointDiffs } from "~/rpc/providerAtoms";
import { getPrimaryKnownEnvironment } from "../primary";
import { issuePrimaryWebSocketToken } from "../primary/auth";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl,
  rotateRemoteBearerSession,
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
import { useStore, selectEnvironmentState } from "~/store";
import { createEnvironmentEventBatcher } from "@ryco/client-runtime/state/threads";
import {
  hasUnsentThreadWork,
  isThreadNonIdle,
  selectThreadBodyUsage,
} from "@ryco/client-runtime/state/threads/threadBodyResidency";
import { useTerminalStateStore } from "~/terminalStateStore";
import type { WsProtocolCloseContext } from "@ryco/client-runtime/rpc";
import {
  createDeviceRpcClient,
  createDirectDeviceRpcTransport,
  WS_URL_PROVIDER_TIMEOUT_MS,
} from "@ryco/client-runtime/rpc";
import {
  environmentQueryRefresh,
  isHostedEnvironmentQueryRefreshReady,
} from "../../rpc/environmentQueryRefresh";
import {
  applySettingsUpdated,
  clearEnvironmentServerConfigs,
  forgetEnvironmentServerConfig,
  getServerConfig,
  writeEnvironmentServerConfig,
} from "../../rpc/serverState";
import { DeviceWsTransport, HostedWsTransport, WsTransport } from "../../rpc/wsTransport";
import { createWsRpcClient, type WsRpcClient } from "../../rpc/wsRpcClient";
import { appendVersionMismatchHint, resolveServerConfigVersionMismatch } from "../../versionSkew";
import {
  createPrimaryShellFrameProbe,
  markStartupPhase,
  measureStartupPhase,
} from "~/perf/startupInstrumentation";
import { isHostedHubMode } from "~/env";
import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import { isHostedEnvironmentDemanded } from "~/hostedHub/hostedConnectionCoordinator";
import {
  getHostedEnvironmentSessions,
  hostedEnvironmentSessionsMode,
  hostedHubController,
  markHostedSessionReady,
  markHostedSessionReplaying,
  reportHostedShellSnapshotFailure,
  useHostedHubStore,
} from "~/hostedHub/state";
import {
  bindHostedDispatchReplay,
  getHostedRelayAttemptFactory,
  hostedDispatchLineage,
} from "~/hostedHub/transport";
import { createWebEnvironmentStateSink } from "./environmentStateSink";
import {
  createHostedEnvironmentConnection,
  hostedEnvironmentConnectionGeneration,
  type HostedConnectionFence,
} from "./hostedEnvironmentConnection";
import { webFrameScheduler, webSocket } from "../../platform";
import { DesktopWorkspaceIpcSocketFactory } from "../../platform/desktopWorkspaceSocket";

function isSavedEnvironmentConnectionCancelledError(
  error: unknown,
): error is SavedEnvironmentConnectionCancelledError {
  return error instanceof SavedEnvironmentConnectionCancelledError;
}

let needsProviderInvalidation = false;
// `@` search caches are invalidated per changed checkout, not globally.
const projectSearchInvalidations = createProjectSearchInvalidationQueue();
const environmentStateSink = createWebEnvironmentStateSink({
  markProviderInvalidationNeeded: () => {
    needsProviderInvalidation = true;
    getEnvironmentSupervisor().requestProviderInvalidation();
  },
  flushProviderInvalidation: () => {
    needsProviderInvalidation = false;
    invalidateAllCheckpointDiffs();
    projectSearchInvalidations.flush();
  },
  supervisor: getEnvironmentSupervisor,
});
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
      projectSearchInvalidations.reset();
    },
    // Retained hosted sessions open their connections only through the
    // lifecycle owner's connect port (`connectHostedEnvironment`).
    createPrimaryConnection: () =>
      getPrimaryKnownEnvironment()?.environmentId && !hostsRetainedEnvironmentSessions()
        ? createPrimaryEnvironmentConnection()
        : null,
    listSavedEnvironmentRecords,
    hasSavedEnvironmentRegistryHydrated,
    waitForSavedEnvironmentRegistryHydration,
    subscribeSavedEnvironmentRegistry: useSavedEnvironmentRegistryStore.subscribe,
    connectSavedEnvironment: (record, isCancelled, signal) =>
      connectSavedEnvironment(record, undefined, isCancelled, signal),
    isSavedEnvironmentAwaitingRepair: (environmentId) =>
      isSavedEnvironmentAwaitingRepair(
        useSavedEnvironmentRuntimeStore.getState().byId[environmentId],
      ),
    disconnectSavedEnvironment,
    waitForPrimaryShellSnapshotApplied,
    subscribeBrowserResume: subscribeBrowserResumeReconnects,
    isThreadDetailSubscriptionNonIdle: (environmentId, threadId) =>
      isThreadNonIdle(useStore.getState(), scopeThreadRef(environmentId, threadId)),
    listThreadBodies: () => selectThreadBodyUsage(useStore.getState()),
    evictThreadBodies: (threadRefs) => useStore.getState().evictThreadBodies(threadRefs),
    isThreadBodyProtected: (threadRef) =>
      hasUnsentThreadWork(threadRef, {
        queuesByThreadKey: useMessageQueueStore.getState().queuesByThreadKey,
        draftsByThreadKey: useComposerDraftStore.getState().draftsByThreadKey,
      }),
    syncThreadDetailSnapshot: (environmentId, snapshot) =>
      useStore
        .getState()
        .syncServerThreadDetail((snapshot as { readonly thread: never }).thread, environmentId),
    // The timeline fetches a previewed activity's full payload when its row expands.
    threadWindowActivityPayloads: "preview",
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
    scheduleShellFrame: scheduleStreamBatchFrame,
    onShellSnapshotReceived: (environmentId) => {
      if (environmentId === getPrimaryKnownEnvironment()?.environmentId) {
        markStartupPhase("primary-shell-snapshot-received");
        measureStartupPhase(
          "primary-shell-decode",
          "primary-shell-frame-received",
          "primary-shell-snapshot-received",
        );
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
  let reject: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  // Rejected before anyone waits (a credential rejected mid-connect): observed.
  promise.catch(NOOP);

  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value);
      resolve = null;
      reject = null;
    },
    reject: (error: unknown) => {
      reject?.(error);
      resolve = null;
      reject = null;
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

function disposeThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  getEnvironmentSupervisor().disposeThreadDetailSubscriptionsForEnvironment(environmentId);
}

export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  options?: ThreadDetailSubscriptionRetainOptions,
): ReleaseThreadDetailSubscription {
  return getEnvironmentSupervisor().retainThreadDetailSubscription(
    environmentId,
    threadId,
    options,
  );
}

/** Loads full shells for archived stubs; see the supervisor's `ensureArchivedThreadShells`. */
export function ensureArchivedThreadShells(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): void {
  if (threadIds.length === 0) return;
  getEnvironmentSupervisor().ensureArchivedThreadShells(environmentId, threadIds);
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

function setRuntimeRequiresAuth(environmentId: EnvironmentId) {
  useSavedEnvironmentRuntimeStore
    .getState()
    .patch(environmentId, savedEnvironmentRequiresAuthState(isoNow()));
}

function toSavedEnvironmentCredentialError(error: unknown): SavedEnvironmentCredentialError {
  return error instanceof SavedEnvironmentCredentialError
    ? error
    : new SavedEnvironmentCredentialError(SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE, {
        cause: error,
      });
}

/**
 * The node rejected a registered connection's bearer. Its transport has stopped,
 * so it leaves the supervisor too: Connect then starts over with a session check
 * and answers "pair it again" instead of reusing a dead socket.
 */
function markSavedEnvironmentCredentialRejected(
  environmentId: EnvironmentId,
  connection: EnvironmentConnection,
) {
  setRuntimeRequiresAuth(environmentId);
  // Deferred out of the transport callback that reported the rejection.
  globalThis.setTimeout(() => {
    if (getEnvironmentSupervisor().read(environmentId) !== connection) return;
    void removeConnection(environmentId).catch(() => false);
  }, 0);
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
  const needsProjectUiSync = events.some(
    (event) =>
      event.type === "project.created" ||
      event.type === "project.meta-updated" ||
      event.type === "project.deleted",
  );

  if (batchEffects.needsProviderInvalidation) {
    projectSearchInvalidations.noteEvents(environmentId, events);
    environmentStateSink.markProviderInvalidationNeeded();
  }

  // The raw events go to the store: the reducer folds a batch's consecutive
  // message deltas into one owned copy per thread, so pre-merging them here
  // saves nothing, and merging a delta with the empty-text completion that
  // follows it would turn the delta into a replacement of the whole text.
  environmentStateSink.applyOrchestrationEvents(environmentId, events);
  if (needsProjectUiSync) {
    environmentStateSink.syncProjects(environmentId);
  }

  const needsThreadUiSync = events.some(
    (event) =>
      event.type === "thread.created" ||
      event.type === "thread.deleted" ||
      event.type === "thread.trashed" ||
      event.type === "thread.untrashed",
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

/**
 * Schedules a stream batch's commit (thread-detail events, shell items). A
 * hidden document paints nothing and throttles frames and timers, so it only
 * coalesces the current task's burst instead of waiting for a frame.
 */
function scheduleStreamBatchFrame(callback: () => void): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    queueMicrotask(callback);
    return;
  }
  webFrameScheduler.scheduleFrame(callback);
}

// Thread-detail events arrive one WebSocket message each (a streaming delta
// every ~32 ms per active thread, bursts on replay). Batch them per animation
// frame so N messages become one store commit and one round of derived UI
// sync. The batcher is a store mutation barrier: any other store write applies
// the buffered events first, so ordering against snapshots, shell events and
// removals is unchanged.
const threadDetailEventBatcher = createEnvironmentEventBatcher<OrchestrationEvent>({
  apply: (environmentId, events) => applyRecoveredEventBatch(events, environmentId),
  scheduleFrame: scheduleStreamBatchFrame,
});

export function applyEnvironmentThreadDetailEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
) {
  threadDetailEventBatcher.enqueue(environmentId, event);
}

/** Applies buffered thread-detail events now (tests, teardown). */
export function flushEnvironmentThreadDetailEvents(): void {
  threadDetailEventBatcher.flush();
}

/** Whether hosted Web keeps one session, and one connection, per environment. */
function hostsRetainedEnvironmentSessions(): boolean {
  return isHostedHubMode() && hostedEnvironmentSessionsMode() === "retained";
}

/**
 * A single-session hosted connection's fence: the shared lifecycle generation,
 * which the owner advances on every switch, suspension and teardown, and the
 * selected session's readiness.
 */
function sharedGenerationFence(generation: number): HostedConnectionFence {
  return {
    accepts: () => useHostedHubStore.getState().generation === generation,
    markReady: (environmentId) => markHostedSessionReady(environmentId, generation),
    markReplaying: (environmentId) => markHostedSessionReplaying(environmentId, generation),
    reportShellError: (environmentId) =>
      reportHostedShellSnapshotFailure(environmentId, generation),
    isQueryRefreshReady: (environmentId) =>
      isHostedEnvironmentQueryRefreshReady(useHostedHubStore.getState(), environmentId, generation),
  };
}

/**
 * A connection's stream handlers. `fence` is the hosted lifecycle owner's for
 * the connection — the shared generation in single-session mode, the
 * environment's record generation with retained sessions — and `null` for a
 * direct connection, which nothing fences.
 */
function createEnvironmentConnectionHandlers(
  fence: HostedConnectionFence | null = null,
  initialRefreshEnvironmentId?: EnvironmentId,
  options: {
    /**
     * Resume the shell after a reconnect instead of taking a fresh snapshot.
     * Direct connections only: a hosted session must accept a current snapshot
     * before it regains mutation authority.
     */
    readonly resumeShell?: boolean;
  } = {},
) {
  const acceptsEvent = () => fence === null || fence.accepts();
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
    const isAuthoritativelyReady = () => fence === null || fence.isQueryRefreshReady(environmentId);
    void environmentQueryRefresh
      .ready(environmentId, refreshGeneration, isAuthoritativelyReady)
      .catch(() => undefined);
  };
  const resumeShell = options.resumeShell === true && fence === null;
  return {
    ...(resumeShell
      ? {
          readShellResumeSequence: (environmentId: EnvironmentId) =>
            getEnvironmentSupervisor().readShellProjectionSequence(environmentId),
          onShellResumed: (environmentId: EnvironmentId) => {
            completeQueryRefresh(environmentId);
          },
        }
      : {}),
    onResubscribe: (environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      beginQueryRefresh(environmentId);
      fence?.markReplaying(environmentId);
    },
    onShellError: (environmentId: EnvironmentId) => {
      if (fence !== null && fence.accepts()) fence.reportShellError(environmentId);
    },
    resetShellProjection: (environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      getEnvironmentSupervisor().resetShellProjection(environmentId);
    },
    applyShellEvent: (event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      getEnvironmentSupervisor().applyShellEvent(event, environmentId);
    },
    applyThreadPriorities: (
      item: OrchestrationShellThreadPrioritiesItem,
      environmentId: EnvironmentId,
    ) => {
      if (!acceptsEvent()) return;
      getEnvironmentSupervisor().applyThreadPriorities(item, environmentId);
    },
    syncShellSnapshot: (
      snapshot: OrchestrationStubbedShellSnapshot,
      environmentId: EnvironmentId,
    ) => {
      if (!acceptsEvent()) return;
      getEnvironmentSupervisor().syncShellSnapshot(snapshot, environmentId, {
        onCurrent: () => {
          fence?.markReady(environmentId);
          completeQueryRefresh(environmentId);
        },
        onReady: () => {
          fence?.markReady(environmentId);
          completeQueryRefresh(environmentId);
        },
      });
    },
    applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => {
      if (!acceptsEvent()) return;
      const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
      // The shell entry, stub or full: an archived stub is still a known, archived thread.
      const serverThread = selectEnvironmentState(useStore.getState(), environmentId)
        .threadShellById[threadRef.threadId];
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
    const environmentId = knownEnvironment?.environmentId ?? null;
    const dispatchReplay = bindHostedDispatchReplay({
      environmentId,
      lineage: hostedDispatchLineage(useHostedHubStore.getState()),
      markUncertain: () => {
        if (environmentId) hostedHubController.markEnvironmentDeliveryUnknown(environmentId);
      },
    });
    const hostedHandlers = attemptFactory.lifecycleHandlers(dispatchReplay);
    const transport = new HostedWsTransport(() => attemptFactory.nextUrl(), {
      ...hostedHandlers,
      getConnectionLabel: () => connectionLabel,
      getEnvironmentId: () => knownEnvironment?.environmentId ?? null,
      onOpen: () => {
        hostedHandlers.onOpen?.();
        markStartupPhase("primary-ws-open");
      },
    });
    return dispatchReplay.wrap(
      createWsRpcClient(transport, createDeviceRpcClient(transport, { manageTransport: false })),
    );
  }

  const authenticatedSocketUrl = async (
    pathname: "/ws" | "/ws/device" | "/ws/device-frames",
    signal?: AbortSignal,
  ) => {
    const issued = await issuePrimaryWebSocketToken(signal);
    const url = new URL(wsBaseUrl, window.location.origin);
    url.pathname = pathname;
    url.searchParams.set("wsToken", issued.token);
    return url.toString();
  };
  const shellFrameProbe = createPrimaryShellFrameProbe(
    (url, protocols) => webSocket.webSocketConstructor(url, protocols) as WebSocket,
  );
  const transport = new WsTransport((signal) => authenticatedSocketUrl("/ws", signal), {
    getConnectionLabel: () => connectionLabel,
    getEnvironmentId: () => knownEnvironment?.environmentId ?? null,
    getVersionMismatchHint: () =>
      resolveServerConfigVersionMismatch(getServerConfig())?.hint ?? null,
    onOpen: () => {
      markStartupPhase("primary-ws-open");
    },
    urlProviderTimeoutMs: WS_URL_PROVIDER_TIMEOUT_MS,
    onRequestStart: shellFrameProbe.onRequestStart,
    webSocketConstructor: shellFrameProbe.webSocketConstructor,
  });
  return createWsRpcClient(
    transport,
    createDeviceRpcClient(
      createDirectDeviceRpcTransport({
        main: transport,
        openDedicated: () =>
          new DeviceWsTransport((signal) => authenticatedSocketUrl("/ws/device", signal), {
            getConnectionLabel: () => connectionLabel,
            urlProviderTimeoutMs: WS_URL_PROVIDER_TIMEOUT_MS,
          }),
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
  signal?: AbortSignal,
): Promise<string> {
  const saved = getSavedEnvironmentRecord(environmentId);
  if (!saved) throw new Error(`Saved environment ${environmentId} not found.`);
  // An SSH tunnel does not survive sleep or a dropped network, and nothing
  // restarts it on its own. Ensuring it here — a quick readiness check when it
  // is healthy — lets every reconnect attempt rebuild a dead tunnel, relaunch
  // the remote server if needed, and follow a new local port.
  const record = saved.desktopSsh
    ? (await prepareSavedEnvironmentRecordForConnection(saved)).record
    : saved;
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
        ...(signal === undefined ? {} : { signal }),
      });
  const url = new URL(rawUrl, window.location.origin);
  url.pathname = pathname;
  return url.toString();
}

/**
 * Direct pairings renew their bearer while in use. The renewed bearer replaces
 * the stored one, so every use reads the bearer stored now and nothing else: a
 * bearer remembered from an earlier read may have been superseded, and the node
 * revokes the whole pairing when it sees one after its grace.
 */
const savedSessionRenewal = createSavedSessionRenewal({
  readBearerToken: (environmentId) => readSavedEnvironmentBearerToken(environmentId),
  writeBearerToken: (environmentId, token) =>
    writeSavedEnvironmentBearerToken(environmentId, token),
});

/**
 * Keeps a registered direct connection's pairing renewed while it stays
 * connected. Returns the stop the connection calls once it is disposed.
 */
function keepSavedEnvironmentSessionRenewed(
  record: SavedEnvironmentRecord,
  connection: EnvironmentConnection,
  session: AuthSessionState,
): () => void {
  if (record.desktopSsh) return NOOP;
  return savedSessionRenewal.keepRenewed({
    environmentId: record.environmentId,
    session,
    isCurrent: () => getEnvironmentSupervisor().read(record.environmentId) === connection,
    fetchSessionState: (bearerToken) =>
      fetchRemoteSessionState({ httpBaseUrl: record.httpBaseUrl, bearerToken }),
    rotate: (bearerToken) =>
      rotateRemoteBearerSession({ httpBaseUrl: record.httpBaseUrl, bearerToken }),
  });
}

function createSavedEnvironmentClient(
  environmentId: EnvironmentId,
  owner: {
    /**
     * Whether this client's attempt, or the connection it registered, still
     * owns the environment's state. A socket an attempt left behind once
     * cancelled or replaced keeps reporting until it stops, and must not
     * overwrite the state of the connection that replaced it.
     */
    readonly speaksForEnvironment: () => boolean;
    readonly onCredentialRejected: () => void;
  },
): WsRpcClient {
  useSavedEnvironmentRuntimeStore.getState().ensure(environmentId);
  const socketUrl = async (
    pathname: "/ws" | "/ws/device" | "/ws/device-frames",
    signal?: AbortSignal,
  ) =>
    resolveSavedEnvironmentSocketUrl(
      environmentId,
      await savedSessionRenewal.readBearerToken(environmentId),
      pathname,
      signal,
    );
  // A direct pairing's URL is one token request, bounded so a hung one cannot
  // stall reconnecting. An SSH environment's may rebuild its tunnel and
  // relaunch the remote server, which takes as long as it takes.
  const urlProviderDeadline = getSavedEnvironmentRecord(environmentId)?.desktopSsh
    ? {}
    : { urlProviderTimeoutMs: WS_URL_PROVIDER_TIMEOUT_MS };

  const transport = new WsTransport((signal) => socketUrl("/ws", signal), {
    ...urlProviderDeadline,
    getConnectionLabel: () => getSavedEnvironmentRecord(environmentId)?.label ?? null,
    getEnvironmentId: () => environmentId,
    // A remote machine can be asleep or offline for hours; keep trying on a
    // capped backoff, and keep its status out of the primary's.
    persistentReconnect: true,
    // An expired or revoked bearer is not one of those outages: no retry can
    // bring it back, so the socket stops and its pending requests fail.
    isTerminalUrlError: isSavedEnvironmentCredentialRejection,
    onTerminalUrlError: owner.onCredentialRejected,
    recordGlobalConnectionState: false,
    getVersionMismatchHint: () =>
      resolveServerConfigVersionMismatch(
        useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
      )?.hint ?? null,
    onAttempt: () => {
      if (owner.speaksForEnvironment()) setRuntimeConnecting(environmentId);
    },
    onOpen: () => {
      if (owner.speaksForEnvironment()) setRuntimeConnected(environmentId);
    },
    onError: (message: string) => {
      if (!owner.speaksForEnvironment()) return;
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
      if (context.intentional || !owner.speaksForEnvironment()) {
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
  });
  return createWsRpcClient(
    transport,
    createDeviceRpcClient(
      createDirectDeviceRpcTransport({
        main: transport,
        openDedicated: () =>
          new DeviceWsTransport((signal) => socketUrl("/ws/device", signal), {
            ...urlProviderDeadline,
            getConnectionLabel: () => getSavedEnvironmentRecord(environmentId)?.label ?? null,
            isTerminalUrlError: isSavedEnvironmentCredentialRejection,
          }),
      }),
      {
        openFrameSource: (udid, handlers) =>
          createDeviceFrameSource({
            udid,
            handlers,
            socket: webSocket,
            resolveUrl: () => socketUrl("/ws/device-frames"),
          }),
      },
    ),
  );
}

/**
 * The node's answer for a saved bearer: its session, or `null` once the node no
 * longer accepts it. The node answers an expired or revoked bearer with
 * `authenticated: false`, so this is asked before anything waits on a socket,
 * whose ws-token request for that bearer would fail on every reconnect.
 */
async function readSavedEnvironmentSession(
  record: SavedEnvironmentRecord,
  bearerToken: string,
  signal?: AbortSignal,
): Promise<AuthSessionState | null> {
  try {
    const check = await checkSavedEnvironmentSession({
      fetchSessionState: () =>
        record.desktopSsh
          ? fetchDesktopSshSessionState(record.httpBaseUrl, bearerToken)
          : fetchRemoteSessionState({
              httpBaseUrl: record.httpBaseUrl,
              bearerToken,
              ...(signal === undefined ? {} : { signal }),
            }),
    });
    return check.status === "authenticated" ? check.session : null;
  } catch (error) {
    const rejected = record.desktopSsh
      ? isSshHttpAuthError(error, 401)
      : isRemoteEnvironmentAuthHttpError(error) && error.status === 401;
    if (rejected) return null;
    throw error;
  }
}

async function refreshSavedEnvironmentMetadata(
  environmentId: EnvironmentId,
  bearerToken: string,
  client: WsRpcClient,
  options: {
    readonly roleHint?: AuthSessionRole | null;
    /** A config already in hand; nothing is read. */
    readonly config?: ServerConfig | null;
    /**
     * The config subscription's snapshot. It is used when it arrives in time;
     * otherwise the config is read once. Rejects on credential rejection.
     */
    readonly configSnapshot?: Promise<ServerConfig>;
    readonly session?: AuthSessionState;
  } = {},
): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error(`Saved environment ${environmentId} not found.`);
  }

  // The config wait runs alongside the session check; a rejected session still
  // decides the outcome first.
  const readConfig = () => client.server.getConfig();
  const configPromise: Promise<ServerConfig> = options.config
    ? Promise.resolve(options.config)
    : options.configSnapshot
      ? awaitSavedEnvironmentConfig({ snapshot: options.configSnapshot, readConfig })
      : withSavedEnvironmentTimeout(
          readConfig(),
          SAVED_ENVIRONMENT_INITIAL_CONFIG_TIMEOUT_MS,
          "The environment answered but did not finish connecting in time.",
        );
  configPromise.catch(NOOP);
  const session = options.session ?? (await readSavedEnvironmentSession(record, bearerToken));
  if (session === null) {
    throw new SavedEnvironmentCredentialError(SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE);
  }
  const serverConfig = await configPromise;
  const roleHint = options.roleHint;

  useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
    authState: "authenticated",
    descriptor: serverConfig.environment,
    serverConfig,
    role: session.role ?? roleHint ?? null,
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
  const environmentId = knownEnvironment.environmentId;

  const existing = getEnvironmentSupervisor().read(environmentId);
  if (existing) {
    return existing;
  }
  if (hostsRetainedEnvironmentSessions()) {
    throw new Error("No hosted connection is registered for the active environment.");
  }

  const hostedGeneration = isHostedHubMode() ? useHostedHubStore.getState().generation : null;
  return registerConnection(
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment,
      client: createPrimaryEnvironmentClient(knownEnvironment),
      // The hosted lifecycle owner's generation: once it moves on, this
      // connection's config is neither published nor read.
      ...(hostedGeneration === null
        ? {}
        : {
            lifecycleGeneration: {
              generation: hostedGeneration,
              readCurrent: () => useHostedHubStore.getState().generation,
            },
          }),
      // The config stream starts with the connection and feeds the
      // per-environment config store, ahead of any shell that shows it.
      onConfigUpdated: (config, type) => writeEnvironmentServerConfig(environmentId, config, type),
      ...createEnvironmentConnectionHandlers(
        hostedGeneration === null ? null : sharedGenerationFence(hostedGeneration),
        hostedGeneration !== null ? environmentId : undefined,
        { resumeShell: hostedGeneration === null },
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

// Retained hosted sessions: the lifecycle owner's ports for one environment's
// connection. Each names the record generation it acts for, so a late release
// or suspension of an old generation never tears down a newer connection.

/**
 * Open the environment's connection for this record generation. An existing
 * connection of an older generation is removed first; one of this generation
 * or a newer one makes this a no-op, as does a generation the record has
 * already moved past.
 */
export async function connectHostedEnvironment(
  node: HostedHubNode,
  generation: number,
): Promise<void> {
  const environmentId = node.environmentId;
  const sessions = getHostedEnvironmentSessions();
  if (!sessions.isCurrentGeneration(environmentId, generation)) return;
  const existing = getEnvironmentSupervisor().read(environmentId);
  if (existing) {
    const existingGeneration = hostedEnvironmentConnectionGeneration(existing);
    if (existingGeneration !== null && existingGeneration >= generation) return;
    await removeConnection(environmentId).catch(() => false);
    if (
      !sessions.isCurrentGeneration(environmentId, generation) ||
      getEnvironmentSupervisor().read(environmentId)
    ) {
      return;
    }
  }
  registerConnection(
    createHostedEnvironmentConnection({
      node,
      generation,
      sessions,
      handlersFor: (fence) => createEnvironmentConnectionHandlers(fence, environmentId),
      isDemanded: () => isHostedEnvironmentDemanded(environmentId),
    }),
  );
}

/**
 * Local teardown of the environment's connection when its generation is at
 * most `generation`. Never waits for the remote end to acknowledge a close.
 */
async function removeHostedConnectionUpTo(
  environmentId: EnvironmentId,
  generation: number,
): Promise<void> {
  const existing = getEnvironmentSupervisor().read(environmentId);
  if (!existing) return;
  const existingGeneration = hostedEnvironmentConnectionGeneration(existing);
  if (existingGeneration !== null && existingGeneration > generation) return;
  await removeConnection(environmentId).catch(() => false);
}

/** Remove the environment's connection of this generation or older. */
export function removeHostedEnvironment(
  environmentId: EnvironmentId,
  generation: number,
): Promise<void> {
  return removeHostedConnectionUpTo(environmentId, generation);
}

/**
 * Dispose the transport of the environment's connection of this generation or
 * older. What it displays stays in the store; the lifecycle owner decides when
 * node-scoped state goes.
 */
export function suspendHostedEnvironment(
  environmentId: EnvironmentId,
  generation: number,
): Promise<void> {
  return removeHostedConnectionUpTo(environmentId, generation);
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
    await existing.ensureBootstrapped();
    return existing;
  }
  const socketFactory = new DesktopWorkspaceIpcSocketFactory(input.environmentId, bridge);
  const transport = new HostedWsTransport(() => socketFactory.nextUrl(), {
    preserveSocketPath: true,
    webSocketConstructor: (url) => socketFactory.createSocket(url) as unknown as WebSocket,
    retryTransientErrors: false,
    ...socketFactory.lifecycleHandlers,
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
      onConfigUpdated: (config, type) => {
        writeEnvironmentServerConfig(input.environmentId, config, type);
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
    if (getEnvironmentSupervisor().read(input.environmentId) === connection) {
      await removeConnection(input.environmentId).catch(() => undefined);
    }
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
  return await getEnvironmentSupervisor().ensureSavedEnvironmentConnection(
    record,
    (isCancelled, signal) => connectSavedEnvironment(record, options, isCancelled, signal),
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
  /** Aborted when the supervisor gives the attempt up; abandons its requests. */
  signal?: AbortSignal,
): Promise<EnvironmentConnection> {
  let activeRecord = record;
  let roleHint = options?.role ?? null;
  let bearerToken =
    options?.bearerToken ?? (await readSavedEnvironmentBearerToken(record.environmentId));
  let clientOverride = options?.client;
  let reissuedDesktopSshBearer = false;
  // Before it registers a connection, the attempt reports the environment's
  // state only while it is still the environment's attempt.
  const attemptSpeaksForEnvironment = () =>
    !isCancelled() && getEnvironmentSupervisor().read(record.environmentId) === null;
  // SSH mints a fresh bearer through its own tunnel, once per connect: a node
  // that rejects the fresh one too fails instead of looping.
  const reissueDesktopSshBearerOnce = async (cause: unknown) => {
    if (reissuedDesktopSshBearer) {
      throw new Error("The SSH environment rejected its freshly issued credential.", { cause });
    }
    reissuedDesktopSshBearer = true;
    const issued = await issueDesktopSshBearerSession(activeRecord);
    activeRecord = issued.record;
    bearerToken = issued.bearerToken;
    roleHint = issued.role;
    clientOverride = undefined;
  };

  for (;;) {
    if (!bearerToken) {
      if (record.desktopSsh) {
        const issued = await issueDesktopSshBearerSession(activeRecord);
        activeRecord = issued.record;
        bearerToken = issued.bearerToken;
        roleHint = issued.role;
      } else {
        await removeSavedEnvironmentBearerToken(record.environmentId).catch(() => undefined);
        if (attemptSpeaksForEnvironment()) {
          useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
            authState: "requires-auth",
            role: null,
            connectionState: "disconnected",
            lastError: "Saved environment is missing its saved credential. Pair it again.",
            lastErrorAt: isoNow(),
          });
        }
        throw new SavedEnvironmentCredentialError(
          "Saved environment is missing its saved credential.",
        );
      }
    }
    const prepared = await prepareSavedEnvironmentRecordForConnection(activeRecord);
    activeRecord = prepared.record;

    const presentedBearerToken = bearerToken;
    // The bearer is checked before any socket exists, so a credential the node
    // no longer accepts never requests a ws-token or opens a socket.
    let session: AuthSessionState | null;
    try {
      session = await readSavedEnvironmentSession(activeRecord, presentedBearerToken, signal);
    } catch (error) {
      if (attemptSpeaksForEnvironment()) setRuntimeError(activeRecord.environmentId, error);
      throw error;
    }
    if (session === null) {
      const rejected = new SavedEnvironmentCredentialError(SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE);
      if (activeRecord.desktopSsh) {
        await reissueDesktopSshBearerOnce(rejected);
        continue;
      }
      // The bearer stays stored: the record keeps its place, and pairing again
      // replaces the credential.
      if (attemptSpeaksForEnvironment()) setRuntimeRequiresAuth(activeRecord.environmentId);
      throw rejected;
    }
    if (isCancelled()) {
      throw new SavedEnvironmentConnectionCancelledError(activeRecord.environmentId);
    }
    // A pairing in use renews its bearer before a socket is built on it. SSH
    // environments mint a fresh bearer through their tunnel instead.
    const renewalRecord = activeRecord;
    const renewal = renewalRecord.desktopSsh
      ? { bearerToken: presentedBearerToken, session }
      : await savedSessionRenewal.renew({
          environmentId: renewalRecord.environmentId,
          session,
          bearerToken: presentedBearerToken,
          fetchSessionState: (token) =>
            fetchRemoteSessionState({
              httpBaseUrl: renewalRecord.httpBaseUrl,
              bearerToken: token,
              ...(signal === undefined ? {} : { signal }),
            }),
          rotate: (token) =>
            rotateRemoteBearerSession({
              httpBaseUrl: renewalRecord.httpBaseUrl,
              bearerToken: token,
              ...(signal === undefined ? {} : { signal }),
            }),
        });
    const activeBearerToken = renewal.bearerToken;

    let credentialRejected = false;
    let registered = false;
    // The config subscription's first item is a full snapshot; the connect
    // and each reconnect use it and read the config themselves only when it is
    // slow to arrive.
    const initialConfigSnapshot = createDeferredPromise<ServerConfig>();
    // The socket stopped for good: nothing will deliver a config any more.
    const credentialRejection = createDeferredPromise<never>();
    const configSnapshotUnlessRejected = (snapshot: Promise<ServerConfig>) =>
      Promise.race([snapshot, credentialRejection.promise]);
    // Only the environment's live attempt, or the connection it registered,
    // reports the environment's state. An attempt a disconnect or a new pairing
    // cancelled, and a connection something else has since replaced, say
    // nothing about the credential the environment holds now.
    const speaksForEnvironment = () => {
      if (isCancelled()) return false;
      const current = getEnvironmentSupervisor().read(activeRecord.environmentId);
      return registered ? current === connection : current === null;
    };
    const client =
      clientOverride ??
      createSavedEnvironmentClient(activeRecord.environmentId, {
        speaksForEnvironment,
        onCredentialRejected: () => {
          credentialRejected = true;
          credentialRejection.reject(
            new SavedEnvironmentCredentialError(SAVED_ENVIRONMENT_REQUIRES_AUTH_MESSAGE),
          );
          if (!activeRecord.desktopSsh && speaksForEnvironment()) {
            markSavedEnvironmentCredentialRejected(activeRecord.environmentId, connection);
          }
        },
      });
    // The pairing's renewal, kept while this connection is registered, stops
    // with it.
    let stopRenewal: () => void = NOOP;
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
      refreshMetadata: async ({ configSnapshot }) => {
        try {
          // The replacement config subscription sends a full snapshot; it
          // stands in for a separate config read unless it is slow.
          await refreshSavedEnvironmentMetadata(
            activeRecord.environmentId,
            await savedSessionRenewal.readBearerToken(activeRecord.environmentId),
            client,
            { configSnapshot: configSnapshotUnlessRejected(configSnapshot) },
          );
        } catch (error) {
          if (
            activeRecord.desktopSsh ||
            !(error instanceof SavedEnvironmentCredentialError || credentialRejected)
          ) {
            throw error;
          }
          if (speaksForEnvironment()) {
            markSavedEnvironmentCredentialRejected(activeRecord.environmentId, connection);
          }
          throw toSavedEnvironmentCredentialError(error);
        }
      },
      onConfigUpdated: (config, type) => {
        writeEnvironmentServerConfig(activeRecord.environmentId, config, type);
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
      ...createEnvironmentConnectionHandlers(null, undefined, { resumeShell: true }),
      onDispose: () => stopRenewal(),
    });

    // Removal goes by identity: the environment may already hold another
    // attempt's healthy connection, which this attempt must not take down.
    let discarded = false;
    const discardConnection = async () => {
      if (discarded) return;
      discarded = true;
      stopRenewal();
      stopRenewal = NOOP;
      if (
        registered &&
        getEnvironmentSupervisor().read(activeRecord.environmentId) === connection
      ) {
        await removeConnection(activeRecord.environmentId).catch(() => false);
      } else {
        await connection.dispose().catch(() => undefined);
      }
      registered = false;
    };
    try {
      if (isCancelled()) {
        await connection.dispose().catch(() => undefined);
        throw new SavedEnvironmentConnectionCancelledError(activeRecord.environmentId);
      }
      // The bearer passed its session check (and any renewal), so the
      // connection registers now, while its ws-token, upgrade and config are
      // still in flight: thread subscriptions waiting for this environment
      // attach at once and go out as soon as the socket opens. A rejection
      // that arrives later removes it again, by identity.
      registerConnection(connection);
      registered = true;
      stopRenewal = keepSavedEnvironmentSessionRenewed(activeRecord, connection, renewal.session);
      try {
        await refreshSavedEnvironmentMetadata(
          activeRecord.environmentId,
          activeBearerToken,
          client,
          {
            roleHint,
            session,
            ...(options?.serverConfig
              ? { config: options.serverConfig }
              : { configSnapshot: configSnapshotUnlessRejected(initialConfigSnapshot.promise) }),
          },
        );
      } catch (error) {
        const isAuthError =
          error instanceof SavedEnvironmentCredentialError ||
          credentialRejected ||
          (activeRecord.desktopSsh
            ? isSshHttpAuthError(error, 401)
            : isRemoteEnvironmentAuthHttpError(error) && error.status === 401);
        if (!isAuthError) {
          throw error;
        }
        if (!activeRecord.desktopSsh) {
          // The socket's ws-token request was rejected after the session check
          // passed: the session expired or was revoked in between.
          if (speaksForEnvironment()) setRuntimeRequiresAuth(activeRecord.environmentId);
          throw toSavedEnvironmentCredentialError(error);
        }
        await discardConnection();
        await reissueDesktopSshBearerOnce(error);
        continue;
      }
      if (isCancelled()) {
        await discardConnection();
        throw new SavedEnvironmentConnectionCancelledError(activeRecord.environmentId);
      }
      return connection;
    } catch (error) {
      if (error instanceof SavedEnvironmentConnectionCancelledError) {
        throw error;
      }
      if (speaksForEnvironment() && !(error instanceof SavedEnvironmentCredentialError)) {
        setRuntimeError(activeRecord.environmentId, error);
      }
      await discardConnection();
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

  // A network change — Wi-Fi to Ethernet, joining a VPN, waking on a new
  // network — leaves sockets that look open but are dead.
  const handleOnline = () => {
    listener("online");
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("online", handleOnline);
  // Desktop windows usually stay visible through a sleep, so they hear about
  // the wake from the main process instead.
  const unsubscribeSystemResume = window.desktopBridge?.onSystemResume?.(() => {
    listener("system-resume");
  });
  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pageshow", handlePageShow);
    window.removeEventListener("online", handleOnline);
    unsubscribeSystemResume?.();
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
      if (!(error instanceof SavedEnvironmentCredentialError)) {
        setRuntimeError(environmentId, error);
      }
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
    if (!(error instanceof SavedEnvironmentCredentialError)) {
      setRuntimeError(environmentId, error);
    }
    throw error;
  }
}

export async function removeSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  await disconnectSavedEnvironment(environmentId);
  disposeThreadDetailSubscriptionsForEnvironment(environmentId);
  useSavedEnvironmentRegistryStore.getState().remove(environmentId);
  useSavedEnvironmentRuntimeStore.getState().clear(environmentId);
  forgetEnvironmentServerConfig(environmentId);
  useStore.getState().removeEnvironmentState(environmentId);
  // Project artwork is cached per node, past its connections: forget it too.
  clearProjectIconCache(environmentId);
  await removeSavedEnvironmentBearerToken(environmentId);
}

export async function addSavedEnvironment(input: {
  readonly label: string;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly desktopSsh?: DesktopSshEnvironmentTarget;
  /**
   * Set when the code came from `auth.issueLinkedDirectAccess` over the Hub
   * relay. A pairing without it is the user's own and is never relinked.
   */
  readonly hubLink?: SavedEnvironmentHubLink;
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
    ...(input.hubLink ? { hubLink: input.hubLink } : {}),
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
  // A connect still running started on the credential this pairing replaced;
  // joining it would answer for the old one.
  getEnvironmentSupervisor().cancelPendingSavedEnvironmentConnection(environmentId);
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
  clearEnvironmentServerConfigs();
  lastBrowserHiddenAt = null;
  primaryShellSnapshotApplied = false;
  primaryShellSnapshotAppliedPromise = new Promise<void>((resolve) => {
    resolvePrimaryShellSnapshotApplied = resolve;
  });
}
