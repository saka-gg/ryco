import { useState } from "react";
import { WS_METHODS } from "@ryco/contracts";
import { FolderIcon, ServerIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsTarget } from "../../settingsTarget";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ProjectPreferenceSettings } from "./ProjectPreferenceSettings";
import { SettingsSection } from "./settingsLayout";
import { WorktreeRootSettings } from "./WorktreeRootSettings";
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

/** Node defaults for new threads and worktrees, with per-project overrides. */
export function ProjectDefaultsSection() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const capability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  const projects = allProjects
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ id: project.id, title: project.name }));
  const [selection, setSelection] = useState<{ environmentId: string; projectId: string }>({
    environmentId: environmentId ?? "",
    projectId: "",
  });
  // A different node starts back at its own defaults; drafts never cross nodes.
  const projectId = selection.environmentId === (environmentId ?? "") ? selection.projectId : "";
  const disabled =
    !capability.allowed ||
    !config ||
    !target ||
    !target.connected ||
    target.canManage === false ||
    target.canMutate === false;
  return (
    <SettingsSection
      title="Project defaults"
      owner="node"
      description={
        projectId
          ? "Overrides for this project. Fields you don't change keep following the device defaults."
          : "Used by new threads and worktrees. Pick a project to override fields for it."
      }
      headerAction={
        <ProjectScopeSelect
          projects={projects}
          value={projectId}
          disabled={disabled}
          onChange={(next) => setSelection({ environmentId: environmentId ?? "", projectId: next })}
        />
      }
    >
      {config?.environment.capabilities.projectPreferences === true ? (
        <ProjectPreferenceSettings projectId={projectId} projects={projects} />
      ) : null}
      <WorktreeRootSettings projectId={projectId} projects={projects} />
      <WorktreeSubmoduleSettings projectId={projectId} projects={projects} />
    </SettingsSection>
  );
}
