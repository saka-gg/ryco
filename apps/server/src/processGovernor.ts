/**
 * Process-wide admission control for short-lived git and forge CLI children.
 *
 * Every git, gh, glab and az child the server spawns goes through one pool per
 * kind. Work runs in one of two lanes:
 *
 * - `interactive` (the default): the focused thread's surfaces and RPCs a user
 *   issued. Admitted immediately, always; it only counts toward the pool.
 * - `background`: sidebar and sweep refreshes, worktree discovery, reconcile.
 *   Admitted only while the pool has room, so a burst of background work
 *   queues (first come, first served) instead of launching hundreds of
 *   children, and it yields to interactive work, which takes room first.
 *
 * A permit covers exactly one child's lifetime (spawn to exit or timeout), so
 * holding one never waits on another and the pools cannot deadlock.
 */
import os from "node:os";

import { Context, Duration, Effect, Metric } from "effect";

export type ProcessLane = "interactive" | "background";
export type ProcessPoolName = "git" | "forge";

/**
 * The lane child processes started by the current fiber run in. Wrap
 * background work with {@link inBackgroundProcessLane}; everything else is
 * interactive.
 */
export const ProcessLaneRef = Context.Reference<ProcessLane>("ryco/process/ProcessLane", {
  defaultValue: () => "interactive",
});

export const inBackgroundProcessLane = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.provideService(effect, ProcessLaneRef, "background");

export const GIT_PROCESS_LIMIT = Math.min(8, Math.max(2, os.availableParallelism?.() ?? 4));
export const FORGE_PROCESS_LIMIT = 4;

const FORGE_COMMANDS = new Set(["gh", "glab", "az"]);

/** Which pool governs a command, by executable basename; null for anything else. */
export function processPoolForCommand(command: string): ProcessPoolName | null {
  const base = command
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(exe|cmd|bat)$/i, "")
    .toLowerCase();
  if (!base) return null;
  if (base === "git") return "git";
  return FORGE_COMMANDS.has(base) ? "forge" : null;
}

export interface ProcessPoolStats {
  readonly pool: ProcessPoolName;
  readonly limit: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly admittedTotal: number;
  readonly queuedTotal: number;
  readonly maxQueueWaitMs: number;
}

interface Waiter {
  readonly grant: () => void;
}

export interface ProcessPermitRequest {
  /** Withdraws a queued request, or releases the permit if it was already granted. */
  readonly cancel: () => void;
}

export class ProcessPool {
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];
  private admittedTotal = 0;
  private queuedTotal = 0;
  private maxQueueWaitMs = 0;

  readonly name: ProcessPoolName;
  readonly limit: number;
  private readonly now: () => number;

  constructor(name: ProcessPoolName, limit: number, now: () => number = Date.now) {
    this.name = name;
    this.limit = limit;
    this.now = now;
  }

  /**
   * Requests a permit. `onGranted` runs synchronously when the permit is free
   * now, otherwise once a background slot opens. The release it receives is
   * idempotent.
   */
  request(
    lane: ProcessLane,
    onGranted: (release: () => void, queueWaitMs: number) => void,
  ): ProcessPermitRequest {
    let release: (() => void) | null = null;
    let withdrawn = false;
    const grant = (enqueuedAtMs: number) => {
      const queueWaitMs = Math.max(0, this.now() - enqueuedAtMs);
      this.maxQueueWaitMs = Math.max(this.maxQueueWaitMs, queueWaitMs);
      this.inFlight += 1;
      this.admittedTotal += 1;
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
        this.drain();
      };
      onGranted(release, queueWaitMs);
    };

    const enqueuedAtMs = this.now();
    if (lane === "interactive" || (this.waiters.length === 0 && this.inFlight < this.limit)) {
      grant(enqueuedAtMs);
    } else {
      this.queuedTotal += 1;
      const waiter: Waiter = {
        grant: () => {
          if (!withdrawn) grant(enqueuedAtMs);
        },
      };
      this.waiters.push(waiter);
      return {
        cancel: () => {
          withdrawn = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          release?.();
        },
      };
    }
    return { cancel: () => release?.() };
  }

  stats(): ProcessPoolStats {
    return {
      pool: this.name,
      limit: this.limit,
      inFlight: this.inFlight,
      queued: this.waiters.length,
      admittedTotal: this.admittedTotal,
      queuedTotal: this.queuedTotal,
      maxQueueWaitMs: this.maxQueueWaitMs,
    };
  }

  private drain(): void {
    while (this.inFlight < this.limit) {
      const next = this.waiters.shift();
      if (!next) return;
      next.grant();
    }
  }
}

const pools: Record<ProcessPoolName, ProcessPool> = {
  git: new ProcessPool("git", GIT_PROCESS_LIMIT),
  forge: new ProcessPool("forge", FORGE_PROCESS_LIMIT),
};

export function processGovernorStats(): ReadonlyArray<ProcessPoolStats> {
  return [pools.git.stats(), pools.forge.stats()];
}

const processQueueWaitDuration = Metric.timer("ryco_process_governor_queue_wait_duration", {
  description: "Time background child processes waited for a governor permit.",
});

const acquirePermit = (pool: ProcessPool, lane: ProcessLane) =>
  Effect.callback<{ readonly release: () => void; readonly queueWaitMs: number }>((resume) => {
    const request = pool.request(lane, (release, queueWaitMs) =>
      resume(Effect.succeed({ release, queueWaitMs })),
    );
    return Effect.sync(request.cancel);
  });

/**
 * Runs `effect` — the full lifetime of one `command` child — under its pool's
 * permit, in the current fiber's lane. Commands outside the governed pools run
 * unchanged. Queue time is not part of the child's own timeout.
 */
export const governChildProcess = <A, E, R>(
  command: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const poolName = processPoolForCommand(command);
  if (poolName === null) return effect;
  const pool = pools[poolName];
  return Effect.flatMap(ProcessLaneRef, (lane) =>
    Effect.uninterruptibleMask((restore) =>
      restore(acquirePermit(pool, lane)).pipe(
        Effect.flatMap((permit) =>
          (permit.queueWaitMs > 0
            ? Metric.update(
                Metric.withAttributes(processQueueWaitDuration, { pool: poolName, lane }),
                Duration.millis(permit.queueWaitMs),
              ).pipe(Effect.andThen(restore(effect)))
            : restore(effect)
          ).pipe(Effect.ensuring(Effect.sync(permit.release))),
        ),
      ),
    ),
  );
};

/** Promise counterpart of {@link governChildProcess} for non-Effect spawners. */
export async function governChildProcessPromise<A>(
  command: string,
  lane: ProcessLane,
  run: () => Promise<A>,
): Promise<A> {
  const poolName = processPoolForCommand(command);
  if (poolName === null) return run();
  const release = await new Promise<() => void>((resolve) => {
    pools[poolName].request(lane, (granted) => resolve(granted));
  });
  try {
    return await run();
  } finally {
    release();
  }
}
