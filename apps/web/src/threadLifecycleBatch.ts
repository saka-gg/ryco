import type { SidebarUndoDescribe } from "@ryco/client-runtime/state/threads";
import {
  dispatchSidebarUndoBatch,
  type SidebarBatchCommand,
  type SidebarUndoBatchResult,
} from "@ryco/client-runtime/state/threads/sidebarUndoBatch";
import type { ScopedThreadRef, ThreadId } from "@ryco/contracts";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { newCommandId } from "./lib/utils";
import { readSidebarUndoContext, sidebarUndo } from "./sidebarUndo";

// The bulk half of threadLifecycleCommands.ts, which loads it with the first
// bulk action and hands it the command to send, so the shell does not carry
// it. Import only boot modules here: a module that also sits in a shell chunk
// would move into a chunk file of its own and add a request to the shell.

export type ThreadBatchAction = "settle" | "unsettle" | "snooze" | "unsnooze";

const threadCount = (count: number) => (count === 1 ? "1 thread" : `${count} threads`);

const errorDescription = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed.";

/** Says that a bulk action left `count` threads alone: their machine takes no changes now. */
export function presentSkippedThreads(count: number): void {
  toastManager.add({
    type: "warning",
    title: `Skipped ${threadCount(count)}`,
    description: `${count === 1 ? "Its" : "Their"} machine is not ready. Try again when it reconnects.`,
  });
}

/** A bulk notice's copy; `count` is what its Undo still restores. */
const noticeCopy =
  (action: "settle" | "snooze", applyingVerb: string, doneVerb: string): SidebarUndoDescribe =>
  ({ count, applying }) => ({
    title: applying
      ? `${applyingVerb} ${threadCount(count)}…`
      : `${threadCount(count)} ${doneVerb}`,
    undoLabel: `Undo ${action} for ${threadCount(count)}`,
  });

const COPY: Record<
  ThreadBatchAction,
  { readonly failure: (threads: string) => string; readonly notice?: SidebarUndoDescribe }
> = {
  settle: {
    failure: (threads) => `Could not settle ${threads}`,
    notice: noticeCopy("settle", "Settling", "settled"),
  },
  unsettle: { failure: (threads) => `Could not move ${threads} to Active` },
  snooze: {
    failure: (threads) => `Could not snooze ${threads}`,
    notice: noticeCopy("snooze", "Snoozing", "snoozed"),
  },
  unsnooze: { failure: (threads) => `Could not unsnooze ${threads}` },
};

/**
 * Sends one lifecycle command to each thread, with one Undo notice for the lot.
 * Shows at most one toast each for failed threads, skipped threads (their
 * machine is not ready) and threads whose machine cannot undo. Never rejects.
 */
export async function dispatchThreadBatch(
  targets: readonly ScopedThreadRef[],
  action: ThreadBatchAction,
  command: (threadId: ThreadId) => SidebarBatchCommand,
): Promise<SidebarUndoBatchResult | null> {
  const copy = COPY[action];
  let result: SidebarUndoBatchResult;
  try {
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
        description: errorDescription(error),
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
        description: errorDescription(firstFailure.error),
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
