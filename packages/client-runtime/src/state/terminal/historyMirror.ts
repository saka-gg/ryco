import type { TerminalCursor, TerminalEvent, TerminalSessionSnapshot } from "@ryco/contracts";

import { isTerminalSnapshotDeltaFor } from "./reconciliation.ts";

/** What a surface shows of one terminal: its scrollback up to `cursor`. */
export interface TerminalHistoryMirror {
  readonly cursor: TerminalCursor;
  readonly history: string;
}

export interface TerminalHistoryMirrorCacheOptions {
  /** Terminals kept; the least recently used goes first. */
  readonly maxEntries: number;
  /**
   * UTF-16 units of scrollback kept per terminal; the head is dropped once it grows a quarter
   * past it.
   */
  readonly maxHistoryUnits: number;
  /** UTF-16 units kept across all terminals. */
  readonly maxTotalUnits: number;
}

/** The last `maxUnits` units of `history`, never starting inside a surrogate pair. */
function keepTail(history: string, maxUnits: number): string {
  if (history.length <= maxUnits) return history;
  let start = history.length - maxUnits;
  const first = history.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return history.slice(start);
}

/**
 * A client's copy of the scrollback its terminal surfaces showed, kept after they close, so the
 * next open asks `terminal.open` with `sinceCursor` and downloads only what came after instead of
 * up to 2 MiB of history. Memory only and bounded; a terminal it does not hold, or one whose
 * answer is not a delta for the cursor it asked with, simply hydrates from the full answer.
 *
 * It must follow exactly what the surface shows: the hydration answer, then each output it
 * applied, a clear, a restart.
 */
export function createTerminalHistoryMirrorCache(options: TerminalHistoryMirrorCacheOptions) {
  // Insertion-ordered: the first entry is the least recently used.
  const entries = new Map<string, TerminalHistoryMirror>();
  let totalUnits = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalUnits -= entry.history.length;
  };
  const store = (key: string, mirror: TerminalHistoryMirror) => {
    remove(key);
    // Trimmed in steps, not on every append: slicing flattens the string.
    const history =
      mirror.history.length > options.maxHistoryUnits * 1.25
        ? keepTail(mirror.history, options.maxHistoryUnits)
        : mirror.history;
    const kept = { cursor: mirror.cursor, history };
    entries.set(key, kept);
    totalUnits += kept.history.length;
    for (const oldest of entries.keys()) {
      if (entries.size <= options.maxEntries && totalUnits <= options.maxTotalUnits) break;
      if (oldest === key) continue;
      remove(oldest);
    }
  };

  return {
    /** The cursor to open `key` with, when this client still holds what it showed. */
    cursorFor(key: string): TerminalCursor | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      // Touch: a terminal opened again is the most recently used.
      entries.delete(key);
      entries.set(key, entry);
      return entry.cursor;
    },
    /**
     * Records a hydration answer and returns the scrollback the surface shows from it: the kept
     * history with the delta appended when the answer is a delta for `sinceCursor`, else the
     * answer's own history. `null` for a delta whose base is no longer kept (evicted meanwhile):
     * open again without a cursor.
     */
    hydrate(
      key: string,
      snapshot: Pick<TerminalSessionSnapshot, "history" | "cursor" | "historySince">,
      sinceCursor: TerminalCursor | undefined,
    ): string | null {
      const previous = entries.get(key);
      if (isTerminalSnapshotDeltaFor(snapshot, sinceCursor)) {
        // A delta appends to exactly what was kept at `sinceCursor`, or it cannot be shown.
        if (
          previous === undefined ||
          previous.cursor.generation !== sinceCursor?.generation ||
          previous.cursor.sequence !== sinceCursor.sequence
        ) {
          remove(key);
          return null;
        }
      }
      const delta = previous !== undefined && isTerminalSnapshotDeltaFor(snapshot, sinceCursor);
      const history = delta ? previous.history + snapshot.history : snapshot.history;
      if (snapshot.cursor) store(key, { cursor: snapshot.cursor, history });
      else remove(key);
      return entries.get(key)?.history ?? history;
    },
    /** Follows an event the surface applied on top of its hydration. */
    apply(key: string, event: TerminalEvent): void {
      if (event.type === "started" || event.type === "restarted") {
        if (event.snapshot.cursor) {
          store(key, { cursor: event.snapshot.cursor, history: event.snapshot.history });
        } else remove(key);
        return;
      }
      if (event.type !== "output" && event.type !== "cleared") return;
      const entry = entries.get(key);
      if (!entry) return;
      const cursor = event.cursor;
      if (!cursor || cursor.generation !== entry.cursor.generation) {
        remove(key);
        return;
      }
      if (cursor.sequence <= entry.cursor.sequence) return;
      store(key, {
        cursor,
        history: event.type === "cleared" ? "" : entry.history + event.data,
      });
    },
    delete(key: string): void {
      remove(key);
    },
    /** Drops every kept terminal `keep` rejects (threads that were archived or removed). */
    prune(keep: (key: string) => boolean): void {
      for (const key of [...entries.keys()]) if (!keep(key)) remove(key);
    },
    size(): number {
      return entries.size;
    },
  };
}

export type TerminalHistoryMirrorCache = ReturnType<typeof createTerminalHistoryMirrorCache>;
