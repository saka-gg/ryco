// FILE: addProjectDialogEntry.ts
// Purpose: What the command palette's store needs to route "Add project":
//          whether the add-project dialog is available on this tier, and
//          opening it.
// Layer: Web UI state. The only piece of the project-nodes feature in the boot
//        bundle (the command palette's store imports it). The dialogs' store
//        (`projectNodesDialogStore.ts`) loads with the app shell and hands its
//        opener over here as it loads, so opening stays synchronous and boot
//        carries neither the store nor an import of it.

import type { EnvironmentId, ScopedProjectRef } from "@ryco/contracts";

import { getPresentationTier, type PresentationTier } from "../../lib/presentationTier";

/**
 * Whether `openAddProject()` entry points open `AddProjectDialog` instead of the
 * command palette's add-project views. On: the dialog covers everything those
 * views do (A26). The frozen phone tier keeps the palette either way; turning
 * this off sends every tier back to it.
 */
export const ADD_PROJECT_DIALOG_ENABLED: boolean = true;

/** Where the add-project dialog starts: a folder on the node, a clone, a copy from another node, or linking a checkout. */
export type AddProjectDialogMode = "folder" | "clone" | "copy" | "link";

export interface OpenAddProjectOptions {
  /** Preselects the node (skips the node step when it can take projects). */
  readonly environmentId?: EnvironmentId | null;
  readonly mode?: AddProjectDialogMode | null;
  /** The project a `copy` or `link` starts from. */
  readonly projectRef?: ScopedProjectRef | null;
}

/** Whether `openAddProject()` entry points open the dialog on `tier` (else the palette's views). */
export function addProjectDialogAvailable(tier: PresentationTier = getPresentationTier()): boolean {
  // The frozen phone tier keeps the palette's add-project views (A26).
  return ADD_PROJECT_DIALOG_ENABLED && tier !== "phone";
}

type AddProjectDialogOpener = (options: OpenAddProjectOptions) => void;

let addProjectDialogOpener: AddProjectDialogOpener | null = null;

/** Called by `projectNodesDialogStore.ts` as it loads, with its `openAddProject`. */
export function provideAddProjectDialogOpener(open: AddProjectDialogOpener): void {
  addProjectDialogOpener = open;
}

/**
 * Opens the add-project dialog (`projectNodesDialogStore.openAddProject`) and
 * reports whether it did. The app shell loads the dialogs' store, which hosts
 * the dialog, before any entry point renders; until then this opens nothing
 * and returns false, and the caller shows the palette's add-project views.
 */
export function openAddProjectDialog(options: OpenAddProjectOptions): boolean {
  if (addProjectDialogOpener === null) return false;
  addProjectDialogOpener(options);
  return true;
}
