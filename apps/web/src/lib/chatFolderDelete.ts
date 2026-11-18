import {
  deleteChatFolderAfterPurge,
  describeChatFolderDeleteOutcome,
  isDeletedThreadListed,
  type ChatFolderTarget,
} from "@ryco/client-runtime/state/chats";
import type { ThreadId } from "@ryco/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { selectEnvironmentState, useStore } from "../store";

export type { ChatFolderTarget } from "@ryco/client-runtime/state/chats";

/**
 * "Also delete files" of a chat's delete, once the node accepted it: the
 * shared `deleteChatFolderAfterPurge` decides when to ask the node and whether
 * to at all; this reports the outcome as a toast.
 */
export function scheduleChatFolderDelete(target: ChatFolderTarget, threadId: ThreadId): void {
  deleteChatFolderAfterPurge({
    target,
    // Undo, here or on another device, lists the conversation again.
    isRestored: () =>
      isDeletedThreadListed(
        selectEnvironmentState(useStore.getState(), target.environmentId),
        threadId,
      ),
    resolveDeleteChatFolder: () =>
      readEnvironmentApi(target.environmentId)?.projects.deleteChatFolder,
    report: (outcome) => {
      const notice = describeChatFolderDeleteOutcome(target, outcome);
      const toast = { type: notice.tone, title: notice.title, description: notice.description };
      toastManager.add(notice.tone === "error" ? stackedThreadToast(toast) : toast);
    },
  });
}
