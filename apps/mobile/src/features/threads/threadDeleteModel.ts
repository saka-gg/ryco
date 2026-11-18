import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  chatFolderFreedByDelete,
  deleteChatFolderAfterPurge,
  describeChatFolderDeleteOutcome,
  isDeletedThreadListed,
  type ChatFolderEnvironment,
  type ChatFolderTarget,
} from "@ryco/client-runtime/state/chats";
import type {
  EnvironmentId,
  ProjectsDeleteChatFolderInput,
  ProjectsDeleteChatFolderResult,
  ThreadId,
} from "@ryco/contracts";

/**
 * The thread screen's Delete, kept free of React Native so a node test can
 * check it: what the confirmation offers, and how "Delete with files" reports.
 * Which folder a delete frees and when the node may delete it are the shared
 * rules in `@ryco/client-runtime/state/chats` (the web's "Also delete files").
 */

export interface ThreadDeleteConfirmation {
  readonly title: string;
  readonly message: string;
  /**
   * The second, opt-in way to delete: also the chat's folder. Only for the last
   * conversation of a "No project" chat; plain Delete always keeps the files.
   */
  readonly deleteWithFiles: { readonly label: string } | null;
}

export function threadDeleteConfirmation(
  title: string,
  folder: ChatFolderTarget | null,
): ThreadDeleteConfirmation {
  const removed = "The chat, its attachments and its terminal history are removed for good.";
  return {
    title: `Delete "${title}"?`,
    message:
      folder === null
        ? removed
        : `${removed} Delete keeps the chat's files in ${folder.folderPath}. Delete with files also deletes that folder once the chat can no longer be restored.`,
    deleteWithFiles: folder === null ? null : { label: "Delete with files" },
  };
}

/** The folder deleting this conversation frees, read from the environment's state now. */
export function chatFolderForThreadDelete(
  environment: ChatFolderEnvironment,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ChatFolderTarget | null {
  return chatFolderFreedByDelete(environment, scopeThreadRef(environmentId, threadId));
}

/**
 * "Delete with files", once the node accepted the delete: the shared schedule
 * asks the node for the folder after the purge, never for a conversation that
 * was restored. Only a give-up is worth interrupting for, and it says where the
 * files remain; a deleted folder is what was asked for.
 */
export function scheduleChatFolderDelete(input: {
  readonly target: ChatFolderTarget;
  readonly threadId: ThreadId;
  readonly readEnvironment: () => Pick<ChatFolderEnvironment, "threadShellById">;
  readonly resolveDeleteChatFolder: () =>
    | ((input: ProjectsDeleteChatFolderInput) => Promise<ProjectsDeleteChatFolderResult>)
    | null
    | undefined;
  readonly alert: (title: string, message: string) => void;
}): void {
  deleteChatFolderAfterPurge({
    target: input.target,
    isRestored: () => isDeletedThreadListed(input.readEnvironment(), input.threadId),
    resolveDeleteChatFolder: input.resolveDeleteChatFolder,
    report: (outcome) => {
      if (outcome.kind !== "failed") return;
      const notice = describeChatFolderDeleteOutcome(input.target, outcome);
      input.alert(notice.title, notice.description);
    },
  });
}
