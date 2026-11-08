import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import type { Project } from "@ryco/client-runtime/state/threads";
import { deriveLogicalProjectKey } from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId } from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { normalizeProjectPathForDispatch } from "@ryco/shared/projectPaths";

/** Where a project on the phone's Add Project sheet comes from. */
export type AddProjectSource = "folder" | "clone" | "copy" | "link";

/** The machines a project can be added to now: online (or connecting) and open to changes. */
export function addProjectMachines(
  nodes: ReadonlyArray<NodeCatalogEntry>,
): ReadonlyArray<NodeCatalogEntry> {
  return nodes.filter((node) => node.presence !== "offline" && node.canMutate);
}

/** The machine the sheet starts on: the one asked for when it can take a project, else the first. */
export function initialAddProjectMachine(
  machines: ReadonlyArray<NodeCatalogEntry>,
  requested: EnvironmentId | null,
): EnvironmentId | null {
  const asked = machines.find((node) => node.environmentId === requested);
  if (asked) return asked.environmentId;
  return (
    machines.find((node) => node.presence === "online")?.environmentId ??
    machines[0]?.environmentId ??
    null
  );
}

/** A project on another machine that the copy and link sources offer. */
export interface OtherMachineProject {
  readonly project: Project;
  readonly machineLabel: string;
}

/**
 * Projects on other machines that `target` does not have yet (by repository),
 * one per logical project: what "Copy from another machine" and "Link a
 * checkout already here" list. Chats are never projects to copy.
 */
export function otherMachineProjects(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly target: EnvironmentId;
  readonly labelOf: (environmentId: EnvironmentId) => string | null;
}): ReadonlyArray<OtherMachineProject> {
  const onTarget = new Set(
    input.projects
      .filter((project) => project.environmentId === input.target && !isChatProject(project))
      .map((project) => deriveLogicalProjectKey(project)),
  );
  const seen = new Set<string>();
  const rows: OtherMachineProject[] = [];
  for (const project of input.projects) {
    if (project.environmentId === input.target || isChatProject(project)) continue;
    const key = deriveLogicalProjectKey(project);
    if (onTarget.has(key) || seen.has(key)) continue;
    const machineLabel = input.labelOf(project.environmentId);
    if (machineLabel === null) continue;
    seen.add(key);
    rows.push({ project, machineLabel });
  }
  return rows.toSorted((left, right) =>
    left.project.name.localeCompare(right.project.name, undefined, { sensitivity: "base" }),
  );
}

/** The folder a clone gets inside `parent`, with the parent's separator. */
export function cloneDestinationPath(parent: string, folderName: string): string {
  const base = normalizeProjectPathForDispatch(parent);
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.endsWith(separator) ? `${base}${folderName}` : `${base}${separator}${folderName}`;
}

/** What the primary button of each source says. */
export function addProjectActionLabel(source: AddProjectSource, machineLabel: string): string {
  switch (source) {
    case "folder":
      return "Add this folder";
    case "clone":
      return `Clone to ${machineLabel}`;
    case "copy":
      return "Choose what to copy";
    case "link":
      return "Link this folder";
  }
}
