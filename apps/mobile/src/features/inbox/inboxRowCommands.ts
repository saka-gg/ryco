import type { SidebarActionCommand } from "@ryco/client-runtime/state/threads";
import { resolveSnoozePresets } from "@ryco/shared/threadSnooze";
import { Alert } from "react-native";

import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { newCommandId } from "../../lib/ids";
import { sidebarUndo } from "../../state/sidebarUndo";
import { changeThreadPin } from "../../state/threadPins";
import { withThreadDismissal } from "../threadList/threadDismissal";
import { requestCustomSnooze } from "./customSnoozeModel";
import type { InboxThreadRow } from "./inboxModel";
import {
  ARCHIVE_TASK_ACTION_ID,
  COPY_TASK_ID_ACTION_ID,
  CUSTOM_SNOOZE_ACTION_ID,
  PIN_TASK_ACTION_ID,
  UNPIN_TASK_ACTION_ID,
} from "./inboxRowActions";

/**
 * Sends one row command through the shared Undo history. A command that takes
 * the row out of where it is listed (archive, settle, snooze, hide) lets the
 * row animate out first and brings it back when the command fails.
 */
function dispatchRowCommand(
  row: InboxThreadRow,
  command: SidebarActionCommand,
  options: { readonly dismiss: boolean; readonly failureTitle: string },
): void {
  const target = { environmentId: row.environmentId, threadId: row.threadId };
  const send = async () => {
    await sidebarUndo.dispatch(target, command);
    return true;
  };
  void (options.dismiss ? withThreadDismissal(row.key, send, Boolean) : send()).catch(
    (error: unknown) =>
      Alert.alert(
        options.failureTitle,
        error instanceof Error ? error.message : "The request failed.",
      ),
  );
}

export function archiveInboxRow(row: InboxThreadRow): void {
  if (!row.canArchive) return;
  dispatchRowCommand(
    row,
    { type: "thread.archive", threadId: row.threadId, commandId: newCommandId() },
    { dismiss: true, failureTitle: "Could not archive task" },
  );
}

/** Snoozes the row's thread until `until`, or wakes it with null. */
export function snoozeInboxRow(row: InboxThreadRow, until: string | null): void {
  if (!(until ? row.canSnooze : row.canUnsnooze)) return;
  dispatchRowCommand(
    row,
    until
      ? {
          type: "thread.snooze",
          threadId: row.threadId,
          commandId: newCommandId(),
          snoozedUntil: until,
        }
      : { type: "thread.unsnooze", threadId: row.threadId, commandId: newCommandId() },
    // A snoozed row leaves Active; a woken one only moves up.
    { dismiss: until !== null, failureTitle: "Could not update snooze" },
  );
}

export function setInboxRowPinned(row: InboxThreadRow, pinned: boolean): void {
  changeThreadPin(row.key, pinned);
}

/** Runs one action of a row's long-press menu or its swipe Snooze menu. */
export function runInboxRowAction(row: InboxThreadRow, event: string): void {
  if (event === COPY_TASK_ID_ACTION_ID) {
    copyTextWithHaptic(row.threadId, { target: "task ID" });
    return;
  }
  if (event === PIN_TASK_ACTION_ID || event === UNPIN_TASK_ACTION_ID) {
    setInboxRowPinned(row, event === PIN_TASK_ACTION_ID);
    return;
  }
  if (event === ARCHIVE_TASK_ACTION_ID) {
    archiveInboxRow(row);
    return;
  }
  if (event === "settle" || event === "unsettle") {
    if (!row.mutationEnabled || !row.canSettle) return;
    dispatchRowCommand(
      row,
      event === "settle"
        ? { type: "thread.settle", threadId: row.threadId, commandId: newCommandId() }
        : {
            type: "thread.unsettle",
            threadId: row.threadId,
            commandId: newCommandId(),
            reason: "user",
          },
      { dismiss: event === "settle", failureTitle: "Could not update task" },
    );
    return;
  }
  if (event === "hide" || event === "unhide") {
    if (!row.hideActionEnabled) return;
    dispatchRowCommand(
      row,
      {
        type: event === "hide" ? "thread.hide" : "thread.unhide",
        threadId: row.threadId,
        commandId: newCommandId(),
      },
      { dismiss: event === "hide", failureTitle: "Could not update task" },
    );
    return;
  }
  if (event === CUSTOM_SNOOZE_ACTION_ID) {
    if (!row.canSnooze) return;
    void requestCustomSnooze().then((until) => {
      if (until) snoozeInboxRow(row, until);
    });
    return;
  }
  // The snooze instant is resolved at press time, not from the rendered list.
  const until =
    event === "unsnooze"
      ? null
      : resolveSnoozePresets(new Date()).find((preset) => preset.id === event)?.snoozedUntil;
  if (until === undefined) return;
  snoozeInboxRow(row, until);
}
