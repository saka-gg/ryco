import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { ScopedThreadRef } from "@ryco/contracts";
import { type MouseEvent, useLayoutEffect, useRef, useState } from "react";

import { isMacPlatform } from "../../lib/utils";
import {
  dispatchThreadSettlementBatch,
  dispatchThreadSnoozeBatch,
  presentSkippedThreads,
} from "../../threadLifecycleCommands";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadSelectionClick } from "../Sidebar.logic";
import { type InboxBulkActions, resolveInboxBulkActions } from "./inboxBulkTriage.logic";
import type { InboxSidebarRow } from "./inboxSidebarModel";

type DeleteThreads = (targets: readonly ScopedThreadRef[]) => Promise<boolean>;

/**
 * A multiple selection as it was when a row's menu opened. The menu's labels
 * and actions use it, never a later read of the selection.
 */
export interface InboxMenuSelection {
  readonly rows: ReadonlyArray<InboxSidebarRow>;
  readonly actions: InboxBulkActions;
  /** Deletes threads after one confirmation; false when declined. Absent: no Delete. */
  readonly deleteThreads: DeleteThreads | undefined;
}

export type InboxBulkRequest =
  | { readonly action: Exclude<keyof InboxBulkActions, "snooze"> }
  | { readonly action: "snooze"; readonly snoozedUntil: string };

/** One stable object for every row, so a selection change renders only the rows it changed. */
export interface InboxRowSelection {
  /**
   * Cmd-click (Ctrl-click off Mac) toggles the row and Shift-click selects the
   * displayed range. True when the click selected instead of opening the row.
   */
  readonly click: (row: InboxSidebarRow, event: MouseEvent) => boolean;
  /**
   * The displayed selection when `row` is one of several selected rows. Null
   * otherwise, and a selection without `row` is cleared (its menu acts on it alone).
   */
  readonly menuSelection: (row: InboxSidebarRow) => InboxMenuSelection | null;
  /** Clears the selection and changes the rows the request's action allows. */
  readonly run: (selection: InboxMenuSelection, request: InboxBulkRequest) => void;
}

export function useInboxRowSelection(input: {
  /** The rows the list shows, in order: selection ranges and bulk actions never reach others. */
  readonly displayedRows: ReadonlyArray<InboxSidebarRow>;
  readonly onDeleteThreads: DeleteThreads | undefined;
}): InboxRowSelection {
  const displayedRowsRef = useRef(input.displayedRows);
  const onDeleteThreadsRef = useRef(input.onDeleteThreads);
  useLayoutEffect(() => {
    // Read when a row is clicked; synced after render so the React Compiler can
    // optimize the list (render-time ref writes make it bail out).
    displayedRowsRef.current = input.displayedRows;
    onDeleteThreadsRef.current = input.onDeleteThreads;
    // A filter, a collapsed section or host, or a thread that left hides rows:
    // they leave the selection, so no action reaches what the list does not show.
    const store = useThreadSelectionStore.getState();
    if (store.selectedThreadKeys.size === 0) return;
    const displayed = new Set(input.displayedRows.map((row) => row.key));
    const hidden = [...store.selectedThreadKeys].filter((key) => !displayed.has(key));
    if (hidden.length > 0) store.removeFromSelection(hidden);
  }, [input.displayedRows, input.onDeleteThreads]);
  const [selection] = useState<InboxRowSelection>(() => ({
    click: (row, event) => {
      const intent = resolveThreadSelectionClick(event, isMacPlatform(navigator.platform));
      if (intent === null) return false;
      event.preventDefault();
      const store = useThreadSelectionStore.getState();
      if (intent === "toggle") store.toggleThread(row.key);
      else
        store.rangeSelectTo(
          row.key,
          displayedRowsRef.current.map((displayed) => displayed.key),
        );
      return true;
    },
    menuSelection: (row) => {
      const store = useThreadSelectionStore.getState();
      const selected = store.selectedThreadKeys;
      if (!selected.has(row.key)) {
        if (selected.size > 0) store.clearSelection();
        return null;
      }
      const rows = displayedRowsRef.current.filter((displayed) => selected.has(displayed.key));
      if (rows.length < 2) return null;
      return {
        rows,
        actions: resolveInboxBulkActions(rows),
        deleteThreads: onDeleteThreadsRef.current,
      };
    },
    run: (menuSelection, request) => {
      const rows = menuSelection.actions[request.action];
      const targets = rows.map((row) => scopeThreadRef(row.environmentId, row.threadId));
      const store = useThreadSelectionStore.getState();
      if (request.action === "delete") {
        // The selection stays while the confirmation is open, and when it is declined.
        void menuSelection.deleteThreads?.(targets).then((deleted) => {
          if (!deleted) return;
          store.clearSelection();
          const skipped = menuSelection.rows.filter((row) => !row.mutationEnabled).length;
          if (skipped > 0) presentSkippedThreads(skipped);
        });
        return;
      }
      store.clearSelection();
      switch (request.action) {
        case "settle":
        case "unsettle":
          void dispatchThreadSettlementBatch(targets, request.action === "settle");
          return;
        case "snooze":
          void dispatchThreadSnoozeBatch(targets, request.snoozedUntil);
          return;
        case "unsnooze":
          void dispatchThreadSnoozeBatch(targets, null);
          return;
        case "markUnread": {
          const { markThreadUnread } = useUiStateStore.getState();
          for (const row of rows) markThreadUnread(row.key, row.latestTurnCompletedAt);
          return;
        }
      }
    },
  }));
  return selection;
}
