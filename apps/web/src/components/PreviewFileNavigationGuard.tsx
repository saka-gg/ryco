import { reportPreviewNavigationBlocked } from "../previewNavigation";
import { parsePreviewRouteSearch } from "../previewRouteSearch";
import { useEffect } from "react";
import { useBlocker } from "@tanstack/react-router";
import { flushPreviewFiles, hasUnsavedPreviewFiles } from "./previewFileSessions";
import { toastManager } from "./ui/toast";

/** Mounted above panels so a remount cannot remove draft protection. */
export function PreviewFileNavigationGuard() {
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedPreviewFiles()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      // Revealing the recovery UI cannot abandon a draft. In particular, a
      // failed draft retained after a panel remount must remain reachable.
      if (
        current.pathname === next.pathname &&
        parsePreviewRouteSearch(current.search as Record<string, unknown>).preview !== "1" &&
        parsePreviewRouteSearch(next.search as Record<string, unknown>).preview === "1"
      )
        return false;
      if (!hasUnsavedPreviewFiles()) return false;
      const saved = await flushPreviewFiles();
      if (!saved) {
        reportPreviewNavigationBlocked(next.pathname);
        toastManager.add({
          type: "error",
          title: "Editor changes could not be saved",
          description:
            "Your draft is preserved. Resolve the save error in File Preview before leaving.",
        });
      }
      return !saved;
    },
    enableBeforeUnload: false,
  });
  return null;
}
