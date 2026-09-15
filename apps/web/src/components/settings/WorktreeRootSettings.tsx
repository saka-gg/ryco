import { useState } from "react";
import type { ServerSettingsPatch } from "@ryco/contracts";
import { useShallow } from "zustand/react/shallow";

import { useServerConfig, applySettingsUpdated } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import { DraftInput } from "../ui/draft-input";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

/** A node-scoped preference. Paths are interpreted and validated by the selected server. */
export function WorktreeRootSettings() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  // Remount the editor on node changes so in-flight errors and drafts never cross environments.
  return (
    <WorktreeRootEditor
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

export function WorktreeRootEditor({
  projects,
  disabled,
}: {
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly disabled: boolean;
}) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const [selectedProject, setSelectedProject] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = projects.some((project) => project.id === selectedProject)
    ? selectedProject
    : "";
  const settings = config?.settings;
  const override =
    projectId && settings && Object.hasOwn(settings.projectWorktreeRoots, projectId)
      ? settings.projectWorktreeRoots[projectId]
      : null;
  const inherited = projectId !== "" && !override;
  const value = projectId ? (override ?? "") : (settings?.worktreeRoot ?? "");
  const effective = override || settings?.worktreeRoot || "Ryco-managed directory";

  async function save(root: string) {
    if (disabled || saving) return;
    setSaving(true);
    setError(null);
    const patch: ServerSettingsPatch = projectId
      ? { projectWorktreeRoots: { [projectId]: root.trim() || null } }
      : { worktreeRoot: root.trim() };
    try {
      if (target) await updateEnvironmentServerSettings(target.environmentId, patch);
      else applySettingsUpdated(await ensureLocalApi().server.updateSettings(patch));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save worktree root. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      title="Worktree root"
      owner="node"
      scope={target?.nodeLabel ?? "This node"}
      description="Choose where new worktrees are created on this node. Existing checkouts keep their paths."
      control={
        <div className="flex w-full flex-col gap-2 sm:w-72">
          <Select
            value={projectId || "environment"}
            disabled={disabled || saving}
            onValueChange={(value) => {
              setSelectedProject(value === "environment" ? "" : (value ?? ""));
              setError(null);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Worktree root scope">
              <SelectValue>
                {projects.find((project) => project.id === projectId)?.title ??
                  "Environment default"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="environment">Environment default</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <DraftInput
            key={projectId}
            value={value}
            disabled={disabled || saving}
            onCommit={(root) => {
              void save(root);
            }}
            placeholder={projectId ? "Inherit environment default" : "Ryco-managed directory"}
            aria-label="Worktree root directory"
            spellCheck={false}
            autoCapitalize="none"
          />
          <p className="break-all text-xs text-muted-foreground">
            {inherited ? "Inherited: " : "Effective: "}
            {effective}
          </p>
          <p className="text-xs text-muted-foreground">
            Use an absolute path or ~/. Leave empty to {projectId ? "inherit" : "reset"}.
          </p>
          {value && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || saving}
              onClick={() => {
                void save("");
              }}
            >
              {projectId ? "Use environment default" : "Reset worktree root"}
            </Button>
          )}
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
