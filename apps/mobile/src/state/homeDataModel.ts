import { sameRecordIgnoring } from "../lib/recordEquality";

/**
 * How far a thread's `updatedAt` may move before Home takes its new summary. Home's clock ticks
 * every 30 s and its rows show minutes, so a streamed reply (which moves `updatedAt` a few times
 * a second) does not rebuild the inbox for a change the list would not show.
 */
export const HOME_SUMMARY_UPDATED_AT_TOLERANCE_MS = 30_000;

const UPDATED_AT: ReadonlySet<string> = new Set(["updatedAt"]);

interface SummaryRow {
  readonly environmentId: string;
  readonly id: string;
  readonly updatedAt?: string | null | undefined;
}

function updatedAtWithin(previous: SummaryRow, next: SummaryRow, toleranceMs: number): boolean {
  if (previous.updatedAt === next.updatedAt) return true;
  if (!previous.updatedAt || !next.updatedAt) return false;
  const distance = Math.abs(Date.parse(next.updatedAt) - Date.parse(previous.updatedAt));
  return Number.isFinite(distance) && distance < toleranceMs;
}

/**
 * Keeps each thread summary's previous object while it differs only by an `updatedAt` that moved
 * less than the tolerance, so a shallow-compared selection of all threads stays the same array
 * and Home neither re-renders nor rebuilds its inbox while a reply streams. One per subscriber.
 */
export function createHomeSummaryStabilizer<T extends SummaryRow>(
  toleranceMs = HOME_SUMMARY_UPDATED_AT_TOLERANCE_MS,
): (rows: ReadonlyArray<T>) => ReadonlyArray<T> {
  let previous = new Map<string, T>();
  return (rows) => {
    const next = new Map<string, T>();
    const stable = rows.map((row) => {
      const key = `${row.environmentId}\u0000${row.id}`;
      const before = previous.get(key);
      const kept =
        before !== undefined &&
        before !== row &&
        updatedAtWithin(before, row, toleranceMs) &&
        sameRecordIgnoring(before, row, UPDATED_AT)
          ? before
          : row;
      next.set(key, kept);
      return kept;
    });
    previous = next;
    return stable;
  };
}
