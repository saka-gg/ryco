import type { WorktreeSetupSnapshot } from "@ryco/contracts";
import { create } from "zustand";

import type { WorktreeLaunch } from "./logic.ts";

/** Settled launches kept for views that still read their timing. */
const MAX_SETTLED_LAUNCHES = 16;

export interface WorktreeLaunchBeginInput {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly baseRef: string;
  readonly fetchOrigin: boolean;
  /** Defaults to now. */
  readonly startedAtMs?: number;
}

export interface WorktreeLaunchStore {
  readonly launchesByKey: Readonly<Record<string, WorktreeLaunch>>;
  /** Starts a launch, replacing a settled one of the same thread. */
  readonly begin: (input: WorktreeLaunchBeginInput) => void;
  readonly applySnapshot: (key: string, snapshot: WorktreeSetupSnapshot) => void;
  readonly markFeedUnavailable: (key: string) => void;
  readonly handOff: (key: string) => void;
  readonly fail: (key: string, error: string) => void;
  readonly requestCancel: (key: string) => void;
  readonly setInterruptOnStart: (key: string) => void;
  readonly clearInterruptOnStart: (key: string) => void;
  readonly remove: (key: string) => void;
}

const update = (
  launches: Readonly<Record<string, WorktreeLaunch>>,
  key: string,
  change: (launch: WorktreeLaunch) => WorktreeLaunch,
): Readonly<Record<string, WorktreeLaunch>> => {
  const current = launches[key];
  if (!current) return launches;
  const next = change(current);
  return next === current ? launches : { ...launches, [key]: next };
};

function pruneSettled(
  launches: Readonly<Record<string, WorktreeLaunch>>,
): Readonly<Record<string, WorktreeLaunch>> {
  const settled = Object.values(launches)
    .filter((launch) => launch.phase === "handed-off")
    .toSorted((a, b) => a.startedAtMs - b.startedAtMs);
  if (settled.length <= MAX_SETTLED_LAUNCHES) return launches;
  const next = { ...launches };
  for (const launch of settled.slice(0, settled.length - MAX_SETTLED_LAUNCHES)) {
    delete next[launch.key];
  }
  return next;
}

export const useWorktreeLaunchStore = create<WorktreeLaunchStore>((set) => ({
  launchesByKey: {},
  begin: (input) =>
    set((state) => {
      const startedAtMs = input.startedAtMs ?? Date.now();
      return {
        launchesByKey: pruneSettled({
          ...state.launchesByKey,
          [input.key]: {
            key: input.key,
            environmentId: input.environmentId,
            threadId: input.threadId,
            messageId: input.messageId,
            startedAt: new Date(startedAtMs).toISOString(),
            startedAtMs,
            baseRef: input.baseRef,
            fetchOrigin: input.fetchOrigin,
            phase: "preparing",
            snapshot: null,
            feedUnavailable: false,
            handedOffAtMs: null,
            error: null,
            interruptOnStart: false,
          },
        }),
      };
    }),
  applySnapshot: (key, snapshot) =>
    set((state) => ({
      launchesByKey: update(state.launchesByKey, key, (launch) =>
        launch.snapshot && launch.snapshot.sequence >= snapshot.sequence
          ? launch
          : { ...launch, snapshot },
      ),
    })),
  markFeedUnavailable: (key) =>
    set((state) => ({
      launchesByKey: update(state.launchesByKey, key, (launch) =>
        launch.feedUnavailable || launch.snapshot ? launch : { ...launch, feedUnavailable: true },
      ),
    })),
  handOff: (key) =>
    set((state) => ({
      launchesByKey: update(state.launchesByKey, key, (launch) =>
        launch.phase === "handed-off"
          ? launch
          : { ...launch, phase: "handed-off", handedOffAtMs: Date.now() },
      ),
    })),
  fail: (key, error) =>
    set((state) => ({
      launchesByKey: update(state.launchesByKey, key, (launch) => ({
        ...launch,
        phase: "failed",
        error,
      })),
    })),
  requestCancel: (key) =>
    set((state) => ({
      launchesByKey: update(state.launchesByKey, key, (launch) =>
        launch.phase === "preparing" ? { ...launch, phase: "cancelling" } : launch,
      ),
    })),
  setInterruptOnStart: (key) =>
    set((state) => ({
      launchesByKey: update(state.launchesByKey, key, (launch) =>
        launch.interruptOnStart ? launch : { ...launch, interruptOnStart: true },
      ),
    })),
  clearInterruptOnStart: (key) =>
    set((state) => ({
      launchesByKey: update(state.launchesByKey, key, (launch) =>
        launch.interruptOnStart ? { ...launch, interruptOnStart: false } : launch,
      ),
    })),
  remove: (key) =>
    set((state) => {
      if (!state.launchesByKey[key]) return state;
      const next = { ...state.launchesByKey };
      delete next[key];
      return { launchesByKey: next };
    }),
}));

export function readWorktreeLaunch(key: string): WorktreeLaunch | null {
  return useWorktreeLaunchStore.getState().launchesByKey[key] ?? null;
}
