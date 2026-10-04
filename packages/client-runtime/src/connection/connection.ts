import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
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
import { bindDeviceConnection } from "../state/device/runtime.ts";

export interface PushSequenceMonitor {
  readonly recordEvent: (environmentId: EnvironmentId, sequence: number) => void;
  readonly recordSnapshot: (environmentId: EnvironmentId, sequence: number) => void;
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
  readonly reconnect: () => Promise<void>;
  readonly dispose: () => Promise<void>;
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
  readonly syncShellSnapshot: (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  readonly applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => void;
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

export interface EnvironmentConnectionInput extends OrchestrationHandlers {
  readonly kind: "primary" | "saved";
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly pushSequenceMonitor: PushSequenceMonitor;
  readonly refreshMetadata?: () => Promise<void>;
  readonly onConfigUpdated?: (
    config: ServerConfig,
    source: ServerConfigStreamEvent["type"],
  ) => void;
  readonly onWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
  readonly onResubscribe?: (environmentId: EnvironmentId) => void;
  readonly onShellError?: (environmentId: EnvironmentId) => void;
  /** Runs once the connection is disposed: what its owner keeps running for it stops with it. */
  readonly onDispose?: () => void;
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
  const shouldObserveConfig = input.kind === "saved" || input.onConfigUpdated !== undefined;
  let observedConfig: ServerConfig | null = null;
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
  const unsubConfig = shouldObserveConfig
    ? input.client.server.subscribeConfig(
        (event) => {
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
          const nextConfig = projectServerConfigEvent(observedConfig, normalizedEvent);
          if (!nextConfig) return;
          observedConfig = nextConfig;
          input.onConfigUpdated?.(nextConfig, normalizedEvent.type);
        },
        {
          onResubscribe: () => {
            observedConfig = null;
          },
        },
      )
    : () => undefined;
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
      input.pushSequenceMonitor.recordEvent(environmentId, item.sequence);
      input.applyShellEvent(item, environmentId);
    },
    {
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
  const deviceBinding = input.client.device
    ? bindDeviceConnection(environmentId, input.client.device)
    : null;
  const cleanup = () => {
    disposed = true;
    invalidateShellReadiness();
    shellReadinessListeners.clear();
    unsubShell();
    unsubTerminalEvent();
    unsubLifecycle();
    unsubConfig();
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
    reconnect: async () => {
      bootstrapGate.reset();
      invalidateShellReadiness();
      deviceBinding?.reconnecting();
      try {
        await input.client.reconnect();
        await deviceBinding?.refreshInventory();
        await input.refreshMetadata?.();
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
