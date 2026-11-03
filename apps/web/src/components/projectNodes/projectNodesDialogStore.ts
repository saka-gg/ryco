// FILE: projectNodesDialogStore.ts
// Purpose: Opens the app's one "Add project" dialog and its one "Copy <project>
//          to another node" dialog from any surface, records whether a
//          cross-node copy is running this session (its toasts need the
//          dialogs' surface mounted) and which checkouts it copies (the
//          sidebar's badge), and carries "Show in project selector" to the
//          new-thread hero.
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

/** "Show in project selector": the new-thread hero showing this project opens its selector. */
export interface ProjectSelectorOpenRequest {
  readonly projectRef: ScopedProjectRef;
  /** `Date.now()` when asked; older requests are dropped (see `takeProjectSelectorOpenRequest`). */
  readonly requestedAt: number;
}

export interface ProjectNodesDialogState {
  readonly addProject: ProjectNodesDialogSlot<AddProjectDialogRequest>;
  readonly copyProject: ProjectNodesDialogSlot<CopyProjectDialogRequest>;
  /**
   * A copy started or resumed in this session. The app shell then keeps the
   * dialogs' surface mounted, which also hosts what the copy's toasts need.
   */
  readonly copiesActive: boolean;
  readonly projectSelectorOpenRequest: ProjectSelectorOpenRequest | null;
  /**
   * Running copies by the checkout they copy (`scopedProjectKey`): the percent
   * of the part that runs now, null while nothing measures it. The sidebar
   * badges the project's row with it; the copy runtime publishes it.
   */
  readonly copyBadges: Readonly<Record<string, number | null>>;
}

const CLOSED = { open: false, token: 0, request: null } as const;
const NO_COPY_BADGES: Readonly<Record<string, number | null>> = {};

/** App-wide state of the project-nodes dialogs; `ProjectNodesDialogs` is their only host. */
export const useProjectNodesDialogStore = create<ProjectNodesDialogState>()(() => ({
  addProject: CLOSED,
  copyProject: CLOSED,
  copiesActive: false,
  projectSelectorOpenRequest: null,
  copyBadges: NO_COPY_BADGES,
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
 * `useCommandPaletteStore.getState().openAddProject(options)`, which calls this
 * when `addProjectDialogAvailable()` and no folder path is handed over.
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
 * starts from it) and link a copy already on a node (the palette store's `openAddProject` in
 * link mode, passed in by the caller: the add-project dialog where it is
 * available, else the palette's add-project views). Both preload the dialogs
 * on menu intent.
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
  };
}

/** How long a "Show in project selector" request waits for the project's hero to appear. */
const PROJECT_SELECTOR_OPEN_REQUEST_TTL_MS = 15_000;

/**
 * Asks the new-thread hero that shows `projectRef` to open its project
 * selector, e.g. after the add-project dialog opened a draft there. The
 * request lapses after a few seconds, so a later visit does not open it.
 */
export function requestProjectSelectorOpen(projectRef: ScopedProjectRef): void {
  const request: ProjectSelectorOpenRequest = { projectRef, requestedAt: Date.now() };
  useProjectNodesDialogStore.setState({ projectSelectorOpenRequest: request });
  globalThis.setTimeout(() => {
    if (useProjectNodesDialogStore.getState().projectSelectorOpenRequest === request) {
      useProjectNodesDialogStore.setState({ projectSelectorOpenRequest: null });
    }
  }, PROJECT_SELECTOR_OPEN_REQUEST_TTL_MS);
}

/** Whether the pending request names `projectRef`. */
export function isProjectSelectorOpenRequested(
  request: ProjectSelectorOpenRequest | null,
  projectRef: ScopedProjectRef,
): request is ProjectSelectorOpenRequest {
  return (
    request !== null &&
    request.projectRef.environmentId === projectRef.environmentId &&
    request.projectRef.projectId === projectRef.projectId
  );
}

/** The selector of `projectRef` opened or closed on its own: the request is done. */
export function clearProjectSelectorOpenRequest(projectRef: ScopedProjectRef): void {
  const request = useProjectNodesDialogStore.getState().projectSelectorOpenRequest;
  if (isProjectSelectorOpenRequested(request, projectRef)) {
    useProjectNodesDialogStore.setState({ projectSelectorOpenRequest: null });
  }
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

/**
 * Where the copy runtime keeps its job records (ids only). Here so the shell
 * can tell whether there is anything to resume without loading the runtime.
 * Hosted builds keep them in memory for the session (`useLocalStorage`).
 */
export const PROJECT_COPY_RECORDS_STORAGE_KEY = "ryco:project-copies:v1";

/**
 * Agent Control approvals of a copy that may have bound a proposal to this
 * client's executor before the copy's own record existed (ids only), so a
 * reload still ends such a proposal. Kept by the copy runtime.
 */
export const PROJECT_COPY_STARTS_STORAGE_KEY = "ryco:project-copy-starts:v1";

const hasStoredEntries = (key: string): boolean => {
  try {
    const stored = getLocalStorageItem(key, Schema.Unknown);
    return Array.isArray(stored) && stored.length > 0;
  } catch {
    return false;
  }
};

/** Whether a session left copy records behind (the copy runtime decides what to resume). */
export function hasStoredProjectCopyRecords(): boolean {
  return (
    hasStoredEntries(PROJECT_COPY_RECORDS_STORAGE_KEY) ||
    hasStoredEntries(PROJECT_COPY_STARTS_STORAGE_KEY)
  );
}

/** Test-only: both dialogs closed, nothing running. */
export function resetProjectNodesDialogStoreForTests(): void {
  useProjectNodesDialogStore.setState({
    addProject: CLOSED,
    copyProject: CLOSED,
    copiesActive: false,
    projectSelectorOpenRequest: null,
    copyBadges: NO_COPY_BADGES,
  });
}
