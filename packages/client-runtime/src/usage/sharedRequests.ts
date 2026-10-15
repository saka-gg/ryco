// @effect-diagnostics globalDate:off

/**
 * How long a prefetched answer waits for the view it was fetched for. It
 * matches the router's default freshness for intent preloads, so a hover that
 * is followed by a click within that time never asks twice.
 */
export const PREFETCH_HANDOFF_MS = 30_000;

export interface SharedRequestOptions {
  /**
   * The caller stops waiting when this aborts. A request nobody waits for any
   * more is aborted too; a caller without a signal keeps it until it settles.
   */
  readonly signal?: AbortSignal | undefined;
  /** An explicit refresh: never take a prefetched answer (an identical in-flight request is still joined). */
  readonly fresh?: boolean | undefined;
}

interface Flight<T> {
  promise: Promise<T>;
  readonly controller: AbortController;
  /** Callers with a signal that has not aborted yet. */
  waiting: number;
  /** A caller without a signal joined: the request runs to the end. */
  pinned: boolean;
  /** Started by a prefetch nobody has joined yet: it runs to the end and hands its answer off. */
  prefetched: boolean;
  settled: boolean;
  readonly detach: Array<() => void>;
}

interface Handoff<T> {
  readonly value: T;
  readonly settledAtMs: number;
}

/**
 * Identical requests share one flight, keyed by the caller. A prefetch (a
 * route loader, link intent) starts the request a view is about to make: the
 * view joins it while it runs, or takes its answer once within
 * {@link PREFETCH_HANDOFF_MS} after it settled, instead of asking again. A
 * later mount still asks again, so a reopened view revalidates.
 *
 * A request that every waiting caller abandoned (a superseded range, say) is
 * aborted, so the node can drop the work. Prefetches are never aborted: their
 * answer is what the next view paints.
 */
export class SharedRequests<T> {
  readonly #flights = new Map<string, Flight<T>>();
  readonly #handoffs = new Map<string, Handoff<T>>();
  readonly #handoffMs: number;
  readonly #now: () => number;

  constructor(options: { readonly handoffMs?: number; readonly now?: () => number } = {}) {
    this.#handoffMs = options.handoffMs ?? PREFETCH_HANDOFF_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Join the identical in-flight request, take an unclaimed prefetched answer, or start one. */
  request(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    options: SharedRequestOptions = {},
  ): Promise<T> {
    const flight = this.#flights.get(key);
    if (flight !== undefined) {
      if (options.signal?.aborted !== true) {
        // The joining caller takes over from the prefetch that started it.
        flight.prefetched = false;
        this.#hold(key, flight, options.signal);
      }
      return flight.promise;
    }
    const handoff = this.#handoffs.get(key);
    this.#handoffs.delete(key);
    if (
      handoff !== undefined &&
      options.fresh !== true &&
      this.#now() - handoff.settledAtMs <= this.#handoffMs
    ) {
      return Promise.resolve(handoff.value);
    }
    const started = this.#start(key, start, false, undefined);
    this.#hold(key, started, options.signal);
    return started.promise;
  }

  /**
   * Start the request a view is about to make, unless it is already running or
   * answered. `keep` decides which answers may stand in for the view's own request.
   */
  prefetch(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    keep: (value: T) => boolean = () => true,
  ): void {
    const now = this.#now();
    for (const [handoffKey, handoff] of this.#handoffs) {
      if (now - handoff.settledAtMs > this.#handoffMs) this.#handoffs.delete(handoffKey);
    }
    if (this.#flights.has(key) || this.#handoffs.has(key)) return;
    // Nobody may await a prefetch; its failure is reported to the view that asks next.
    void this.#start(key, start, true, keep).promise.catch(() => undefined);
  }

  /** Forget `key`'s answer and stop sharing its in-flight request (it still settles). */
  forget(key: string): void {
    this.#flights.delete(key);
    this.#handoffs.delete(key);
  }

  /** Forget every answer and stop sharing in-flight requests (they still settle). */
  clear(): void {
    this.#flights.clear();
    this.#handoffs.clear();
  }

  #start(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    prefetched: boolean,
    keep: ((value: T) => boolean) | undefined,
  ): Flight<T> {
    const flight: Flight<T> = {
      promise: Promise.resolve(undefined as T),
      controller: new AbortController(),
      waiting: 0,
      pinned: false,
      prefetched,
      settled: false,
      detach: [],
    };
    let running: Promise<T>;
    try {
      running = start(flight.controller.signal);
    } catch (error) {
      running = Promise.reject(error);
    }
    flight.promise = running.then(
      (value) => {
        // A prefetch is only dropped by clear(): its answer must not outlive that.
        const current = this.#flights.get(key) === flight;
        this.#settle(key, flight);
        if (current && flight.prefetched && keep?.(value) === true) {
          this.#handoffs.set(key, { value, settledAtMs: this.#now() });
        }
        return value;
      },
      (error: unknown) => {
        this.#settle(key, flight);
        throw error;
      },
    );
    this.#flights.set(key, flight);
    return flight;
  }

  #hold(key: string, flight: Flight<T>, signal: AbortSignal | undefined): void {
    if (signal === undefined) {
      flight.pinned = true;
      return;
    }
    if (signal.aborted) {
      this.#abortIfAbandoned(key, flight);
      return;
    }
    flight.waiting += 1;
    const onAbort = () => {
      flight.waiting -= 1;
      this.#abortIfAbandoned(key, flight);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.detach.push(() => signal.removeEventListener("abort", onAbort));
  }

  #abortIfAbandoned(key: string, flight: Flight<T>): void {
    if (flight.settled || flight.pinned || flight.prefetched || flight.waiting > 0) return;
    if (this.#flights.get(key) === flight) this.#flights.delete(key);
    flight.controller.abort();
  }

  #settle(key: string, flight: Flight<T>): void {
    flight.settled = true;
    for (const detach of flight.detach.splice(0)) detach();
    if (this.#flights.get(key) === flight) this.#flights.delete(key);
  }
}
