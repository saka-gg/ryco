import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Comfortably past the 360ms entrance, so a row that re-renders mid-way keeps its animation. */
const ENTER_CLEAR_MS = 600;
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The tasks that just appeared, which play the row entrance. Every id
 * present when the list first shows, or when `baselineKey` changes (a new
 * filter), counts as already there, so only tasks added afterwards animate.
 * `baselineKey` is `null` while the list is loading. Ids are marked before
 * the first paint, so a new row never flashes in at rest first.
 */
export function useEnteringTaskIds(
  ids: ReadonlyArray<string>,
  baselineKey: string | null,
): ReadonlySet<string> {
  const knownRef = useRef<Set<string>>(new Set());
  const baselineRef = useRef<string | null>(null);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [entering, setEntering] = useState<ReadonlySet<string>>(NO_IDS);

  // `ids` should be memoized by the caller: this runs whenever its identity changes.
  useLayoutEffect(() => {
    if (baselineKey === null) return;
    const known = knownRef.current;
    const fresh = baselineRef.current === baselineKey ? ids.filter((id) => !known.has(id)) : [];
    baselineRef.current = baselineKey;
    for (const id of ids) known.add(id);
    if (fresh.length === 0) return;
    setEntering((previous) => new Set([...previous, ...fresh]));
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setEntering((previous) => {
        const next = new Set(previous);
        for (const id of fresh) next.delete(id);
        return next.size === 0 ? NO_IDS : next;
      });
    }, ENTER_CLEAR_MS);
    timersRef.current.add(timer);
  }, [ids, baselineKey]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return entering;
}
