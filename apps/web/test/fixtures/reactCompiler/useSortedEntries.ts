import { useMemo } from "react";

const DIRECTIONS = ["asc", "desc"] as const;
type Direction = (typeof DIRECTIONS)[number];

/** A generic hook in a `.ts` module: TypeScript syntax without JSX. */
export function useSortedEntries<T extends { readonly key: string }>(
  entries: ReadonlyArray<T>,
  direction: Direction,
): ReadonlyArray<T> {
  const sorted = useMemo(() => {
    const copy = [...entries];
    copy.sort((left, right) => left.key.localeCompare(right.key));
    return direction === "asc" ? copy : copy.toReversed();
  }, [entries, direction]);
  return sorted satisfies ReadonlyArray<T>;
}

export function isDirection(value: string): value is Direction {
  return (DIRECTIONS as ReadonlyArray<string>).includes(value);
}
