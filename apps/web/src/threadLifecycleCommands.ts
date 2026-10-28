import type { ScopedThreadRef } from "@ryco/contracts";

import {
  canArchiveSidebarThread,
  shouldConfirmSidebarThreadArchive,
} from "./components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { readEnvironmentApi } from "./environmentApi";
import { newCommandId } from "./lib/utils";
import { readLocalApi } from "./localApi";
import { sidebarUndo } from "./sidebarUndo";
import type { SidebarThreadSummary } from "./types";

// The lifecycle changes every surface makes (Inbox rows and menus, the project
// sidebar, shortcuts, the command palette). Each goes through sidebarUndo, so
// receipts, Undo and the owning node's checks stay in one place. Failures are
// shown here.

const errorDescription = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** Settles a thread, or moves it back to Active. Resolves whether the node took it. */
export async function dispatchThreadSettlement(
  target: ScopedThreadRef,
  settled: boolean,
): Promise<boolean> {
  if (!readEnvironmentApi(target.environmentId)) {
    toastManager.add({
      type: "error",
      title: "Could not update thread",
      description: "The owning machine is not connected.",
    });
    return false;
  }
  const command = settled
    ? ({ type: "thread.settle", commandId: newCommandId(), threadId: target.threadId } as const)
    : ({
        type: "thread.unsettle",
        commandId: newCommandId(),
        threadId: target.threadId,
        reason: "user",
      } as const);
  const failureTitle = settled ? "Could not settle thread" : "Could not move thread to Active";
  try {
    await sidebarUndo.dispatch(target, command);
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: failureTitle,
      description: errorDescription(error, "The request failed."),
    });
    return false;
  }
}

/** Snoozes a thread until `snoozedUntil`, or wakes it with null. */
export async function dispatchThreadSnooze(
  target: ScopedThreadRef,
  snoozedUntil: string | null,
): Promise<void> {
  if (!readEnvironmentApi(target.environmentId)) {
    toastManager.add({
      type: "error",
      title: "Could not update snooze",
      description: "The owning machine is not connected.",
    });
    return;
  }
  const command = snoozedUntil
    ? ({
        type: "thread.snooze",
        commandId: newCommandId(),
        threadId: target.threadId,
        snoozedUntil,
      } as const)
    : ({ type: "thread.unsnooze", commandId: newCommandId(), threadId: target.threadId } as const);
  try {
    await sidebarUndo.dispatch(target, command);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not update snooze",
      description: errorDescription(error, "The request failed."),
    });
  }
}

type ArchiveThread = (target: ScopedThreadRef) => Promise<void>;

/** Archives a thread, or says why it cannot. */
export async function attemptThreadArchive(input: {
  readonly target: ScopedThreadRef;
  /** The listed thread, when known: one without a conversation is not archived. */
  readonly thread: Pick<SidebarThreadSummary, "latestUserMessageAt" | "lineage"> | undefined;
  readonly archiveThread: ArchiveThread;
}): Promise<void> {
  if (input.thread !== undefined && !canArchiveSidebarThread(input.thread)) {
    toastManager.add({ type: "warning", title: "Send a message before archiving" });
    return;
  }
  try {
    await input.archiveThread(input.target);
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to archive thread",
        description: errorDescription(error, "An error occurred."),
      }),
    );
  }
}

async function confirmWithDialog(message: string): Promise<boolean> {
  const localApi = readLocalApi();
  return localApi ? localApi.dialogs.confirm(message) : window.confirm(message);
}

/** Archives a thread, asking first when "Archive confirmation" is on. */
export async function requestThreadArchive(
  input: {
    readonly target: ScopedThreadRef;
    readonly thread: Pick<SidebarThreadSummary, "title" | "latestUserMessageAt" | "lineage">;
    readonly isDraft: boolean;
    readonly confirmThreadArchive: boolean;
    readonly archiveThread: ArchiveThread;
  },
  confirm: (message: string) => Promise<boolean> = confirmWithDialog,
): Promise<void> {
  if (
    shouldConfirmSidebarThreadArchive({
      archiveAvailable: !input.isDraft && canArchiveSidebarThread(input.thread),
      confirmThreadArchive: input.confirmThreadArchive,
    }) &&
    !(await confirm(
      [
        `Archive thread "${input.thread.title}"?`,
        "Its session stops and its history is kept indefinitely. Unarchive it from Settings › Archive.",
      ].join("\n"),
    ))
  ) {
    return;
  }
  await attemptThreadArchive(input);
}
