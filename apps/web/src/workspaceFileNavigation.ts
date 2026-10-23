import type { ScopedThreadRef } from "@ryco/contracts";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";

import { usePaneThreadRef } from "./components/chat/PaneFocus";
import {
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "./threadRoutes";
import {
  buildOpenFilesSearch,
  parseWorkspaceFileReveal,
  type WorkspaceFileReveal,
} from "./workspaceRouteSearch";

/** Opens workspace files in Ryco's own Files panel. */
export interface WorkspaceFileOpener {
  /** There is a Files panel to open `reveal` in, and the route can name it. */
  canOpen(reveal: WorkspaceFileReveal): boolean;
  /**
   * Opens `reveal` in the Files panel of the thread the link belongs to;
   * false when that cannot be done (the caller falls back, to an editor say).
   */
  open(reveal: WorkspaceFileReveal): boolean;
}

type WorkspaceFileRouter = Pick<NonNullable<ReturnType<typeof useRouter>>, "state" | "navigate">;

/**
 * The thread whose Files panel a link opens in. In a split it is the link's
 * own pane, which is not always the routed (focused) one; outside a split the
 * routed thread or draft is the only one shown.
 */
export function resolveWorkspaceFileOpenTarget(input: {
  readonly paneThreadRef: ScopedThreadRef | null;
  readonly routeParams: Record<string, string | undefined>;
}): ThreadRouteTarget | null {
  if (input.paneThreadRef) return { kind: "server", threadRef: input.paneThreadRef };
  return resolveThreadRouteTarget(input.routeParams);
}

export function createWorkspaceFileOpener(
  router: WorkspaceFileRouter | null | undefined,
  paneThreadRef: ScopedThreadRef | null,
): WorkspaceFileOpener {
  const target = () => {
    if (!router) return null;
    const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveWorkspaceFileOpenTarget({ paneThreadRef, routeParams: params });
  };
  // Only a reveal the route search can carry opens anything.
  const routable = (reveal: WorkspaceFileReveal) =>
    parseWorkspaceFileReveal({ workspaceFile: reveal.path, workspaceFileLine: reveal.line });
  return {
    canOpen: (reveal) => routable(reveal) !== null && target() !== null,
    open: (reveal) => {
      const current = target();
      const file = routable(reveal);
      if (!router || !current || !file) return false;
      // Every panel key is replaced, so another pane's thread starts clean.
      const search = (previous: Record<string, unknown>) => buildOpenFilesSearch(previous, file);
      if (current.kind === "draft") {
        void router.navigate({
          to: "/draft/$draftId",
          params: { draftId: current.draftId },
          replace: true,
          search,
        });
      } else {
        // In a split this also focuses the link's pane, as a click on it does.
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
  const paneThreadRef = usePaneThreadRef();
  return useMemo(() => createWorkspaceFileOpener(router, paneThreadRef), [paneThreadRef, router]);
}
