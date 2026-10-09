// FILE: path-text.tsx
// Purpose: The two ways a filesystem path is shown in running UI: on one line,
//          shortening its parent folders first so the name stays readable, or
//          wrapped between folders instead of inside their names.
// Layer: Web UI primitives. Path splitting lives in `lib/projectPaths.ts`.

import type { CSSProperties } from "react";

import { splitPathAtSeparators, splitPathForDisplay } from "~/lib/projectPaths";
import { cn } from "~/lib/utils";

/** Parents this short ("/", "C:\") are shown whole; longer ones may ellipsize. */
const SHORT_PARENT_CHARS = 3;

/**
 * Characters at the end of a long name that stay visible when the name itself
 * has to shorten: a chat folder's "-<8 hex>" id and one more. Names up to twice
 * this long (every chat folder is longer) truncate at their end.
 */
const LEAF_END_CHARS = 10;

/** Text whose every character fills exactly one cell of a monospace font. */
const SINGLE_CELL_TEXT = /^[\u0020-\u007e\u00a0-\u00ac\u00ae-\u017f]*$/;

/**
 * In a monospace font the cut-down start of a long name spans whole character
 * cells, so its "…" ends flush against the kept end instead of leaving part of
 * a cell that reads as a space (the spare part lands after the end). A tenth of
 * a pixel of headroom keeps a name that fits exactly from rounding a cell short,
 * and a tenth of slack lets the last cell survive layout rounding; together they
 * clip at most a fifth of a pixel off the end's right edge.
 */
const CELL_ALIGNED_START_STYLE: CSSProperties = {
  maxWidth: `calc(round(down, 100% - ${LEAF_END_CHARS}ch + 0.1px, 1ch) + 0.1px)`,
};

let graphemeSegmenter: Intl.Segmenter | undefined;

/**
 * Cuts a long name before its last `LEAF_END_CHARS` characters, counted in
 * graphemes so an accent or an emoji is never split between the two parts.
 * `null` for a name short enough to stay one piece.
 */
function splitLeafEnd(leaf: string): { readonly start: string; readonly end: string } | null {
  if (leaf.length <= LEAF_END_CHARS * 2) return null;
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = Array.from(graphemeSegmenter.segment(leaf), (part) => part.segment);
  if (graphemes.length <= LEAF_END_CHARS * 2) return null;
  return {
    start: graphemes.slice(0, -LEAF_END_CHARS).join(""),
    end: graphemes.slice(-LEAF_END_CHARS).join(""),
  };
}

/**
 * A path on one line. When space runs out the parent folders give way first,
 * from the outermost one in ("…/projects/name", down to "…/name"), and only
 * then the last segment: a long one in its middle, keeping its end (a chat
 * folder's id) readable ("…/2026-10-08-plan-a-…p-1a2b3c4d"). The full path is
 * the tooltip. Renders as a flex row aligned on its text baseline, so labels
 * beside it line up whether or not it has parents.
 */
export function TruncatedPath(props: {
  readonly path: string;
  readonly className?: string | undefined;
  /** Classes for the parent folders, with the separator before the last segment. */
  readonly parentClassName?: string | undefined;
  readonly leafClassName?: string | undefined;
  /**
   * The path is set in a monospace font: a long name that shortens is then cut
   * at whole characters, so its "…" sits flush against the end it keeps.
   */
  readonly monospace?: boolean | undefined;
}) {
  const { head, separator, leaf } = splitPathForDisplay(props.path);
  const parent = `${head}${separator}`;
  const leafParts = splitLeafEnd(leaf);
  const cellAligned = props.monospace === true && SINGLE_CELL_TEXT.test(leaf);
  return (
    <span
      className={cn("flex min-w-0 items-baseline", props.className)}
      title={props.path}
      data-slot="truncated-path"
    >
      {parent ? (
        <span
          data-slot="truncated-path-parent"
          className={cn(
            parent.length > SHORT_PARENT_CHARS
              ? // Gives up its width before the leaf gives up any (flex-shrink is
                // weighted by size, and at a smaller factor the leaf lost a
                // fraction of a pixel, enough for a "…" in a name that fit), and
                // right to left: the ellipsis replaces the outermost folders,
                // keeps the ones nearest the name, and at its narrowest leaves
                // "…/" (the separator ends the parent). Space left over from
                // cutting at a character lands at the outer edge.
                "min-w-[2ch] shrink-[1000000] truncate [direction:rtl]"
              : "shrink-0",
            props.parentClassName,
          )}
        >
          {/* An isolated left-to-right run: the path reads in order inside the rtl box. */}
          <span dir="ltr">{parent}</span>
        </span>
      ) : null}
      {leafParts ? (
        // Its own baseline-aligned row: the start ellipsizes down to "…" while
        // the end never shrinks. Whitespace is kept so a space at the cut
        // survives; the row clips rather than spills on an absurdly narrow line.
        <span
          data-slot="truncated-path-leaf"
          className={cn("flex min-w-0 items-baseline overflow-clip", props.leafClassName)}
        >
          <span
            data-slot="truncated-path-leaf-start"
            className={cn(
              "min-w-[1ch] overflow-hidden text-ellipsis whitespace-pre",
              // Sized by its whole-cell cap alone, never squeezed in between;
              // where `round()` is missing it shrinks like any flex item.
              cellAligned && "supports-[width:round(1px,1px)]:shrink-0",
            )}
            style={cellAligned ? CELL_ALIGNED_START_STYLE : undefined}
          >
            {leafParts.start}
          </span>
          <span data-slot="truncated-path-leaf-end" className="shrink-0 whitespace-pre">
            {leafParts.end}
          </span>
        </span>
      ) : (
        <span
          data-slot="truncated-path-leaf"
          className={cn("min-w-0 truncate", props.leafClassName)}
        >
          {leaf}
        </span>
      )}
    </span>
  );
}

/**
 * A path that wraps between folders (after each separator) and breaks inside
 * a name only when that name alone is wider than the line. Each folder is an
 * inline block, so the hyphens of a slug like "2026-10-08-plan-a-trip" are no
 * break points while the whole name still fits on a line.
 */
export function WrappingPath(props: {
  readonly path: string;
  readonly className?: string | undefined;
}) {
  return (
    <span className={cn("[overflow-wrap:anywhere]", props.className)} data-slot="wrapping-path">
      {splitPathAtSeparators(props.path).map((chunk, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- folders are positional and can repeat
        <span key={index} className="inline-block max-w-full">
          {chunk}
        </span>
      ))}
    </span>
  );
}
