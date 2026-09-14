import type { Project, SidebarWorktreeSummary } from "@ryco/client-runtime/state/threads";
import {
  DEFAULT_MODEL,
  ProviderInstanceId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type WorktreeId,
} from "@ryco/contracts";

import type { ProjectEnvironment } from "../projects/projectsModel";

export interface NewTaskLaunchContext {
  readonly environmentId?: EnvironmentId | null;
  readonly projectId?: ProjectId | null;
  readonly worktreeId?: WorktreeId | null;
}

export interface NewTaskDefaults {
  readonly environment: ProjectEnvironment | null;
  readonly project: Project | null;
  readonly worktree: SidebarWorktreeSummary | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: "full-access";
  readonly interactionMode: "default";
  readonly tokenMode: "balanced";
  readonly requiresProject: boolean;
}

function mutationReady(environment: ProjectEnvironment): boolean {
  return environment.connectionState === "connected";
}

export function deriveNewTaskDefaults(input: {
  readonly launch?: NewTaskLaunchContext;
  readonly environments: ReadonlyArray<ProjectEnvironment>;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
}): NewTaskDefaults {
  const launchedEnvironment = input.launch?.environmentId
    ? input.environments.find(
        (environment) =>
          environment.environmentId === input.launch?.environmentId && mutationReady(environment),
      )
    : null;
  const environment =
    launchedEnvironment ?? input.environments.find((candidate) => mutationReady(candidate)) ?? null;

  const projects = environment
    ? input.projects.filter((project) => project.environmentId === environment.environmentId)
    : [];
  const launchedProject = input.launch?.projectId
    ? projects.find((project) => project.id === input.launch?.projectId)
    : null;
  const project = launchedProject ?? projects[0] ?? null;

  const launchedWorktree =
    project && input.launch?.worktreeId
      ? input.worktrees.find(
          (worktree) =>
            worktree.environmentId === project.environmentId &&
            worktree.projectId === project.id &&
            worktree.id === input.launch?.worktreeId &&
            worktree.archivedAt === null,
        )
      : null;

  return {
    environment,
    project,
    worktree: launchedWorktree ?? null,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    tokenMode: "balanced",
    requiresProject: environment !== null && project === null,
  };
}

export function newTaskContextLabel(input: {
  readonly environmentLabel: string | null;
  readonly projectTitle: string | null;
  readonly worktreeTitle: string | null;
}): string {
  return [
    input.environmentLabel ?? "Choose machine",
    input.projectTitle ?? "Choose project",
    input.worktreeTitle ?? "Local workspace",
  ].join(" · ");
}

export function inferTaskTitle(prompt: string): string {
  const firstLine = prompt
    .trim()
    .split(/\r?\n/u)
    .find((line) => line.trim());
  const title = firstLine?.trim() ?? "New task";
  return title.length <= 72 ? title : `${title.slice(0, 69).trimEnd()}…`;
}

/** Project ids are scoped to their machine; choosing a row must retain both. */
export function resolveNewTaskProjectChoice(input: {
  readonly target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
  readonly projects: ReadonlyArray<Project>;
  readonly environments: ReadonlyArray<ProjectEnvironment>;
}): Project | null {
  if (
    !input.environments.some(
      (environment) =>
        environment.environmentId === input.target.environmentId && mutationReady(environment),
    )
  )
    return null;
  return (
    input.projects.find(
      (project) =>
        project.environmentId === input.target.environmentId &&
        project.id === input.target.projectId,
    ) ?? null
  );
}
