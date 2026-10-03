import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";

/** Opens a URL through the platform shell; failures surface as a toast. */
export function openExternalLink(url: string, failureTitle: string): void {
  const api = readLocalApi();
  if (!api) {
    toastManager.add({ type: "error", title: "Link opening is unavailable." });
    return;
  }
  void api.shell.openExternal(url).catch((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}
