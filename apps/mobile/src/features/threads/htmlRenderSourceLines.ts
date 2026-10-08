import {
  HTML_RENDER_SOURCE_PREVIEW_MAX_CHARS,
  stripHtmlRenderBootstrap,
} from "@ryco/shared/htmlRender";

/**
 * How much of a page's source the full-screen Source view shows: the same cap
 * web's Source view uses. The source of a page with inlined images can run to
 * megabytes; its head is what a reader wants to read, and Share has the rest.
 */
export const HTML_RENDER_SOURCE_MAX_CHARS = HTML_RENDER_SOURCE_PREVIEW_MAX_CHARS;

/**
 * Longest stretch of source one row of the Source view holds. An inlined image
 * is a single line of hundreds of kilobytes; laid out as one text it would cost
 * a frame's worth of layout and memory on its own, so a long line arrives as
 * consecutive rows that wrap like the line they came from.
 */
export const HTML_RENDER_SOURCE_ROW_CHARS = 2_000;

export interface HtmlRenderSourceLines {
  readonly rows: ReadonlyArray<string>;
  /** The source was longer than `HTML_RENDER_SOURCE_MAX_CHARS`; only its start is shown. */
  readonly truncated: boolean;
}

/** `end`, or one before it where `end` would split a surrogate pair. */
function cutAt(text: string, end: number): number {
  if (end >= text.length) return text.length;
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/**
 * The page as the agent wrote it (without Ryco's injected bootstrap), capped
 * and split into the rows the Source view lists.
 */
export function buildHtmlRenderSourceLines(html: string): HtmlRenderSourceLines {
  const source = stripHtmlRenderBootstrap(html);
  const truncated = source.length > HTML_RENDER_SOURCE_MAX_CHARS;
  const shown = truncated ? source.slice(0, cutAt(source, HTML_RENDER_SOURCE_MAX_CHARS)) : source;
  const rows: string[] = [];
  for (const line of shown.split(/\r\n|\r|\n/)) {
    let start = 0;
    do {
      const end = cutAt(line, start + HTML_RENDER_SOURCE_ROW_CHARS);
      rows.push(line.slice(start, end));
      start = end;
    } while (start < line.length);
  }
  // A trailing newline ends the last line; it does not start an empty one.
  if (rows.length > 1 && rows.at(-1) === "") rows.pop();
  return { rows, truncated };
}
