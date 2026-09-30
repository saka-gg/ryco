import { useState } from "react";
import { Schema } from "effect";
import { WorktreeSubmodules } from "@ryco/contracts";
import {
  WORKTREE_SUBMODULE_OPTIONS,
  worktreeSubmodulesPatch,
} from "@ryco/shared/worktreeSubmodules";
import { useShallow } from "zustand/react/shallow";

import { useServerConfig, applySettingsUpdated } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

export function WorktreeSubmoduleSettings() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  return (
    <WorktreeSubmoduleEditor
      key={environmentId ?? "disconnected"}
      projects={projects
        .filter((project) => project.environmentId === environmentId)
        .map((project) => ({ id: project.id, title: project.name }))}
      disabled={
        scope === "client" ||
        !config ||
        (scope === "node" && !target) ||
        Boolean(
          target && (!target.connected || target.canManage === false || target.canMutate === false),
        )
      }
    />
  );
}

export function WorktreeSubmoduleEditor({
  projects,
  disabled,
}: {
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly disabled: boolean;
}) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const supported = config?.environment.capabilities.worktreeSubmoduleSettings === true;
  const editingDisabled = disabled || !supported;
  const [selectedProject, setSelectedProject] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = projects.some((project) => project.id === selectedProject)
    ? selectedProject
    : "";
  const settings = config?.settings;
  const override =
    projectId && settings && Object.hasOwn(settings.projectWorktreeSubmodules, projectId)
      ? settings.projectWorktreeSubmodules[projectId]
      : null;
  const value = projectId ? (override ?? "inherit") : (settings?.worktreeSubmodules ?? "recursive");
  async function save(value: string | null) {
    if (editingDisabled || saving || !value) return;
    const mode = value === "inherit" ? null : value;
    if (mode !== null && !Schema.is(WorktreeSubmodules)(mode)) return;
    setSaving(true);
    setError(null);
    try {
      const patch = worktreeSubmodulesPatch(projectId || null, mode);
      if (target) await updateEnvironmentServerSettings(target.environmentId, patch);
      else applySettingsUpdated(await ensureLocalApi().server.updateSettings(patch));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save submodule initialization. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsRow
      title="Worktree submodules"
      description="Choose how new worktrees initialize submodules. Existing checkouts are unaffected. Project overrides take precedence over repository configuration and the node default."
      owner="node"
      scope={target?.nodeLabel ?? "This node"}
      control={
        <div className="flex w-full flex-col gap-2 sm:w-72">
          <Select
            value={projectId ? `project:${projectId}` : "environment"}
            disabled={editingDisabled || saving}
            onValueChange={(value) => {
              setSelectedProject(
                value?.startsWith("project:") ? value.slice("project:".length) : "",
              );
              setError(null);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Worktree submodules scope">
              <SelectValue>
                {projects.find((project) => project.id === projectId)?.title ?? "Node default"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="environment">Node default</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={`project:${project.id}`}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={value}
            disabled={editingDisabled || saving}
            onValueChange={(value) => {
              void save(value);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Worktree submodule initialization">
              <SelectValue>
                {value === "inherit"
                  ? "Inherit"
                  : WORKTREE_SUBMODULE_OPTIONS.find((option) => option.value === value)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {projectId && <SelectItem value="inherit">Inherit</SelectItem>}
              {WORKTREE_SUBMODULE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-xs text-muted-foreground">
            {!supported
              ? "This node does not support configurable submodules. Update the node to change this setting."
              : value === "inherit"
                ? "Use repository configuration when present, otherwise the node default."
                : WORKTREE_SUBMODULE_OPTIONS.find((option) => option.value === value)?.description}
          </p>
          {saving && (
            <p role="status" className="text-xs text-muted-foreground">
              Saving…
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}
