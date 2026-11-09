import type { AutomationCentreSnapshot, EnvironmentId, ProjectId } from "@ryco/contracts";
import { deriveScheduleRows, dueScheduleRuns } from "../agentControl/index.ts";

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

/** The key of one project's checkout on one device (the same as the web's `projectCheckoutKey`). */
export function automationCheckoutKey(environmentId: string, projectId: string): string {
  return `${environmentId}\0${projectId}`;
}

export interface AutomationCheckoutRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export type AutomationCountsEntry =
  | {
      readonly status: "ready";
      /** The snapshot as read (the phone's Scheduled list derives its rows from it). */
      readonly snapshot: AutomationCentreSnapshot;
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
    const entry = entries.get(automationCheckoutKey(checkout.environmentId, checkout.projectId));
    if (entry?.status !== "ready") continue;
    known = true;
    schedules += entry.counts.schedules;
    waiting += entry.counts.waiting;
  }
  return known ? { schedules, waiting } : null;
}

/** Everything the loader knows, replaced as a whole on every change. */
export interface AutomationCountsState {
  /** By `automationCheckoutKey`. */
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
  /** Checkouts asked for afresh (`maxAgeMs: 0`) while being read: read once more after. */
  const again = new Map<string, AutomationCheckoutRef>();
  const listeners = new Set<() => void>();
  const publish = (entries: ReadonlyMap<string, AutomationCountsEntry>) => {
    const loading = inFlight.size > 0;
    if (entries === state.entries && loading === state.loading) return;
    state = { entries, loading };
    for (const listener of listeners) listener();
  };
  const withEntry = (
    entries: ReadonlyMap<string, AutomationCountsEntry>,
    key: string,
    entry: AutomationCountsEntry,
  ) => {
    const next = new Map(entries);
    next.set(key, entry);
    return next;
  };
  /** Starts a read; returns the entries with an "unavailable" entry when none could start. */
  const read = (
    checkout: AutomationCheckoutRef,
    key: string,
    epoch: number,
    entries: ReadonlyMap<string, AutomationCountsEntry>,
  ): ReadonlyMap<string, AutomationCountsEntry> => {
    let snapshotRead: Promise<AutomationCentreSnapshot> | null;
    try {
      snapshotRead = input.readSnapshot(checkout);
    } catch {
      snapshotRead = null;
    }
    if (!snapshotRead) return withEntry(entries, key, { status: "unavailable", fetchedAt: now() });
    inFlight.add(key);
    snapshotRead.then(
      (snapshot) =>
        settle(checkout, key, epoch, {
          status: "ready",
          snapshot,
          counts: checkoutAutomationCounts({
            projectId: checkout.projectId,
            snapshot,
            nowMs: now(),
          }),
          fetchedAt: now(),
        }),
      () => settle(checkout, key, epoch, { status: "unavailable", fetchedAt: now() }),
    );
    return entries;
  };
  const settle = (
    checkout: AutomationCheckoutRef,
    key: string,
    epoch: number,
    entry: AutomationCountsEntry,
  ) => {
    if (epoch !== generation) return;
    inFlight.delete(key);
    let entries: ReadonlyMap<string, AutomationCountsEntry> = withEntry(state.entries, key, entry);
    if (again.delete(key)) entries = read(checkout, key, epoch, entries);
    publish(entries);
  };

  return {
    request: (checkouts, options) => {
      const maxAgeMs = options?.maxAgeMs ?? AUTOMATION_COUNTS_MAX_AGE_MS;
      const epoch = generation;
      let entries = state.entries;
      for (const checkout of checkouts) {
        const key = automationCheckoutKey(checkout.environmentId, checkout.projectId);
        if (inFlight.has(key)) {
          // What changed may have landed after the read in flight began.
          if (maxAgeMs <= 0) again.set(key, checkout);
          continue;
        }
        const entry = entries.get(key);
        if (entry && now() - entry.fetchedAt < maxAgeMs) continue;
        entries = read(checkout, key, epoch, entries);
      }
      publish(entries);
    },
    cancel: () => {
      if (inFlight.size === 0) return;
      generation += 1;
      inFlight.clear();
      again.clear();
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
