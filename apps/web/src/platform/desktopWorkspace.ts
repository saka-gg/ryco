import {
  EnvironmentId,
  ThreadId,
  type DesktopWorkspaceScopeProjection,
  type DesktopWorkspaceConnectionCommand,
  type DesktopWorkspaceStateProjection,
  type DesktopWorkspaceStatePush,
} from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
  createThreadContentCapture,
  decodeCachedEnvironmentContent,
  measureRecordBodyBytes,
  selectThreadsForContentCache,
  trimContentToBudget,
  type CachedEnvironmentShellSnapshot,
  type CachedThreadContent,
  type CapturedThreadContent,
} from "@ryco/client-runtime/state/threads";
import {
  boundWorkspaceMetadataSnapshot,
  isWorkspaceMetadataSnapshot,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { useSyncExternalStore } from "react";

import {
  connectPrimaryEnvironment,
  connectDesktopWorkspaceEnvironment,
  disconnectPrimaryEnvironment,
  disconnectSavedEnvironment,
  readEnvironmentConnection,
} from "../environments/runtime";
import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  readWorkspaceMetadataSnapshot,
  remapWorkspaceMetadataSnapshotEnvironment,
  workspaceMetadataToCachedShellSnapshot,
} from "../workspaceMetadataProjection";
import { reconcileDesktopWorkspaceCacheHydration } from "./desktopWorkspaceCacheHydration";
import { renewDesktopMachineDirectAccess } from "./desktopHubLinkedDirectAccess";

const SIGNED_OUT: DesktopWorkspaceStateProjection = {
  status: "signed-out",
  accountId: null,
  localEnvironmentId: null,
  machines: [],
  snapshots: [],
  queuedEnvironmentIds: [],
  activeConnectionCount: 0,
};

let current = SIGNED_OUT;
const listeners = new Set<() => void>();
let hydratedEnvironmentIds = new Set<EnvironmentId>();

/**
 * Whether this device keeps recent conversations (Desktop main holds them,
 * encrypted). Null until main has answered, and for good when it cannot.
 */
let threadContentCacheEnabled: boolean | null = null;
const threadContentCacheListeners = new Set<() => void>();
/** Cached thread content main returned, by environment, until the environment is live. */
const cachedThreadContent = new Map<EnvironmentId, Record<string, CachedThreadContent>>();
/** Environments whose cached content was asked for since the last reset; each is asked once. */
const requestedThreadContent = new Set<EnvironmentId>();
/** Bumped on every reset, so an answer to a request from before it is dropped. */
let threadContentGeneration = 0;

export function readDesktopWorkspaceState(): DesktopWorkspaceStateProjection {
  return current;
}

export function subscribeDesktopWorkspaceState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDesktopWorkspaceState(): DesktopWorkspaceStateProjection {
  return useSyncExternalStore(
    subscribeDesktopWorkspaceState,
    readDesktopWorkspaceState,
    readDesktopWorkspaceState,
  );
}

export function readDesktopThreadContentCacheEnabled(): boolean | null {
  return threadContentCacheEnabled;
}

function subscribeDesktopThreadContentCacheEnabled(listener: () => void): () => void {
  threadContentCacheListeners.add(listener);
  return () => threadContentCacheListeners.delete(listener);
}

export function useDesktopThreadContentCacheEnabled(): boolean | null {
  return useSyncExternalStore(
    subscribeDesktopThreadContentCacheEnabled,
    readDesktopThreadContentCacheEnabled,
    readDesktopThreadContentCacheEnabled,
  );
}

function adoptThreadContentCacheEnabled(enabled: boolean): void {
  if (threadContentCacheEnabled === enabled) return;
  threadContentCacheEnabled = enabled;
  for (const listener of threadContentCacheListeners) listener();
}

/** Turning the cache off makes main delete what it holds; on, it starts keeping conversations. */
export async function setDesktopThreadContentCacheEnabled(enabled: boolean): Promise<void> {
  const set = globalThis.window?.desktopBridge?.setDesktopThreadContentCacheEnabled;
  if (!set) return;
  adoptThreadContentCacheEnabled(await set(enabled));
}

/** Forgets cached content and what was asked for, e.g. on an account change or when the cache is off. */
function resetCachedThreadContent(): void {
  threadContentGeneration += 1;
  cachedThreadContent.clear();
  requestedThreadContent.clear();
}

/** The cached shell of an environment, with the cached display content of its threads. */
function cachedShellSnapshot(snapshot: WorkspaceMetadataSnapshot): CachedEnvironmentShellSnapshot {
  const shell = workspaceMetadataToCachedShellSnapshot(snapshot);
  const content = cachedThreadContent.get(snapshot.environmentId);
  if (content === undefined) return shell;
  return {
    ...shell,
    // The shell's rows were just built, so the content can be set on them directly.
    threads: shell.threads.map((thread) =>
      Object.assign(thread, { content: content[thread.shell.id] }),
    ),
  };
}

/**
 * Asks main, once, for the display content it kept for an environment that is
 * painted from the cache, and shows it as soon as it arrives. Display only:
 * the store ignores it for anything a live snapshot already provided.
 */
function requestCachedThreadContent(environmentId: EnvironmentId): void {
  const read = globalThis.window?.desktopBridge?.getDesktopThreadContent;
  if (
    !read ||
    threadContentCacheEnabled !== true ||
    requestedThreadContent.has(environmentId) ||
    useStore.getState().environmentStateById[environmentId]?.hydratedFromCacheAt === undefined
  ) {
    return;
  }
  requestedThreadContent.add(environmentId);
  const generation = threadContentGeneration;
  void read(environmentId)
    .then((stored) => {
      const snapshot = current.snapshots.find((entry) => entry.environmentId === environmentId);
      if (
        generation !== threadContentGeneration ||
        !isWorkspaceMetadataSnapshot(snapshot, environmentId) ||
        !hydratedEnvironmentIds.has(environmentId)
      ) {
        return;
      }
      // What main returns is validated again here, against the threads the snapshot lists.
      const content = decodeCachedEnvironmentContent(
        { content: stored },
        new Set(snapshot.threads.map((thread) => String(thread.id))),
      );
      if (Object.keys(content).length === 0) return;
      cachedThreadContent.set(environmentId, content);
      useStore
        .getState()
        .hydrateEnvironmentStateFromCache(cachedShellSnapshot(snapshot), environmentId, {
          replaceCached: true,
        });
    })
    .catch(() => undefined);
}

function requestCachedThreadContentForHydratedEnvironments(): void {
  for (const environmentId of hydratedEnvironmentIds) requestCachedThreadContent(environmentId);
}

/**
 * A mounted thread detail is demand. Sidebar prewarming deliberately does not
 * call this helper, so cached/list rows cannot connect every machine.
 */
function retainDesktopWorkspaceScope(
  environmentId: EnvironmentId,
  scope: DesktopWorkspaceScopeProjection,
): () => void {
  const bridge = globalThis.window?.desktopBridge;
  const retainScope = bridge?.retainDesktopWorkspaceScope;
  if (!bridge || !retainScope) return () => undefined;
  let released = false;
  let retaining = false;
  let leaseId: string | null = null;
  let renewal: ReturnType<typeof setInterval> | null = null;

  const canRetain = () =>
    current.status === "ready" &&
    current.machines.some(
      (machine) => machine.environmentId === environmentId && machine.canConnect,
    );

  const stopLease = () => {
    if (renewal) globalThis.clearInterval(renewal);
    renewal = null;
    const retainedLeaseId = leaseId;
    leaseId = null;
    if (retainedLeaseId) {
      void bridge.releaseDesktopWorkspaceScope?.(retainedLeaseId).catch(() => undefined);
    }
  };

  const reconcile = () => {
    if (released) return;
    if (!canRetain()) {
      stopLease();
      return;
    }
    if (retaining || leaseId !== null) return;
    retaining = true;
    void retainScope({
      environmentId,
      scope,
    })
      .then((result) => {
        retaining = false;
        if (released || !canRetain()) {
          void bridge.releaseDesktopWorkspaceScope?.(result.leaseId).catch(() => undefined);
          return;
        }
        leaseId = result.leaseId;
        renewal = globalThis.setInterval(() => {
          void bridge.renewDesktopWorkspaceScope?.(result.leaseId).catch(() => {
            if (released || leaseId !== result.leaseId) return;
            // Main may have expired this lease while the renderer was asleep.
            // A mounted consumer still needs demand; acquire a fresh lease.
            stopLease();
            reconcile();
          });
        }, 15_000);
      })
      .catch(() => {
        retaining = false;
      });
  };

  const unsubscribe = subscribeDesktopWorkspaceState(reconcile);
  reconcile();

  return () => {
    released = true;
    unsubscribe();
    stopLease();
  };
}

export function retainDesktopWorkspaceThreadScope(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  return retainDesktopWorkspaceScope(environmentId, { type: "thread-detail", threadId });
}

export function retainDesktopWorkspaceInteractiveScope(environmentId: EnvironmentId): () => void {
  return retainDesktopWorkspaceScope(environmentId, { type: "interactive" });
}

export function retainDesktopWorkspaceVcsScope(
  environmentId: EnvironmentId,
  cwd: string,
): () => void {
  return retainDesktopWorkspaceScope(environmentId, { type: "vcs-status", cwd });
}

export function retainDesktopWorkspaceProviderScope(
  environmentId: EnvironmentId,
  instanceId?: string,
): () => void {
  return retainDesktopWorkspaceScope(environmentId, {
    type: "provider-status",
    ...(instanceId ? { instanceId } : {}),
  });
}

/**
 * A snapshot is identified by its environment and capture time, so one that
 * matches a held snapshot keeps the held object (and with it the held array when
 * nothing changed) for consumers that compare by identity.
 */
function reuseHeldSnapshots(
  held: DesktopWorkspaceStateProjection["snapshots"],
  incoming: DesktopWorkspaceStateProjection["snapshots"],
): DesktopWorkspaceStateProjection["snapshots"] {
  const heldByEnvironment = new Map(held.map((snapshot) => [snapshot.environmentId, snapshot]));
  let identical = incoming.length === held.length;
  const next = incoming.map((snapshot, index) => {
    const existing = heldByEnvironment.get(snapshot.environmentId);
    const kept = existing?.capturedAt === snapshot.capturedAt ? existing : snapshot;
    if (kept !== held[index]) identical = false;
    return kept;
  });
  return identical ? held : next;
}

function adopt(state: DesktopWorkspaceStatePush): void {
  const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  const localHubAlias =
    primaryEnvironmentId !== null &&
    state.localEnvironmentId !== null &&
    state.localEnvironmentId !== primaryEnvironmentId
      ? state.localEnvironmentId
      : null;
  const heldSnapshots = new Set(current.snapshots);
  const snapshots =
    state.snapshots === undefined
      ? current.snapshots
      : reuseHeldSnapshots(current.snapshots, state.snapshots);
  // A held snapshot was validated when it arrived, and hydrating it again is a
  // no-op while the store still has the environment, so neither is repeated.
  const settled = new Set<EnvironmentId>();
  for (const snapshot of snapshots) {
    if (
      heldSnapshots.has(snapshot) &&
      snapshot.environmentId !== localHubAlias &&
      useStore.getState().environmentStateById[snapshot.environmentId] !== undefined
    ) {
      settled.add(snapshot.environmentId);
    }
  }
  const reconciled = reconcileDesktopWorkspaceCacheHydration({
    snapshots: snapshots.filter((snapshot) => !settled.has(snapshot.environmentId)),
    previouslyHydratedEnvironmentIds: new Set(
      Array.from(hydratedEnvironmentIds).filter((environmentId) => !settled.has(environmentId)),
    ),
    ...(localHubAlias === null ? {} : { excludedEnvironmentIds: new Set([localHubAlias]) }),
    port: {
      hydrate: (snapshot) => {
        // Hydration never replaces an environment the store already has.
        if (useStore.getState().environmentStateById[snapshot.environmentId] !== undefined) return;
        useStore
          .getState()
          .hydrateEnvironmentStateFromCache(cachedShellSnapshot(snapshot), snapshot.environmentId);
      },
      isCacheHydrated: (environmentId) =>
        useStore.getState().environmentStateById[environmentId]?.hydratedFromCacheAt !== undefined,
      remove: (environmentId) => useStore.getState().removeEnvironmentState(environmentId),
    },
  });
  hydratedEnvironmentIds = new Set([...reconciled, ...settled]);
  current = { ...state, snapshots };
  for (const listener of listeners) listener();
  requestCachedThreadContentForHydratedEnvironments();
}

async function applyConnectionCommand(
  command: DesktopWorkspaceConnectionCommand,
  isCurrent: () => boolean,
): Promise<void> {
  const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  const usesDirectLocalConnection =
    primaryEnvironmentId !== null &&
    current.localEnvironmentId === command.environmentId &&
    primaryEnvironmentId !== command.environmentId;
  if (usesDirectLocalConnection) {
    if (command.action === "connect") {
      if (command.delayMs > 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, command.delayMs));
      }
      if (!isCurrent()) return;
      try {
        const connection = connectPrimaryEnvironment();
        if (!connection) throw new Error("Primary environment is unavailable.");
        await connection.ensureBootstrapped();
        if (!isCurrent()) return;
        await globalThis.window?.desktopBridge
          ?.reportDesktopWorkspaceConnection?.({
            environmentId: command.environmentId,
            connected: true,
          })
          .catch(() => undefined);
      } catch (error) {
        if (!isCurrent()) return;
        await globalThis.window?.desktopBridge
          ?.reportDesktopWorkspaceConnection?.({
            environmentId: command.environmentId,
            connected: false,
          })
          .catch(() => undefined);
        throw error;
      }
      return;
    }
    await globalThis.window?.desktopBridge
      ?.reportDesktopWorkspaceConnection?.({
        environmentId: command.environmentId,
        connected: false,
      })
      .catch(() => undefined);
    return;
  }

  if (command.action === "connect") {
    if (command.delayMs > 0) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, command.delayMs));
    }
    if (!isCurrent()) return;
    let connection = readEnvironmentConnection(command.environmentId);
    try {
      if (!connection) {
        const machine = current.machines.find(
          (candidate) => candidate.environmentId === command.environmentId,
        );
        if (!machine?.canConnect) throw new Error("Desktop workspace machine is unavailable.");
        connection = await connectDesktopWorkspaceEnvironment({
          environmentId: machine.environmentId,
          label: machine.label,
        });
      } else {
        await connection.ensureBootstrapped();
      }
      if (!isCurrent()) return;
      await globalThis.window?.desktopBridge
        ?.reportDesktopWorkspaceConnection?.({
          environmentId: command.environmentId,
          connected: connection.shellSnapshotReadiness.read() !== null,
        })
        .catch(() => undefined);
      const machine = current.machines.find(
        (candidate) => candidate.environmentId === command.environmentId,
      );
      if (machine) renewDesktopMachineDirectAccess(machine);
    } catch (error) {
      if (!isCurrent()) return;
      await globalThis.window?.desktopBridge
        ?.reportDesktopWorkspaceConnection?.({
          environmentId: command.environmentId,
          connected: false,
        })
        .catch(() => undefined);
      throw error;
    }
    return;
  }
  const connection = readEnvironmentConnection(command.environmentId);
  if (!connection) return;
  if (connection.kind === "primary") {
    await disconnectPrimaryEnvironment();
  } else {
    await disconnectSavedEnvironment(command.environmentId);
  }
  if (!isCurrent()) return;
  await globalThis.window?.desktopBridge
    ?.reportDesktopWorkspaceConnection?.({
      environmentId: command.environmentId,
      connected: false,
    })
    .catch(() => undefined);
}

/** Whether two metadata values (plain data from the projection) hold the same content. */
function sameMetadata(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameMetadata(entry, right[index]))
    );
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameMetadata(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

/** What was last handed to main for an environment, and what it was read from. */
interface MetadataPublication {
  /** The snapshot as read from the store, before remapping to the machine's environment. */
  source: WorkspaceMetadataSnapshot;
  /** The remapped content, before bounding and the capture time. */
  content: WorkspaceMetadataSnapshot;
  pending: boolean;
}

/**
 * The store rebuilds a snapshot's arrays only when their sources change, so
 * identical arrays mean identical content without comparing it.
 */
function sameSourceArrays(left: WorkspaceMetadataSnapshot, right: WorkspaceMetadataSnapshot) {
  return (
    left.environmentId === right.environmentId &&
    left.projects === right.projects &&
    left.worktrees === right.worktrees &&
    left.threads === right.threads
  );
}

function sameMetadataContent(left: WorkspaceMetadataSnapshot, right: WorkspaceMetadataSnapshot) {
  return (
    left.environmentId === right.environmentId &&
    sameMetadata(left.projects, right.projects) &&
    sameMetadata(left.worktrees, right.worktrees) &&
    sameMetadata(left.threads, right.threads)
  );
}

/** Changes to conversations are handed to main at most this often. */
const THREAD_CONTENT_PUBLISH_THROTTLE_MS = 2_000;

/** What the content of an environment was last captured from, and what that captured. */
interface ThreadContentPublication {
  readonly inputs: ThreadContentInputs;
  readonly captured: ReadonlyArray<CapturedThreadContent>;
}

/**
 * The store replaces a message list when it changes, so identical lists mean
 * identical content without looking at it. Visits and the open thread decide
 * which conversations are kept, so they are inputs too.
 */
interface ThreadContentInputs {
  readonly messageIds: unknown;
  readonly messages: unknown;
  readonly threadIds: unknown;
  readonly visits: unknown;
  readonly routedThreadId: string | null;
}

function sameThreadContentInputs(left: ThreadContentInputs, right: ThreadContentInputs): boolean {
  return (
    left.messageIds === right.messageIds &&
    left.messages === right.messages &&
    left.threadIds === right.threadIds &&
    left.visits === right.visits &&
    left.routedThreadId === right.routedThreadId
  );
}

/** A capture reuses the entry of a thread whose messages did not change. */
function sameCapturedThreads(
  left: ReadonlyArray<CapturedThreadContent>,
  right: ReadonlyArray<CapturedThreadContent>,
): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** The thread open in this window, from its hash route (`#/<environmentId>/<threadId>`). */
function readRoutedThread(): { environmentId: string; threadId: string } | null {
  const route =
    (globalThis.window?.location?.hash ?? "").replace(/^#/u, "").split(/[?#]/u)[0] ?? "";
  const segments = route.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  try {
    return {
      environmentId: decodeURIComponent(segments[0]!),
      threadId: decodeURIComponent(segments[1]!),
    };
  } catch {
    return null;
  }
}

/** Bind the renderer only to secret-free projections and exact environment commands. */
export function startDesktopWorkspaceBridge(): () => void {
  const bridge = globalThis.window?.desktopBridge;
  if (!bridge?.getDesktopWorkspaceState) return () => undefined;
  let disposed = false;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let publicationAccountId = current.accountId;
  const commands = new Map<EnvironmentId, DesktopWorkspaceConnectionCommand>();
  const publications = new Map<EnvironmentId, MetadataPublication>();
  const threadContentCapture = createThreadContentCapture();
  const threadContentPublications = new Map<EnvironmentId, ThreadContentPublication>();
  let threadContentTimer: ReturnType<typeof setTimeout> | null = null;
  const forgetThreadContentPublications = () => {
    threadContentPublications.clear();
    threadContentCapture.clear();
  };
  const adoptPublicationScope = (state: DesktopWorkspaceStatePush) => {
    if (publicationAccountId !== state.accountId) {
      publications.clear();
      forgetThreadContentPublications();
      resetCachedThreadContent();
      commands.clear();
      publicationAccountId = state.accountId;
    }
    for (const environmentId of publications.keys()) {
      if (
        !state.machines.some(
          (machine) => machine.environmentId === environmentId && machine.canReadMetadata,
        )
      ) {
        publications.delete(environmentId);
        threadContentPublications.delete(environmentId);
        threadContentCapture.forget(environmentId);
      }
    }
    adopt(state);
  };
  const publishLiveMetadata = () => {
    if (publishTimer) globalThis.clearTimeout(publishTimer);
    publishTimer = globalThis.setTimeout(() => {
      publishTimer = null;
      const publish = bridge.publishDesktopWorkspaceSnapshot;
      if (!publish || disposed) return;
      const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
      for (const machine of current.machines) {
        if (!machine.canReadMetadata) continue;
        const sourceEnvironmentId =
          primaryEnvironmentId !== null && machine.environmentId === current.localEnvironmentId
            ? primaryEnvironmentId
            : machine.environmentId;
        // Cached metadata is already owned by main. Echoing it back would make
        // offline data look newly captured and continuously rewrite the cache.
        if (
          useStore.getState().environmentStateById[sourceEnvironmentId]?.hydratedFromCacheAt !==
          undefined
        )
          continue;
        const snapshot = readWorkspaceMetadataSnapshot(sourceEnvironmentId, 0);
        if (!snapshot) continue;
        const previous = publications.get(machine.environmentId);
        if (previous?.pending || (previous && sameSourceArrays(previous.source, snapshot))) {
          continue;
        }
        const projected = remapWorkspaceMetadataSnapshotEnvironment(
          snapshot,
          machine.environmentId,
        );
        if (previous && sameMetadataContent(previous.content, projected)) {
          previous.source = snapshot;
          continue;
        }
        const publication: MetadataPublication = {
          source: snapshot,
          content: projected,
          pending: true,
        };
        publications.set(machine.environmentId, publication);
        void publish({ ...boundWorkspaceMetadataSnapshot(projected), capturedAt: Date.now() })
          .then(() => {
            if (disposed || publications.get(machine.environmentId) !== publication) return;
            publication.pending = false;
            // Flush changes received during the write, at most one write per node.
            publishLiveMetadata();
          })
          .catch(() => {
            if (publications.get(machine.environmentId) === publication)
              publications.delete(machine.environmentId);
          });
      }
    }, 100);
  };
  /**
   * Hands main the display content of each live machine's recent conversations
   * when it changed. Nothing is serialized for a store update that left the
   * message lists, the visits and the open thread as they were.
   */
  const publishThreadContent = () => {
    const publish = bridge.publishDesktopThreadContent;
    if (!publish || disposed || threadContentCacheEnabled !== true) return;
    const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
    const routed = readRoutedThread();
    const visits = useUiStateStore.getState().threadLastVisitedAtById;
    for (const machine of current.machines) {
      if (!machine.canReadMetadata) continue;
      // The local server is shown from the primary environment, never from a copy
      // painted from the cache, so there is nothing to hydrate its content into.
      if (
        primaryEnvironmentId !== null &&
        machine.environmentId === current.localEnvironmentId &&
        machine.environmentId !== primaryEnvironmentId
      ) {
        continue;
      }
      const environment = useStore.getState().environmentStateById[machine.environmentId];
      // Content painted from the cache is already owned by main; echoing it back
      // would make offline data look newly captured.
      if (!environment?.bootstrapComplete || environment.hydratedFromCacheAt !== undefined)
        continue;
      const routedThreadId =
        routed?.environmentId === machine.environmentId ? ThreadId.make(routed.threadId) : null;
      const inputs: ThreadContentInputs = {
        messageIds: environment.messageIdsByThreadId,
        messages: environment.messageByThreadId,
        threadIds: environment.threadIds,
        visits,
        routedThreadId,
      };
      const previous = threadContentPublications.get(machine.environmentId);
      if (previous && sameThreadContentInputs(previous.inputs, inputs)) continue;
      const captured = threadContentCapture.capture(
        machine.environmentId,
        environment,
        selectThreadsForContentCache({
          threadIds: environment.threadIds,
          hasMessages: (threadId) => (environment.messageIdsByThreadId[threadId]?.length ?? 0) > 0,
          routedThreadId,
          lastVisitedAt: (threadId) =>
            visits[scopedThreadKey({ environmentId: machine.environmentId, threadId })],
        }),
      );
      threadContentPublications.set(machine.environmentId, { inputs, captured });
      if (previous ? sameCapturedThreads(previous.captured, captured) : captured.length === 0) {
        continue;
      }
      publish(
        machine.environmentId,
        Object.fromEntries(
          trimContentToBudget({
            bodyBytes: measureRecordBodyBytes({
              environmentId: machine.environmentId,
              capturedAt: Date.now(),
            }),
            entries: captured,
            budgetBytes: THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
          }).map((thread) => [thread.threadId, thread.content]),
        ),
      );
    }
  };
  // A throttle, not a debounce: a conversation that streams for minutes must still reach main.
  const scheduleThreadContentPublication = () => {
    if (threadContentTimer !== null || disposed || threadContentCacheEnabled !== true) return;
    threadContentTimer = globalThis.setTimeout(() => {
      threadContentTimer = null;
      publishThreadContent();
    }, THREAD_CONTENT_PUBLISH_THROTTLE_MS);
  };
  /** A window that is leaving sight hands over what is still waiting. */
  const flushThreadContent = () => {
    if (threadContentTimer === null) return;
    globalThis.clearTimeout(threadContentTimer);
    threadContentTimer = null;
    publishThreadContent();
  };
  const flushThreadContentWhenHidden = () => {
    if (globalThis.document?.visibilityState === "hidden") flushThreadContent();
  };
  const unsubscribeThreadContentSetting = subscribeDesktopThreadContentCacheEnabled(() => {
    if (threadContentCacheEnabled === true) {
      requestCachedThreadContentForHydratedEnvironments();
      scheduleThreadContentPublication();
      return;
    }
    if (threadContentTimer !== null) globalThis.clearTimeout(threadContentTimer);
    threadContentTimer = null;
    forgetThreadContentPublications();
    resetCachedThreadContent();
  });
  globalThis.window?.addEventListener?.("pagehide", flushThreadContent);
  globalThis.document?.addEventListener?.("visibilitychange", flushThreadContentWhenHidden);
  // Main publishes only on change, so a state adopted from the initial read
  // must not replace one pushed while that read was in flight: nothing would
  // publish the newer state again until the next change.
  let pushedDuringRead = false;
  let pushedSnapshotsDuringRead = false;
  const unsubscribeState = bridge.onDesktopWorkspaceState?.((state) => {
    if (disposed) return;
    pushedDuringRead = true;
    pushedSnapshotsDuringRead ||= state.snapshots !== undefined;
    adoptPublicationScope(state);
    publishLiveMetadata();
    scheduleThreadContentPublication();
  });
  const unsubscribeCommands = bridge.onDesktopWorkspaceConnectionCommand?.((command) => {
    if (disposed || commands.get(command.environmentId)?.action === command.action) return;
    commands.set(command.environmentId, command);
    const isCurrent = () => !disposed && commands.get(command.environmentId) === command;
    void applyConnectionCommand(command, isCurrent)
      .catch(() => undefined)
      .finally(() => {
        if (isCurrent()) commands.delete(command.environmentId);
      });
  });
  const unsubscribeStore = useStore.subscribe(() => {
    publishLiveMetadata();
    scheduleThreadContentPublication();
  });
  const unsubscribeVisits = useUiStateStore.subscribe(scheduleThreadContentPublication);
  void bridge
    .getDesktopThreadContentCacheEnabled?.()
    .then((enabled) => {
      if (!disposed) adoptThreadContentCacheEnabled(enabled);
    })
    .catch(() => undefined);
  void bridge
    .getDesktopWorkspaceState()
    .then((state) => {
      if (disposed) return;
      if (!pushedDuringRead) {
        adoptPublicationScope(state);
      } else if (!pushedSnapshotsDuringRead) {
        // The pushes left their snapshots out because they matched the ones
        // this read returned, which are the only ones held so far.
        adoptPublicationScope({ ...current, snapshots: state.snapshots });
      }
      // Otherwise a push carried snapshots newer than the read, which it replaces.
      publishLiveMetadata();
      scheduleThreadContentPublication();
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    if (publishTimer) globalThis.clearTimeout(publishTimer);
    if (threadContentTimer !== null) globalThis.clearTimeout(threadContentTimer);
    unsubscribeState?.();
    unsubscribeCommands?.();
    unsubscribeStore();
    unsubscribeVisits();
    unsubscribeThreadContentSetting();
    globalThis.window?.removeEventListener?.("pagehide", flushThreadContent);
    globalThis.document?.removeEventListener?.("visibilitychange", flushThreadContentWhenHidden);
    resetCachedThreadContent();
  };
}
