import type { VcsWorkspaceContentFile, VcsWorkspaceContentLine } from "./VcsDriver.ts";

/**
 * Bytes kept of one matching line: a window around git's first match, so a
 * minified bundle's line is never held whole.
 */
const LINE_WINDOW_BYTES = 4_096;
/** How much of the window comes before the first match. */
const LINE_WINDOW_LEADING_BYTES = 512;
/** Records of a longer path are skipped. */
const MAX_PATH_BYTES = 4_096;

const NUL = 0x00;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;

const TEXT_DECODER = new TextDecoder("utf-8");
const PATH_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface GitGrepOutputOptions {
  /** Files at or before this path, in UTF-8 byte order, are skipped. */
  readonly afterPath: string;
  readonly maxLinesPerFile: number;
}

export interface GitGrepOutputParser {
  /** Reads the next chunk of output and returns the files it completed. */
  readonly push: (chunk: Uint8Array) => VcsWorkspaceContentFile[];
  /** The last file, once the output ended. A record cut off by the end is dropped. */
  readonly end: () => VcsWorkspaceContentFile[];
}

interface OpenFile {
  readonly pathBytes: Buffer;
  readonly path: string;
  readonly lines: VcsWorkspaceContentLine[];
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Where `bytes[start, end)` ends without a character the window cut in half. */
function endOfWholeCharacters(bytes: Uint8Array, start: number, end: number): number {
  for (let lead = end - 1; lead >= Math.max(start, end - 4); lead -= 1) {
    const byte = bytes[lead] ?? 0;
    if (isContinuationByte(byte)) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return lead + length > end ? lead : end;
  }
  return end;
}

/** A path, or null when it is not UTF-8: no workspace listing can name such a file. */
function decodePath(bytes: Uint8Array): string | null {
  try {
    return PATH_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parses `git grep -z -n --column` output incrementally, whatever the chunk
 * boundaries: one `path\0line\0column\0text\n` record per matching line, the
 * files in path order. `column` is the 1-based byte offset of the line's first
 * match. Each file keeps its first `maxLinesPerFile` lines.
 */
export function makeGitGrepOutputParser(options: GitGrepOutputOptions): GitGrepOutputParser {
  const afterPath = Buffer.from(options.afterPath, "utf8");
  const pathBuffer = Buffer.alloc(MAX_PATH_BYTES);
  const window = Buffer.alloc(LINE_WINDOW_BYTES);
  let field: "path" | "lineNumber" | "column" | "text" = "path";
  let pathLength = 0;
  let pathTooLong = false;
  let lineNumber = 0;
  let column = 0;
  /** The record's line goes into `file`. */
  let keepLine = false;
  /** Offset in the line where the window starts. */
  let windowStart = 0;
  /** Bytes of the line read so far. */
  let lineLength = 0;
  let lastLineByte = -1;
  let file: OpenFile | null = null;
  let completed: VcsWorkspaceContentFile[] = [];

  const closeFile = () => {
    if (file !== null && file.lines.length > 0) {
      completed.push({ path: file.path, lines: file.lines });
    }
    file = null;
  };

  const appendPath = (chunk: Uint8Array, start: number, end: number) => {
    if (pathTooLong || pathLength + end - start > MAX_PATH_BYTES) {
      pathTooLong = true;
      return;
    }
    pathBuffer.set(chunk.subarray(start, end), pathLength);
    pathLength += end - start;
  };

  const readNumber = (value: number, chunk: Uint8Array, start: number, end: number): number => {
    let next = value;
    for (let index = start; index < end; index += 1) {
      const byte = chunk[index] ?? 0;
      if (byte >= DIGIT_ZERO && byte <= DIGIT_NINE) next = next * 10 + byte - DIGIT_ZERO;
    }
    return next;
  };

  /** A record's path is complete: it continues the open file or opens the next one. */
  const startRecord = () => {
    const pathBytes = pathBuffer.subarray(0, pathLength);
    if (pathTooLong || file === null || !file.pathBytes.equals(pathBytes)) {
      closeFile();
      const path =
        !pathTooLong && Buffer.compare(pathBytes, afterPath) > 0 ? decodePath(pathBytes) : null;
      if (path !== null) file = { pathBytes: Buffer.from(pathBytes), path, lines: [] };
    }
    keepLine = file !== null && file.lines.length < options.maxLinesPerFile;
  };

  const readText = (chunk: Uint8Array, start: number, end: number) => {
    if (end <= start) return;
    if (keepLine) {
      const from = Math.max(start, start + windowStart - lineLength);
      const to = Math.min(end, start + windowStart + LINE_WINDOW_BYTES - lineLength);
      if (from < to) window.set(chunk.subarray(from, to), lineLength + from - start - windowStart);
    }
    lineLength += end - start;
    lastLineByte = chunk[end - 1] ?? -1;
  };

  const finishLine = () => {
    if (!keepLine || file === null) return;
    // A CRLF file's lines keep their \r.
    const contentLength = lastLineByte === CARRIAGE_RETURN ? lineLength - 1 : lineLength;
    const windowEnd = Math.min(contentLength, windowStart + LINE_WINDOW_BYTES);
    const cutStart = windowStart > 0;
    const cutEnd = windowEnd < contentLength;
    let start = 0;
    let end = Math.max(0, windowEnd - windowStart);
    if (cutStart) {
      while (start < Math.min(end, 3) && isContinuationByte(window[start] ?? 0)) start += 1;
    }
    if (cutEnd) end = endOfWholeCharacters(window, start, end);
    const matchOffset = Math.min(Math.max(column - 1 - windowStart, start), end);
    file.lines.push({
      lineNumber,
      text: TEXT_DECODER.decode(window.subarray(start, end)),
      matchStart: TEXT_DECODER.decode(window.subarray(start, matchOffset)).length,
      cutStart,
      cutEnd,
    });
  };

  const push = (chunk: Uint8Array): VcsWorkspaceContentFile[] => {
    let index = 0;
    while (index < chunk.length) {
      if (field === "text") {
        const newline = chunk.indexOf(NEWLINE, index);
        readText(chunk, index, newline === -1 ? chunk.length : newline);
        if (newline === -1) break;
        finishLine();
        field = "path";
        pathLength = 0;
        pathTooLong = false;
        lineNumber = 0;
        column = 0;
        index = newline + 1;
        continue;
      }
      const separator = chunk.indexOf(NUL, index);
      const end = separator === -1 ? chunk.length : separator;
      if (field === "path") appendPath(chunk, index, end);
      else if (field === "lineNumber") lineNumber = readNumber(lineNumber, chunk, index, end);
      else column = readNumber(column, chunk, index, end);
      if (separator === -1) break;
      index = separator + 1;
      if (field === "path") {
        startRecord();
        field = "lineNumber";
      } else if (field === "lineNumber") {
        field = "column";
      } else {
        windowStart = Math.max(0, column - 1 - LINE_WINDOW_LEADING_BYTES);
        lineLength = 0;
        lastLineByte = -1;
        field = "text";
      }
    }
    const files = completed;
    completed = [];
    return files;
  };

  return {
    push,
    end: () => {
      closeFile();
      const files = completed;
      completed = [];
      return files;
    },
  };
}
