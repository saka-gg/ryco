import type { ProjectKind } from "@ryco/contracts";

/** Anything that may carry a project kind: wire projects, projections, client state. */
export interface ProjectKindCarrier {
  readonly kind?: ProjectKind | undefined;
}

/**
 * The one reading of a project's kind. Absent (older nodes, snapshots and caches) or unknown
 * values mean a regular project, so a chat is only ever recognised when it says so explicitly.
 */
export function projectKindOf(project: ProjectKindCarrier | null | undefined): ProjectKind {
  return project?.kind === "chat" ? "chat" : "project";
}

/** Whether the project backs a "No project" chat (a Ryco-managed folder, one per chat). */
export function isChatProject(project: ProjectKindCarrier | null | undefined): boolean {
  return projectKindOf(project) === "chat";
}

/**
 * Project lists, pickers and counts never offer chats: a chat's project is its folder, not a
 * place to start work. Returns the input unchanged (same identity) when it holds no chats, so
 * memoized consumers stay stable.
 */
export function excludeChatProjects<T extends ProjectKindCarrier>(
  projects: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return projects.some(isChatProject)
    ? projects.filter((project) => !isChatProject(project))
    : projects;
}
