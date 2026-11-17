import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import { readLocalApi } from "../localApi";
import { errorMessage } from "~/lib/errorMessage";

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
        description: errorMessage(error, "An error occurred."),
      }),
    );
  }
}
