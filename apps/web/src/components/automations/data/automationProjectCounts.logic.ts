import type { AutomationCentreSnapshot, EnvironmentId, ProjectId } from "@ryco/contracts";
import { deriveScheduleRows, dueScheduleRuns } from "@ryco/client-runtime/state/agentControl";

import { projectCheckoutKey } from "../../../projectCheckouts.logic";

/** What the project switcher says about a project. */
export interface AutomationProjectCounts {
  /** The schedules the dialog lists, lapsed proposals aside. */
  readonly schedules: number;
  /** Runs waiting for approval. */
  readonly waiting: number;
}

/** One checkout's share of its project's counts, read off the dialog's own rows. */
export function checkoutAutomationCounts(input: {
  readonly projectId: ProjectId;
  readonly snapshot: AutomationCentreSnapshot;
  readonly nowMs: number;
}): AutomationProjectCounts {
  // Like the lab's switcher: lapsed proposals are the open dialog's business.
  const rows = deriveScheduleRows(input).filter((row) => row.state !== "lapsed");
  return { schedules: rows.length, waiting: dueScheduleRuns(rows).length };
}

export interface AutomationCheckoutRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export type AutomationCountsEntry =
  | {
      readonly status: "ready";
      readonly counts: AutomationProjectCounts;
      readonly fetchedAt: number;
    }
  /** The device was unreachable, or its server refused the read. */
  | { readonly status: "unavailable"; readonly fetchedAt: number };

/**
 * A project's counts from its checkouts' entries: the sum of what is known,
 * or null while no checkout has answered yet.
 */
export function projectAutomationCounts(
  checkouts: readonly AutomationCheckoutRef[],
  entries: ReadonlyMap<string, AutomationCountsEntry>,
): AutomationProjectCounts | null {
  let known = false;
  let schedules = 0;
  let waiting = 0;
  for (const checkout of checkouts) {
    const entry = entries.get(projectCheckoutKey(checkout.environmentId, checkout.projectId));
    if (entry?.status !== "ready") continue;
    known = true;
    schedules += entry.counts.schedules;
    waiting += entry.counts.waiting;
  }
  return known ? { schedules, waiting } : null;
}

/** Everything the loader knows, replaced as a whole on every change. */
export interface AutomationCountsState {
  /** By `projectCheckoutKey`. */
  readonly entries: ReadonlyMap<string, AutomationCountsEntry>;
  /** A read is in flight. */
  readonly loading: boolean;
}

export interface AutomationCountsLoader {
  /** Reads every checkout with no entry, or one older than `maxAgeMs`, that is not already being read. */
  readonly request: (
    checkouts: readonly AutomationCheckoutRef[],
    options?: { readonly maxAgeMs?: number },
  ) => void;
  /** Drops the reads in flight: their answers are ignored and the next request reads again. */
  readonly cancel: () => void;
  readonly getState: () => AutomationCountsState;
  readonly subscribe: (listener: () => void) => () => void;
}

export const AUTOMATION_COUNTS_MAX_AGE_MS = 60_000;

/**
 * One-shot reads of checkouts' automation snapshots, kept as counts. Not a
 * live subscription: a switcher asks when it opens, and an answer younger
 * than `maxAgeMs` is reused.
 */
export function createAutomationCountsLoader(input: {
  /** One read of a checkout's snapshot, or null when the device has no reader. */
  readonly readSnapshot: (
    checkout: AutomationCheckoutRef,
  ) => Promise<AutomationCentreSnapshot> | null;
  readonly now?: () => number;
}): AutomationCountsLoader {
  const now = input.now ?? Date.now;
  let state: AutomationCountsState = { entries: new Map(), loading: false };
  let generation = 0;
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  const publish = (entries: ReadonlyMap<string, AutomationCountsEntry>) => {
    const loading = inFlight.size > 0;
    if (entries === state.entries && loading === state.loading) return;
    state = { entries, loading };
    for (const listener of listeners) listener();
  };
  const withEntry = (key: string, entry: AutomationCountsEntry) => {
    const next = new Map(state.entries);
    next.set(key, entry);
    return next;
  };
  const settle = (key: string, epoch: number, entry: AutomationCountsEntry) => {
    if (epoch !== generation) return;
    inFlight.delete(key);
    publish(withEntry(key, entry));
  };

  return {
    request: (checkouts, options) => {
      const maxAgeMs = options?.maxAgeMs ?? AUTOMATION_COUNTS_MAX_AGE_MS;
      const epoch = generation;
      let entries = state.entries;
      for (const checkout of checkouts) {
        const key = projectCheckoutKey(checkout.environmentId, checkout.projectId);
        const entry = entries.get(key);
        if (inFlight.has(key) || (entry && now() - entry.fetchedAt < maxAgeMs)) continue;
        let read: Promise<AutomationCentreSnapshot> | null;
        try {
          read = input.readSnapshot(checkout);
        } catch {
          read = null;
        }
        if (!read) {
          const next = new Map(entries);
          next.set(key, { status: "unavailable", fetchedAt: now() });
          entries = next;
          continue;
        }
        inFlight.add(key);
        read.then(
          (snapshot) =>
            settle(key, epoch, {
              status: "ready",
              counts: checkoutAutomationCounts({
                projectId: checkout.projectId,
                snapshot,
                nowMs: now(),
              }),
              fetchedAt: now(),
            }),
          () => settle(key, epoch, { status: "unavailable", fetchedAt: now() }),
        );
      }
      publish(entries);
    },
    cancel: () => {
      if (inFlight.size === 0) return;
      generation += 1;
      inFlight.clear();
      publish(state.entries);
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
