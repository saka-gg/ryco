import type { ThreadId } from "@ryco/contracts";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { errorMessage } from "~/lib/errorMessage";

/**
 * The shared thread clipboard actions (thread id and workspace path) with
 * their toast feedback. Used by the desktop sidebar rows and the phone thread
 * action sheet so both presenters keep identical behavior.
 */
export function useThreadClipboardActions() {
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: errorMessage(error, "An error occurred."),
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: errorMessage(error, "An error occurred."),
        }),
      );
    },
  });

  return { copyThreadIdToClipboard, copyPathToClipboard };
}
