import { useSyncExternalStore } from "react";

import { mobileKV } from "../platform/kv";

/**
 * When this device last saw each thread after it woke from snooze, by scoped
 * thread key. Mobile keeps no general per-thread visit record, so the Inbox's
 * "Woke" mark reads this one: a thread shows "Woke" until it is opened at or
 * after its wake (`isThreadWokeUnseen`). Device-local, like web's visit record.
 */
export type SnoozeWokeSeen = Readonly<Record<string, string>>;

const STORAGE_KEY = "ryco.snoozeWokeSeen";
/** The most recent wakes kept; an older one can only mark a thread that woke long ago. */
export const SNOOZE_WOKE_SEEN_LIMIT = 200;

const EMPTY: SnoozeWokeSeen = {};

/**
 * `seen` with `threadKey` seen at `wokeAt`, keeping the `limit` latest wakes.
 * The same object when that adds nothing: a wake is only ever seen later.
 */
export function recordSnoozeWokeSeen(
  seen: SnoozeWokeSeen,
  threadKey: string,
  wokeAt: string,
  limit: number = SNOOZE_WOKE_SEEN_LIMIT,
): SnoozeWokeSeen {
  const wokeAtMs = Date.parse(wokeAt);
  if (!Number.isFinite(wokeAtMs)) return seen;
  if (Date.parse(seen[threadKey] ?? "") >= wokeAtMs) return seen;
  const entries = Object.entries({ ...seen, [threadKey]: wokeAt })
    .toSorted((left, right) => Date.parse(right[1]) - Date.parse(left[1]))
    .slice(0, limit);
  return Object.fromEntries(entries);
}

/** Keeps the entries that are a key and a parseable time. */
export function sanitizeSnoozeWokeSeen(parsed: unknown): SnoozeWokeSeen {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY;
  let seen = EMPTY;
  for (const [threadKey, wokeAt] of Object.entries(parsed)) {
    if (typeof wokeAt === "string") seen = recordSnoozeWokeSeen(seen, threadKey, wokeAt);
  }
  return seen;
}

let state: SnoozeWokeSeen = EMPTY;
let hydration: "idle" | "loading" | "done" = "idle";
const listeners = new Set<() => void>();

function setState(next: SnoozeWokeSeen): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function persist(): void {
  // Before the saved marks are read, writing would drop them; hydration saves the merge.
  if (hydration !== "done") return;
  void mobileKV.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {
    // Best effort: an unsaved mark only shows "Woke" again after a restart.
  });
}

/** Reads the saved marks once; marks made meanwhile are kept. */
export function hydrateSnoozeWokeSeen(): void {
  if (hydration !== "idle") return;
  hydration = "loading";
  void mobileKV
    .getItem(STORAGE_KEY)
    .then((raw) => {
      let saved = EMPTY;
      try {
        saved = raw === null ? EMPTY : sanitizeSnoozeWokeSeen(JSON.parse(raw));
      } catch {
        saved = EMPTY;
      }
      let merged = saved;
      for (const [threadKey, wokeAt] of Object.entries(state)) {
        merged = recordSnoozeWokeSeen(merged, threadKey, wokeAt);
      }
      hydration = "done";
      setState(merged);
      if (merged !== saved) persist();
    })
    .catch(() => {
      hydration = "done";
    });
}

/** Records that the thread was seen after it woke at `wokeAt`. */
export function markSnoozeWokeSeen(threadKey: string, wokeAt: string): void {
  hydrateSnoozeWokeSeen();
  const next = recordSnoozeWokeSeen(state, threadKey, wokeAt);
  if (next === state) return;
  setState(next);
  persist();
}

export function getSnoozeWokeSeen(): SnoozeWokeSeen {
  return state;
}

function subscribe(listener: () => void): () => void {
  hydrateSnoozeWokeSeen();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSnoozeWokeSeen(): SnoozeWokeSeen {
  return useSyncExternalStore(subscribe, getSnoozeWokeSeen, getSnoozeWokeSeen);
}

export function resetSnoozeWokeSeenForTests(): void {
  state = EMPTY;
  hydration = "idle";
  listeners.clear();
}
