import { readProjectChatErrorReason } from "@ryco/client-runtime/state/chats";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { THREAD_DELETE_GRACE_MS } from "@ryco/shared/workspaceLifecycle";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { errorMessage } from "~/lib/errorMessage";

/** The folder of a chat whose last conversation is being deleted. */
export interface ChatFolderTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly folderPath: string;
}

/** First try: the node's purge plus room for it to settle. */
export const CHAT_FOLDER_DELETE_DELAY_MS = THREAD_DELETE_GRACE_MS + 2_000;
export const CHAT_FOLDER_DELETE_RETRY_MS = 5_000;
export const CHAT_FOLDER_DELETE_ATTEMPTS = 4;

function reportFailure(target: ChatFolderTarget, description: string): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not delete the chat folder",
      description: `${description} The files are still in ${target.folderPath}.`,
    }),
  );
}

/**
 * "Also delete files" of a chat's delete. The conversation stays restorable
 * until its node purges it `THREAD_DELETE_GRACE_MS` after the delete, so the
 * folder is only asked for after that, never at click time. Nothing happens
 * once `isRestored` reports that Undo (here or on another device) brought the
 * conversation back, and the node itself refuses while any conversation of the
 * chat is live or restorable; a purge or session stop that has not settled yet
 * is retried a few times. Reports the outcome as a toast and never throws.
 */
export function deleteChatFolderAfterPurge(
  target: ChatFolderTarget,
  isRestored: () => boolean,
): void {
  let attemptsLeft = CHAT_FOLDER_DELETE_ATTEMPTS;
  const attempt = async (): Promise<void> => {
    if (isRestored()) return;
    const deleteChatFolder = readEnvironmentApi(target.environmentId)?.projects.deleteChatFolder;
    if (!deleteChatFolder) {
      reportFailure(target, "This device cannot delete chat folders.");
      return;
    }
    try {
      const result = await deleteChatFolder({ projectId: target.projectId });
      toastManager.add(
        result.deleted
          ? { type: "success", title: "Chat folder deleted", description: target.folderPath }
          : {
              type: "info",
              title: "Chat folder already gone",
              description: `Nothing was left to delete at ${target.folderPath}.`,
            },
      );
    } catch (error) {
      const reason = readProjectChatErrorReason(error);
      if ((reason === "has-threads" || reason === "busy") && --attemptsLeft > 0) {
        setTimeout(() => void attempt(), CHAT_FOLDER_DELETE_RETRY_MS);
        return;
      }
      if (isRestored()) return;
      reportFailure(target, errorMessage(error, "The request failed."));
    }
  };
  setTimeout(() => void attempt(), CHAT_FOLDER_DELETE_DELAY_MS);
}
