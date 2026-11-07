import { resolveSnoozePresets } from "@ryco/shared/threadSnooze";

import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { newCommandId } from "../../lib/ids";
import { changeThreadPin } from "../../state/threadPins";
import { dispatchThreadListCommand } from "../threadList/threadListCommands";
import { requestCustomSnooze } from "./customSnoozeModel";
import type { InboxThreadRow } from "./inboxModel";
import {
  ARCHIVE_TASK_ACTION_ID,
  COPY_TASK_ID_ACTION_ID,
  CUSTOM_SNOOZE_ACTION_ID,
  PIN_TASK_ACTION_ID,
  UNPIN_TASK_ACTION_ID,
} from "./inboxRowActions";

export function archiveInboxRow(row: InboxThreadRow): void {
  if (!row.canArchive) return;
  dispatchThreadListCommand(
    row,
    { type: "thread.archive", threadId: row.threadId, commandId: newCommandId() },
    { dismiss: true, failureTitle: "Could not archive task" },
  );
}

/** Snoozes the row's thread until `until`, or wakes it with null. */
export function snoozeInboxRow(row: InboxThreadRow, until: string | null): void {
  if (!(until ? row.canSnooze : row.canUnsnooze)) return;
  dispatchThreadListCommand(
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
    dispatchThreadListCommand(
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
    dispatchThreadListCommand(
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
