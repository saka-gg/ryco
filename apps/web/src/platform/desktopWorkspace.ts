import {
  EnvironmentId,
  ThreadId,
  type DesktopWorkspaceScopeProjection,
  type DesktopWorkspaceConnectionCommand,
  type DesktopWorkspaceStateProjection,
} from "@ryco/contracts";
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
          void bridge.renewDesktopWorkspaceScope?.(result.leaseId).catch(() => undefined);
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

function adopt(state: DesktopWorkspaceStateProjection): void {
  const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  const localHubAlias =
    primaryEnvironmentId !== null &&
    state.localEnvironmentId !== null &&
    state.localEnvironmentId !== primaryEnvironmentId
      ? state.localEnvironmentId
      : null;
  hydratedEnvironmentIds = new Set(
    reconcileDesktopWorkspaceCacheHydration({
      snapshots: state.snapshots,
      previouslyHydratedEnvironmentIds: hydratedEnvironmentIds,
      ...(localHubAlias === null ? {} : { excludedEnvironmentIds: new Set([localHubAlias]) }),
      port: {
        hydrate: (snapshot) =>
          useStore
            .getState()
            .hydrateEnvironmentStateFromCache(
              workspaceMetadataToCachedShellSnapshot(snapshot),
              snapshot.environmentId,
            ),
        isCacheHydrated: (environmentId) =>
          useStore.getState().environmentStateById[environmentId]?.hydratedFromCacheAt !==
          undefined,
        remove: (environmentId) => useStore.getState().removeEnvironmentState(environmentId),
      },
    }),
  );
  current = state;
  for (const listener of listeners) listener();
}

async function applyConnectionCommand(command: DesktopWorkspaceConnectionCommand): Promise<void> {
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
      try {
        const connection = connectPrimaryEnvironment();
        if (!connection) throw new Error("Primary environment is unavailable.");
        await connection.ensureBootstrapped();
        await globalThis.window?.desktopBridge
          ?.reportDesktopWorkspaceConnection?.({
            environmentId: command.environmentId,
            connected: true,
          })
          .catch(() => undefined);
      } catch (error) {
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

  let connection = readEnvironmentConnection(command.environmentId);
  if (command.action === "connect") {
    if (command.delayMs > 0) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, command.delayMs));
    }
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
        await connection.reconnect();
        await connection.ensureBootstrapped();
      }
      await globalThis.window?.desktopBridge
        ?.reportDesktopWorkspaceConnection?.({
          environmentId: command.environmentId,
          connected: true,
        })
        .catch(() => undefined);
    } catch (error) {
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
  if (!connection) return;
  if (connection.kind === "primary") {
    await disconnectPrimaryEnvironment();
  } else {
    await disconnectSavedEnvironment(command.environmentId);
  }
  await globalThis.window?.desktopBridge
    ?.reportDesktopWorkspaceConnection?.({
      environmentId: command.environmentId,
      connected: false,
    })
    .catch(() => undefined);
}

/** Bind the renderer only to secret-free projections and exact environment commands. */
export function startDesktopWorkspaceBridge(): () => void {
  const bridge = globalThis.window?.desktopBridge;
  if (!bridge?.getDesktopWorkspaceState) return () => undefined;
  let disposed = false;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let publicationAccountId = current.accountId;
  const publications = new Map<EnvironmentId, { fingerprint: string; pending: boolean }>();
  const adoptPublicationScope = (state: DesktopWorkspaceStateProjection) => {
    if (publicationAccountId !== state.accountId) {
      publications.clear();
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
        const projected = remapWorkspaceMetadataSnapshotEnvironment(
          snapshot,
          machine.environmentId,
        );
        const fingerprint = JSON.stringify(projected);
        const previous = publications.get(machine.environmentId);
        if (previous?.pending || previous?.fingerprint === fingerprint) continue;
        const publication = { fingerprint, pending: true };
        publications.set(machine.environmentId, publication);
        void publish({ ...projected, capturedAt: Date.now() })
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
  const unsubscribeState = bridge.onDesktopWorkspaceState?.((state) => {
    if (disposed) return;
    adoptPublicationScope(state);
    publishLiveMetadata();
  });
  const unsubscribeCommands = bridge.onDesktopWorkspaceConnectionCommand?.((command) => {
    void applyConnectionCommand(command).catch(() => undefined);
  });
  const unsubscribeStore = useStore.subscribe(publishLiveMetadata);
  void bridge
    .getDesktopWorkspaceState()
    .then((state) => {
      if (disposed) return;
      adoptPublicationScope(state);
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
