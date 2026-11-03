import type { ScopedThreadRef } from "@ryco/contracts";
import { useLayoutEffect, useState } from "react";

import { useLazyComponentReady } from "../../lib/preloadableLazy";
import { notifySurfaceLoadFailure } from "../ui/surfaceLoadFailure";
import { LazyWorkspacePullRequestsPopover } from "./lazyWorktreeDialogs";
import type { WorkspacePullRequestsPopoverProps } from "./WorkspacePullRequestsPopover";

/**
 * The pull requests popover (its list, the stack, the link picker), mounted from its first open
 * on and kept mounted after it closes, so it can animate closed and going from one pull request
 * to two never remounts it. Its chunk loads on that open, or earlier on intent
 * (`preloadWorkspacePullRequestsPopover`), so nothing of it loads with the sidebar or the chat. A
 * failed chunk closes it and offers a Retry that reopens the same view, shown only while
 * `threadRef` (the surface's thread, when it has one) is open.
 */
export function WorkspacePullRequestsPopoverOnDemand({
  threadRef,
  ...props
}: WorkspacePullRequestsPopoverProps & { readonly threadRef?: ScopedThreadRef | null }) {
  const [wanted, setWanted] = useState(false);
  if (props.open && !wanted) setWanted(true);
  const ready = useLazyComponentReady(LazyWorkspacePullRequestsPopover, wanted, {
    onLoadError: (error) => {
      const view = props.view;
      props.onOpenChange(false);
      setWanted(false);
      notifySurfaceLoadFailure(
        "pull requests",
        error,
        () => {
          props.onViewChange(view);
          props.onOpenChange(true);
        },
        threadRef,
      );
    },
  });
  const mounted = wanted && ready;
  // The first mount is closed for one commit, so the popover opens from closed and plays its
  // enter animation like every later open (mounted open, it would appear without one).
  const [primed, setPrimed] = useState(false);
  useLayoutEffect(() => {
    if (mounted && !primed) setPrimed(true);
  }, [mounted, primed]);
  return mounted ? (
    <LazyWorkspacePullRequestsPopover {...props} open={props.open && primed} />
  ) : null;
}
