import type { ComponentProps } from "react";

import { preloadableLazy, type PreloadableLazyComponent } from "../../lib/preloadableLazy";
import type { NewWorktreeDialog } from "./NewWorktreeDialog";

/*
 * The worktree dialogs, code-split once for every surface that opens them (the
 * chat's toolbar and header, the sidebar): one module state per dialog, so a
 * preload from any of them serves all. The linked-item dialog carries the work
 * item detail views and the raw-HTML markdown stack (parse5); the new-worktree
 * dialog carries the pull request, issue and Jira pickers.
 */

// Annotated through the component type: its props interface is module-private.
export const LazyNewWorktreeDialog: PreloadableLazyComponent<
  ComponentProps<typeof NewWorktreeDialog>
> = preloadableLazy(() => import("./NewWorktreeDialog").then((module) => module.NewWorktreeDialog));

export const LazyLinkedWorktreeItemDialog = preloadableLazy(() =>
  import("./LinkedWorktreeItemDialog").then((module) => module.LinkedWorktreeItemDialog),
);
