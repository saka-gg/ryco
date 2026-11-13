import type { EnvironmentId, StatisticsScope, StatisticsSnapshot } from "@ryco/contracts";

import { SharedRequests, type SharedRequestOptions } from "./sharedRequests.ts";

/** Reads one environment's statistics snapshot. */
export type StatisticsSnapshotFetch = (signal: AbortSignal) => Promise<StatisticsSnapshot>;

/** Flight key for a request made before the environment is known; its answer is never kept. */
const UNKNOWN_ENVIRONMENT_KEY = "";
/** Separates the environment from the scope in a key; never part of an environment id. */
const SCOPE_SEPARATOR = "\u0000";

/**
 * The last statistics snapshot per environment and scope, so a reopened Activity view
 * paints it at once and refreshes in the background, plus sharing of the
 * in-flight request between concurrent views and the route's prefetch (see
 * {@link SharedRequests}).
 *
 * Snapshots are owner-only node data: one environment's snapshot is never
 * handed to another (nor one scope's to the other), and {@link forget} / {@link clear} also discard answers
 * that were still in flight when they ran, so a node switch or an account
 * teardown cannot be repopulated by the connection it just left.
 */
export class StatisticsSnapshotCache {
  /** Keyed by {@link snapshotKey}. */
  readonly #snapshots = new Map<string, StatisticsSnapshot>();
  readonly #requests: SharedRequests<StatisticsSnapshot>;
  readonly #generations = new Map<EnvironmentId, number>();
  #epoch = 0;

  constructor(options: { readonly handoffMs?: number; readonly now?: () => number } = {}) {
    this.#requests = new SharedRequests(options);
  }

  /** The last snapshot this client received from `environmentId` for `scope`, if any. */
  peek(
    environmentId: EnvironmentId | null,
    scope: StatisticsScope = "ryco",
  ): StatisticsSnapshot | undefined {
    return environmentId === null
      ? undefined
      : this.#snapshots.get(snapshotKey(environmentId, scope));
  }

  /** The view's own request: joins an identical one in flight or takes a fresh prefetched answer. */
  load(
    environmentId: EnvironmentId | null,
    fetch: StatisticsSnapshotFetch,
    options: SharedRequestOptions & { readonly scope?: StatisticsScope | undefined } = {},
  ): Promise<StatisticsSnapshot> {
    const scope = options.scope ?? "ryco";
    return this.#requests.request(
      flightKey(environmentId, scope),
      (signal) => this.#read(environmentId, scope, fetch, signal),
      options,
    );
  }

  /** Start the request a view is about to make (route loader, link intent). */
  prefetch(
    environmentId: EnvironmentId | null,
    fetch: StatisticsSnapshotFetch,
    scope: StatisticsScope = "ryco",
  ): void {
    this.#requests.prefetch(flightKey(environmentId, scope), (signal) =>
      this.#read(environmentId, scope, fetch, signal),
    );
  }

  /** Drop one environment's snapshots (every scope), prefetched answers and in-flight sharing. */
  forget(environmentId: EnvironmentId): void {
    this.#generations.set(environmentId, this.#generation(environmentId) + 1);
    const prefix = `${environmentId}${SCOPE_SEPARATOR}`;
    for (const key of this.#snapshots.keys()) {
      if (key.startsWith(prefix)) this.#snapshots.delete(key);
    }
    this.#requests.forgetMatching((key) => key.startsWith(prefix));
  }

  /** Drop every snapshot, e.g. when the signed-in account goes away. */
  clear(): void {
    this.#epoch += 1;
    this.#snapshots.clear();
    this.#requests.clear();
  }

  async #read(
    environmentId: EnvironmentId | null,
    scope: StatisticsScope,
    fetch: StatisticsSnapshotFetch,
    signal: AbortSignal,
  ): Promise<StatisticsSnapshot> {
    const epoch = this.#epoch;
    const generation = environmentId === null ? 0 : this.#generation(environmentId);
    const snapshot = await fetch(signal);
    if (
      environmentId !== null &&
      epoch === this.#epoch &&
      generation === this.#generation(environmentId)
    ) {
      this.#snapshots.set(snapshotKey(environmentId, scope), snapshot);
    }
    return snapshot;
  }

  #generation(environmentId: EnvironmentId): number {
    return this.#generations.get(environmentId) ?? 0;
  }
}

function snapshotKey(environmentId: EnvironmentId, scope: StatisticsScope): string {
  return `${environmentId}${SCOPE_SEPARATOR}${scope}`;
}

function flightKey(environmentId: EnvironmentId | null, scope: StatisticsScope): string {
  return `${environmentId ?? UNKNOWN_ENVIRONMENT_KEY}${SCOPE_SEPARATOR}${scope}`;
}

/** Shared by every statistics view in this client. */
export const statisticsSnapshotCache = new StatisticsSnapshotCache();
