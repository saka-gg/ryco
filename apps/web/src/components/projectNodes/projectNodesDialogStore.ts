// FILE: projectNodesDialogStore.ts
// Purpose: Opens the app's one "Add project" dialog and its one "Copy <project>
//          to another node" dialog from any surface, and records whether a
//          cross-node copy is running this session (its toasts need the
//          dialogs' surface mounted).
// Layer: Web UI state. The only static piece of the project-nodes feature: the
//        command palette's store (boot) and the app shell import it. The
//        dialogs (`ProjectNodesDialogs.tsx`), the copy runtime and the Agent
//        Control executor all load lazily; entry points import only this file.

import type { EnvironmentId, ScopedProjectRef } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem } from "../../hooks/useLocalStorage";
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

export interface AddProjectDialogRequest {
  readonly environmentId: EnvironmentId | null;
  readonly mode: AddProjectDialogMode | null;
  readonly projectRef: ScopedProjectRef | null;
}

/** The surface that asked for the copy; the dialog adapts its wording and first focus to it. */
export type CopyProjectDialogOrigin =
  | "sidebar"
  | "kebab"
  | "projects-page"
  | "selector"
  | "add-project"
  | "devices-section";

export interface CopyProjectDialogRequest {
  /** The checkout being copied. */
  readonly source: ScopedProjectRef;
  /** Preselected destination node; null lets the user pick. */
  readonly targetEnvironmentId: EnvironmentId | null;
  readonly origin: CopyProjectDialogOrigin;
}

/**
 * The cross-node actions a project menu offers when its surface opts in (A26):
 * the sidebar passes them, the frozen phone tier does not.
 */
export interface CrossNodeProjectActions {
  /** "Copy to another node…" */
  readonly onCopy: () => void;
  /** "Link a copy that's already on a node…" */
  readonly onLink: () => void;
  /** The menu is about to open: start loading the dialogs. */
  readonly onIntent?: (() => void) | undefined;
}

export interface OpenCopyProjectInput {
  readonly source: ScopedProjectRef;
  readonly targetEnvironmentId?: EnvironmentId | null;
  readonly origin: CopyProjectDialogOrigin;
}

export interface ProjectNodesDialogSlot<Request> {
  readonly open: boolean;
  /** Bumps on every open, so each open starts from a fresh form. */
  readonly token: number;
  /** The latest request; kept after closing so the content stays while the dialog folds. */
  readonly request: Request | null;
}

export interface ProjectNodesDialogState {
  readonly addProject: ProjectNodesDialogSlot<AddProjectDialogRequest>;
  readonly copyProject: ProjectNodesDialogSlot<CopyProjectDialogRequest>;
  /**
   * A copy started or resumed in this session. The app shell then keeps the
   * dialogs' surface mounted, which also hosts what the copy's toasts need.
   */
  readonly copiesActive: boolean;
}

const CLOSED = { open: false, token: 0, request: null } as const;

/** App-wide state of the project-nodes dialogs; `ProjectNodesDialogs` is their only host. */
export const useProjectNodesDialogStore = create<ProjectNodesDialogState>()(() => ({
  addProject: CLOSED,
  copyProject: CLOSED,
  copiesActive: false,
}));

/**
 * Starts loading the dialogs' code ahead of a likely open (an entry point is
 * hovered or focused, a menu opens), so the first open does not wait on it.
 */
export function preloadProjectNodesDialogs(): void {
  void import("./ProjectNodesDialogs");
}

/** Whether `openAddProject()` entry points open the dialog on `tier` (else the palette's views). */
export function addProjectDialogAvailable(tier: PresentationTier = getPresentationTier()): boolean {
  // The frozen phone tier keeps the palette's add-project views (A26).
  return ADD_PROJECT_DIALOG_ENABLED && tier !== "phone";
}

/**
 * Opens the add-project dialog. Entry points that must keep the palette on the
 * phone tier (and while the dialog is off) go through
 * `useCommandPaletteStore.getState().openAddProject()`, or `openAddProjectWith`
 * when they know the node or the source, which call this when
 * `addProjectDialogAvailable()`.
 */
export function openAddProject(options: OpenAddProjectOptions = {}): void {
  const request: AddProjectDialogRequest = {
    environmentId: options.environmentId ?? null,
    mode: options.mode ?? null,
    projectRef: options.projectRef ?? null,
  };
  useProjectNodesDialogStore.setState((state) => ({
    addProject: { open: true, token: state.addProject.token + 1, request },
  }));
}

export function closeAddProject(): void {
  const { addProject } = useProjectNodesDialogStore.getState();
  if (!addProject.open) return;
  useProjectNodesDialogStore.setState({ addProject: { ...addProject, open: false } });
}

/** Opens "Copy <project> to another node…" for one checkout. */
export function openCopyProject(input: OpenCopyProjectInput): void {
  const request: CopyProjectDialogRequest = {
    source: input.source,
    targetEnvironmentId: input.targetEnvironmentId ?? null,
    origin: input.origin,
  };
  useProjectNodesDialogStore.setState((state) => ({
    copyProject: { open: true, token: state.copyProject.token + 1, request },
  }));
}

export function closeCopyProject(): void {
  const { copyProject } = useProjectNodesDialogStore.getState();
  if (!copyProject.open) return;
  useProjectNodesDialogStore.setState({ copyProject: { ...copyProject, open: false } });
}

/**
 * A project menu's cross-node actions for one checkout: copy it (the dialog
 * starts from it) and link a copy already on a node (the add-project dialog in
 * link mode, else `openAddProjectFallback`, the palette's add-project views,
 * until that dialog is available). Both preload the dialogs on menu intent.
 */
export function crossNodeProjectActions(input: {
  readonly projectRef: ScopedProjectRef;
  readonly origin: CopyProjectDialogOrigin;
  readonly openAddProjectFallback: () => void;
}): CrossNodeProjectActions {
  const { projectRef, origin } = input;
  return {
    onCopy: () => openCopyProject({ source: projectRef, origin }),
    onLink: () => {
      if (addProjectDialogAvailable()) openAddProject({ mode: "link", projectRef });
      else input.openAddProjectFallback();
    },
    onIntent: preloadProjectNodesDialogs,
  };
}

/** The copy runtime calls this when it starts or resumes a copy. */
export function markProjectCopiesActive(): void {
  if (useProjectNodesDialogStore.getState().copiesActive) return;
  useProjectNodesDialogStore.setState({ copiesActive: true });
}

/**
 * Where the copy runtime keeps its job records (ids only). Here so the shell
 * can tell whether there is anything to resume without loading the runtime.
 * Hosted builds keep them in memory for the session (`useLocalStorage`).
 */
export const PROJECT_COPY_RECORDS_STORAGE_KEY = "ryco:project-copies:v1";

/** Whether a session left copy records behind (the copy runtime decides what to resume). */
export function hasStoredProjectCopyRecords(): boolean {
  try {
    const stored = getLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, Schema.Unknown);
    return Array.isArray(stored) && stored.length > 0;
  } catch {
    return false;
  }
}

/** Test-only: both dialogs closed, nothing running. */
export function resetProjectNodesDialogStoreForTests(): void {
  useProjectNodesDialogStore.setState({
    addProject: CLOSED,
    copyProject: CLOSED,
    copiesActive: false,
  });
}
