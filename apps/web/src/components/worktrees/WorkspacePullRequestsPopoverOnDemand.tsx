import { useState } from "react";

import { useLazyComponentReady } from "../../lib/preloadableLazy";
import { notifySurfaceLoadFailure } from "../ui/surfaceLoadFailure";
import { LazyWorkspacePullRequestsPopover } from "./lazyWorktreeDialogs";
import type { WorkspacePullRequestsPopoverProps } from "./WorkspacePullRequestsPopover";

/**
 * The pull requests popover (its list, the stack, the link picker), mounted from its first open
 * on and kept mounted after it closes, so it can animate closed and going from one pull request
 * to two never remounts it. Its chunk loads on that open, or earlier on intent
 * (`preloadWorktreeBadgeSurfaces`), so nothing of it loads with the sidebar or the chat. A failed
 * chunk closes it and offers a Retry that reopens the same view.
 */
export function WorkspacePullRequestsPopoverOnDemand(props: WorkspacePullRequestsPopoverProps) {
  const [wanted, setWanted] = useState(false);
  if (props.open && !wanted) setWanted(true);
  const ready = useLazyComponentReady(LazyWorkspacePullRequestsPopover, wanted, {
    onLoadError: (error) => {
      const view = props.view;
      props.onOpenChange(false);
      setWanted(false);
      notifySurfaceLoadFailure("pull requests", error, () => {
        props.onViewChange(view);
        props.onOpenChange(true);
      });
    },
  });
  return wanted && ready ? <LazyWorkspacePullRequestsPopover {...props} /> : null;
}
