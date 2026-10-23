import type { EnvironmentId } from "@ryco/contracts";

import type { EnvironmentConnection } from "../../connection/connection.ts";
import type {
  EnvironmentConnectionSupervisor,
  ShellAcceptance,
} from "../../connection/supervision.ts";
import { mapThreadShellSummary } from "./store.ts";
import { isDelegatedThreadLineage } from "./threadLineage.ts";
import {
  createThreadNotificationProjector,
  type ThreadNotificationEvent,
} from "./threadNotifications.ts";
import type { SidebarThreadOrStub } from "./types.ts";

/** The part of the connection supervisor a notification feed reads. */
export type ThreadNotificationSource = Pick<
  EnvironmentConnectionSupervisor,
  "subscribe" | "list" | "read" | "readShellProjectionSequence" | "subscribeShellAcceptance"
>;

export interface ThreadNotificationCandidate {
  readonly event: ThreadNotificationEvent;
  /** The thread was delegated by another thread, which receives its result. */
  readonly delegated: boolean;
}

export interface ThreadNotificationFeed {
  /** Revalidates a candidate after an asynchronous step (a permission prompt, a platform call). */
  readonly isCurrent: (event: ThreadNotificationEvent) => boolean;
  readonly stop: () => void;
}

interface TrackedConnection {
  readonly connection: EnvironmentConnection;
  readonly unsubscribe: () => void;
  /** The readiness token the environment was last baselined with. */
  baselined: object | null;
}

/**
 * Feeds the notification projector from what the connection supervisor
 * accepted, with each connection's shell readiness token as the generation.
 * A new token (a new socket attempt's snapshot, or a resume), a snapshot the
 * stream applied, a connection appearing and the feed starting each baseline
 * silently from the store. Accepted thread upserts are observed one by one, as
 * the store normalizes each. Candidates reach `onCandidate` after the current
 * task's synchronous work, outside the store commit that produced them, and
 * only while still current.
 */
export function startThreadNotificationFeed(input: {
  readonly source: ThreadNotificationSource;
  /** The environment's committed thread rows, archived stubs included. */
  readonly readEnvironmentThreads: (
    environmentId: EnvironmentId,
  ) => ReadonlyArray<SidebarThreadOrStub>;
  readonly now: () => number;
  readonly onCandidate: (candidate: ThreadNotificationCandidate) => void;
}): ThreadNotificationFeed {
  const { source } = input;
  const readToken = (environmentId: EnvironmentId) =>
    source.read(environmentId)?.shellSnapshotReadiness.read() ?? null;
  const projector = createThreadNotificationProjector({ readGeneration: readToken });
  const tracked = new Map<EnvironmentId, TrackedConnection>();
  let pending: ThreadNotificationCandidate[] = [];
  let stopped = false;

  const rebaseline = (environmentId: EnvironmentId) => {
    const token = readToken(environmentId);
    if (token === null) return;
    // Applies buffered shell items first, observed against the previous baseline.
    const sequence = source.readShellProjectionSequence(environmentId);
    if (sequence === null || readToken(environmentId) !== token) return;
    projector.baseline({
      environmentId,
      generation: token,
      sequence,
      threads: input.readEnvironmentThreads(environmentId),
      nowMs: input.now(),
    });
    const entry = tracked.get(environmentId);
    if (entry !== undefined) entry.baselined = token;
  };

  const onReadiness = (environmentId: EnvironmentId) => {
    if (stopped) return;
    const token = readToken(environmentId);
    // The same token is the same attempt's shell, which is baselined already.
    if (token !== null && token !== tracked.get(environmentId)?.baselined) {
      rebaseline(environmentId);
    }
  };

  const syncConnections = () => {
    if (stopped) return;
    const connections = new Map(
      source.list().map((connection) => [connection.environmentId, connection]),
    );
    for (const [environmentId, entry] of Array.from(tracked)) {
      if (connections.get(environmentId) === entry.connection) continue;
      entry.unsubscribe();
      tracked.delete(environmentId);
      projector.clear(environmentId);
    }
    for (const connection of connections.values()) {
      const { environmentId } = connection;
      if (tracked.has(environmentId)) continue;
      tracked.set(environmentId, {
        connection,
        unsubscribe: connection.shellSnapshotReadiness.subscribe(() => onReadiness(environmentId)),
        baselined: null,
      });
      rebaseline(environmentId);
    }
  };

  const deliver = () => {
    const candidates = pending;
    pending = [];
    for (const candidate of candidates) {
      if (stopped) return;
      if (!projector.isCurrent(candidate.event)) continue;
      try {
        input.onCandidate(candidate);
      } catch (error) {
        console.warn("Thread notification delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const onAcceptance = (acceptance: ShellAcceptance) => {
    if (stopped) return;
    const { environmentId } = acceptance;
    if (acceptance.kind === "snapshot") {
      rebaseline(environmentId);
      return;
    }
    const generation = readToken(environmentId);
    if (generation === null) return;
    const nowMs = input.now();
    const queued = pending.length;
    for (const event of acceptance.events) {
      if (event.kind === "thread-removed") {
        projector.remove({
          environmentId,
          generation,
          sequence: event.sequence,
          threadId: event.threadId,
        });
        continue;
      }
      if (event.kind !== "thread-upserted") continue;
      // Each event's own state, not the batch's last: a thread created and
      // asking for approval within one batch still alerts.
      const thread = mapThreadShellSummary(event.thread, environmentId);
      const candidate = projector.observe({ generation, sequence: event.sequence, thread, nowMs });
      if (candidate !== null) {
        pending.push({ event: candidate, delegated: isDelegatedThreadLineage(thread.lineage) });
      }
    }
    // Shell batches commit inside store mutation barriers; nothing reaches
    // the user from there.
    if (queued === 0 && pending.length > 0) void Promise.resolve().then(deliver);
  };

  const unsubscribeRegistry = source.subscribe(syncConnections);
  const unsubscribeAcceptance = source.subscribeShellAcceptance(onAcceptance);
  syncConnections();

  return {
    isCurrent: (event) => projector.isCurrent(event),
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribeRegistry();
      unsubscribeAcceptance();
      for (const entry of tracked.values()) entry.unsubscribe();
      tracked.clear();
      pending = [];
      projector.reset();
    },
  };
}
