import { preloadableLazy } from "../../lib/preloadableLazy";

/*
 * The linked-item dialog, code-split once for every surface that opens it (the
 * chat's toolbar and header, the sidebar): one module state, so a preload from
 * any of them serves all. It carries the work item detail views and the
 * raw-HTML markdown stack (parse5). Every mount passes `onLoadError`: a failed
 * chunk is a toast with a Retry, never the root error view.
 */

export const LazyLinkedWorktreeItemDialog = preloadableLazy(() =>
  import("./LinkedWorktreeItemDialog").then((module) => module.LinkedWorktreeItemDialog),
);

/**
 * A workspace's pull requests popover (its list, the stack, the link picker): every surface
 * mounts it on its first open (`WorkspacePullRequestsPopoverOnDemand`).
 */
export const LazyWorkspacePullRequestsPopover = preloadableLazy(() =>
  import("./WorkspacePullRequestsPopover").then((module) => module.WorkspacePullRequestsPopover),
);

/** Pointer or focus intent toward a badge that opens the linked-item dialog. */
export function preloadLinkedWorktreeItemDialog(): void {
  void LazyLinkedWorktreeItemDialog.preload();
}

/** Pointer or focus intent toward a control that opens the pull requests popover. */
export function preloadWorkspacePullRequestsPopover(): void {
  void LazyWorkspacePullRequestsPopover.preload();
}

/**
 * Pointer or focus intent toward a sidebar badge: it opens the linked-item dialog, or with
 * several pull requests the pull requests popover.
 */
export function preloadWorktreeBadgeSurfaces(): void {
  void LazyLinkedWorktreeItemDialog.preload();
  void LazyWorkspacePullRequestsPopover.preload();
}
