import type { AtlassianConnectionId, EnvironmentId, WorkItemProject } from "@ryco/contracts";
import { useEffect } from "react";
import { useWorkItemProjects } from "~/rpc/useWorkItems";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { errorMessage } from "~/lib/errorMessage";

const JIRA_PROJECT_PICKER_EMPTY = "__ryco_empty_jira_project__";
const EMPTY_PROJECTS: ReadonlyArray<WorkItemProject> = [];

function splitProjectKeys(value: string): ReadonlyArray<string> {
  return value
    .split(/[,\s]+/u)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function selectedProjectValue(input: {
  readonly projectKeys: string;
  readonly projects: ReadonlyArray<WorkItemProject>;
}): string {
  const keys = splitProjectKeys(input.projectKeys);
  if (keys.length !== 1) return JIRA_PROJECT_PICKER_EMPTY;
  const key = keys[0];
  if (!key) return JIRA_PROJECT_PICKER_EMPTY;
  return input.projects.some((project) => project.key === key) ? key : JIRA_PROJECT_PICKER_EMPTY;
}

export function JiraProjectPicker(props: {
  readonly environmentId: EnvironmentId | null;
  readonly connectionId: AtlassianConnectionId | null;
  readonly siteUrl: string;
  readonly projectKeys: string;
  readonly disabled?: boolean;
  readonly onProjectKeysChange: (projectKeys: string) => void;
}) {
  const {
    environmentId,
    connectionId,
    siteUrl,
    projectKeys,
    disabled = false,
    onProjectKeysChange,
  } = props;
  const projectsQuery = useWorkItemProjects({
    environmentId,
    connectionId,
    siteUrl,
    enabled: !disabled,
  });
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;
  const selectedValue = selectedProjectValue({ projectKeys, projects });

  useEffect(() => {
    if (disabled) return;
    if (projectKeys.trim().length > 0) return;
    if (projects.length !== 1) return;
    const project = projects[0];
    if (project) onProjectKeysChange(project.key);
  }, [disabled, onProjectKeysChange, projectKeys, projects]);

  return (
    <div className="space-y-1.5">
      <Select
        value={selectedValue}
        onValueChange={(value) => {
          if (typeof value === "string" && value !== JIRA_PROJECT_PICKER_EMPTY) {
            onProjectKeysChange(value);
          }
        }}
      >
        <SelectTrigger size="sm" disabled={disabled || connectionId === null}>
          <SelectValue
            placeholder={
              projectsQuery.isLoading
                ? "Loading Jira projects"
                : projects.length > 0
                  ? "Select Jira project"
                  : "No Jira projects found"
            }
          />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={JIRA_PROJECT_PICKER_EMPTY}>Select Jira project</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.key} value={project.key}>
              {project.key} - {project.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {projectsQuery.error ? (
        <p className="text-destructive text-[11px]">
          {errorMessage(projectsQuery.error, "Failed to load Jira projects.")}
        </p>
      ) : projects.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Select a project to fill the project key automatically.
        </p>
      ) : connectionId !== null && !projectsQuery.isLoading ? (
        <p className="text-[11px] text-muted-foreground">
          Enter project keys manually if this token cannot list projects.
        </p>
      ) : null}
    </div>
  );
}
