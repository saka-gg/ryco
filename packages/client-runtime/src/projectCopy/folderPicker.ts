// FILE: folderPicker.ts
// Purpose: The folder picker's path model on a node of any platform (breadcrumbs, places,
//          joining a child folder), the note under search results, and the
//          status line that says what the selected folder is and whether it can be used for the
//          picker's mode.
// Layer: Web UI logic, pure. Path parsing reuses `lib/projectPaths.ts`.

import type {
  FilesystemSearchDirectoriesResult,
  NodePathHints,
  ProjectDestinationPreview,
  ProjectDestinationState,
} from "@ryco/contracts/project-copy";

import { joinNodePath } from "./plan.ts";

import {
  formatProjectPath,
  getBrowseParentPath,
  inferProjectTitleFromPath,
  isSameFilesystemPath,
  normalizeProjectPathForDispatch,
} from "@ryco/shared/projectPaths";

/**
 * What the picked folder is for:
 * - `folder`: an existing (or new) folder that becomes the project.
 * - `parent`: the folder a clone or copy goes into, as `<parent>/<childName>`.
 * - `link`: an existing checkout of a given repository.
 */
export type FolderPickerMode = "folder" | "parent" | "link";

/** The last segment of a path, "/" for the root. */
export function nodePathLeaf(path: string): string {
  return inferProjectTitleFromPath(path) || path;
}

/** A path as the picker shows it: home-relative when it sits under the node's home. */
export function formatNodePath(path: string, homeDirectory: string | null | undefined): string {
  return formatProjectPath(normalizeProjectPathForDispatch(path), homeDirectory);
}

function isRootPath(path: string): boolean {
  return path === "/" || /^[A-Za-z]:[\\/]?$/u.test(path) || /^\\\\[^\\]+\\[^\\]+\\?$/u.test(path);
}

export interface FolderCrumb {
  readonly path: string;
  readonly label: string;
  /** A filesystem root ("/", "C:"), shown without a separator after it. */
  readonly isRoot: boolean;
}

/**
 * The breadcrumbs of a listed directory, outermost first. They start at the
 * node's home ("~") when the directory is under it, at the workspace access
 * root when browsing is restricted (nothing above it can be listed), and at the
 * filesystem root otherwise.
 */
export function buildFolderCrumbs(
  directory: string,
  options: {
    readonly homeDirectory?: string | null | undefined;
    readonly accessRoot?: string | null | undefined;
  } = {},
): FolderCrumb[] {
  const crumbs: FolderCrumb[] = [];
  let current: string | null = normalizeProjectPathForDispatch(directory);
  // A path has at most as many crumbs as it has characters; the bound only guards a parser bug.
  for (let guard = 0; current !== null && current.length > 0 && guard < 256; guard += 1) {
    const isHome =
      current === "~" ||
      (options.homeDirectory ? isSameFilesystemPath(current, options.homeDirectory) : false);
    const isAccessRoot = options.accessRoot
      ? isSameFilesystemPath(current, options.accessRoot)
      : false;
    const root = isRootPath(current);
    crumbs.unshift({
      path: current,
      label: isHome
        ? "~"
        : isAccessRoot
          ? formatNodePath(current, options.homeDirectory)
          : root
            ? current.replace(/[\\/]+$/u, "") || "/"
            : nodePathLeaf(current),
      isRoot: root && !isHome,
    });
    if (isHome || isAccessRoot || root) break;
    const parent = getBrowseParentPath(current);
    current = parent === null ? null : normalizeProjectPathForDispatch(parent);
  }
  return crumbs;
}

export interface FolderPlace {
  readonly path: string;
  readonly label: string;
  readonly kind: "home" | "access-root" | "code-root";
}

/**
 * The picker's Places: home (or the workspace access root when browsing is
 * restricted), then the node's code roots. Without path hints, home and the
 * starting folder.
 */
export function buildFolderPlaces(
  hints: Pick<NodePathHints, "homeDirectory" | "codeRoots" | "workspaceAccessRoot"> | null,
  startDirectory: string | null,
): FolderPlace[] {
  const places: FolderPlace[] = [];
  const add = (place: FolderPlace) => {
    if (!places.some((existing) => isSameFilesystemPath(existing.path, place.path))) {
      places.push(place);
    }
  };
  if (!hints) {
    add({ path: "~", label: "Home", kind: "home" });
    if (startDirectory) {
      const start = normalizeProjectPathForDispatch(startDirectory);
      if (start !== "~") add({ path: start, label: nodePathLeaf(start), kind: "code-root" });
    }
    return places;
  }
  if (hints.workspaceAccessRoot) {
    add({
      path: hints.workspaceAccessRoot,
      label: nodePathLeaf(hints.workspaceAccessRoot),
      kind: "access-root",
    });
  } else {
    add({ path: hints.homeDirectory, label: "Home", kind: "home" });
  }
  for (const root of hints.codeRoots) {
    add({ path: root.path, label: nodePathLeaf(root.path), kind: "code-root" });
  }
  return places;
}

/** The folder a mode's selection points at: the child folder for `parent`, else the selection. */
export function resolveFolderDestination(
  mode: FolderPickerMode,
  selectedPath: string | null,
  childName: string | null | undefined,
): string | null {
  if (selectedPath === null) return null;
  if (mode !== "parent") return selectedPath;
  const name = childName?.trim();
  return name ? joinNodePath(selectedPath, [name]) : null;
}

export type FolderStatusTone = "neutral" | "positive" | "caution" | "negative";

export type FolderStatusKind =
  | "empty-selection"
  | "checking"
  | "check-failed"
  | "existing-project"
  | "git-repository"
  | "plain-folder"
  | "empty-folder"
  | "missing-folder"
  | "new-folder"
  | "occupied"
  | "same-repository"
  | "other-repository"
  | "not-a-repository"
  | "refused"
  | "needs-update"
  | "unchecked"
  /** A host's rewording (`describeStatus`): where a clone goes. */
  | "clone-destination";

/** One run of the status text; `path` runs are set in the monospace face. */
export interface FolderStatusSegment {
  readonly text: string;
  readonly path?: boolean;
}

/** What the picker says about the selection, and whether the selection can be used. */
export interface FolderSelectionStatus {
  readonly kind: FolderStatusKind;
  readonly tone: FolderStatusTone;
  readonly segments: ReadonlyArray<FolderStatusSegment>;
  /** The segments as plain text. */
  readonly text: string;
  /** The selection can be used for the mode (the node still judges it on submit). */
  readonly usable: boolean;
  /** The selected folder (the parent in `parent` mode). */
  readonly selectedPath: string | null;
  /** The folder the project would live in. */
  readonly destinationPath: string | null;
  /** The node's preview of `destinationPath`, when it has one. */
  readonly preview: ProjectDestinationPreview | null;
  /** The node's free alternative when the destination is taken. */
  readonly suggestedPath: string | null;
}

function status(
  input: Omit<FolderSelectionStatus, "text" | "suggestedPath"> & {
    readonly suggestedPath?: string | null;
  },
): FolderSelectionStatus {
  return {
    ...input,
    suggestedPath: input.suggestedPath ?? null,
    text: input.segments.map((segment) => segment.text).join(""),
  };
}

const REFUSED_FALLBACK: Partial<Record<ProjectDestinationState, string>> = {
  "access-denied": "This node doesn't allow projects here.",
  invalid: "This isn't a usable path.",
  "retired-checkout": "This folder belonged to a moved or removed project; agents can't run here.",
};

export interface DescribeFolderSelectionInput {
  readonly mode: FolderPickerMode;
  readonly nodeLabel: string;
  readonly homeDirectory: string | null;
  readonly selectedPath: string | null;
  /** `resolveFolderDestination` of the selection. */
  readonly destinationPath: string | null;
  /** The node offers `projects.previewDestination`. */
  readonly supportsPreview: boolean;
  readonly preview: ProjectDestinationPreview | null;
  readonly previewError: Error | null;
  /**
   * A project the client knows is rooted at the destination (`name` null when only its id
   * is known); the node's preview reports one too.
   */
  readonly existingProject: { readonly name: string | null } | null;
  /** From the node's folder annotations, when it reported them. */
  readonly isGitRepository: boolean | null;
  readonly gitBranch: string | null;
  /** Link mode: the repository the checkout must belong to (null: one without a remote). */
  readonly expectedRepositoryCanonicalKey?: string | null | undefined;
  /**
   * The client knows the destination does not exist (a typed path its parent's listing
   * lacks), for nodes without a preview.
   */
  readonly knownMissing?: boolean | undefined;
}

/**
 * The status line under the picker. Without a preview (older nodes) it reports
 * only what the client knows and lets the node judge the path on submit.
 */
export function describeFolderSelection(
  input: DescribeFolderSelectionInput,
): FolderSelectionStatus {
  const { mode, nodeLabel, selectedPath, destinationPath, preview } = input;
  const base = { selectedPath, destinationPath, preview };

  if (selectedPath === null) {
    return status({
      ...base,
      kind: "empty-selection",
      tone: "neutral",
      segments: [
        {
          text:
            mode === "parent"
              ? "Select the folder to put it in."
              : mode === "link"
                ? "Select the checkout to link."
                : "Select a folder.",
        },
      ],
      usable: false,
    });
  }
  if (destinationPath === null) {
    return status({
      ...base,
      kind: "empty-selection",
      tone: "neutral",
      segments: [{ text: "Name the new folder first." }],
      usable: false,
    });
  }
  if (mode === "link" && !input.supportsPreview) {
    return status({
      ...base,
      kind: "needs-update",
      tone: "negative",
      segments: [{ text: `Update Ryco on ${nodeLabel} to link a checkout that's already there.` }],
      usable: false,
    });
  }

  if (input.existingProject !== null || preview?.existingProjectId) {
    const name = input.existingProject?.name ?? null;
    return status({
      ...base,
      kind: "existing-project",
      tone: "caution",
      segments: name
        ? [{ text: "This is already the project " }, { text: name }, { text: ` on ${nodeLabel}.` }]
        : [{ text: `This is already a project on ${nodeLabel}.` }],
      usable: false,
      // A clone or copy can still go next to it.
      suggestedPath: mode === "parent" ? (preview?.suggestedPath ?? null) : null,
    });
  }

  if (input.supportsPreview && preview === null) {
    if (input.previewError) {
      return status({
        ...base,
        kind: "check-failed",
        tone: "caution",
        segments: [
          { text: `Couldn't check this folder on ${nodeLabel}: ${input.previewError.message}` },
        ],
        // The node judges the path again when the project is added.
        usable: mode !== "link",
      });
    }
    return status({
      ...base,
      kind: "checking",
      tone: "neutral",
      segments: [{ text: `Checking on ${nodeLabel}…` }],
      usable: false,
    });
  }

  if (preview) {
    const refused = REFUSED_FALLBACK[preview.state];
    if (refused !== undefined) {
      return status({
        ...base,
        kind: "refused",
        tone: "negative",
        segments: [{ text: preview.detail ?? refused }],
        usable: false,
      });
    }
  }

  const branch = input.gitBranch;
  const isRepository = preview ? preview.state === "is-git-repository" : input.isGitRepository;

  if (mode === "link") {
    if (!isRepository || !preview) {
      return status({
        ...base,
        kind: "not-a-repository",
        tone: "negative",
        segments: [{ text: "Not a Git repository." }],
        usable: false,
      });
    }
    const expected = input.expectedRepositoryCanonicalKey ?? null;
    if (preview.existingRepositoryCanonicalKey !== expected) {
      return status({
        ...base,
        kind: "other-repository",
        tone: "negative",
        segments: preview.existingRepositoryCanonicalKey
          ? [
              { text: "A different repository: " },
              { text: preview.existingRepositoryCanonicalKey, path: true },
            ]
          : [{ text: "A repository without a remote, so it can't be matched." }],
        usable: false,
      });
    }
    return status({
      ...base,
      kind: "same-repository",
      tone: "positive",
      segments: branch
        ? [{ text: "Same repository, on " }, { text: branch, path: true }]
        : [{ text: "Same repository." }],
      usable: true,
    });
  }

  if (mode === "parent") {
    if (!preview) {
      return status({
        ...base,
        kind: "unchecked",
        tone: "neutral",
        segments: [{ text: `Goes here; ${nodeLabel} checks the folder when it starts.` }],
        usable: true,
      });
    }
    switch (preview.state) {
      case "available":
        return status({
          ...base,
          kind: "new-folder",
          tone: "positive",
          segments: [{ text: "New folder; it's created for the project." }],
          usable: true,
        });
      case "exists-empty":
        return status({
          ...base,
          kind: "empty-folder",
          tone: "positive",
          segments: [{ text: "Exists and is empty; it's used as is." }],
          usable: true,
        });
      default: {
        const sameRepository =
          preview.state === "is-git-repository" &&
          input.expectedRepositoryCanonicalKey !== undefined &&
          preview.existingRepositoryCanonicalKey !== null &&
          preview.existingRepositoryCanonicalKey === input.expectedRepositoryCanonicalKey;
        return status({
          ...base,
          kind: sameRepository ? "same-repository" : "occupied",
          tone: "caution",
          segments: [
            {
              text: sameRepository
                ? "Already a checkout of this repository."
                : "This folder already exists.",
            },
          ],
          usable: false,
          suggestedPath: preview.suggestedPath,
        });
      }
    }
  }

  // `folder` mode: the selection itself becomes the project.
  if (preview?.state === "available" || (!preview && input.knownMissing === true)) {
    return status({
      ...base,
      kind: "missing-folder",
      tone: "caution",
      segments: [{ text: "Doesn't exist yet; adding the project creates it." }],
      usable: true,
    });
  }
  if (isRepository) {
    return status({
      ...base,
      kind: "git-repository",
      tone: "positive",
      segments: branch
        ? [{ text: "Git repository on " }, { text: branch, path: true }]
        : [{ text: "Git repository" }],
      usable: true,
    });
  }
  if (preview?.state === "exists-empty") {
    return status({
      ...base,
      kind: "empty-folder",
      tone: "neutral",
      segments: [{ text: "Empty folder" }],
      usable: true,
    });
  }
  if (preview) {
    return status({
      ...base,
      kind: "plain-folder",
      tone: "neutral",
      segments: [{ text: "Plain folder (no Git)" }],
      usable: true,
    });
  }
  return status({
    ...base,
    kind: "unchecked",
    tone: "neutral",
    segments: [{ text: `Folder on ${nodeLabel}; it's checked when you add it.` }],
    usable: true,
  });
}

/**
 * The path the status bar shows above its line: the folder the project would live in, else
 * the selection (a parent whose new folder has no name yet), home-relative; null before
 * anything is selected. The status line itself never repeats it.
 */
export function folderStatusPath(
  value: Pick<FolderSelectionStatus, "destinationPath" | "selectedPath">,
  homeDirectory: string | null | undefined,
): string | null {
  const path = value.destinationPath ?? value.selectedPath;
  return path === null ? null : formatNodePath(path, homeDirectory);
}

/** A stable key for a status, so a parent hears about real changes only. */
export function folderSelectionStatusKey(value: FolderSelectionStatus): string {
  return [
    value.kind,
    value.usable,
    value.text,
    value.selectedPath,
    value.destinationPath,
    value.suggestedPath,
    value.preview?.state,
    value.preview?.resolvedPath,
  ].join("\u0000");
}

/* ───────── Search results ───────── */

/**
 * The note under the search results: `more-matches` when more folders matched
 * than the list shows ("type more"), `incomplete` when the node's search ran
 * out of time or folders before it searched everywhere. A directory the node
 * read only in part says neither: one huge asset folder is not a reason to
 * narrow the query. A node that predates `limitReached` reported both through
 * `truncated`, so for it only a full list counts.
 */
export function folderSearchNote(
  result: Pick<FilesystemSearchDirectoriesResult, "matches" | "truncated" | "limitReached">,
  limit: number,
): "more-matches" | "incomplete" | null {
  if (result.limitReached === undefined) {
    return result.matches.length >= limit ? "more-matches" : null;
  }
  if (result.limitReached) return "more-matches";
  return result.truncated ? "incomplete" : null;
}
