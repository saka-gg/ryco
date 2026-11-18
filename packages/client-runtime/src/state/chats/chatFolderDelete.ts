// "Also delete files" of deleting a chat's last conversation: when the node may
// be asked to delete the chat's folder, and how the outcome reads. No UI: web's
// `ChatDeleteDialog` and the phone's thread screen both use this and differ
// only in how they ask and how they report the outcome. Which folder a delete
// frees is decided in `chatFolder.ts`.

import type {
  ProjectsDeleteChatFolderInput,
  ProjectsDeleteChatFolderResult,
} from "@ryco/contracts";
import { THREAD_DELETE_GRACE_MS } from "@ryco/shared/workspaceLifecycle";

import type { ChatFolderTarget } from "./chatFolder.ts";
import { causeMessage, readProjectChatErrorReason } from "./promoteChat.ts";

/** First try: the node's purge plus room for it to settle. */
export const CHAT_FOLDER_DELETE_DELAY_MS = THREAD_DELETE_GRACE_MS + 2_000;
export const CHAT_FOLDER_DELETE_RETRY_MS = 5_000;
export const CHAT_FOLDER_DELETE_ATTEMPTS = 4;

/** How a scheduled folder delete ended. Not reported when the conversation was restored. */
export type ChatFolderDeleteOutcome =
  | { readonly kind: "deleted" }
  | { readonly kind: "already-gone" }
  | { readonly kind: "failed"; readonly reason: string };

/** The outcome as every surface words it; `failed` says where the files remain. */
export interface ChatFolderDeleteNotice {
  readonly tone: "success" | "info" | "error";
  readonly title: string;
  readonly description: string;
}

export function describeChatFolderDeleteOutcome(
  target: ChatFolderTarget,
  outcome: ChatFolderDeleteOutcome,
): ChatFolderDeleteNotice {
  switch (outcome.kind) {
    case "deleted":
      return { tone: "success", title: "Chat folder deleted", description: target.folderPath };
    case "already-gone":
      return {
        tone: "info",
        title: "Chat folder already gone",
        description: `Nothing was left to delete at ${target.folderPath}.`,
      };
    case "failed":
      return {
        tone: "error",
        title: "Could not delete the chat folder",
        description: `${outcome.reason} The files are still in ${target.folderPath}.`,
      };
  }
}

type DeleteChatFolder = (
  input: ProjectsDeleteChatFolderInput,
) => Promise<ProjectsDeleteChatFolderResult>;

/**
 * "Also delete files" of a chat's delete, started once the node accepted the
 * delete. The conversation stays restorable until its node purges it
 * `THREAD_DELETE_GRACE_MS` after the delete, so the folder is only asked for
 * after that, never at delete time. Nothing happens once `isRestored` reports
 * that Undo (on this device or another) brought the conversation back, and the
 * node itself refuses while any conversation of the chat is live or
 * restorable; a purge or session stop that has not settled yet (`has-threads`,
 * `busy`) is retried a few times. `report` gets the outcome; this never throws.
 */
export function deleteChatFolderAfterPurge(input: {
  readonly target: ChatFolderTarget;
  readonly isRestored: () => boolean;
  /** The node's `projects.deleteChatFolder`, read at each attempt; null when unavailable. */
  readonly resolveDeleteChatFolder: () => DeleteChatFolder | null | undefined;
  readonly report: (outcome: ChatFolderDeleteOutcome) => void;
}): void {
  const { target, isRestored, report } = input;
  let attemptsLeft = CHAT_FOLDER_DELETE_ATTEMPTS;
  const attempt = async (): Promise<void> => {
    if (isRestored()) return;
    const deleteChatFolder = input.resolveDeleteChatFolder();
    if (!deleteChatFolder) {
      report({ kind: "failed", reason: "This device cannot delete chat folders." });
      return;
    }
    try {
      const result = await deleteChatFolder({ projectId: target.projectId });
      report({ kind: result.deleted ? "deleted" : "already-gone" });
    } catch (error) {
      const reason = readProjectChatErrorReason(error);
      if ((reason === "has-threads" || reason === "busy") && --attemptsLeft > 0) {
        setTimeout(() => void attempt(), CHAT_FOLDER_DELETE_RETRY_MS);
        return;
      }
      if (isRestored()) return;
      report({ kind: "failed", reason: causeMessage(error) ?? "The request failed." });
    }
  };
  setTimeout(() => void attempt(), CHAT_FOLDER_DELETE_DELAY_MS);
}
