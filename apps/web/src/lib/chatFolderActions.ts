import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import { readEnvironmentApi } from "../environmentApi";
import { readLocalApi } from "../localApi";

/**
 * Shows a folder on this machine in the file manager (`"file-manager"`) or the
 * preferred editor (`"editor"`), reporting a failure as a toast. Only folders
 * on the primary environment can be opened this way.
 */
export async function openFolderWithFeedback(
  path: string,
  target: "file-manager" | "editor",
): Promise<void> {
  const api = readLocalApi();
  if (!api) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open folder",
        description: "No local editor bridge is available.",
      }),
    );
    return;
  }
  try {
    if (target === "file-manager") await api.shell.openInEditor(path, "file-manager");
    else await openInPreferredEditor(api, path);
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open folder",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

/**
 * Deletes a chat's folder through its node (which only ever removes folders
 * strictly inside its chats root) and reports the outcome as a toast. Never
 * throws: the conversation itself is already gone when this runs.
 */
export async function deleteChatFolderWithFeedback(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly folderPath: string;
}): Promise<void> {
  const deleteChatFolder = readEnvironmentApi(input.environmentId)?.projects.deleteChatFolder;
  if (!deleteChatFolder) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not delete the chat folder",
        description: `This device cannot delete chat folders. The files are still in ${input.folderPath}.`,
      }),
    );
    return;
  }
  try {
    const result = await deleteChatFolder({ projectId: input.projectId });
    toastManager.add(
      result.deleted
        ? { type: "success", title: "Chat folder deleted", description: input.folderPath }
        : {
            type: "info",
            title: "Chat folder already gone",
            description: `Nothing was left to delete at ${input.folderPath}.`,
          },
    );
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not delete the chat folder",
        description: `${error instanceof Error ? error.message : "The request failed."} The files are still in ${input.folderPath}.`,
      }),
    );
  }
}
