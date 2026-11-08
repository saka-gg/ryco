import type { ProjectCopyMode, ProjectCopyOptionsPlan } from "@ryco/client-runtime/projectCopy";
import type { Project } from "@ryco/client-runtime/state/threads";
import { deriveLogicalProjectKey } from "@ryco/client-runtime/state/workspace";
import type { ScopedProjectRef } from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";

/**
 * Every checkout of the project `ref` names, across machines: the project the
 * copy starts from and those of the same repository (the logical project).
 * A chat's folder is never a project to copy.
 */
export function copyMembersOf(
  projects: ReadonlyArray<Project>,
  ref: ScopedProjectRef,
): ReadonlyArray<Project> {
  const project = projects.find(
    (candidate) => candidate.environmentId === ref.environmentId && candidate.id === ref.projectId,
  );
  if (!project || isChatProject(project)) return [];
  const key = deriveLogicalProjectKey(project);
  const members = projects.filter(
    (candidate) => !isChatProject(candidate) && deriveLogicalProjectKey(candidate) === key,
  );
  return members.length > 0 ? members : [project];
}

export interface CopyModeRow {
  readonly mode: ProjectCopyMode;
  readonly label: string;
  readonly detail: string;
  readonly available: boolean;
}

const MODE_LABELS: Readonly<Record<ProjectCopyMode, string>> = {
  clone: "Clone from the remote",
  "send-files": "Send the files",
  link: "Link the existing folder",
};

/** The How rows: each mode with what it does or why it can't, in the order the form shows them. */
export function copyModeRows(options: ProjectCopyOptionsPlan): ReadonlyArray<CopyModeRow> {
  const clone = options.modes.clone;
  const cloneDetail = clone.available
    ? clone.reachable === false
      ? (clone.reachabilityDetail ?? "The destination can't reach the remote.")
      : (clone.remoteUrl ?? "Clones the repository there.")
    : (clone.reason ?? "No remote to clone from.");
  const rows: CopyModeRow[] = [
    { mode: "clone", label: MODE_LABELS.clone, detail: cloneDetail, available: clone.available },
    {
      mode: "send-files",
      label: MODE_LABELS["send-files"],
      detail: options.modes.sendFiles.available
        ? "This phone carries the repository over, history included."
        : (options.modes.sendFiles.reason ?? "Not possible for this project."),
      available: options.modes.sendFiles.available,
    },
  ];
  // Link only applies where a checkout already sits in the folder.
  if (options.modes.link.available || options.choices.mode === "link") {
    rows.push({
      mode: "link",
      label: MODE_LABELS.link,
      detail: "Adds the checkout that is already there, copying nothing.",
      available: options.modes.link.available,
    });
  }
  return rows;
}

/** The primary button's words for the effective mode. */
export function copyStartLabel(mode: ProjectCopyMode, targetLabel: string): string {
  if (mode === "link") return `Link on ${targetLabel}`;
  return `Copy to ${targetLabel}`;
}

/** "1 changed file", "3 changed files", "No changes". */
export function changedFilesLabel(count: number): string {
  if (count === 0) return "No changes";
  return `${count} changed ${count === 1 ? "file" : "files"}`;
}
