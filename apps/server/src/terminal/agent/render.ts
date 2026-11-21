/**
 * Cutting terminal output to a size a model can take, deliberately and visibly: keep the end by
 * default, cut a very long line in its middle, and say what was cut with the exact call that
 * reads the rest.
 *
 * @module terminal/agent/render
 */

/** Default size of the output part of a result, in characters (~5k tokens). */
export const DEFAULT_MAX_CHARS = 20_000;
/** The most an agent may ask for: well under what providers accept as one tool result. */
export const MAX_MAX_CHARS = 60_000;
export const MIN_MAX_CHARS = 500;
/** A single line longer than this is cut in the middle (minified files, base64 ...). */
export const MAX_LINE_CHARS = 2_000;

export interface Clip {
  /** The lines shown, joined with "\n". */
  readonly text: string;
  /** 1-based numbers of the first and last line shown; 0 when nothing is shown. */
  readonly first: number;
  readonly last: number;
  readonly total: number;
  /** Lines left out before `first` and after `last`. */
  readonly omittedBefore: number;
  readonly omittedAfter: number;
  /** Lines cut in the middle because they were too long on their own. */
  readonly longLinesCut: number;
}

export const clampMaxChars = (value: number | undefined): number =>
  Math.max(MIN_MAX_CHARS, Math.min(value ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS));

export function cutLongLine(line: string, limit: number): [string, boolean] {
  if (line.length <= limit) return [line, false];
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return [
    `${line.slice(0, head)} … [${line.length - limit} characters cut] … ${line.slice(-tail)}`,
    true,
  ];
}

/**
 * Keeps the end of `lines` within `maxChars`, or, with `fromLine` (1-based), the lines from
 * there on. Never empty when there are lines: the last (or first) one is always shown, cut.
 */
export function clipLines(
  lines: ReadonlyArray<string>,
  options: { readonly maxChars?: number | undefined; readonly fromLine?: number | undefined } = {},
): Clip {
  const maxChars = clampMaxChars(options.maxChars);
  const lineLimit = Math.min(MAX_LINE_CHARS, maxChars);
  const total = lines.length;
  const picked: Array<string> = [];
  let used = 0;
  let longLinesCut = 0;
  const take = (raw: string): boolean => {
    const [line, cut] = cutLongLine(raw, lineLimit);
    const cost = line.length + 1;
    if (picked.length > 0 && used + cost > maxChars) return false;
    if (cut) longLinesCut += 1;
    used += cost;
    picked.push(line);
    return true;
  };
  if (options.fromLine !== undefined) {
    const start = Math.max(1, Math.min(Math.floor(options.fromLine), total + 1));
    for (let index = start - 1; index < total && take(lines[index]!); index += 1);
    return {
      text: picked.join("\n"),
      first: picked.length > 0 ? start : 0,
      last: picked.length > 0 ? start + picked.length - 1 : 0,
      total,
      omittedBefore: start - 1,
      omittedAfter: total - (start - 1) - picked.length,
      longLinesCut,
    };
  }
  for (let index = total - 1; index >= 0 && take(lines[index]!); index -= 1);
  picked.reverse();
  return {
    text: picked.join("\n"),
    first: picked.length > 0 ? total - picked.length + 1 : 0,
    last: picked.length > 0 ? total : 0,
    total,
    omittedBefore: total - picked.length,
    omittedAfter: 0,
    longLinesCut,
  };
}

export interface FormatClipOptions {
  /** The output's beginning is gone (scrolled out of the history, or from before it was read). */
  readonly startLost?: boolean;
  /** How many lines the history keeps, for the note about a lost start. */
  readonly historyLines?: number;
}

/**
 * A result's output block: notes on what was cut, each with the call that reads it
 * (`readMore(fromLine)`), then the text.
 */
export function formatClip(
  clip: Clip,
  readMore: (fromLine: number) => string,
  options: FormatClipOptions = {},
): string {
  const notes: Array<string> = [];
  if (options.startLost) {
    notes.push(
      `[The beginning of this output is no longer in the terminal's history${
        options.historyLines === undefined ? "" : ` (${options.historyLines} lines)`
      }.]`,
    );
  }
  if (clip.omittedBefore > 0) {
    notes.push(
      `[Showing lines ${clip.first}-${clip.last} of ${clip.total}; ${clip.omittedBefore} earlier lines cut. Read them with ${readMore(1)}.]`,
    );
  }
  if (clip.longLinesCut > 0) {
    notes.push(`[${clip.longLinesCut} very long line(s) were shortened in the middle.]`);
  }
  const body = clip.total === 0 ? "(no output)" : clip.text;
  const tail =
    clip.omittedAfter > 0
      ? `\n[${clip.omittedAfter} more lines. Continue with ${readMore(clip.last + 1)}.]`
      : "";
  return (notes.length > 0 ? `${notes.join("\n")}\n` : "") + body + tail;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A command line for one-line mentions, keeping both ends (the program and its last arguments). */
export function shortCommand(commandLine: string, max = 80): string {
  const one = commandLine.trim().replace(/\s*\n\s*/g, " ⏎ ");
  if (one.length <= max) return one;
  const head = Math.ceil((max - 1) / 2);
  return `${one.slice(0, head)}…${one.slice(one.length - (max - 1 - head))}`;
}
