/**
 * Maps a session's output cursors to positions in its retained history, so
 * `terminal.open` can answer a `sinceCursor` with only the output after it
 * instead of the whole scrollback (up to 2 MiB).
 *
 * Positions are absolute: UTF-16 units appended since the last reset (open,
 * clear, restart). The history keeps a suffix of that stream, starting at
 * `origin`, because trimming drops its head. Each output event that appended
 * visible text records `(sequence, end)`; events that append nothing (activity,
 * fully stripped control output, exit) need no mark, since the end at their
 * cursor is the end at the nearest earlier mark.
 *
 * Unresolvable cursors return `null` and the caller sends the full history:
 * a cursor before the last reset, older than the retained marks, or whose
 * position was already trimmed out of the history.
 */

/** Marks kept per session; the oldest half is dropped (into the floor) beyond it. */
export const MAX_HISTORY_CURSOR_MARKS = 4_096;

export class TerminalHistoryCursorIndex {
  /** Absolute position of `history[0]`. */
  private origin = 0;
  /** Absolute end of the history. */
  private end = 0;
  /** Cursors below this cannot be resolved. */
  private floorSequence = 0;
  /** Absolute end of the history as of `floorSequence`. */
  private floorEnd = 0;
  /** Ascending sequences of output events that appended history, and the end after each. */
  private sequences: number[] = [];
  private ends: number[] = [];
  private readonly maxMarks: number;

  /**
   * @param floorSequence lowest cursor sequence that reflects `historyLength`: one above the
   *   session's cursor when the history is (re)initialized, so earlier cursors resolve to null.
   */
  constructor(floorSequence: number, historyLength: number, maxMarks = MAX_HISTORY_CURSOR_MARKS) {
    this.maxMarks = Math.max(1, maxMarks);
    this.reset(floorSequence, historyLength);
  }

  /** The history was replaced (loaded, cleared, restarted); older cursors no longer resolve. */
  reset(floorSequence: number, historyLength: number): void {
    this.origin = 0;
    this.end = historyLength;
    this.floorSequence = floorSequence;
    this.floorEnd = historyLength;
    this.sequences = [];
    this.ends = [];
  }

  /**
   * Records an output event at `sequence` that appended `appendedLength` units, leaving
   * `retainedLength` units of history after head trimming.
   */
  append(sequence: number, appendedLength: number, retainedLength: number): void {
    this.end += appendedLength;
    this.origin = this.end - retainedLength;
    this.sequences.push(sequence);
    this.ends.push(this.end);
    if (this.sequences.length <= this.maxMarks) return;
    // Dropping a block keeps this amortized O(1); cursors in the dropped range
    // resolve to null (a full snapshot) instead of an inexact position.
    const drop = this.sequences.length >> 1;
    this.floorSequence = this.sequences[drop - 1]!;
    this.floorEnd = this.ends[drop - 1]!;
    this.sequences = this.sequences.slice(drop);
    this.ends = this.ends.slice(drop);
  }

  /** History after the output at `sequence`, or null when it cannot be determined exactly. */
  since(sequence: number, history: string): string | null {
    if (sequence < this.floorSequence) return null;
    // A history that does not match the recorded positions is never sliced.
    if (this.end - this.origin !== history.length) return null;
    let low = 0;
    let high = this.sequences.length - 1;
    let endAtCursor = this.floorEnd;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.sequences[middle]! <= sequence) {
        endAtCursor = this.ends[middle]!;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (endAtCursor < this.origin) return null;
    return history.slice(endAtCursor - this.origin);
  }
}
