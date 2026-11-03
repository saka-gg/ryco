// @effect-diagnostics globalDate:off
import type { EnvironmentId } from "@ryco/contracts";

import type { AppState, EnvironmentState } from "../threads/store.ts";
import { fullThreadEntry } from "../threads/types.ts";

/** How often an open, visible recap asks again on its own. */
export const DAILY_RECAP_POLL_MS = 5 * 60_000;
/** The least time between two refreshes that finished turns trigger. */
export const DAILY_RECAP_COMPLETION_REFRESH_MIN_MS = 20_000;
/** A recap at least this old asks again when its page comes back into view. */
export const DAILY_RECAP_FOCUS_STALE_MS = 60_000;

/**
 * Each live node's newest finished turn (its `completedAt` in epoch ms, or null
 * before its first), keyed by node. Nodes whose shell is not live are
 * absent: their turns finish unseen, so their entry would only move on a
 * reconnect.
 */
export type LatestTurnCompletions = Readonly<Record<EnvironmentId, number | null>>;

type ThreadSummaries = EnvironmentState["sidebarThreadSummaryById"];

function newestTurnCompletion(summaries: ThreadSummaries): number | null {
  let newest: number | null = null;
  for (const entry of Object.values(summaries)) {
    const turn = fullThreadEntry(entry)?.latestTurn;
    // A running turn may still carry the completion of the run it resumed.
    if (turn == null || turn.state === "running" || turn.completedAt === null) continue;
    const completedAt = Date.parse(turn.completedAt);
    if (Number.isFinite(completedAt) && (newest === null || completedAt > newest)) {
      newest = completedAt;
    }
  }
  return newest;
}

/**
 * A store selector of {@link LatestTurnCompletions}. It returns the same object
 * until some node's entry changes, and rescans a node's threads only when its
 * summaries changed, so it is cheap on every store update.
 */
export function createLatestTurnCompletionSelector(): (state: AppState) => LatestTurnCompletions {
  const newestBySummaries = new WeakMap<ThreadSummaries, number | null>();
  let last: LatestTurnCompletions = {};
  return (state) => {
    const next: Record<EnvironmentId, number | null> = {};
    let changed = false;
    let size = 0;
    for (const [environmentId, environmentState] of Object.entries(state.environmentStateById)) {
      if (!environmentState.bootstrapComplete) continue;
      const summaries = environmentState.sidebarThreadSummaryById;
      let newest = newestBySummaries.get(summaries);
      if (newest === undefined) {
        newest = newestTurnCompletion(summaries);
        newestBySummaries.set(summaries, newest);
      }
      const id = environmentId as EnvironmentId;
      next[id] = newest;
      size += 1;
      if (!Object.hasOwn(last, id) || last[id] !== newest) changed = true;
    }
    if (!changed && size === Object.keys(last).length) return last;
    last = next;
    return next;
  };
}

/**
 * The nodes in both snapshots whose newest finished turn moved later: their
 * recap misses it. A node that just went live is not among them (opening or
 * reconnecting asks it anyway), and neither is one whose newest turn went away.
 */
export function nodesWithNewTurnCompletions(
  previous: LatestTurnCompletions,
  next: LatestTurnCompletions,
): EnvironmentId[] {
  const moved: EnvironmentId[] = [];
  for (const [environmentId, newest] of Object.entries(next)) {
    const id = environmentId as EnvironmentId;
    if (newest === null || !Object.hasOwn(previous, id)) continue;
    const before = previous[id] ?? null;
    if (before === null || newest > before) moved.push(id);
  }
  return moved;
}

/**
 * How long a refresh for a finished turn must wait so that such refreshes run
 * at most every {@link DAILY_RECAP_COMPLETION_REFRESH_MIN_MS}: zero when the
 * last one (null: none yet) is at least that old.
 */
export function nextCompletionRefreshDelay(lastRefreshAtMs: number | null, nowMs: number): number {
  if (lastRefreshAtMs === null) return 0;
  return Math.max(0, lastRefreshAtMs + DAILY_RECAP_COMPLETION_REFRESH_MIN_MS - nowMs);
}
