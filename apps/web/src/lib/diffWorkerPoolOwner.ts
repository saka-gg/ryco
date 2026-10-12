import type { DiffThemeName } from "./diffRendering";

/**
 * Lease-counted owner for the diff highlight worker pool, kept free of worker
 * imports so its lifecycle is unit-testable. `diffWorkerPool.ts` binds it to
 * the real `@pierre/diffs` pool.
 */

const MAX_DIFF_WORKER_POOL_SIZE = 2;
export const DIFF_WORKER_POOL_IDLE_TIMEOUT_MS = 3 * 60_000;
export const DIFF_WORKER_POOL_HIDDEN_IDLE_TIMEOUT_MS = 30_000;

/**
 * Workers hold their own grammars and caches (about 2 MB each), and one
 * worker already keeps typical turn diffs busy. Two cover large patches on
 * machines with cores to spare without competing with chat rendering.
 */
export function resolveDiffWorkerPoolSize(hardwareConcurrency: number | undefined): number {
  const cores = Math.max(1, hardwareConcurrency || 4);
  return Math.max(1, Math.min(MAX_DIFF_WORKER_POOL_SIZE, Math.floor(cores / 4)));
}

export interface DiffWorkerPoolLease<Pool> {
  readonly pool: Pool;
  readonly release: () => void;
}

export interface DiffWorkerPoolOwnerDeps<Pool> {
  readonly create: (themeName: DiffThemeName) => Pool;
  readonly terminate: (pool: Pool) => void;
  readonly isDocumentHidden: () => boolean;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}

export interface DiffWorkerPoolOwner<Pool> {
  /** The live pool, created on demand. Unleased pools start their idle grace. */
  readonly get: (themeName: DiffThemeName) => Pool;
  readonly acquire: (themeName: DiffThemeName) => DiffWorkerPoolLease<Pool>;
  /** Re-evaluates the idle grace after a document visibility change. */
  readonly onVisibilityChange: () => void;
  readonly peek: () => Pool | null;
  readonly dispose: () => void;
}

export function createDiffWorkerPoolOwner<Pool>(
  deps: DiffWorkerPoolOwnerDeps<Pool>,
): DiffWorkerPoolOwner<Pool> {
  let pool: Pool | null = null;
  let leaseCount = 0;
  let idleTimer: unknown = null;

  const cancelIdleTermination = () => {
    if (idleTimer !== null) {
      deps.clearTimer(idleTimer);
      idleTimer = null;
    }
  };

  const terminatePool = () => {
    idleTimer = null;
    if (pool === null || leaseCount > 0) {
      return;
    }
    const current = pool;
    pool = null;
    deps.terminate(current);
  };

  const scheduleIdleTermination = () => {
    cancelIdleTermination();
    if (pool === null || leaseCount > 0) {
      return;
    }
    idleTimer = deps.setTimer(
      terminatePool,
      deps.isDocumentHidden()
        ? DIFF_WORKER_POOL_HIDDEN_IDLE_TIMEOUT_MS
        : DIFF_WORKER_POOL_IDLE_TIMEOUT_MS,
    );
  };

  const get = (themeName: DiffThemeName): Pool => {
    if (pool === null) {
      pool = deps.create(themeName);
    }
    if (leaseCount === 0) {
      scheduleIdleTermination();
    }
    return pool;
  };

  return {
    get,
    acquire: (themeName) => {
      const leased = get(themeName);
      leaseCount += 1;
      cancelIdleTermination();
      let released = false;
      return {
        pool: leased,
        release: () => {
          if (released) return;
          released = true;
          leaseCount = Math.max(0, leaseCount - 1);
          if (leaseCount === 0) {
            scheduleIdleTermination();
          }
        },
      };
    },
    onVisibilityChange: () => {
      if (pool !== null && leaseCount === 0) {
        scheduleIdleTermination();
      }
    },
    peek: () => pool,
    dispose: () => {
      cancelIdleTermination();
      leaseCount = 0;
      terminatePool();
    },
  };
}
