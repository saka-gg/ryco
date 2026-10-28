import { SIDEBAR_UNDO_BATCH_LIMIT } from "@ryco/client-runtime/state/threads";

import type { InboxSidebarRow } from "./inboxSidebarModel";

// Only the lazily loaded InboxSettleFinished imports this: a module the shell
// also imports would get a chunk file of its own.

/**
 * The rows "Settle finished" settles: idle threads among `rows` and their
 * folded delegated children whose finished result the user has seen (settling
 * a host alone would bring its children back). Oldest first, at most `limit`.
 */
export function selectSettleFinishedRows(
  rows: ReadonlyArray<InboxSidebarRow>,
  input: {
    readonly isUnseen: (row: InboxSidebarRow) => boolean;
    readonly limit?: number;
  },
): InboxSidebarRow[] {
  return rows
    .flatMap((row) => [row, ...row.delegatedChildren])
    .filter(
      (row) =>
        row.state === "idle" &&
        !row.settled &&
        row.snoozedUntil === null &&
        row.settlementActionEnabled &&
        row.latestTurnCompletedAt !== null &&
        !input.isUnseen(row),
    )
    .toSorted(
      (left, right) =>
        Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
        left.key.localeCompare(right.key),
    )
    .slice(0, input.limit ?? SIDEBAR_UNDO_BATCH_LIMIT);
}
