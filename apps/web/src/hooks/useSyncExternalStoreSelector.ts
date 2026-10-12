import { useMemo, useSyncExternalStore } from "react";

/**
 * Builds a `getSnapshot` for `useSyncExternalStore` that applies `selector`
 * once per store snapshot and keeps the previous selection while `isEqual`
 * holds, so React sees a stable value and skips the re-render.
 */
function createSelectionReader<Snapshot, Selection>(
  getSnapshot: () => Snapshot,
  selector: (snapshot: Snapshot) => Selection,
  isEqual: (left: Selection, right: Selection) => boolean,
): () => Selection {
  let memoized: { readonly snapshot: Snapshot; readonly selection: Selection } | null = null;
  return () => {
    const snapshot = getSnapshot();
    if (memoized !== null && Object.is(memoized.snapshot, snapshot)) {
      return memoized.selection;
    }
    const nextSelection = selector(snapshot);
    const selection =
      memoized !== null && isEqual(memoized.selection, nextSelection)
        ? memoized.selection
        : nextSelection;
    memoized = { snapshot, selection };
    return selection;
  };
}

/**
 * `useSyncExternalStore` with a selector: the component re-renders only when
 * the selected value changes under `isEqual` (Object.is by default), not on
 * every store notification. Pass a stable (module-level or memoized) selector;
 * an inline selector still works but recomputes on every render.
 *
 * `getSnapshot` must return the same value while the store is unchanged.
 */
export function useSyncExternalStoreSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  selector: (snapshot: Snapshot) => Selection,
  isEqual: (left: Selection, right: Selection) => boolean = Object.is,
): Selection {
  const getSelection = useMemo(
    () => createSelectionReader(getSnapshot, selector, isEqual),
    [getSnapshot, selector, isEqual],
  );
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}
