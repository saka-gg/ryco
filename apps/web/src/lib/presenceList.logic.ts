/**
 * Keyed list presence: items that leave stay rendered in an `exit` phase
 * (at their old position) until the caller drops them, and new items start in
 * an `enter` phase until settled. Pure; `usePresenceList` adds the timers.
 */

export type PresencePhase = "enter" | "present" | "exit";

export interface PresenceEntry<T> {
  readonly key: string;
  readonly item: T;
  readonly phase: PresencePhase;
}

export interface ReconcilePresenceOptions {
  /** New items start in `enter` (false: straight to `present`, e.g. the first render or reduced motion). */
  readonly animateEnter: boolean;
  /** Removed items linger in `exit` (false: dropped at once). */
  readonly keepExiting: boolean;
}

/**
 * Merges the next item list into the previous entries. Next items keep their
 * order and take their latest value; a removed item stays right after the
 * entry it followed before (or at the head), so exits collapse in place. An
 * item that comes back while exiting returns to `present`.
 */
export function reconcilePresence<T>(
  previous: ReadonlyArray<PresenceEntry<T>>,
  next: ReadonlyArray<T>,
  getKey: (item: T) => string,
  options: ReconcilePresenceOptions,
): ReadonlyArray<PresenceEntry<T>> {
  const nextKeys = new Set<string>();
  for (const item of next) nextKeys.add(getKey(item));

  // Exiting entries grouped by the nearest earlier entry that is still present.
  const exitsAfter = new Map<string | null, PresenceEntry<T>[]>();
  const previousPhase = new Map<string, PresencePhase>();
  if (options.keepExiting) {
    let anchor: string | null = null;
    for (const entry of previous) {
      previousPhase.set(entry.key, entry.phase);
      if (nextKeys.has(entry.key)) {
        anchor = entry.key;
        continue;
      }
      const group = exitsAfter.get(anchor) ?? [];
      group.push(entry.phase === "exit" ? entry : { ...entry, phase: "exit" });
      exitsAfter.set(anchor, group);
    }
  } else {
    for (const entry of previous) previousPhase.set(entry.key, entry.phase);
  }

  const result: PresenceEntry<T>[] = [...(exitsAfter.get(null) ?? [])];
  const emitted = new Set<string>();
  for (const item of next) {
    const key = getKey(item);
    if (emitted.has(key)) continue;
    emitted.add(key);
    const before = previousPhase.get(key);
    const phase: PresencePhase =
      before === undefined
        ? options.animateEnter
          ? "enter"
          : "present"
        : before === "exit"
          ? "present"
          : before;
    result.push({ key, item, phase });
    const exits = exitsAfter.get(key);
    if (exits) result.push(...exits);
  }
  return result;
}

/** Entering entries become present (after the enter state has painted). */
export function settlePresence<T>(
  entries: ReadonlyArray<PresenceEntry<T>>,
): ReadonlyArray<PresenceEntry<T>> {
  if (!entries.some((entry) => entry.phase === "enter")) return entries;
  return entries.map((entry) =>
    entry.phase === "enter" ? { ...entry, phase: "present" as const } : entry,
  );
}

/** Drops an entry whose exit has finished; a key that came back meanwhile is kept. */
export function dropExited<T>(
  entries: ReadonlyArray<PresenceEntry<T>>,
  key: string,
): ReadonlyArray<PresenceEntry<T>> {
  const index = entries.findIndex((entry) => entry.key === key && entry.phase === "exit");
  if (index === -1) return entries;
  return [...entries.slice(0, index), ...entries.slice(index + 1)];
}
