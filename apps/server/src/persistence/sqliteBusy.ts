/**
 * Lock-wait policy for the server's SQLite connections.
 *
 * `node:sqlite` is synchronous, so SQLite's busy handler sleeps on the calling
 * thread. With `busy_timeout = 5000` on the main connection, a write lock held
 * by another process (the offline CLI) froze the event loop for up to 5 s:
 * WebSocket heartbeats, provider streams and every RPC stalled with it. The
 * main connection now waits only {@link MAIN_CONNECTION_BUSY_TIMEOUT_MS}
 * synchronously and retries a busy statement asynchronously with backoff, for
 * the same total budget, so the loop keeps running while it waits.
 *
 * Kept free of `node:sqlite` imports: the runtime layer loads the driver
 * lazily, and Bun uses its own client.
 *
 * @module sqliteBusy
 */

/** Synchronous busy wait per attempt on the main-thread connection. */
export const MAIN_CONNECTION_BUSY_TIMEOUT_MS = 25;
/** Total time a busy statement keeps retrying, the previous synchronous `busy_timeout`. */
export const BUSY_RETRY_BUDGET_MS = 5_000;
/** Busy timeout for drivers without async retry (Bun) and for off-thread readers. */
export const BLOCKING_BUSY_TIMEOUT_MS = 5_000;

const SQLITE_BUSY = 5;
/**
 * A WAL read snapshot went stale before the transaction's first write. SQLite
 * returns it without invoking the busy handler and the statement can never
 * succeed in this transaction, so retrying it only burns the budget.
 */
const SQLITE_BUSY_SNAPSHOT = 517;

/** True for SQLITE_BUSY (and its extended codes) that waiting can resolve. */
export function isRetryableSqliteBusy(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const errcode = (cause as { readonly errcode?: unknown }).errcode;
  if (typeof errcode !== "number") return false;
  return (errcode & 0xff) === SQLITE_BUSY && errcode !== SQLITE_BUSY_SNAPSHOT;
}

/** Backoff before retry `attempt` (0-based): 5, 10, 20, 40, 80, then 100 ms. */
export function busyRetryDelayMs(attempt: number): number {
  return Math.min(100, 5 * 2 ** Math.min(attempt, 5));
}
