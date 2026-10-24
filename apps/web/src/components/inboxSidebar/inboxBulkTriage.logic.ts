import { SIDEBAR_UNDO_BATCH_LIMIT } from "@ryco/client-runtime/state/threads";

import type { InboxSidebarRow } from "./inboxSidebarModel";

/** The rows of a selection each bulk action changes, in the selection's order. */
export interface InboxBulkActions {
  readonly settle: ReadonlyArray<InboxSidebarRow>;
  /** Move to Active. */
  readonly unsettle: ReadonlyArray<InboxSidebarRow>;
  readonly snooze: ReadonlyArray<InboxSidebarRow>;
  readonly unsnooze: ReadonlyArray<InboxSidebarRow>;
  readonly markUnread: ReadonlyArray<InboxSidebarRow>;
  readonly delete: ReadonlyArray<InboxSidebarRow>;
}

/**
 * Splits selected rows by the actions a row's own menu allows them, keeping at
 * most `limit` rows per action.
 */
export function resolveInboxBulkActions(
  rows: ReadonlyArray<InboxSidebarRow>,
  limit = SIDEBAR_UNDO_BATCH_LIMIT,
): InboxBulkActions {
  const take = (eligible: (row: InboxSidebarRow) => boolean) =>
    rows.filter(eligible).slice(0, limit);
  return {
    settle: take((row) => !row.settled && row.settlementActionEnabled),
    unsettle: take((row) => row.settled && row.settlementActionEnabled),
    snooze: take((row) => row.canSnooze),
    unsnooze: take((row) => row.canUnsnooze),
    // Local to this client; only a finished turn has anything to mark.
    markUnread: take((row) => row.latestTurnCompletedAt !== null),
    // Deleting needs a machine that takes changes now, as in the row menu.
    delete: take((row) => row.mutationEnabled),
  };
}
