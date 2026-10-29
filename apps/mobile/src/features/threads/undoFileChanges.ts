import {
  UNDO_FILE_CHANGES_COPY,
  keptChangesRestoreNote,
  revertCheckpointGuardFailureMessage,
  runCheckpointRevert,
  type CheckpointRevertMode,
  type CheckpointRevertNotice,
  type CheckpointRevertThreadView,
} from "@ryco/client-runtime/state/session";
import type { EnvironmentApi, EnvironmentId, ThreadId } from "@ryco/contracts";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { newCommandId } from "../../lib/ids";

// "Undo file changes" under a reply on mobile, over the shared revert
// (`runCheckpointRevert`): the turn's files go back and the chat stays, or,
// when the agent can forget turns, the thread is reverted with them.

/** Asks whether to undo only the files or revert the thread too; null when cancelled. */
export function chooseUndoFileChangesMode(input: {
  /** The agent can forget turns, so "Revert thread too" is offered. */
  readonly revertThreadAvailable: boolean;
  /** An earlier revert's checkpoint whose kept changes restoring would discard too. */
  readonly keptChangesTurnCount?: number | null | undefined;
}): Promise<CheckpointRevertMode | null> {
  const notes = [
    UNDO_FILE_CHANGES_COPY.description,
    UNDO_FILE_CHANGES_COPY.replacedNote,
    ...(input.keptChangesTurnCount === null || input.keptChangesTurnCount === undefined
      ? []
      : [keptChangesRestoreNote(input.keptChangesTurnCount)]),
    ...(input.revertThreadAvailable ? [UNDO_FILE_CHANGES_COPY.revertThreadNote] : []),
  ];
  return new Promise((resolve) => {
    showConfirmDialog({
      title: UNDO_FILE_CHANGES_COPY.title,
      message: notes.join(" "),
      confirmText: UNDO_FILE_CHANGES_COPY.keepChat,
      destructive: true,
      ...(input.revertThreadAvailable
        ? {
            alternative: {
              text: UNDO_FILE_CHANGES_COPY.revertThread,
              destructive: true,
              onPress: () => resolve("restore-files"),
            },
          }
        : {}),
      onConfirm: () => resolve("keep-chat"),
      onCancel: () => resolve(null),
    });
  });
}

export interface UndoFileChangesResult {
  /** What to tell the user went wrong, or null. */
  readonly error: string | null;
  /** The node's note on a finished undo, worth showing. */
  readonly notice: CheckpointRevertNotice | null;
}

/**
 * The whole flow, outside the screen: refuse early, ask, send the undo, and wait
 * for the node's verdict.
 */
export async function runUndoFileChanges(input: {
  readonly api: EnvironmentApi | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The checkpoint before the turn whose files go back. */
  readonly turnCount: number;
  readonly environmentUnavailable: boolean;
  readonly turnInProgress: boolean;
  /** Why the agent cannot forget turns; the files can still be undone. */
  readonly providerRefusal: string | null;
  readonly keptChangesTurnCount: number | null;
  readonly readThread: () => CheckpointRevertThreadView | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}): Promise<UndoFileChangesResult> {
  const { api } = input;
  const result = await runCheckpointRevert({
    environmentId: input.environmentId,
    dispatchCommand: api ? (command) => api.orchestration.dispatchCommand(command) : null,
    threadId: input.threadId,
    turnCount: input.turnCount,
    environmentUnavailable: input.environmentUnavailable,
    environmentUnavailableLabel: null,
    turnInProgress: input.turnInProgress,
    providerRefusal: input.providerRefusal,
    keepChatAvailable: true,
    choose: () =>
      chooseUndoFileChangesMode({
        revertThreadAvailable: input.providerRefusal === null,
        keptChangesTurnCount: input.keptChangesTurnCount,
      }),
    newCommandId,
    readThread: input.readThread,
    subscribe: input.subscribe,
  });
  switch (result.kind) {
    case "refused":
      return { error: revertCheckpointGuardFailureMessage(result.reason), notice: null };
    case "not-reverted":
      return { error: result.error, notice: null };
    case "reverted":
      return { error: null, notice: result.notice };
    case "unconfirmed":
      return { error: result.error, notice: null };
  }
}
