import { WORKTREE_SETUP_OUTPUT_TAIL_LINES } from "@ryco/contracts";

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and the
// remaining two-byte escapes. A shell prompt is mostly these.
const TERMINAL_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;
// Everything below space except tab, newline and carriage return.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
// An escape cut off at the end of a chunk, completed by the next one.
// eslint-disable-next-line no-control-regex
const TRAILING_PARTIAL_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*)?$/u;
// A runaway line (a progress bar without newlines) is cut, not buffered forever.
const MAX_PENDING_LINE_LENGTH = 4_096;
const MAX_TAIL_LINE_LENGTH = 240;

/**
 * The last few readable lines of a terminal's output: escapes stripped, a
 * carriage return overwriting its line the way a terminal shows it, blank
 * lines dropped. Feed raw chunks in arrival order.
 */
export class TerminalOutputTail {
  private readonly lines: string[] = [];
  private readonly maxLines: number;
  private pending = "";
  private carry = "";

  constructor(maxLines: number = WORKTREE_SETUP_OUTPUT_TAIL_LINES) {
    this.maxLines = maxLines;
  }

  /** Adds a chunk; reports whether the visible tail changed. */
  push(chunk: string): boolean {
    const before = this.snapshot().join("\n");
    let text = this.carry + chunk;
    const partial = TRAILING_PARTIAL_ESCAPE.exec(text);
    this.carry = partial ? partial[0] : "";
    if (partial) text = text.slice(0, partial.index);
    text = text.replace(TERMINAL_ESCAPE, "").replace(CONTROL_CHARACTERS, "");

    const segments = text.replace(/\r\n/gu, "\n").split("\n");
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const overwrite = segment.lastIndexOf("\r");
      // A bare `\r` returns to the line start: what follows replaces the line.
      this.pending = overwrite === -1 ? this.pending + segment : segment.slice(overwrite + 1);
      if (this.pending.length > MAX_PENDING_LINE_LENGTH) {
        this.pending = this.pending.slice(-MAX_PENDING_LINE_LENGTH);
      }
      if (index < segments.length - 1) {
        this.commit(this.pending);
        this.pending = "";
      }
    }
    return this.snapshot().join("\n") !== before;
  }

  /** The visible tail, including the line still being written. */
  snapshot(): ReadonlyArray<string> {
    const current = normalizeLine(this.pending);
    const all = current ? [...this.lines, current] : this.lines;
    return all.slice(-this.maxLines);
  }

  private commit(line: string): void {
    const normalized = normalizeLine(line);
    if (!normalized) return;
    this.lines.push(normalized);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }
}

function normalizeLine(line: string): string {
  const trimmed = line.replace(/\t/gu, "  ").trimEnd();
  if (trimmed.trim().length === 0) return "";
  return trimmed.length > MAX_TAIL_LINE_LENGTH
    ? `${trimmed.slice(0, MAX_TAIL_LINE_LENGTH - 1)}…`
    : trimmed;
}
