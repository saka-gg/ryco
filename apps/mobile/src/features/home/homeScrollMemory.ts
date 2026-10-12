import type { HomeMode } from "./homeMode";

/**
 * Where each Home list was scrolled to, kept outside React state.
 *
 * The offset is only read back as a list's `initialScrollOffset` when the list
 * remounts (switching modes, or a changed search/node filter re-keying it), so
 * holding it in state re-rendered Home — and rebuilt its models — on every
 * scroll event (~30/s). Offsets are remembered per mode *and* per filter key, so
 * a changed search or node scope starts at the top while the other mode keeps
 * its position, exactly as the reducer used to reset it.
 */
export interface HomeScrollMemory {
  readonly offsetFor: (mode: HomeMode, filterKey: string) => number;
  readonly record: (mode: HomeMode, filterKey: string, offset: number) => void;
}

export function createHomeScrollMemory(): HomeScrollMemory {
  const byMode = new Map<HomeMode, { readonly filterKey: string; readonly offset: number }>();
  return {
    offsetFor: (mode, filterKey) => {
      const entry = byMode.get(mode);
      return entry !== undefined && entry.filterKey === filterKey ? entry.offset : 0;
    },
    record: (mode, filterKey, offset) => {
      byMode.set(mode, { filterKey, offset: Math.max(0, offset) });
    },
  };
}

/** The key a Home list is mounted under: a new search or node scope remounts it at the top. */
export function homeListFilterKey(query: string, nodeScope: string | null): string {
  return JSON.stringify([query, nodeScope]);
}
