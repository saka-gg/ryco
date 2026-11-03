// Streamed assistant Markdown is released in whole blocks: a release ends only where no
// later line can reopen what came before it. The scan follows CommonMark's fenced and
// indented code blocks and the list items they nest in. It does not track block quotes,
// so a fence inside one is quoted text here (a blank line ends the quote anyway).

const TAB_STOP = 4;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as a
// no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
const FENCE_PATTERN = /^(`{3,}|~{3,})(.*)$/;
const LIST_MARKER_PATTERN = /^(?:[-*+]|(\d{1,9})[.)])(?=[ \t]|$)/;
const THEMATIC_BREAK_PATTERN = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;
const BLOCK_QUOTE_PATTERN = /^>/;
// The scanned start of an unfinished line is kept to read the line once it ends. A line
// is classified by its start, so a longer one keeps only this much.
const MAX_PARTIAL_LINE_CHARS = 1_024;

/**
 * Where a scan of streamed assistant Markdown stands. Opaque to callers: it carries
 * what a following line continues, from `splitBufferedAssistantText` or
 * `scanAssistantText` to the next scan.
 */
export interface AssistantTextScan {
  /** The open fenced code block: its opening marker and its container's content column. */
  readonly fence: { readonly marker: string; readonly container: number } | null;
  /** Content columns of the open list items, outermost first. */
  readonly listItems: ReadonlyArray<number>;
  /** The last line was paragraph text, which a less indented line may continue. */
  readonly paragraph: boolean;
  /** The content column the open indented code block is indented from, if one is open. */
  readonly indentedCode: number | null;
  /** The scanned start of an unfinished line. */
  readonly partialLine: string;
}

/** The scan of a message before its first character. */
export const ASSISTANT_TEXT_SCAN_START: AssistantTextScan = {
  fence: null,
  listItems: [],
  paragraph: false,
  indentedCode: null,
  partialLine: "",
};

export interface SplitAssistantText {
  /** Text whose blocks cannot change shape as more arrives. */
  readonly ready: string;
  /** Text to hold until the next boundary or the end of the message. */
  readonly rest: string;
  /** The scan where `rest` starts, for the next split of what is held. */
  readonly restScan: AssistantTextScan;
}

export interface SplitAssistantTextOptions {
  /**
   * Holds everything from a fence whose info string matches, even once it closes: a block
   * the server consumes when the message completes never streams.
   */
  readonly holdFence?: (info: string) => boolean;
}

/**
 * Splits streamed assistant text after its last blank line, closing code fence or
 * finished indented code block outside an open code block. Only newline-terminated lines
 * count, so a partial line never leaks, and no text inside an open code block is ever
 * ready. `scan` is where the text starts: the `restScan` of the split that held it, or
 * `scanAssistantText` of everything sent before it. Concatenating `ready` and `rest`
 * always gives back `text`.
 */
export function splitBufferedAssistantText(
  text: string,
  scan: AssistantTextScan = ASSISTANT_TEXT_SCAN_START,
  options?: SplitAssistantTextOptions,
): SplitAssistantText {
  const scanner = new LineScanner(scan);
  let boundary = 0;
  let boundaryScan = scan;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) break;
    // Only a line that ends an indented code block can end a block before itself.
    const before = scanner.indentedCode === null ? null : scanner.snapshot("");
    const effect = scanner.feed(lineText(text, lineStart, newline, scan.partialLine));
    if (effect.endsBefore && before !== null && lineStart > boundary) {
      boundary = lineStart;
      boundaryScan = before;
    }
    if (effect.opensFence !== null && options?.holdFence?.(effect.opensFence)) break;
    // A leading blank line ends nothing worth sending on its own.
    if (effect.endsAfter && (lineStart > 0 || !effect.blank)) {
      boundary = newline + 1;
      boundaryScan = scanner.snapshot("");
    }
    lineStart = newline + 1;
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary), restScan: boundaryScan };
}

/**
 * The scan at the end of `text`, which continues `scan`: for text sent whole, such as a
 * buffer spilled at its size cap or a token-streamed delta.
 */
export function scanAssistantText(text: string, scan: AssistantTextScan): AssistantTextScan {
  const scanner = new LineScanner(scan);
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) break;
    scanner.feed(lineText(text, lineStart, newline, scan.partialLine));
    lineStart = newline + 1;
  }
  const partialLine = lineStart === 0 ? scan.partialLine + text : text.slice(lineStart);
  return scanner.snapshot(partialLine.slice(0, MAX_PARTIAL_LINE_CHARS));
}

function lineText(text: string, lineStart: number, newline: number, partialLine: string): string {
  const line = text.slice(lineStart, newline);
  return (lineStart === 0 ? partialLine + line : line).replace(/[ \t\r]+$/, "");
}

interface LineEffect {
  /** The line ends an indented code block, so a block ends before it. */
  readonly endsBefore: boolean;
  /** A block ends with this line (a blank line or a closing fence). */
  readonly endsAfter: boolean;
  /** The line is blank. */
  readonly blank: boolean;
  /** The info string of the fence the line opens, if it opens one. */
  readonly opensFence: string | null;
}

const NO_EFFECT: LineEffect = {
  endsBefore: false,
  endsAfter: false,
  blank: false,
  opensFence: null,
};
const ENDS_BEFORE: LineEffect = { ...NO_EFFECT, endsBefore: true };
const CLOSES_FENCE: LineEffect = { ...NO_EFFECT, endsAfter: true };
const BLANK: LineEffect = { ...NO_EFFECT, blank: true };
const BLANK_ENDS_AFTER: LineEffect = { ...BLANK, endsAfter: true };

class LineScanner {
  fence: AssistantTextScan["fence"];
  readonly listItems: number[];
  paragraph: boolean;
  indentedCode: number | null;

  constructor(scan: AssistantTextScan) {
    this.fence = scan.fence;
    this.listItems = [...scan.listItems];
    this.paragraph = scan.paragraph;
    this.indentedCode = scan.indentedCode;
  }

  snapshot(partialLine: string): AssistantTextScan {
    return {
      fence: this.fence,
      listItems: [...this.listItems],
      paragraph: this.paragraph,
      indentedCode: this.indentedCode,
      partialLine,
    };
  }

  /** Reads one whole line, trailing whitespace removed. */
  feed(line: string): LineEffect {
    if (BLANK_LINE_PATTERN.test(line)) {
      if (this.fence !== null) return BLANK;
      this.paragraph = false;
      // Indented code continues past blank lines; the next line decides.
      return this.indentedCode === null ? BLANK_ENDS_AFTER : BLANK;
    }
    const { column, offset } = leadingIndent(line, 0, 0);
    if (this.fence !== null) {
      if (column >= this.fence.container) {
        if (!closesFence(this.fence, line.slice(offset), column)) return NO_EFFECT;
        this.fence = null;
        this.paragraph = false;
        return CLOSES_FENCE;
      }
      // Code in a list item has no lazy lines: a line indented less than the item's
      // content ends the item, and the fence with it. The line is read afresh below.
      this.fence = null;
    }
    let endsBefore = false;
    if (this.indentedCode !== null) {
      if (column >= this.indentedCode + TAB_STOP) return NO_EFFECT;
      this.indentedCode = null;
      endsBefore = true;
    }

    // The open list items this line is indented enough to stay in.
    let depth = this.listItems.length;
    while (depth > 0 && this.listItems[depth - 1]! > column) depth -= 1;
    // A block start interrupts a paragraph only in the paragraph's own container.
    let block = blockStart(line.slice(offset), column - containerOf(this.listItems, depth), {
      interrupting: this.paragraph && depth === this.listItems.length,
    });
    if (block === null && this.paragraph) {
      // Paragraph text, lazily continued or not: every list item stays open.
      return endsBefore ? ENDS_BEFORE : NO_EFFECT;
    }
    this.listItems.length = depth;

    let position = offset;
    let lineColumn = column;
    for (;;) {
      const container = containerOf(this.listItems, this.listItems.length);
      if (block === null) {
        // Indented code (a paragraph would have continued above), or paragraph text.
        if (lineColumn - container >= TAB_STOP) this.indentedCode = container;
        else this.paragraph = true;
        break;
      }
      if (block.kind === "fence") {
        this.fence = { marker: block.marker, container };
        this.paragraph = false;
        return { ...NO_EFFECT, endsBefore, opensFence: block.info.trim() };
      }
      if (block.kind !== "list-item") {
        // A heading or thematic break ends any paragraph; a block quote holds text.
        this.paragraph = block.kind === "block-quote";
        break;
      }
      const markerEnd = lineColumn + block.markerLength;
      const content = leadingIndent(line, position + block.markerLength, markerEnd);
      const empty = content.offset === line.length;
      // An item whose text starts more than four columns past its marker starts with
      // indented code; its content column is one past the marker.
      const itemColumn =
        empty || content.column - markerEnd > TAB_STOP ? markerEnd + 1 : content.column;
      this.listItems.push(itemColumn);
      this.paragraph = false;
      if (empty) break;
      // The item's first line may open a fence or another item ("- 1. ```bash").
      position = content.offset;
      lineColumn = content.column;
      block = blockStart(line.slice(position), lineColumn - itemColumn, { interrupting: false });
    }
    return endsBefore ? ENDS_BEFORE : NO_EFFECT;
  }
}

type BlockStart =
  | { readonly kind: "list-item"; readonly markerLength: number }
  | { readonly kind: "fence"; readonly marker: string; readonly info: string }
  | { readonly kind: "heading" | "thematic-break" | "block-quote" };

/**
 * The block a line's content starts, or null for paragraph text and indented code.
 * `relativeColumn` is how far the content sits past its container's content column.
 */
function blockStart(
  content: string,
  relativeColumn: number,
  options: { readonly interrupting: boolean },
): BlockStart | null {
  if (relativeColumn >= TAB_STOP) return null;
  if (THEMATIC_BREAK_PATTERN.test(content)) return { kind: "thematic-break" };
  const marker = LIST_MARKER_PATTERN.exec(content);
  if (marker !== null) {
    // CommonMark: a list item interrupts a paragraph only with text, and only as an
    // unordered item or one numbered 1.
    const empty = BLANK_LINE_PATTERN.test(content.slice(marker[0].length));
    const ordered = marker[1] !== undefined;
    if (!options.interrupting || (!empty && (!ordered || Number(marker[1]) === 1))) {
      return { kind: "list-item", markerLength: marker[0].length };
    }
  }
  const fence = FENCE_PATTERN.exec(content);
  // CommonMark: a backtick fence's info string may not contain a backtick, so a line
  // like ```a`b``` is a paragraph with inline code, not a fence.
  if (fence !== null && !(fence[1]!.startsWith("`") && fence[2]!.includes("`"))) {
    return { kind: "fence", marker: fence[1]!, info: fence[2]! };
  }
  if (HEADING_PATTERN.test(content)) return { kind: "heading" };
  if (BLOCK_QUOTE_PATTERN.test(content)) return { kind: "block-quote" };
  return null;
}

function containerOf(listItems: ReadonlyArray<number>, depth: number): number {
  return depth > 0 ? listItems[depth - 1]! : 0;
}

// CommonMark: the closer uses the opener's character, is at least as long, and carries
// no info string. It may be indented at most three columns past its container's content
// column; deeper lines are code.
function closesFence(
  fence: NonNullable<AssistantTextScan["fence"]>,
  content: string,
  column: number,
): boolean {
  const match = FENCE_PATTERN.exec(content);
  return (
    match !== null &&
    match[2]!.length === 0 &&
    match[1]![0] === fence.marker[0] &&
    match[1]!.length >= fence.marker.length &&
    column - fence.container < TAB_STOP
  );
}

/** Columns and characters of the spaces and tabs at `from`; tabs reach the next stop. */
function leadingIndent(
  line: string,
  from: number,
  startColumn: number,
): { column: number; offset: number } {
  let column = startColumn;
  let offset = from;
  for (; offset < line.length; offset += 1) {
    const char = line[offset];
    if (char === " ") column += 1;
    else if (char === "\t") column += TAB_STOP - (column % TAB_STOP);
    else break;
  }
  return { column, offset };
}
