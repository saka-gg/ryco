import { useState } from "react";
import { Schema } from "effect";
import { WorktreeSubmodules } from "@ryco/contracts";
import {
  WORKTREE_SUBMODULE_OPTIONS,
  worktreeSubmodulesPatch,
} from "@ryco/shared/worktreeSubmodules";

import { useServerConfig, applySettingsUpdated } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import { SettingsRow } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

export function WorktreeSubmoduleSettings({
  projectId,
  projects,
}: {
  readonly projectId: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  return (
    <WorktreeSubmoduleEditor
      key={environmentId ?? "disconnected"}
      projectId={projectId}
      projects={projects}
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
  projectId: requestedProjectId,
  projects,
  disabled,
}: {
  readonly projectId: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly disabled: boolean;
}) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const supported = config?.environment.capabilities.worktreeSubmoduleSettings === true;
  // A removed project must never redirect its edit to the device default.
  const projectMissing =
    requestedProjectId !== "" && !projects.some((project) => project.id === requestedProjectId);
  const projectId = projectMissing ? "" : requestedProjectId;
  const editingDisabled = disabled || !supported || projectMissing;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const options = [
    ...(projectId ? [{ value: "inherit", label: "Inherit" }] : []),
    ...WORKTREE_SUBMODULE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
  ];
  return (
    <SettingsRow
      title="Worktree submodules"
      description="How new worktrees initialize submodules. Project overrides take precedence over repository configuration and the device default."
      owner="node"
      scope={target?.nodeLabel ?? "This node"}
      status={
        error ? (
          <span role="alert" className="text-destructive-foreground">
            {error}
          </span>
        ) : saving ? (
          <span role="status">Saving…</span>
        ) : !supported ? (
          "This node does not support configurable submodules. Update the node to change this setting."
        ) : value === "inherit" ? (
          "Use repository configuration when present, otherwise the device default."
        ) : (
          WORKTREE_SUBMODULE_OPTIONS.find((option) => option.value === value)?.description
        )
      }
      control={
        <SettingsSelect
          ariaLabel="Worktree submodule initialization"
          value={value}
          disabled={editingDisabled || saving}
          onValueChange={(next) => void save(next)}
          options={options}
        />
      }
    />
  );
}
