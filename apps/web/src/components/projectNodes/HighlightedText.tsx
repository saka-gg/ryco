// FILE: HighlightedText.tsx
// Purpose: Renders text with the first case-insensitive match of a query marked, the way the
//          folder picker and the project selector highlight what a search matched.
// Layer: Web UI. `highlightMatch` lives here, not with the folder picker's logic, so the
//        project selector (on the chat route) does not carry the picker's status logic.

import { Fragment } from "react";

export interface HighlightSegment {
  readonly text: string;
  readonly match: boolean;
}

/** `text` cut around the first case-insensitive occurrence of `query`. */
export function highlightMatch(text: string, query: string): HighlightSegment[] {
  const needle = query.trim().toLowerCase();
  const index = needle.length === 0 ? -1 : text.toLowerCase().indexOf(needle);
  if (index < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, index), match: false },
    { text: text.slice(index, index + needle.length), match: true },
    { text: text.slice(index + needle.length), match: false },
  ].filter((segment) => segment.text.length > 0);
}

export function HighlightedText(props: { readonly text: string; readonly query: string }) {
  return (
    <>
      {highlightMatch(props.text, props.query).map((segment, index) =>
        segment.match ? (
          // oxlint-disable-next-line react/no-array-index-key -- segments are positional
          <mark key={index} className="rounded-[2px] bg-warning/38 text-inherit">
            {segment.text}
          </mark>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- segments are positional
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}
