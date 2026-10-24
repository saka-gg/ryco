import type { SidebarUndoDescribe } from "@ryco/client-runtime/state/threads";
import type {
  SidebarBatchCommand,
  SidebarUndoBatchResult,
} from "@ryco/client-runtime/state/threads/sidebarUndoBatch";
import type { ScopedThreadRef, ThreadId } from "@ryco/contracts";

import {
  canArchiveSidebarThread,
  shouldConfirmSidebarThreadArchive,
} from "./components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { readEnvironmentApi } from "./environmentApi";
import { newCommandId } from "./lib/utils";
import { readLocalApi } from "./localApi";
import { readSidebarUndoContext, sidebarUndo } from "./sidebarUndo";
import type { SidebarThreadSummary } from "./types";

// The lifecycle changes every surface makes (Inbox rows and menus, the project
// sidebar, shortcuts, the command palette). Each goes through sidebarUndo, so
// receipts, Undo and the owning node's checks stay in one place. Failures are
// shown here.

const errorDescription = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const settlementCommand = (threadId: ThreadId, settled: boolean) =>
  settled
    ? ({ type: "thread.settle", commandId: newCommandId(), threadId } as const)
    : ({ type: "thread.unsettle", commandId: newCommandId(), threadId, reason: "user" } as const);

const snoozeCommand = (threadId: ThreadId, snoozedUntil: string | null) =>
  snoozedUntil
    ? ({ type: "thread.snooze", commandId: newCommandId(), threadId, snoozedUntil } as const)
    : ({ type: "thread.unsnooze", commandId: newCommandId(), threadId } as const);

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
  const failureTitle = settled ? "Could not settle thread" : "Could not move thread to Active";
  try {
    await sidebarUndo.dispatch(target, settlementCommand(target.threadId, settled));
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
  try {
    await sidebarUndo.dispatch(target, snoozeCommand(target.threadId, snoozedUntil));
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not update snooze",
      description: errorDescription(error, "The request failed."),
    });
  }
}

const threadCount = (count: number) => (count === 1 ? "1 thread" : `${count} threads`);

/** Says that a bulk action left `count` threads alone: their machine takes no changes now. */
export function presentSkippedThreads(count: number): void {
  toastManager.add({
    type: "warning",
    title: `Skipped ${threadCount(count)}`,
    description: `${count === 1 ? "Its" : "Their"} machine is not ready. Try again when it reconnects.`,
  });
}

/** A bulk notice's copy; `count` is what its Undo still restores. */
const bulkNoticeCopy =
  (action: "settle" | "snooze", applyingVerb: string, doneVerb: string): SidebarUndoDescribe =>
  ({ count, applying }) => ({
    title: applying
      ? `${applyingVerb} ${threadCount(count)}…`
      : `${threadCount(count)} ${doneVerb}`,
    undoLabel: `Undo ${action} for ${threadCount(count)}`,
  });

/**
 * Sends one lifecycle command to each thread, with one Undo notice for the lot.
 * Shows at most one toast each for failed threads, skipped threads (their
 * machine is not ready) and threads whose machine cannot undo. Never rejects.
 */
async function dispatchThreadBatch(
  targets: readonly ScopedThreadRef[],
  command: (threadId: ThreadId) => SidebarBatchCommand,
  copy: { readonly failure: (threads: string) => string; readonly notice?: SidebarUndoDescribe },
): Promise<SidebarUndoBatchResult | null> {
  let result: SidebarUndoBatchResult;
  try {
    // Loaded with the first bulk action, so the shell does not carry it.
    const { dispatchSidebarUndoBatch } =
      await import("@ryco/client-runtime/state/threads/sidebarUndoBatch");
    result = await dispatchSidebarUndoBatch({
      history: sidebarUndo,
      readContext: readSidebarUndoContext,
      newCommandId,
      targets,
      command: (target) => command(target.threadId),
      describe: copy.notice,
    });
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: copy.failure(threadCount(targets.length)),
        description: errorDescription(error, "The request failed."),
      }),
    );
    return null;
  }
  const { applied, skipped, failed, withoutUndo } = result;
  const [firstFailure] = failed;
  if (firstFailure) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: copy.failure(threadCount(failed.length)),
        description: errorDescription(firstFailure.error, "The request failed."),
      }),
    );
  }
  if (skipped.length > 0) presentSkippedThreads(skipped.length);
  // The notice counts only what its Undo restores; say why the rest is missing.
  if (withoutUndo > 0 && applied.length > withoutUndo) {
    toastManager.add({
      type: "info",
      title: `${threadCount(withoutUndo)} cannot be undone`,
      description: `Update ${withoutUndo === 1 ? "its" : "their"} machine to use Undo.`,
    });
  }
  return result;
}

/** Settles threads, or moves them back to Active, at most 100 at once. */
export function dispatchThreadSettlementBatch(
  targets: readonly ScopedThreadRef[],
  settled: boolean,
): Promise<SidebarUndoBatchResult | null> {
  return dispatchThreadBatch(
    targets,
    (threadId) => settlementCommand(threadId, settled),
    settled
      ? {
          failure: (threads) => `Could not settle ${threads}`,
          notice: bulkNoticeCopy("settle", "Settling", "settled"),
        }
      : { failure: (threads) => `Could not move ${threads} to Active` },
  );
}

/** Snoozes threads until `snoozedUntil`, or wakes them with null, at most 100 at once. */
export function dispatchThreadSnoozeBatch(
  targets: readonly ScopedThreadRef[],
  snoozedUntil: string | null,
): Promise<SidebarUndoBatchResult | null> {
  return dispatchThreadBatch(
    targets,
    (threadId) => snoozeCommand(threadId, snoozedUntil),
    snoozedUntil
      ? {
          failure: (threads) => `Could not snooze ${threads}`,
          notice: bulkNoticeCopy("snooze", "Snoozing", "snoozed"),
        }
      : { failure: (threads) => `Could not unsnooze ${threads}` },
  );
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
