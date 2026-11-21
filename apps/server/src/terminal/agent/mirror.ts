/**
 * A headless terminal emulator mirroring one Ryco terminal, so agent tools return what a person
 * sees instead of the byte stream: carriage returns, cursor movement, colours, wrapping and
 * full-screen programs are interpreted by xterm.js, the emulator the web and phone terminals
 * render with.
 *
 * Command boundaries come from the shell's OSC 133 marks (`shellIntegration.ts`), and VS Code's
 * OSC 633 where a user's own setup emits those: `C` opens a region at the cursor, `D;<code>`
 * closes it, `A` reports a prompt.
 *
 * Fast output must not starve the server: data is queued and handed to xterm.js a slice at a
 * time; while a backlog builds, parsing takes about a third of the time, and when the backlog
 * holds far more lines than the scrollback keeps, the older ones are skipped unparsed (they
 * would scroll out anyway). Marks and screen-mode switches in skipped text are kept, so command
 * boundaries and full-screen state stay right.
 *
 * Mirrors exist only for terminals an agent uses (`AgentTerminals`), never for every terminal.
 *
 * @module terminal/agent/mirror
 */
import { randomBytes } from "node:crypto";

import * as xtermModule from "@xterm/headless";
import type { IBuffer, IMarker, Terminal as XtermTerminal } from "@xterm/headless";

// Node loads the CommonJS build as a default export only; the bundle exposes the class too.
const Xterm: typeof xtermModule.Terminal =
  (xtermModule as { readonly Terminal?: typeof xtermModule.Terminal }).Terminal ??
  (xtermModule as unknown as { readonly default: typeof xtermModule }).default.Terminal;

/**
 * Widest mirror: memory grows with columns times scrollback (measured with 12,000 long lines:
 * 31 MB at 500 x 5,000, 7.4 MB at 250 x 2,000). Wider terminals wrap a little earlier here.
 */
export const MAX_COLS = 250;
/** Private OSC around the marks kept from skipped output (see `compact`). */
const SKIP_OSC = 7772;
/** Characters handed to xterm.js at a time. */
const SLICE_CHARS = 128 * 1024;
/** Unparsed backlog at which old lines are skipped. */
const COMPACT_CHARS = 1024 * 1024;
/** While a backlog exists, wait this many times as long as a slice took before the next (~33%). */
const BACKLOG_PAUSE_FACTOR = 2;
/** Sequences the rest of the output depends on: marks, screen and cursor-key modes. */
const KEPT_SEQUENCES =
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences
  /\u001b\](?:133|633);[^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[\?(?:1049|1047|47|1|2004)[hl]/g;

export interface Region {
  readonly id: number;
  /** Line where the output starts; disposed (line -1) once it scrolled out of the scrollback. */
  readonly start: IMarker | undefined;
  readonly startCol: number;
  end: IMarker | undefined;
  endCol: number;
  ended: boolean;
  exitCode: number | undefined;
  /** The command line the shell reported (OSC 633;E), when it did. */
  readonly commandLine: string | undefined;
  /** Part of its beginning is missing: skipped as too fast, or from before mirroring. */
  truncated: boolean;
}

/** A read position: new output is everything after it. */
export interface Mark {
  readonly marker: IMarker | undefined;
  readonly col: number;
  /** Taken while a full-screen program showed. */
  readonly alternate: boolean;
  /** How often output had been skipped when the mark was taken. */
  readonly skips: number;
}

export interface LinesResult {
  readonly lines: ReadonlyArray<string>;
  /** The start position scrolled out of the scrollback (or was skipped), so lines are missing. */
  readonly startLost: boolean;
}

export interface ScreenSnapshot {
  readonly lines: ReadonlyArray<string>;
  readonly cursor: { readonly row: number; readonly col: number };
  readonly alternate: boolean;
  readonly cols: number;
  readonly rows: number;
}

export interface MirrorListener {
  readonly onRegionStart?: (region: Region) => void;
  /**
   * A command ended (OSC 133;D). `region` is its output region when the shell marked the start
   * (zsh, bash 4.4+); bash 3.2 marks only ends, and so does every shell for the prompt after
   * an empty line, which callers ignore when nothing ran.
   */
  readonly onCommandEnd?: (exitCode: number | undefined, region: Region | undefined) => void;
  /** The shell drew a prompt (OSC 133;A). */
  readonly onPrompt?: () => void;
  /** Something was parsed: wakes waits. */
  readonly onParsed?: () => void;
}

export interface MirrorOptions {
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: number;
  readonly now?: () => number;
  /**
   * The nonce Ryco's shell integration puts in every mark it prints (`ryco=<nonce>`). Only marks
   * carrying it count; without one, no mark does. Output that prints a look-alike mark (a file,
   * a test, a remote host, another integration such as iTerm2's or VS Code's) is ignored.
   */
  readonly markNonce?: string | undefined;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)));

export class TerminalMirror {
  private readonly xterm: XtermTerminal;
  private readonly now: () => number;
  private readonly scrollback: number;
  private markNonce: string | undefined;
  /** Private to this mirror: output that prints a look-alike skip marker is ignored. */
  private readonly skipToken = randomBytes(8).toString("hex");
  private readonly listeners = new Set<MirrorListener>();
  private nextRegionId = 1;
  private openRegion: Region | undefined;
  private reportedCommandLine: string | undefined;
  private readonly queue: Array<{ data: string; seq: number }> = [];
  private queuedChars = 0;
  private seq = 0;
  private parsedSeq = 0;
  private parsing = false;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters: Array<{ seq: number; resolve: () => void }> = [];
  private inSkipped = false;
  private disposed = false;
  /** When output last arrived (clock ms). */
  lastWriteAt = 0;
  /** Characters received, to tell "something changed" cheaply. */
  received = 0;
  /** How often old lines were skipped unparsed. */
  skips = 0;
  /** A shell mark (OSC 133/633) has been seen: command ends are reported, not guessed. */
  shellIntegration = false;
  /** When the shell last drew its prompt (clock ms), 0 before the first. */
  lastPromptAt = 0;

  constructor(options: MirrorOptions) {
    this.now = options.now ?? Date.now;
    this.scrollback = options.scrollback;
    this.markNonce = options.markNonce;
    this.xterm = new Xterm({
      cols: clamp(options.cols, 20, MAX_COLS),
      rows: clamp(options.rows, 5, 200),
      scrollback: this.scrollback,
      allowProposedApi: true,
      convertEol: false,
    });
    const onMark = (data: string) => {
      this.onShellMark(data);
      return true;
    };
    this.xterm.parser.registerOscHandler(133, onMark);
    this.xterm.parser.registerOscHandler(633, onMark);
    this.xterm.parser.registerOscHandler(SKIP_OSC, (data) => {
      if (data !== `start;${this.skipToken}` && data !== `end;${this.skipToken}`) return true;
      this.inSkipped = data === `start;${this.skipToken}`;
      if (this.inSkipped) {
        this.skips += 1;
        if (this.openRegion !== undefined && !this.openRegion.ended) {
          this.openRegion.truncated = true;
        }
      }
      return true;
    });
  }

  listen(listener: MirrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get cols(): number {
    return this.xterm.cols;
  }

  get rows(): number {
    return this.xterm.rows;
  }

  get applicationCursorKeys(): boolean {
    return this.xterm.modes.applicationCursorKeysMode;
  }

  get bracketedPaste(): boolean {
    return this.xterm.modes.bracketedPasteMode;
  }

  get alternate(): boolean {
    return this.xterm.buffer.active.type === "alternate";
  }

  get currentRegion(): Region | undefined {
    return this.openRegion;
  }

  /** Characters received but not parsed yet. */
  get backlog(): number {
    return this.queuedChars;
  }

  /** Queues live output; parsing happens later, off the caller's path. */
  write(data: string): void {
    if (data.length === 0 || this.disposed) return;
    this.lastWriteAt = this.now();
    this.received += data.length;
    this.enqueue(data);
  }

  /**
   * Output from before this mirror existed (the retained history), not counted as activity.
   * `truncated`: its beginning is missing, so a command open in it lost its start.
   */
  replay(data: string, truncated: boolean): void {
    if (this.disposed) return;
    this.enqueue(truncated ? `${this.skipMarker("start")}${this.skipMarker("end")}${data}` : data);
  }

  /** Resolves once everything written so far has been parsed. */
  flush(): Promise<void> {
    if (this.disposed || this.parsedSeq >= this.seq) return Promise.resolve();
    const seq = this.seq;
    return new Promise<void>((resolve) => this.waiters.push({ seq, resolve }));
  }

  resize(cols: number, rows: number): void {
    const c = clamp(cols, 20, MAX_COLS);
    const r = clamp(rows, 5, 200);
    if (c !== this.xterm.cols || r !== this.xterm.rows) this.xterm.resize(c, r);
  }

  /** Forgets the screen and scrollback, as `clear` in the user's terminal does. */
  reset(): void {
    this.queue.length = 0;
    this.queuedChars = 0;
    this.openRegion = undefined;
    this.xterm.reset();
  }

  /** Ends the open region without a mark (the terminal restarted or exited). */
  closeOpenRegion(): void {
    if (this.openRegion !== undefined && !this.openRegion.ended) this.closeRegion(undefined);
  }

  /** A command's output lines, as rendered. An open region ends at the cursor. */
  regionLines(region: Region): LinesResult {
    const buffer = this.xterm.buffer.normal;
    const startLost = region.start === undefined || region.start.line < 0 || region.truncated;
    const startLine = startLost ? 0 : region.start!.line;
    const startCol = startLost ? 0 : region.startCol;
    const ended = region.ended && region.end !== undefined && region.end.line >= 0;
    const endLine = ended ? region.end!.line : buffer.baseY + buffer.cursorY;
    const endCol = ended ? region.endCol : undefined;
    return { lines: tidy(readLines(buffer, startLine, startCol, endLine, endCol)), startLost };
  }

  /** The current position, to read what comes after it later. */
  mark(options: { readonly exact?: boolean } = {}): Mark {
    if (this.alternate) return { marker: undefined, col: 0, alternate: true, skips: this.skips };
    const buffer = this.xterm.buffer.normal;
    // Unless exact, from the start of the cursor line: a progress bar may still redraw it.
    const marker = this.xterm.registerMarker(0);
    return { marker, col: options.exact ? buffer.cursorX : 0, alternate: false, skips: this.skips };
  }

  /** A mark at the end of a finished region. */
  markAfter(region: Region): Mark {
    if (region.end !== undefined && region.end.line >= 0) {
      return { marker: region.end, col: region.endCol, alternate: false, skips: this.skips };
    }
    return this.mark({ exact: true });
  }

  /** Everything after `mark` on the normal screen; without one, the visible screen. */
  linesSince(mark: Mark | undefined): LinesResult {
    const buffer = this.xterm.buffer.normal;
    const endLine = buffer.baseY + buffer.cursorY;
    if (mark === undefined || mark.alternate || mark.marker === undefined || mark.marker.line < 0) {
      const lost = mark !== undefined && !mark.alternate;
      const from = lost ? 0 : Math.max(0, endLine - this.xterm.rows + 1);
      return { lines: tidy(readLines(buffer, from, 0, endLine, undefined)), startLost: lost };
    }
    return {
      lines: tidy(readLines(buffer, mark.marker.line, mark.col, endLine, undefined)),
      startLost: this.skips > mark.skips,
    };
  }

  /**
   * The output between two marks (`to` absent: up to the cursor). A missing or scrolled-out
   * `from` reads from the top and reports the start lost.
   */
  linesBetween(from: Mark | undefined, to: Mark | undefined): LinesResult {
    const buffer = this.xterm.buffer.normal;
    const usable = (mark: Mark | undefined): mark is Mark & { readonly marker: IMarker } =>
      mark !== undefined && !mark.alternate && mark.marker !== undefined && mark.marker.line >= 0;
    const start = usable(from) ? from : undefined;
    const end = usable(to) ? to : undefined;
    const lines = readLines(
      buffer,
      start?.marker.line ?? 0,
      start?.col ?? 0,
      end?.marker.line ?? buffer.baseY + buffer.cursorY,
      end?.col,
    );
    return {
      lines: tidy(lines),
      startLost: start === undefined || (from !== undefined && this.skips > from.skips),
    };
  }

  /** The visible screen of the active buffer (the full-screen program's, if one runs). */
  screen(): ScreenSnapshot {
    const buffer = this.xterm.buffer.active;
    const top = buffer.baseY;
    const lines: Array<string> = [];
    for (let y = top; y < top + this.xterm.rows; y += 1) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return {
      lines,
      cursor: { row: buffer.cursorY, col: buffer.cursorX },
      alternate: this.alternate,
      cols: this.xterm.cols,
      rows: this.xterm.rows,
    };
  }

  /** The cursor's line, split at the cursor. */
  cursorLine(): { readonly beforeCursor: string; readonly afterCursor: string } {
    const buffer = this.xterm.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    const full = line?.translateToString(false) ?? "";
    return { beforeCursor: full.slice(0, buffer.cursorX), afterCursor: full.slice(buffer.cursorX) };
  }

  /** The last `count` non-empty lines of the screen. */
  tail(count: number): ReadonlyArray<string> {
    return this.screen()
      .lines.filter((line) => line.trim() !== "")
      .slice(-count);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pauseTimer !== undefined) clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    this.queue.length = 0;
    this.queuedChars = 0;
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
    this.listeners.clear();
    this.xterm.dispose();
  }

  private enqueue(data: string): void {
    const seq = ++this.seq;
    this.queue.push({ data, seq });
    this.queuedChars += data.length;
    if (this.queuedChars > COMPACT_CHARS) this.compact();
    this.pump();
  }

  private pump(): void {
    if (this.parsing || this.pauseTimer !== undefined || this.disposed || this.queue.length === 0) {
      return;
    }
    let data = "";
    let upTo = this.parsedSeq;
    while (
      this.queue.length > 0 &&
      (data === "" || data.length + this.queue[0]!.data.length <= SLICE_CHARS)
    ) {
      const next = this.queue.shift()!;
      data += next.data;
      upTo = next.seq;
    }
    this.queuedChars -= data.length;
    this.parsing = true;
    const started = performance.now();
    this.xterm.write(data, () => {
      this.parsing = false;
      if (this.disposed) return;
      this.settle(upTo);
      for (const listener of this.listeners) listener.onParsed?.();
      if (this.queue.length === 0) return;
      // A backlog: leave the event loop to everything else for a while before the next slice.
      const pause = Math.min(250, (performance.now() - started) * BACKLOG_PAUSE_FACTOR);
      if (pause < 1) {
        this.pump();
        return;
      }
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = undefined;
        this.pump();
      }, pause);
    });
  }

  private settle(upTo: number): void {
    this.parsedSeq = Math.max(this.parsedSeq, upTo);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!;
      if (waiter.seq <= this.parsedSeq) {
        this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  /**
   * The backlog is too large: keep as many of its last lines as screen and scrollback hold, plus
   * the state-changing sequences of the skipped part, in order, framed so regions know.
   */
  private compact(): void {
    const all = this.queue.map((entry) => entry.data).join("");
    const keepLines = this.scrollback + this.xterm.rows + 50;
    let cut = all.length;
    for (let lines = 0; lines < keepLines; lines += 1) {
      const index = all.lastIndexOf("\n", cut - 1);
      if (index <= 0) return;
      cut = index;
    }
    const skipped = all.slice(0, cut + 1);
    const kept = skipped.match(KEPT_SEQUENCES)?.join("") ?? "";
    const data = `${this.skipMarker("start")}${kept}${this.skipMarker("end")}\r\n${all.slice(cut + 1)}`;
    const seq = this.queue[this.queue.length - 1]!.seq;
    this.queue.length = 0;
    this.queue.push({ data, seq });
    this.queuedChars = data.length;
  }

  private skipMarker(kind: "start" | "end"): string {
    return `\u001b]${SKIP_OSC};${kind};${this.skipToken}\u0007`;
  }

  /** A restarted shell marks with its new spawn's nonce. */
  setMarkNonce(nonce: string | undefined): void {
    this.markNonce = nonce;
  }

  private onShellMark(data: string): void {
    const [kind, ...params] = data.split(";");
    // Only Ryco's own marks, recognised by this session's nonce.
    if (this.markNonce === undefined || !params.includes(`ryco=${this.markNonce}`)) return;
    const rest = params.filter((param) => !param.startsWith("ryco="));
    this.shellIntegration = true;
    if (kind === "C") {
      const open = this.openRegion;
      const buffer = this.xterm.buffer.normal;
      // A second start with nothing printed since the first (the cursor has not moved) is the
      // same command, not a new one.
      if (
        open !== undefined &&
        !open.ended &&
        open.start !== undefined &&
        open.start.line === buffer.baseY + buffer.cursorY &&
        open.startCol === buffer.cursorX
      ) {
        return;
      }
      if (open !== undefined && !open.ended) this.closeRegion(undefined);
      const region: Region = {
        id: this.nextRegionId++,
        start: this.alternate ? undefined : this.xterm.registerMarker(0),
        startCol: buffer.cursorX,
        end: undefined,
        endCol: 0,
        ended: false,
        exitCode: undefined,
        commandLine: this.reportedCommandLine,
        truncated: this.inSkipped,
      };
      this.reportedCommandLine = undefined;
      this.openRegion = region;
      for (const listener of this.listeners) listener.onRegionStart?.(region);
    } else if (kind === "D") {
      const parsed = rest[0] !== undefined && rest[0] !== "" ? Number(rest[0]) : undefined;
      const code = parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
      if (this.openRegion === undefined || this.openRegion.ended) {
        for (const listener of this.listeners) listener.onCommandEnd?.(code, undefined);
        return;
      }
      this.closeRegion(code);
    } else if (kind === "E") {
      this.reportedCommandLine = decodeOscValue(rest[0] ?? "");
    } else if (kind === "A") {
      this.lastPromptAt = this.now();
      for (const listener of this.listeners) listener.onPrompt?.();
    }
  }

  private closeRegion(exitCode: number | undefined): void {
    const region = this.openRegion!;
    const buffer = this.xterm.buffer.normal;
    region.end = this.alternate ? undefined : this.xterm.registerMarker(0);
    region.endCol = buffer.cursorX;
    region.ended = true;
    region.exitCode = exitCode;
    for (const listener of this.listeners) listener.onCommandEnd?.(exitCode, region);
  }
}

/** Undoes the escaping of OSC 633 values: `\\` is a backslash, `\xHH` a character. */
export function decodeOscValue(value: string): string {
  return value.replace(
    /\\(\\|x([0-9a-fA-F]{2}))/g,
    (_match, _what: string, hex: string | undefined) =>
      hex === undefined ? "\\" : String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Buffer lines [fromLine, toLine] as logical lines (soft-wrapped rows joined). */
function readLines(
  buffer: IBuffer,
  fromLine: number,
  fromCol: number,
  toLine: number,
  toCol: number | undefined,
): Array<string> {
  const out: Array<string> = [];
  let current = "";
  for (let y = fromLine; y <= toLine; y += 1) {
    const line = buffer.getLine(y);
    if (line === undefined) break;
    const continues = y < toLine && buffer.getLine(y + 1)?.isWrapped === true;
    const start = y === fromLine ? fromCol : 0;
    const end = y === toLine ? toCol : undefined;
    if (y === toLine && end === 0 && y !== fromLine && !line.isWrapped) break;
    current += line.translateToString(!continues, start, end);
    if (!continues) {
      out.push(current);
      current = "";
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** Trims line ends and drops trailing empty lines. */
function tidy(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  const out = lines.map((line) => line.trimEnd());
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
