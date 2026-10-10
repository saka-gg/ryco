import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, FolderIcon, ServerIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { buildProjectsPageLocation } from "../../projectsRoute";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { useSettingsTarget } from "../../settingsTarget";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { useProjectsLayoutStore } from "../projects/projectsLayoutStore";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ProjectPreferenceSettings } from "./ProjectPreferenceSettings";
import { SettingsSection } from "./settingsLayout";
import { WorktreeRootSettings } from "./WorktreeRootSettings";
import { ChatsFolderSettings } from "./ChatsFolderSettings";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { WorktreeSubmoduleSettings } from "./WorktreeSubmoduleSettings";

export interface ProjectScopeChoice {
  readonly id: string;
  readonly title: string;
}

/**
 * Which defaults the rows below it edit: the node's, or one project's
 * overrides. One picker for the whole group — every project default shares the
 * same inherit-or-override model, so each row having its own copy of this
 * choice was three ways to ask one question.
 */
export function ProjectScopeSelect({
  projects,
  value,
  onChange,
  disabled,
}: {
  projects: ReadonlyArray<ProjectScopeChoice>;
  value: string;
  onChange: (projectId: string) => void;
  disabled?: boolean;
}) {
  const selected = projects.find((project) => project.id === value);
  return (
    <Select
      value={value ? `project:${value}` : "node"}
      disabled={disabled}
      onValueChange={(next, details) => {
        // The Select can suggest its first option when a project disappears.
        // Only an intentional user selection may change the editing scope.
        if (details.reason === "none") {
          details.cancel();
          return;
        }
        // A removed option can produce null; it must not redirect edits to node defaults.
        if (next === "node") onChange("");
        else if (typeof next === "string" && next.startsWith("project:"))
          onChange(next.slice("project:".length));
      }}
    >
      <SelectTrigger size="sm" aria-label="Project default scope" className="w-full sm:w-52">
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            {value ? (
              <FolderIcon className="size-3.5 shrink-0 opacity-70" />
            ) : (
              <ServerIcon className="size-3.5 shrink-0 opacity-70" />
            )}
            <span className="truncate">
              {selected?.title ?? (value ? "Project removed" : "All projects")}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="node">All projects</SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={`project:${project.id}`}>
            {project.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Where a "per-project overrides" link should land: the checkout last opened
 * on the projects page when it is on this device, else this device's first
 * project, else the page itself.
 */
function projectsPageLocationFor(environmentId: string | undefined, projectIds: readonly string[]) {
  if (!environmentId || projectIds.length === 0) return buildProjectsPageLocation();
  const last = useProjectsLayoutStore.getState().lastCheckoutKey;
  const lastProjectId = last?.startsWith(`${environmentId}\0`)
    ? last.slice(environmentId.length + 1)
    : null;
  const projectId =
    lastProjectId && projectIds.includes(lastProjectId) ? lastProjectId : projectIds[0]!;
  return buildProjectsPageLocation({
    environmentId: environmentId as EnvironmentId,
    projectId: projectId as ProjectId,
    section: "defaults",
  });
}

/**
 * This device's defaults for new threads and worktrees. Each project can
 * override them; those overrides live with the project on the projects page.
 */
export function ProjectDefaultsSection() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const navigate = useNavigate();
  const closeSettings = useSettingsDialogStore((state) => state.closeSettings);
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  // Chats carry no project defaults of their own.
  const projects = excludeChatProjects(allProjects)
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ id: project.id, title: project.name }));
  return (
    <SettingsSection
      title="Project defaults"
      owner="node"
      description="Used by new threads and worktrees in every project on this device."
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            const location = projectsPageLocationFor(
              environmentId,
              projects.map((project) => project.id),
            );
            // Close first; the settings route defers its own back-navigation.
            closeSettings();
            void navigate(location);
          }}
        >
          Per-project overrides
          <ArrowUpRightIcon className="size-3" />
        </Button>
      }
    >
      {config?.environment.capabilities.projectPreferences === true ? (
        <ProjectPreferenceSettings projectId="" projects={projects} />
      ) : null}
      <WorktreeRootSettings projectId="" projects={projects} />
      <ChatsFolderSettings />
      <WorktreeSubmoduleSettings projectId="" projects={projects} />
    </SettingsSection>
  );
}
