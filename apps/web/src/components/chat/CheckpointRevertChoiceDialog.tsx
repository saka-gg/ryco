import {
  EDIT_FROM_HERE_COPY,
  keptChangesRestoreNote,
  type CheckpointRevertMode,
} from "@ryco/client-runtime/state/session";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export interface CheckpointRevertChoiceRequest {
  /** The machine can rewind the conversation and keep the files (`conversationRevert`). */
  readonly keepFilesAvailable: boolean;
  /**
   * The checkpoint an earlier revert left changes in place at, which restoring
   * the files would discard too (`revertKeptChangesDiscardedBy`); null when none.
   */
  readonly keptChangesTurnCount: number | null;
}

/**
 * One "Edit from here" choice at a time: `requestChoice` opens the dialog and
 * resolves with the user's answer (null when cancelled, closed, or replaced).
 */
export function useCheckpointRevertChoice() {
  const [request, setRequest] = useState<CheckpointRevertChoiceRequest | null>(null);
  const resolveRef = useRef<((mode: CheckpointRevertMode | null) => void) | null>(null);

  const settle = useCallback((mode: CheckpointRevertMode | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(mode);
  }, []);

  const requestChoice = useCallback((next: CheckpointRevertChoiceRequest) => {
    resolveRef.current?.(null);
    return new Promise<CheckpointRevertMode | null>((resolve) => {
      resolveRef.current = resolve;
      setRequest(next);
    });
  }, []);

  // An unmounted view never leaves a revert waiting on an answer.
  useEffect(() => () => resolveRef.current?.(null), []);

  return { request, requestChoice, settle };
}

/**
 * Asks how far "Edit from here" goes. Both choices make the agent forget this
 * message and everything after it and return the prompt to the composer;
 * "Revert files too" also puts the checkout back. A machine without
 * `thread.conversation.revert` offers only that.
 */
export function CheckpointRevertChoiceDialog(props: {
  readonly request: CheckpointRevertChoiceRequest | null;
  readonly onSettle: (mode: CheckpointRevertMode | null) => void;
}) {
  const { request, onSettle } = props;
  // Kept while the dialog folds closed, so its content does not jump.
  const [shown, setShown] = useState<CheckpointRevertChoiceRequest | null>(request);
  if (request !== null && request !== shown) setShown(request);
  const keepFilesAvailable = shown?.keepFilesAvailable ?? true;
  const keptChangesTurnCount = shown?.keptChangesTurnCount ?? null;

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onSettle(null);
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{EDIT_FROM_HERE_COPY.title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="grid gap-2">
            <p>{EDIT_FROM_HERE_COPY.description}</p>
            <p>
              {keepFilesAvailable
                ? EDIT_FROM_HERE_COPY.restoreFilesNote
                : EDIT_FROM_HERE_COPY.restoreOnlyNote}
            </p>
            {keptChangesTurnCount === null ? null : (
              <p>{keptChangesRestoreNote(keptChangesTurnCount)}</p>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant={keepFilesAvailable ? "destructive-outline" : "destructive"}
            onClick={() => onSettle("restore-files")}
          >
            {keepFilesAvailable
              ? EDIT_FROM_HERE_COPY.restoreFiles
              : EDIT_FROM_HERE_COPY.restoreOnly}
          </Button>
          {keepFilesAvailable ? (
            <Button onClick={() => onSettle("keep-files")}>{EDIT_FROM_HERE_COPY.keepFiles}</Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
