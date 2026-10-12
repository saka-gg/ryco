/**
 * Cold-start ordering gate shared by the direct and hosted connection paths.
 *
 * The app shell must stay synchronous to render its launch surface, while the
 * snapshot cache is asynchronous. Callers therefore enqueue connection work
 * here. A failed cache read is reported and treated as an empty cache rather
 * than preventing the app from connecting indefinitely.
 *
 * Hydration has two stages:
 *
 * - **direct-ready**: the saved-environment catalog is hydrated, so the direct
 *   supervisor can tell which environments it owns. Its network pre-flight
 *   (keychain read, session check, ws-token, socket open) may start here and
 *   overlap the snapshot cache read. That is safe because the threads store
 *   lets live data win the race: a cached projection never replaces state a
 *   live shell snapshot already created, and live state is never stamped as
 *   cache-provenance. Mutation authority is unaffected: a direct connection
 *   still grants it only after its own fresh shell snapshot.
 * - **hydrated**: the cached node roster and every environment projection
 *   have been read. Hosted work stays behind this stage.
 *
 * The hydration callback marks direct-ready itself; if it never does (a
 * failure before the catalog step), settling hydration opens both stages.
 */

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export interface MobileRuntimeHydrationStages {
  /** The saved-environment catalog is hydrated; direct connection work may start. */
  readonly markDirectReady: () => void;
}

export interface MobileRuntimeStartupBarrier {
  readonly beginHydration: (
    hydrate: (stages: MobileRuntimeHydrationStages) => Promise<void>,
    onFailure: (error: unknown) => void,
  ) => Promise<void>;
  /** Runs once the direct stage is open (or hydration has settled). */
  readonly runAfterDirectReady: (
    work: () => void | Promise<void>,
    onFailure: (error: unknown) => void,
  ) => void;
  readonly runAfterHydration: (
    work: () => void | Promise<void>,
    onFailure: (error: unknown) => void,
  ) => void;
  /** Whether the current generation's hydration has settled. */
  readonly isHydrated: () => boolean;
  readonly reset: () => void;
}

export function createMobileRuntimeStartupBarrier(): MobileRuntimeStartupBarrier {
  let generation = 0;
  let directReady = createDeferred();
  let ready = createDeferred();
  let hydrated = false;
  let hydration: Promise<void> | null = null;

  const beginHydration = (
    hydrate: (stages: MobileRuntimeHydrationStages) => Promise<void>,
    onFailure: (error: unknown) => void,
  ): Promise<void> => {
    if (hydration) return hydration;
    const scheduledGeneration = generation;
    const stageDirectReady = directReady;
    const stages: MobileRuntimeHydrationStages = {
      markDirectReady: () => {
        if (generation === scheduledGeneration) stageDirectReady.resolve();
      },
    };
    const stageReady = ready;
    hydration = Promise.resolve()
      .then(() => hydrate(stages))
      .catch((error: unknown) => {
        onFailure(error);
      })
      .then(() => {
        if (generation !== scheduledGeneration) return;
        hydrated = true;
        stageDirectReady.resolve();
        stageReady.resolve();
      });
    return hydration;
  };

  const runAfter =
    (stage: () => Deferred) =>
    (work: () => void | Promise<void>, onFailure: (error: unknown) => void): void => {
      const scheduledGeneration = generation;
      void stage()
        .promise.then(() => {
          if (generation !== scheduledGeneration) return;
          return work();
        })
        .catch(onFailure);
    };

  const reset = (): void => {
    generation += 1;
    // Release callbacks waiting on the retired generation; their generation
    // check prevents them from starting stale connections.
    directReady.resolve();
    ready.resolve();
    directReady = createDeferred();
    ready = createDeferred();
    hydrated = false;
    hydration = null;
  };

  return {
    beginHydration,
    runAfterDirectReady: runAfter(() => directReady),
    runAfterHydration: runAfter(() => ready),
    isHydrated: () => hydrated,
    reset,
  };
}

export const mobileRuntimeStartupBarrier = createMobileRuntimeStartupBarrier();
