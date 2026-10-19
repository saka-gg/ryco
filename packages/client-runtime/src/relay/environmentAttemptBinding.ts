import type { EnvironmentId } from "@ryco/contracts";

import {
  hostedBrowserRevalidated,
  type HostedEnvironmentSessions,
} from "../authorization/hostedEnvironmentSessions.ts";
import type {
  HostedAccountStatus,
  HostedBrowserStatus,
  HostedDirectoryStatus,
  HostedRelayFailure,
} from "../authorization/types.ts";
import {
  admitHostedRequestForState,
  HostedRelayAttemptFactory,
  hostedRuntimeAttemptPorts,
  type HostedRelayAttemptBinding,
} from "./transport.ts";

/** The account-wide part of hosted state that every environment's connection shares. */
export interface HostedEnvironmentSharedState {
  readonly accountStatus: HostedAccountStatus;
  readonly directoryStatus: HostedDirectoryStatus;
  readonly browserStatus: HostedBrowserStatus;
}

/**
 * How the platform prepares, authenticates and opens this environment's relay
 * channels. Every port it omits falls back to the hosted runtime
 * configuration's, exactly as for the selected node's connection (see
 * {@link hostedRuntimeAttemptPorts}; the relay URL and socket fall back inside
 * the factory). Ports that hand a prepared socket context to each other — its
 * preparation, ticket, disposal and the sockets that receive it — belong
 * together, so a platform overrides them as a set.
 */
export type HostedEnvironmentAttemptPorts = Pick<
  HostedRelayAttemptBinding,
  | "prepareSocketContext"
  | "issueRelayAttempt"
  | "disposeSocketContext"
  | "openEarlyRelaySocket"
  | "relayUrl"
  | "createRelaySocket"
  | "serverAuthenticatedRelayAvailable"
  | "createServerAuthenticatedRelaySocket"
  | "revalidateSession"
  | "connectionSuspect"
> & {
  /** Sees every failure of this environment's current attempt, e.g. a device-wide revocation. */
  readonly onFailure?: (failure: HostedRelayFailure) => void;
};

export interface HostedEnvironmentAttemptFactoryOptions {
  readonly sessions: HostedEnvironmentSessions;
  readonly environmentId: EnvironmentId;
  readonly nodeId: string;
  /**
   * The record generation this connection belongs to; defaults to the
   * environment's current one. A connection created for a generation that has
   * already been replaced stays inert.
   */
  readonly generation?: number;
  readonly readShared: () => HostedEnvironmentSharedState;
  readonly subscribeShared: (listener: () => void) => () => void;
  readonly ports: HostedEnvironmentAttemptPorts;
  /**
   * Whether the platform still wants this environment connected. When it does
   * not, a dropped channel stops instead of reconnecting by itself, and the
   * platform releases the environment.
   */
  readonly isDemanded?: () => boolean;
}

export interface HostedEnvironmentAttemptFactory {
  readonly factory: HostedRelayAttemptFactory;
  readonly binding: HostedRelayAttemptBinding;
  readonly generation: number;
}

/**
 * The relay attempt factory of one environment's connection, bound to one
 * record generation of its session.
 *
 * Admission and reconnects read that environment's own record, never the
 * selected environment's, and every relay callback is written to the record
 * fenced by the generation, so a connection of a replaced generation can
 * neither admit a request nor publish anything.
 */
export function createHostedEnvironmentAttemptFactory(
  options: HostedEnvironmentAttemptFactoryOptions,
): HostedEnvironmentAttemptFactory {
  const { sessions, environmentId, nodeId, readShared, subscribeShared, isDemanded } = options;
  const { onFailure, ...ports } = options.ports;
  const generation = options.generation ?? sessions.read(environmentId)?.generation;
  if (generation === undefined) {
    throw new Error("The hosted environment has no session to bind a relay attempt to.");
  }
  const currentRecord = (attemptGeneration: number) => {
    const record = sessions.read(environmentId);
    return record?.generation === attemptGeneration && attemptGeneration === generation
      ? record
      : undefined;
  };

  const binding: HostedRelayAttemptBinding = {
    ...hostedRuntimeAttemptPorts(),
    ...ports,
    nodeId: () => nodeId,
    generation: () => generation,
    isAuthenticated: () => readShared().accountStatus === "authenticated",
    isCurrent: (attemptGeneration) => currentRecord(attemptGeneration) !== undefined,
    authorizeRequest(info) {
      const record = currentRecord(generation);
      // A superseded connection never becomes current again.
      if (record === undefined) return "forbidden";
      const shared = readShared();
      return admitHostedRequestForState(
        {
          effectiveRole: record.effectiveRole,
          directoryStatus: shared.directoryStatus,
          transportStatus: record.transportStatus,
          // The shared browser status describes the selected environment. A
          // `synchronizing` browser has already revalidated the account and the
          // directory and only waits for the selected environment's snapshot;
          // this environment's own readiness comes from its own session below.
          browserStatus: hostedBrowserRevalidated(shared.browserStatus)
            ? "current"
            : shared.browserStatus,
          sessionStatus: record.sessionStatus,
          sessionRecoveredAfterUnknown: record.sessionRecoveredAfterUnknown,
        },
        info,
      );
    },
    subscribeAdmissionChanges(listener) {
      const unsubscribeShared = subscribeShared(listener);
      const unsubscribeSessions = sessions.subscribe(listener);
      return () => {
        unsubscribeShared();
        unsubscribeSessions();
      };
    },
    shouldReconnect(attemptGeneration) {
      const record = currentRecord(attemptGeneration);
      const shared = readShared();
      return (
        record !== undefined &&
        shared.accountStatus === "authenticated" &&
        hostedBrowserRevalidated(shared.browserStatus) &&
        !record.suspended &&
        record.transportStatus !== "terminal-failure" &&
        shared.directoryStatus === "ready" &&
        (isDemanded?.() ?? true)
      );
    },
    transportStatus: (attemptGeneration, status) =>
      sessions.transportStatus(environmentId, attemptGeneration, status),
    sessionStatus: (attemptGeneration, status) =>
      sessions.sessionStatus(environmentId, attemptGeneration, status),
    role: (attemptGeneration, role) => sessions.role(environmentId, attemptGeneration, role),
    failure(attemptGeneration, failure) {
      // The record fails closed first: a broken platform hook can neither keep
      // it from doing so nor break the transport's own failure handling.
      sessions.failure(environmentId, attemptGeneration, failure);
      if (onFailure === undefined) return;
      try {
        onFailure(failure);
      } catch (error) {
        console.warn("Hosted relay failure handler failed", { environmentId, error });
      }
    },
    markDeliveryUnknown: (attemptGeneration) =>
      sessions.markDeliveryUnknown(environmentId, attemptGeneration),
    connectionClosed: (attemptGeneration) =>
      sessions.connectionClosed(environmentId, attemptGeneration),
    connectionRecovered: (attemptGeneration) =>
      sessions.connectionRecovered(environmentId, attemptGeneration),
  };

  const factory = new HostedRelayAttemptFactory(binding);
  sessions.registerPendingRequestReader(environmentId, generation, () =>
    factory.hasPendingRequests(),
  );
  return { factory, binding, generation };
}
