import type { EnvironmentId } from "@ryco/contracts";

import { useAgentControlStore } from "./store.ts";
import {
  startAgentControlProposalSync,
  type AgentControlSubscriptionSource,
  type AgentControlSyncSink,
} from "./sync.ts";

/**
 * The sink every client uses unless it adds its own bookkeeping: stream
 * events land in the shared `useAgentControlStore`.
 */
export const agentControlStoreSink: AgentControlSyncSink = {
  applyStreamEvent: (environmentId, event) =>
    useAgentControlStore.getState().applyStreamEvent(environmentId, event),
  clearEnvironment: (environmentId) =>
    useAgentControlStore.getState().clearEnvironment(environmentId),
};

/** Where an environment's queue subscription comes from right now. */
export interface AgentControlSyncSource {
  readonly source: AgentControlSubscriptionSource;
  /**
   * The connection the source belongs to; defaults to `source`. A client that
   * builds a fresh api object per read passes its stable rpc client instead,
   * so only a replaced connection restarts the stream.
   */
  readonly connection?: unknown;
}

export interface AgentControlSyncRegistryOptions {
  /** The environment's current source, or nothing while it has no connection. */
  readonly readSource: (environmentId: EnvironmentId) => AgentControlSyncSource | null | undefined;
  /**
   * Notifies when any environment's connection is registered, replaced or
   * removed. Without it the source is only read again on the next retain.
   */
  readonly subscribeSourceChanges?: (listener: () => void) => () => void;
  /** Defaults to `agentControlStoreSink`. */
  readonly sink?: AgentControlSyncSink;
}

export interface AgentControlSyncRegistry {
  /**
   * Hold the environment's queue subscription until the returned release is
   * called (calling it again does nothing). Every holder of one environment
   * shares one subscription, bound to the environment's current connection.
   */
  readonly retain: (environmentId: EnvironmentId) => () => void;
  /** Whether an environment's queue subscription is currently held. */
  readonly isRetained: (environmentId: EnvironmentId) => boolean;
}

interface RetainedSync {
  count: number;
  /** The connection the running subscription is bound to; null while there is none. */
  connection: unknown;
  stopSync: (() => void) | null;
  /** The server refused the subscription; nothing will arrive on it. */
  refused: boolean;
  /** A release left the sync unused; it stops at the end of the task unless retained again. */
  teardownScheduled: boolean;
  unsubscribeSourceChanges: () => void;
}

/**
 * One Agent Control queue subscription per environment however many surfaces
 * show it, reference counted. Every subscription opens with a full snapshot,
 * so sharing it saves a stream and a snapshot per extra surface.
 *
 * The subscription follows the environment's connection: it binds once one
 * exists, and restarts when a retain or a source change finds a different
 * connection than the one it runs on, so late-connecting environments and
 * replaced connections keep the queue live. (Plain reconnects of the same
 * connection need nothing: the transport resubscribes, and the server opens
 * the new subscription with a fresh snapshot.)
 *
 * The last release stops the subscription once the current task ends, so a
 * surface that re-renders with a different set of environments — or React
 * re-running an effect — hands the subscription over instead of tearing it
 * down and opening a new one. A subscription the server refused (feature off,
 * not authorized) is not shared: the transport does not retry a refusal, so
 * the next retain binds again, and turning the feature on reopens the stream.
 *
 * The Agent Control setting is enforced by the target environment's server;
 * the registry decides no policy. Framework-free: each app wraps `retain` in
 * its own hook.
 */
export function createAgentControlSyncRegistry(
  options: AgentControlSyncRegistryOptions,
): AgentControlSyncRegistry {
  const sink = options.sink ?? agentControlStoreSink;
  const retained = new Map<EnvironmentId, RetainedSync>();

  const bind = (environmentId: EnvironmentId, entry: RetainedSync, force: boolean) => {
    const current = options.readSource(environmentId) ?? null;
    const connection = current ? (current.connection ?? current.source) : null;
    if (!force && connection === entry.connection) return;
    entry.stopSync?.();
    entry.stopSync = null;
    entry.connection = connection;
    entry.refused = false;
    if (!current) return;
    entry.stopSync = startAgentControlProposalSync({
      environmentId,
      source: current.source,
      sink,
      onError: () => {
        entry.refused = true;
      },
    });
  };

  const retain = (environmentId: EnvironmentId): (() => void) => {
    let entry = retained.get(environmentId);
    if (!entry) {
      const created: RetainedSync = {
        count: 0,
        connection: null,
        stopSync: null,
        refused: false,
        teardownScheduled: false,
        unsubscribeSourceChanges: () => {},
      };
      created.unsubscribeSourceChanges =
        options.subscribeSourceChanges?.(() => bind(environmentId, created, false)) ??
        created.unsubscribeSourceChanges;
      bind(environmentId, created, true);
      retained.set(environmentId, created);
      entry = created;
    } else {
      bind(environmentId, entry, entry.refused);
    }
    entry.count += 1;
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.count -= 1;
      if (held.count > 0 || held.teardownScheduled) return;
      held.teardownScheduled = true;
      void Promise.resolve().then(() => {
        held.teardownScheduled = false;
        if (held.count > 0 || retained.get(environmentId) !== held) return;
        retained.delete(environmentId);
        held.unsubscribeSourceChanges();
        held.stopSync?.();
      });
    };
  };

  return {
    retain,
    isRetained: (environmentId) => retained.has(environmentId),
  };
}
