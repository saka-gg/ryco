import type { ThreadId } from "@ryco/contracts";
import { useState } from "react";

import { type ChatFolderTarget, deleteChatFolderAfterPurge } from "../lib/chatFolderDelete";
import { selectEnvironmentState, useStore } from "../store";
import { mountDialog } from "./chat/mountDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { WrappingPath } from "./ui/path-text";

/** What `confirmChatDelete` resolves to when confirmed: `onDeleted` only with "Also delete files". */
export interface ChatDeleteChoice {
  readonly onDeleted?: () => void;
}

/**
 * Confirms deleting a chat's last conversation and offers to delete the chat's
 * folder too, off by default. Null when declined. With the folder chosen,
 * `onDeleted` (run once the node accepted the delete) schedules the folder's
 * deletion for after the conversation can no longer be restored.
 * Loaded on demand by `confirmThreadDeletion`.
 */
export function confirmChatDelete(input: {
  readonly message: string;
  readonly threadId: ThreadId;
  readonly folder: ChatFolderTarget;
}): Promise<ChatDeleteChoice | null> {
  const { folder, threadId } = input;
  // Undo, here or on another device, lists the conversation again.
  const isRestored = () =>
    selectEnvironmentState(useStore.getState(), folder.environmentId).threadShellById[threadId] !==
    undefined;
  return new Promise((resolve) => {
    mountDialog((close) => (
      <ChatDeleteDialog
        message={input.message}
        folderPath={folder.folderPath}
        onDone={(choice) => {
          resolve(
            choice === null
              ? null
              : choice
                ? { onDeleted: () => deleteChatFolderAfterPurge(folder, isRestored) }
                : {},
          );
          close();
        }}
      />
    ));
  });
}

/** `onDone(null)` when dismissed, else whether to delete the folder too. */
export function ChatDeleteDialog(props: {
  readonly message: string;
  readonly folderPath: string;
  readonly onDone: (deleteFiles: boolean | null) => void;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onDone(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
          <AlertDialogDescription>{props.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="mx-6 mb-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={deleteFiles}
            onCheckedChange={(checked) => setDeleteFiles(checked === true)}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-foreground">Also delete files</span>
            <WrappingPath path={props.folderPath} className="text-muted-foreground text-xs" />
            <span className="text-muted-foreground text-xs">
              The chat's folder is deleted once the conversation can no longer be restored.
            </span>
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={() => props.onDone(deleteFiles)}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
