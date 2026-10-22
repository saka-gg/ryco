import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";

import { buildThreadRouteParams, resolveThreadRouteTarget } from "./threadRoutes";
import { buildOpenFilesSearch, type WorkspaceFileReveal } from "./workspaceRouteSearch";

/** Opens workspace files in Ryco's own Files panel. */
export interface WorkspaceFileOpener {
  /** The current route is a thread (or draft) with a Files panel to open. */
  canOpen(): boolean;
  /**
   * Opens the Files panel of the routed thread at `reveal`; false when this
   * route has none (the caller falls back, to an editor say).
   */
  open(reveal: WorkspaceFileReveal): boolean;
}

/**
 * The Files panel opener for links rendered in a conversation. It reads the
 * route when used rather than subscribing to it, so a transcript full of file
 * links does not re-render on navigation. The Files panel reads files through
 * the thread's own node, so this works on hosted web and remote nodes, where
 * no local editor can open them.
 */
export function useWorkspaceFileOpener(): WorkspaceFileOpener {
  const router = useRouter({ warn: false });
  return useMemo(() => {
    const target = () => {
      if (!router) return null;
      const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      return resolveThreadRouteTarget(params);
    };
    return {
      canOpen: () => target() !== null,
      open: (reveal) => {
        const current = target();
        if (!router || !current) return false;
        const search = (previous: Record<string, unknown>) =>
          buildOpenFilesSearch(previous, reveal);
        if (current.kind === "draft") {
          void router.navigate({
            to: "/draft/$draftId",
            params: { draftId: current.draftId },
            replace: true,
            search,
          });
        } else {
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(current.threadRef),
            replace: true,
            search,
          });
        }
        return true;
      },
    };
  }, [router]);
}
