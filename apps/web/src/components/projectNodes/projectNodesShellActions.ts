// FILE: projectNodesShellActions.ts
// Purpose: The project-nodes helpers the shell's surfaces use around the
//          dialogs: a project menu's cross-node actions, the sidebar's copy
//          badges and the copy runtime's "a copy runs" signal.
// Layer: Web UI state over `projectNodesDialogStore`, kept out of the boot
//        bundle (the sidebar and the copy runtime load it).

import type { ScopedProjectRef } from "@ryco/contracts";

import {
  NO_COPY_BADGES,
  openCopyProject,
  preloadCopyProject,
  preloadProjectNodesDialogs,
  useProjectNodesDialogStore,
  type CopyProjectDialogOrigin,
  type CrossNodeProjectActions,
  type OpenAddProjectOptions,
} from "./projectNodesDialogStore";

/**
 * A project menu's cross-node actions for one checkout: copy it (the dialog
 * starts from it) and link a copy already on a node (the palette store's `openAddProject` in
 * link mode, passed in by the caller: the add-project dialog where it is
 * available, else the palette's add-project views). Both preload the dialogs
 * on menu intent; the copy also warms its first reads on its own item's intent.
 */
export function crossNodeProjectActions(input: {
  readonly projectRef: ScopedProjectRef;
  readonly origin: CopyProjectDialogOrigin;
  /** `openAddProject` from the command palette's store (which imports this module). */
  readonly openAddProject: (options: OpenAddProjectOptions) => void;
}): CrossNodeProjectActions {
  const { projectRef, origin } = input;
  return {
    onCopy: () => openCopyProject({ source: projectRef, origin }),
    onLink: () => input.openAddProject({ mode: "link", projectRef }),
    onIntent: preloadProjectNodesDialogs,
    onCopyIntent: () => preloadCopyProject(projectRef),
  };
}

/** The copy runtime publishes its running copies' badges (see `copyBadges`). */
export function publishProjectCopyBadges(badges: Readonly<Record<string, number | null>>): void {
  const current = useProjectNodesDialogStore.getState().copyBadges;
  const keys = Object.keys(badges);
  if (
    keys.length === Object.keys(current).length &&
    keys.every((key) => key in current && current[key] === badges[key])
  ) {
    return;
  }
  useProjectNodesDialogStore.setState({
    copyBadges: keys.length === 0 ? NO_COPY_BADGES : badges,
  });
}

/**
 * The badge of a sidebar row that groups `memberKeys` (`scopedProjectKey`s):
 * a running copy's percent (null while unmeasured), undefined when none runs.
 */
export function projectCopyBadgeFor(
  badges: Readonly<Record<string, number | null>>,
  memberKeys: ReadonlyArray<string>,
): number | null | undefined {
  if (badges === NO_COPY_BADGES) return undefined;
  for (const key of memberKeys) {
    if (key in badges) return badges[key] ?? null;
  }
  return undefined;
}

/** The copy runtime calls this when it starts or resumes a copy. */
export function markProjectCopiesActive(): void {
  if (useProjectNodesDialogStore.getState().copiesActive) return;
  useProjectNodesDialogStore.setState({ copiesActive: true });
}
