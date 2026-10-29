import {
  EDIT_FROM_HERE_COPY,
  UNDO_FILE_CHANGES_COPY,
  keptChangesRestoreNote,
  type CheckpointRevertMode,
} from "@ryco/client-runtime/state/session";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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

export type CheckpointRevertChoiceRequest =
  | {
      /** "Edit from here" under a sent message. */
      readonly kind: "edit-from-here";
      /** The machine can rewind the conversation and keep the files (`conversationRevert`). */
      readonly keepFilesAvailable: boolean;
      /**
       * The checkpoint an earlier revert left changes in place at, which restoring
       * the files would discard too (`revertKeptChangesDiscardedBy`); null when none.
       */
      readonly keptChangesTurnCount: number | null;
    }
  | {
      /** "Undo" on a turn's changed files, on a machine that takes `thread.files.revert`. */
      readonly kind: "undo-files";
      /** The agent can forget turns too, so "Revert thread too" is offered. */
      readonly revertThreadAvailable: boolean;
      readonly keptChangesTurnCount: number | null;
    };

/**
 * One revert choice at a time: `requestChoice` opens the dialog and resolves
 * with the user's answer (null when cancelled, closed, or replaced).
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
 * Asks how far a revert goes. "Edit from here": both choices make the agent
 * forget this message and everything after it and return the prompt to the
 * composer; "Revert files too" also puts the checkout back. A machine without
 * `thread.conversation.revert` offers only that. "Undo" on a turn's files: the
 * files go back and the chat stays; "Revert thread too" also rewinds the chat.
 */
export function CheckpointRevertChoiceDialog(props: {
  readonly request: CheckpointRevertChoiceRequest | null;
  readonly onSettle: (mode: CheckpointRevertMode | null) => void;
}) {
  const { request, onSettle } = props;
  // Kept while the dialog folds closed, so its content does not jump.
  const [shown, setShown] = useState<CheckpointRevertChoiceRequest | null>(request);
  if (request !== null && request !== shown) setShown(request);
  const keptChangesTurnCount = shown?.keptChangesTurnCount ?? null;
  const keptChangesNote =
    keptChangesTurnCount === null ? null : <p>{keptChangesRestoreNote(keptChangesTurnCount)}</p>;

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onSettle(null);
      }}
    >
      <AlertDialogPopup className="max-w-md">
        {shown?.kind === "undo-files" ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{UNDO_FILE_CHANGES_COPY.title}</AlertDialogTitle>
              <AlertDialogDescription render={<div />} className="grid gap-2">
                <p>{UNDO_FILE_CHANGES_COPY.description}</p>
                <p>{UNDO_FILE_CHANGES_COPY.replacedNote}</p>
                {keptChangesNote}
                {shown.revertThreadAvailable ? (
                  <p>{UNDO_FILE_CHANGES_COPY.revertThreadNote}</p>
                ) : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter variant="bare">
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              {shown.revertThreadAvailable ? (
                <Button variant="destructive-outline" onClick={() => onSettle("restore-files")}>
                  {UNDO_FILE_CHANGES_COPY.revertThread}
                </Button>
              ) : null}
              <Button variant="destructive" onClick={() => onSettle("keep-chat")}>
                {UNDO_FILE_CHANGES_COPY.keepChat}
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <EditFromHereChoice
            keepFilesAvailable={shown?.keepFilesAvailable ?? true}
            keptChangesNote={keptChangesNote}
            onSettle={onSettle}
          />
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function EditFromHereChoice(props: {
  readonly keepFilesAvailable: boolean;
  readonly keptChangesNote: ReactNode;
  readonly onSettle: (mode: CheckpointRevertMode | null) => void;
}) {
  const { keepFilesAvailable, keptChangesNote, onSettle } = props;
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{EDIT_FROM_HERE_COPY.title}</AlertDialogTitle>
        <AlertDialogDescription render={<div />} className="grid gap-2">
          <p>{EDIT_FROM_HERE_COPY.description}</p>
          <p>
            {keepFilesAvailable
              ? EDIT_FROM_HERE_COPY.restoreFilesNote
              : EDIT_FROM_HERE_COPY.restoreOnlyNote}
          </p>
          {keptChangesNote}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter variant="bare">
        <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        <Button
          variant={keepFilesAvailable ? "destructive-outline" : "destructive"}
          onClick={() => onSettle("restore-files")}
        >
          {keepFilesAvailable ? EDIT_FROM_HERE_COPY.restoreFiles : EDIT_FROM_HERE_COPY.restoreOnly}
        </Button>
        {keepFilesAvailable ? (
          <Button onClick={() => onSettle("keep-files")}>{EDIT_FROM_HERE_COPY.keepFiles}</Button>
        ) : null}
      </AlertDialogFooter>
    </>
  );
}
