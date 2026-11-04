// FILE: NodePathText.tsx
// Purpose: How node + path rows keep what matters visible: a path that doesn't fit gives way
//          at its start ("…/ui/ws/demo"), so the folder's own name stays readable, and a list's
//          node-name column is as wide as its longest name (up to a cap) instead of a fixed
//          width that cuts "MacBook Pro M5" to "MacBook Pro M…".
// Layer: Web UI, presentational. Used by the project selector's checkout rows, the add-project
//        dialog's source and done steps, and the folder picker's search results.

import { useLayoutEffect, type ReactNode, type RefObject } from "react";

import { cn } from "~/lib/utils";

/**
 * A path on one line that, when it doesn't fit, is cut at its start with an
 * ellipsis ("…/code/notes-app"). `children` replaces the plain text (e.g. with
 * highlighted matches); the full path is the tooltip.
 */
export function NodePathText(props: {
  readonly path: string;
  readonly children?: ReactNode;
  readonly title?: string | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <span
      // The box runs right to left so the ellipsis lands at the start; the isolated
      // left-to-right run inside keeps the path's own order, "/" and "~" included.
      className={cn("block min-w-0 truncate text-left [direction:rtl]", props.className)}
      title={props.title ?? props.path}
      data-slot="node-path"
    >
      <bdi dir="ltr">{props.children ?? props.path}</bdi>
    </span>
  );
}

/** The CSS variable a list's node-name cells take their width from. */
export const NODE_LABEL_COLUMN_VAR = "--node-label-column";
/** Marks a node-name cell `useNodeLabelColumn` measures. */
export const NODE_LABEL_CELL = { "data-node-label": "" } as const;

const NODE_LABEL_COLUMN_MIN_PX = 48;
export const NODE_LABEL_COLUMN_MAX_PX = 160;

/**
 * Sizes the node-name column of the rows inside `container` to the widest name
 * among its `NODE_LABEL_CELL` cells, between 48 and 160 px, by setting
 * `--node-label-column` on the container. Cells read it, e.g.
 * `w-(--node-label-column)` or a grid track. Measured again whenever `key`
 * changes (the rows); a name that is still too long truncates at its end.
 */
export function useNodeLabelColumn(container: RefObject<HTMLElement | null>, key: unknown): void {
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const range = document.createRange();
    let widest = 0;
    for (const cell of element.querySelectorAll<HTMLElement>("[data-node-label]")) {
      // The text's own width, not the cell's: a cell sized by the previous answer would
      // otherwise keep the column from ever narrowing.
      range.selectNodeContents(cell);
      widest = Math.max(widest, range.getBoundingClientRect().width);
    }
    range.detach();
    if (widest === 0) {
      element.style.removeProperty(NODE_LABEL_COLUMN_VAR);
      return;
    }
    const width = Math.min(
      NODE_LABEL_COLUMN_MAX_PX,
      Math.max(NODE_LABEL_COLUMN_MIN_PX, Math.ceil(widest)),
    );
    element.style.setProperty(NODE_LABEL_COLUMN_VAR, `${width}px`);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- new rows are measured again
  }, [container, key]);
}
