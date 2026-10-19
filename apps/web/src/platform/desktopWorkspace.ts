import {
  EnvironmentId,
  ThreadId,
  type DesktopWorkspaceScopeProjection,
  type DesktopWorkspaceConnectionCommand,
  type DesktopWorkspaceStateProjection,
  type DesktopWorkspaceStatePush,
} from "@ryco/contracts";
import {
  boundWorkspaceMetadataSnapshot,
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
          .hydrateEnvironmentStateFromCache(
            workspaceMetadataToCachedShellSnapshot(snapshot),
            snapshot.environmentId,
          );
      },
      isCacheHydrated: (environmentId) =>
        useStore.getState().environmentStateById[environmentId]?.hydratedFromCacheAt !== undefined,
      remove: (environmentId) => useStore.getState().removeEnvironmentState(environmentId),
    },
  });
  hydratedEnvironmentIds = new Set([...reconciled, ...settled]);
  current = { ...state, snapshots };
  for (const listener of listeners) listener();
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

/** Bind the renderer only to secret-free projections and exact environment commands. */
export function startDesktopWorkspaceBridge(): () => void {
  const bridge = globalThis.window?.desktopBridge;
  if (!bridge?.getDesktopWorkspaceState) return () => undefined;
  let disposed = false;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let publicationAccountId = current.accountId;
  const commands = new Map<EnvironmentId, DesktopWorkspaceConnectionCommand>();
  const publications = new Map<EnvironmentId, MetadataPublication>();
  const adoptPublicationScope = (state: DesktopWorkspaceStatePush) => {
    if (publicationAccountId !== state.accountId) {
      publications.clear();
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
  const unsubscribeStore = useStore.subscribe(publishLiveMetadata);
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
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    if (publishTimer) globalThis.clearTimeout(publishTimer);
    unsubscribeState?.();
    unsubscribeCommands?.();
    unsubscribeStore();
  };
}
