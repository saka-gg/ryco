import { TurnId } from "@ryco/contracts/base-schemas";

/**
 * Where a reader left each thread's transcript, so returning to a thread opens
 * it there. A thread left at its end keeps no entry: it reopens at its end and
 * follows live output, which is also what an unknown thread does, and it cannot
 * push a remembered spot in another thread out of the memory.
 *
 * A spot away from the end is a row anchor rather than a pixel offset: rows
 * above it change height between visits (folds, lazily loaded history, media
 * measuring late), and an offset from the top would land on another row.
 */

/** Threads remembered away from their end; the least recently left goes first. */
export const THREAD_READING_POSITION_CAPACITY = 100;
/** Longest row or turn id a saved anchor may carry. */
const THREAD_READING_ANCHOR_MAX_ID_LENGTH = 512;
/** Largest offset into its row a saved anchor may carry, in pixels. */
const THREAD_READING_ANCHOR_MAX_OFFSET = 1_000_000;

/** The row at the top of the viewport, and how far into it the viewport starts. */
export interface ThreadReadingAnchor {
  readonly rowId: string;
  /** Pixels from the row's top down to the viewport's top; negative when the row starts lower. */
  readonly offsetWithinRow: number;
  /**
   * The turn holding the row when the view had watched it run. A watched turn
   * keeps its outline open, and a fresh load folds it; reopening keeps this one
   * open so the row is still there, after a reload too.
   */
  readonly turnId?: TurnId | undefined;
}

/** An anchor as saved, with when it was last left: it orders anchors read back from several records. */
export interface SavedThreadReadingAnchor extends ThreadReadingAnchor {
  /** Milliseconds since the epoch. */
  readonly leftAt: number;
}

/** A remembered anchor plus view state that only lives in memory, never in storage. */
export interface RememberedThreadReadingAnchor extends ThreadReadingAnchor {
  /**
   * Turns the view saw running. They keep their outline open once settled, so
   * an anchor inside one is still a row when the thread is shown again.
   */
  readonly watchedTurnIds: ReadonlySet<TurnId>;
}

interface Entry {
  rowId: string;
  offsetWithinRow: number;
  turnId: TurnId | undefined;
  leftAt: number;
  watchedTurnIds: ReadonlySet<TurnId>;
}

const NO_WATCHED_TURNS: ReadonlySet<TurnId> = new Set();

export interface ThreadReadingPositionMemory {
  /** The anchor `threadKey` was left at, or null when it was left at its end (or never shown). */
  read(threadKey: string): RememberedThreadReadingAnchor | null;
  /**
   * Remembers `threadKey` left away from its end. Runs on every scroll event,
   * so an unchanged anchor allocates nothing; it still counts as the most
   * recent visit. Returns whether the row, offset or turn changed.
   */
  rememberAnchor(
    threadKey: string,
    anchor: ThreadReadingAnchor,
    watchedTurnIds?: ReadonlySet<TurnId>,
  ): boolean;
  /** Remembers `threadKey` left at its end. Returns whether that dropped an anchor. */
  rememberAtEnd(threadKey: string): boolean;
  /**
   * Adds saved anchors, ordered with the remembered ones by when each was
   * left; one already in memory was left in this session and stays. Pass every
   * record's anchors at once or one record at a time: the result is the same.
   */
  restore(anchors: Iterable<readonly [string, SavedThreadReadingAnchor]>): void;
  /** Visits every anchor, least recently left first. An anchor is only valid during its callback. */
  forEach(visit: (threadKey: string, anchor: SavedThreadReadingAnchor) => void): void;
  /** Drops the anchors whose thread key matches. */
  forget(matches: (threadKey: string) => boolean): void;
  clear(): void;
}

export function createThreadReadingPositionMemory(
  capacity: number = THREAD_READING_POSITION_CAPACITY,
  now: () => number = Date.now,
): ThreadReadingPositionMemory {
  // Insertion order is recency: a visit moves its entry last, eviction takes the first.
  const entries = new Map<string, Entry>();
  // Stamps never go backwards, so insertion order and `leftAt` agree even
  // when the clock does, or a saved anchor was stamped ahead of it.
  let latestStamp = 0;
  const stamp = () => {
    latestStamp = Math.max(latestStamp, now());
    return latestStamp;
  };
  const touch = (threadKey: string, entry: Entry) => {
    entry.leftAt = stamp();
    entries.delete(threadKey);
    entries.set(threadKey, entry);
  };
  const evict = () => {
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  };
  return {
    read(threadKey) {
      const entry = entries.get(threadKey);
      return entry
        ? {
            rowId: entry.rowId,
            offsetWithinRow: entry.offsetWithinRow,
            turnId: entry.turnId,
            watchedTurnIds: entry.watchedTurnIds,
          }
        : null;
    },
    rememberAnchor(threadKey, anchor, watchedTurnIds = NO_WATCHED_TURNS) {
      const entry = entries.get(threadKey);
      if (entry) {
        touch(threadKey, entry);
        entry.watchedTurnIds = watchedTurnIds;
        if (
          entry.rowId === anchor.rowId &&
          entry.offsetWithinRow === anchor.offsetWithinRow &&
          entry.turnId === anchor.turnId
        ) {
          return false;
        }
        entry.rowId = anchor.rowId;
        entry.offsetWithinRow = anchor.offsetWithinRow;
        entry.turnId = anchor.turnId;
        return true;
      }
      entries.set(threadKey, {
        rowId: anchor.rowId,
        offsetWithinRow: anchor.offsetWithinRow,
        turnId: anchor.turnId,
        leftAt: stamp(),
        watchedTurnIds,
      });
      evict();
      return true;
    },
    rememberAtEnd(threadKey) {
      return entries.delete(threadKey);
    },
    restore(anchors) {
      const merged = new Map(entries);
      for (const [threadKey, anchor] of anchors) {
        if (merged.has(threadKey)) continue;
        merged.set(threadKey, {
          rowId: anchor.rowId,
          offsetWithinRow: anchor.offsetWithinRow,
          turnId: anchor.turnId,
          leftAt: anchor.leftAt,
          watchedTurnIds: NO_WATCHED_TURNS,
        });
        latestStamp = Math.max(latestStamp, anchor.leftAt);
      }
      // A stable sort: anchors left in the same millisecond keep their order.
      const ordered = Array.from(merged).toSorted(
        (left, right) => left[1].leftAt - right[1].leftAt,
      );
      entries.clear();
      for (const [threadKey, entry] of ordered) entries.set(threadKey, entry);
      evict();
    },
    forEach(visit) {
      for (const [threadKey, entry] of entries) visit(threadKey, entry);
    },
    forget(matches) {
      for (const threadKey of Array.from(entries.keys())) {
        if (matches(threadKey)) entries.delete(threadKey);
      }
    },
    clear() {
      entries.clear();
    },
  };
}

function isSavedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= THREAD_READING_ANCHOR_MAX_ID_LENGTH &&
    value.trim() === value
  );
}

/**
 * A saved anchor read back, or null when the value is not one. A turn id that
 * does not read back is dropped (the row may then be folded away); an anchor
 * saved without a time counts as left before any other.
 */
export function decodeThreadReadingAnchor(value: unknown): SavedThreadReadingAnchor | null {
  if (!value || typeof value !== "object") return null;
  const { rowId, offsetWithinRow, turnId, leftAt } = value as Record<string, unknown>;
  if (
    !isSavedId(rowId) ||
    typeof offsetWithinRow !== "number" ||
    !Number.isFinite(offsetWithinRow) ||
    Math.abs(offsetWithinRow) > THREAD_READING_ANCHOR_MAX_OFFSET
  ) {
    return null;
  }
  return {
    rowId,
    offsetWithinRow,
    ...(isSavedId(turnId) ? { turnId: TurnId.make(turnId) } : {}),
    leftAt: typeof leftAt === "number" && Number.isFinite(leftAt) && leftAt >= 0 ? leftAt : 0,
  };
}

/**
 * Whether two saved anchor records hold the same anchors. When each was left
 * is not compared: a reader resting on a row would otherwise rewrite the
 * record on every scroll event.
 */
export function sameThreadReadingAnchors(
  left: Readonly<Record<string, SavedThreadReadingAnchor>>,
  right: Readonly<Record<string, SavedThreadReadingAnchor>>,
): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const a = left[key];
    const b = Object.hasOwn(right, key) ? right[key] : undefined;
    return (
      a !== undefined &&
      b !== undefined &&
      a.rowId === b.rowId &&
      a.offsetWithinRow === b.offsetWithinRow &&
      a.turnId === b.turnId
    );
  });
}
