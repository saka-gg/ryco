// FILE: HighlightedText.tsx
// Purpose: Renders text with the first case-insensitive match of a query marked, the way the
//          folder picker and the project selector highlight what a search matched.
// Layer: Web UI. The matching itself is `highlightMatch` (pure, folderPicker.logic.ts).

import { Fragment } from "react";

import { highlightMatch } from "./folderPicker.logic";

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
