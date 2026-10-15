import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  OrchestrationStubbedShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationShellThreadPrioritiesItem,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleWelcomePayload,
  TerminalEvent,
} from "@ryco/contracts";

import type { KnownEnvironment } from "../knownEnvironment.ts";
import type { WsRpcClient } from "../rpc/index.ts";
import { projectServerConfigEvent } from "../rpc/serverConfigProjection.ts";
import {
  getWsConnectionStatusForEnvironment,
  clearWsConnectionStatusForEnvironment,
} from "../rpc/wsConnectionState.ts";
import { registerDeviceConnection } from "../state/device/runtime.ts";

export interface PushSequenceMonitor {
  readonly recordEvent: (environmentId: EnvironmentId, sequence: number) => void;
  readonly recordSnapshot: (environmentId: EnvironmentId, sequence: number) => void;
}

/** One config update the connection accepted from its config stream. */
export interface EnvironmentConfigUpdate {
  /** The connection's config after the event (inner descriptors normalized for Hub relays). */
  readonly config: ServerConfig;
  /** The event exactly as the node's stream delivered it. */
  readonly event: ServerConfigStreamEvent;
}

/**
 * The node's pushed config, as this connection's one `subscribeConfig` stream
 * keeps it. Every value is stamped with the socket attempt (and, for a hosted
 * connection, the lifecycle generation) it arrived on.
 */
export interface EnvironmentConnectionConfig {
  /**
   * The config, or `null` unless all of these hold: the connection is not
   * disposed, its socket is connected, the snapshot arrived on the current
   * socket attempt and subscription, and a hosted connection's generation is
   * still the owner's current one. A resubscribe, a reconnect and a dispose
   * reset it until the next snapshot.
   */
  readonly read: () => ServerConfig | null;
  /**
   * Observes every accepted update from now on (the current value is
   * `read()`). Incremental events are delivered only on
   * top of a current-attempt snapshot, and nothing is delivered for a stale
   * hosted generation. While any listener is held the stream stays open; a
   * primary connection without `onConfigUpdated` opens it on the first one.
   */
  readonly subscribe: (listener: (update: EnvironmentConfigUpdate) => void) => () => void;
}

export interface EnvironmentConnection {
  readonly kind: "primary" | "saved";
  readonly environmentId: EnvironmentId;
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly ensureBootstrapped: () => Promise<void>;
  /** Snapshot evidence is scoped to the socket attempt that delivered it. */
  readonly shellSnapshotReadiness: {
    readonly read: () => object | null;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly config: EnvironmentConnectionConfig;
  readonly reconnect: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/**
 * The hosted lifecycle generation a connection was created for. Hosted
 * recovery has one owner that advances the generation on every node switch,
 * sign-out, account change, suspension or deactivation; a connection of an
 * older generation (or of none) publishes no config and reads none.
 */
export interface ConnectionLifecycleGeneration {
  readonly generation: number;
  /** The owner's current generation; `null` when it has none for this environment. */
  readonly readCurrent: () => number | null;
}

export interface OrchestrationHandlers {
  /**
   * Forget the previous stream's sequence baseline before accepting the first
   * authoritative snapshot from a replacement subscription. Node processes
   * may restart their in-memory projection sequence at a lower value.
   */
  readonly resetShellProjection: (environmentId: EnvironmentId) => void;
  readonly applyShellEvent: (
    event: OrchestrationShellStreamEvent,
    environmentId: EnvironmentId,
  ) => void;
  /** Archived threads may arrive as stubs (`snapshot.archivedThreadStubs`). */
  readonly syncShellSnapshot: (
    snapshot: OrchestrationStubbedShellSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  readonly applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => void;
  /**
   * Applies a thread-priority ranking. When provided, the connection asks the
   * server for these small items instead of a full shell snapshot per ranking.
   */
  readonly applyThreadPriorities?: (
    item: OrchestrationShellThreadPrioritiesItem,
    environmentId: EnvironmentId,
  ) => void;
  /**
   * The last shell sequence applied for this environment. When provided, a
   * replacement subscription asks the server to resume after it instead of
   * resending the whole shell, and the projection is reset only if a snapshot
   * arrives after all. Leave it out where a fresh snapshot is required — a hosted
   * session must accept a current snapshot before it may mutate.
   */
  readonly readShellResumeSequence?: (environmentId: EnvironmentId) => number | null;
  /** A replacement subscription resumed on top of the shell already held. */
  readonly onShellResumed?: (environmentId: EnvironmentId) => void;
}

export interface RefreshMetadataContext {
  /**
   * The full config snapshot the replacement config subscription delivers
   * after the reconnect began (or already delivered). Never rejects; it stays
   * pending while no snapshot arrives, so callers bound their wait.
   */
  readonly configSnapshot: Promise<ServerConfig>;
}

export interface EnvironmentConnectionInput extends OrchestrationHandlers {
  readonly kind: "primary" | "saved";
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly pushSequenceMonitor: PushSequenceMonitor;
  readonly refreshMetadata?: (context: RefreshMetadataContext) => Promise<void>;
  readonly onConfigUpdated?: (
    config: ServerConfig,
    source: ServerConfigStreamEvent["type"],
  ) => void;
  /** Hosted connections only: see {@link ConnectionLifecycleGeneration}. */
  readonly lifecycleGeneration?: ConnectionLifecycleGeneration;
  readonly onWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
  readonly onResubscribe?: (environmentId: EnvironmentId) => void;
  readonly onShellError?: (environmentId: EnvironmentId) => void;
  /** Runs once the connection is disposed: what its owner keeps running for it stops with it. */
  readonly onDispose?: () => void;
}

/** The next config snapshot, for a reconnect's metadata refresh to reuse. */
function createConfigSnapshotWaiter() {
  let resolve: ((config: ServerConfig) => void) | null = null;
  const promise = new Promise<ServerConfig>((nextResolve) => {
    resolve = nextResolve;
  });
  return {
    promise,
    resolve: (config: ServerConfig) => {
      resolve?.(config);
      resolve = null;
    },
  };
}

function createBootstrapGate() {
  let resolve: (() => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  const createPendingPromise = () => {
    const pending = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    // A push subscription can fail before a caller starts waiting for the
    // initial shell snapshot. Mark that early rejection as observed so native
    // development clients do not surface an uncaught-promise overlay. Returning
    // the original promise from `wait` still preserves the rejection for every
    // caller that needs to react to the failed bootstrap.
    void pending.catch(() => undefined);
    return pending;
  };
  let promise = createPendingPromise();

  return {
    wait: () => promise,
    resolve: () => {
      resolve?.();
      resolve = null;
      reject = null;
    },
    reject: (error: unknown) => {
      reject?.(error);
      resolve = null;
      reject = null;
    },
    reset: () => {
      promise = createPendingPromise();
    },
  };
}

export function createEnvironmentConnection(
  input: EnvironmentConnectionInput,
): EnvironmentConnection {
  const environmentId = input.knownEnvironment.environmentId;
  if (!environmentId) {
    throw new Error(
      `Known environment ${input.knownEnvironment.label} is missing its environmentId.`,
    );
  }

  let disposed = false;
  const bootstrapGate = createBootstrapGate();
  let shellSnapshot: { readonly attempt: number } | null = null;
  const shellReadinessListeners = new Set<() => void>();
  const notifyShellReadiness = () => {
    // A callback can replace its connection subscription while being notified.
    const listeners = Array.from(shellReadinessListeners);
    for (const listener of listeners) listener();
  };
  const invalidateShellReadiness = () => {
    shellSnapshot = null;
    notifyShellReadiness();
  };
  const shouldObserveLifecycle = input.kind === "saved" || input.onWelcome !== undefined;
  // Saved connections and those with a config handler hold their one config
  // stream for their whole life. A primary without one opens it for its first
  // observer (the primary server-state sync), which may wait for the provider
  // catalogs it can name before it subscribes.
  const holdsConfigForLife = input.kind === "saved" || input.onConfigUpdated !== undefined;
  const lifecycleGeneration = input.lifecycleGeneration;
  const isCurrentGeneration = () =>
    lifecycleGeneration === undefined ||
    lifecycleGeneration.readCurrent() === lifecycleGeneration.generation;
  const currentAttempt = () => getWsConnectionStatusForEnvironment(environmentId).attemptCount;
  let observedConfig: {
    readonly config: ServerConfig;
    readonly attempt: number;
    readonly generation: number | null;
  } | null = null;
  const configListeners = new Set<(update: EnvironmentConfigUpdate) => void>();
  // Re-armed when a reconnect begins: the replacement subscription's first
  // item is a full snapshot, which the metadata refresh reuses.
  let configSnapshotWaiter = createConfigSnapshotWaiter();
  const observeEnvironmentIdentity = (nextEnvironmentId: EnvironmentId, source: string) => {
    if (environmentId !== nextEnvironmentId) {
      throw new Error(
        `Environment connection ${environmentId} changed identity to ${nextEnvironmentId} via ${source}.`,
      );
    }
  };
  const normalizeObservedEnvironment = (
    descriptor: ExecutionEnvironmentDescriptor,
    source: string,
  ): ExecutionEnvironmentDescriptor => {
    if (input.knownEnvironment.source !== "hub-hosted") {
      observeEnvironmentIdentity(descriptor.environmentId, source);
      return descriptor;
    }
    // A Hub enrollment owns a stable, opaque environment id independently of
    // the node's legacy local UUID. The authenticated relay target is the
    // authority here; normalize inner descriptors so node-owned state remains
    // keyed to that exact Hub environment without weakening direct connections.
    return {
      ...descriptor,
      environmentId,
      label: input.knownEnvironment.label,
    };
  };

  const unsubLifecycle = shouldObserveLifecycle
    ? input.client.server.subscribeLifecycle((event) => {
        if (event.type !== "welcome") return;
        const payload = {
          ...event.payload,
          environment: normalizeObservedEnvironment(
            event.payload.environment,
            "server lifecycle welcome",
          ),
        };
        input.onWelcome?.(payload);
      })
    : () => undefined;
  const observeConfigEvent = (event: ServerConfigStreamEvent) => {
    // A stale hosted generation never publishes config, not even a snapshot.
    if (disposed || !isCurrentGeneration()) return;
    const attempt = currentAttempt();
    // Incremental events apply only on top of this attempt's own snapshot.
    const base =
      event.type === "snapshot" || observedConfig?.attempt !== attempt
        ? null
        : observedConfig.config;
    const normalizedEvent =
      event.type === "snapshot"
        ? {
            ...event,
            config: {
              ...event.config,
              environment: normalizeObservedEnvironment(
                event.config.environment,
                "server config snapshot",
              ),
            },
          }
        : event;
    const nextConfig = projectServerConfigEvent(base, normalizedEvent);
    if (!nextConfig) return;
    observedConfig = {
      config: nextConfig,
      attempt,
      generation: lifecycleGeneration === undefined ? null : lifecycleGeneration.readCurrent(),
    };
    if (normalizedEvent.type === "snapshot") configSnapshotWaiter.resolve(nextConfig);
    input.onConfigUpdated?.(nextConfig, normalizedEvent.type);
    const update = { config: nextConfig, event };
    for (const listener of Array.from(configListeners)) listener(update);
  };
  let configStreamHolds = 0;
  let unsubConfigStream: (() => void) | null = null;
  const holdConfigStream = (): (() => void) => {
    configStreamHolds += 1;
    if (unsubConfigStream === null && !disposed) {
      unsubConfigStream = input.client.server.subscribeConfig(observeConfigEvent, {
        onResubscribe: () => {
          observedConfig = null;
        },
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      configStreamHolds -= 1;
      if (configStreamHolds > 0) return;
      observedConfig = null;
      const unsubscribe = unsubConfigStream;
      unsubConfigStream = null;
      unsubscribe?.();
    };
  };
  const unsubConfig = holdsConfigForLife ? holdConfigStream() : () => undefined;
  // Resume is attempted only on top of a baseline this connection established
  // itself, and a projection reset waits until the server has chosen between
  // resuming and sending a snapshot.
  let hasShellBaseline = false;
  let awaitingResubscribeBaseline = false;
  const readShellResumeSequence = input.readShellResumeSequence;
  const unsubShell = input.client.orchestration.subscribeShell(
    (item) => {
      if (disposed) return;
      if (item.kind === "resumed") {
        awaitingResubscribeBaseline = false;
        hasShellBaseline = true;
        input.pushSequenceMonitor.recordSnapshot(environmentId, item.fromSequence);
        bootstrapGate.resolve();
        const attempt = getWsConnectionStatusForEnvironment(environmentId).attemptCount;
        if (shellSnapshot?.attempt !== attempt) shellSnapshot = { attempt };
        notifyShellReadiness();
        input.onShellResumed?.(environmentId);
        return;
      }
      if (item.kind === "snapshot") {
        if (awaitingResubscribeBaseline) {
          awaitingResubscribeBaseline = false;
          input.resetShellProjection(environmentId);
        }
        hasShellBaseline = true;
        input.pushSequenceMonitor.recordSnapshot(environmentId, item.snapshot.snapshotSequence);
        input.syncShellSnapshot(item.snapshot, environmentId);
        bootstrapGate.resolve();
        const attempt = getWsConnectionStatusForEnvironment(environmentId).attemptCount;
        if (shellSnapshot?.attempt !== attempt) shellSnapshot = { attempt };
        notifyShellReadiness();
        return;
      }
      if (item.kind === "thread-priorities") {
        input.applyThreadPriorities?.(item, environmentId);
        return;
      }
      input.pushSequenceMonitor.recordEvent(environmentId, item.sequence);
      input.applyShellEvent(item, environmentId);
    },
    {
      ...(input.applyThreadPriorities === undefined ? {} : { threadPriorities: "delta" as const }),
      // The store keeps archived threads as stubs and loads full shells on demand.
      archivedThreads: "stub" as const,
      ...(readShellResumeSequence === undefined
        ? {}
        : {
            resumeFromSequence: () =>
              hasShellBaseline && !disposed ? readShellResumeSequence(environmentId) : null,
          }),
      onResubscribe: () => {
        if (disposed) return;
        bootstrapGate.reset();
        invalidateShellReadiness();
        if (readShellResumeSequence !== undefined && hasShellBaseline) {
          awaitingResubscribeBaseline = true;
        } else {
          input.resetShellProjection(environmentId);
        }
        input.onResubscribe?.(environmentId);
      },
      onError: () => {
        if (disposed) return;
        bootstrapGate.reject(new Error("Shell snapshot synchronization failed."));
        invalidateShellReadiness();
        input.onShellError?.(environmentId);
      },
    },
  );
  const unsubTerminalEvent = input.client.terminal.onEvent((event) =>
    input.applyTerminalEvent(event, environmentId),
  );
  // The device event stream starts only while a device surface retains it.
  const deviceBinding = input.client.device
    ? registerDeviceConnection(environmentId, input.client.device)
    : null;
  const cleanup = () => {
    disposed = true;
    invalidateShellReadiness();
    shellReadinessListeners.clear();
    unsubShell();
    unsubTerminalEvent();
    unsubLifecycle();
    unsubConfig();
    // Observers' holds end with the connection.
    observedConfig = null;
    configListeners.clear();
    const unsubscribeConfigStream = unsubConfigStream;
    unsubConfigStream = null;
    unsubscribeConfigStream?.();
    deviceBinding?.dispose();
  };

  return {
    kind: input.kind,
    environmentId,
    knownEnvironment: input.knownEnvironment,
    client: input.client,
    ensureBootstrapped: () => bootstrapGate.wait(),
    shellSnapshotReadiness: {
      read: () => {
        const status = getWsConnectionStatusForEnvironment(environmentId);
        return !disposed &&
          status.phase === "connected" &&
          shellSnapshot?.attempt === status.attemptCount
          ? shellSnapshot
          : null;
      },
      subscribe: (listener) => {
        shellReadinessListeners.add(listener);
        return () => {
          shellReadinessListeners.delete(listener);
        };
      },
    },
    config: {
      read: () => {
        if (disposed || observedConfig === null) return null;
        const status = getWsConnectionStatusForEnvironment(environmentId);
        if (status.phase !== "connected" || observedConfig.attempt !== status.attemptCount) {
          return null;
        }
        if (
          lifecycleGeneration !== undefined &&
          (observedConfig.generation !== lifecycleGeneration.generation || !isCurrentGeneration())
        ) {
          return null;
        }
        return observedConfig.config;
      },
      subscribe: (listener) => {
        if (disposed) return () => undefined;
        const entry = (update: EnvironmentConfigUpdate) => listener(update);
        configListeners.add(entry);
        const release = holdConfigStream();
        return () => {
          configListeners.delete(entry);
          release();
        };
      },
    },
    reconnect: async () => {
      bootstrapGate.reset();
      invalidateShellReadiness();
      // The replacement socket's own snapshot is the next current config.
      observedConfig = null;
      deviceBinding?.reconnecting();
      const configSnapshot = createConfigSnapshotWaiter();
      configSnapshotWaiter = configSnapshot;
      try {
        // The simulator pane re-reads the inventory itself when the device
        // generation changes; nothing here waits on simulator discovery.
        await input.client.reconnect();
        await input.refreshMetadata?.({ configSnapshot: configSnapshot.promise });
        await bootstrapGate.wait();
      } catch (error) {
        bootstrapGate.reject(error);
        throw error;
      }
    },
    dispose: async () => {
      cleanup();
      input.onDispose?.();
      await input.client.dispose();
      // The transport drops close events once a session is inactive, so a
      // disposed environment's keyed WS status would otherwise stay "connected"
      // forever (e.g. across a hub node switch). No-op for sockets that never
      // recorded per-environment status.
      clearWsConnectionStatusForEnvironment(environmentId);
    },
  };
}
