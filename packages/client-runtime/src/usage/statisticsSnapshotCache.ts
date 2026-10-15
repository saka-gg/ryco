import type { EnvironmentId, StatisticsSnapshot } from "@ryco/contracts";

import { SharedRequests, type SharedRequestOptions } from "./sharedRequests.ts";

/** Reads one environment's statistics snapshot. */
export type StatisticsSnapshotFetch = (signal: AbortSignal) => Promise<StatisticsSnapshot>;

/** Flight key for a request made before the environment is known; its answer is never kept. */
const UNKNOWN_ENVIRONMENT_KEY = "";

/**
 * The last statistics snapshot per environment, so a reopened Activity view
 * paints it at once and refreshes in the background, plus sharing of the
 * in-flight request between concurrent views and the route's prefetch (see
 * {@link SharedRequests}).
 *
 * Snapshots are owner-only node data: one environment's snapshot is never
 * handed to another, and {@link forget} / {@link clear} also discard answers
 * that were still in flight when they ran, so a node switch or an account
 * teardown cannot be repopulated by the connection it just left.
 */
export class StatisticsSnapshotCache {
  readonly #snapshots = new Map<EnvironmentId, StatisticsSnapshot>();
  readonly #requests: SharedRequests<StatisticsSnapshot>;
  readonly #generations = new Map<EnvironmentId, number>();
  #epoch = 0;

  constructor(options: { readonly handoffMs?: number; readonly now?: () => number } = {}) {
    this.#requests = new SharedRequests(options);
  }

  /** The last snapshot this client received from `environmentId`, if any. */
  peek(environmentId: EnvironmentId | null): StatisticsSnapshot | undefined {
    return environmentId === null ? undefined : this.#snapshots.get(environmentId);
  }

  /** The view's own request: joins an identical one in flight or takes a fresh prefetched answer. */
  load(
    environmentId: EnvironmentId | null,
    fetch: StatisticsSnapshotFetch,
    options: SharedRequestOptions = {},
  ): Promise<StatisticsSnapshot> {
    return this.#requests.request(
      flightKey(environmentId),
      (signal) => this.#read(environmentId, fetch, signal),
      options,
    );
  }

  /** Start the request a view is about to make (route loader, link intent). */
  prefetch(environmentId: EnvironmentId | null, fetch: StatisticsSnapshotFetch): void {
    this.#requests.prefetch(flightKey(environmentId), (signal) =>
      this.#read(environmentId, fetch, signal),
    );
  }

  /** Drop one environment's snapshot, prefetched answer and in-flight sharing. */
  forget(environmentId: EnvironmentId): void {
    this.#generations.set(environmentId, this.#generation(environmentId) + 1);
    this.#snapshots.delete(environmentId);
    this.#requests.forget(flightKey(environmentId));
  }

  /** Drop every snapshot, e.g. when the signed-in account goes away. */
  clear(): void {
    this.#epoch += 1;
    this.#snapshots.clear();
    this.#requests.clear();
  }

  async #read(
    environmentId: EnvironmentId | null,
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
      this.#snapshots.set(environmentId, snapshot);
    }
    return snapshot;
  }

  #generation(environmentId: EnvironmentId): number {
    return this.#generations.get(environmentId) ?? 0;
  }
}

function flightKey(environmentId: EnvironmentId | null): string {
  return environmentId ?? UNKNOWN_ENVIRONMENT_KEY;
}

/** Shared by every statistics view in this client. */
export const statisticsSnapshotCache = new StatisticsSnapshotCache();
