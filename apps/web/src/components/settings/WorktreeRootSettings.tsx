import { useState } from "react";
import type { ServerSettingsPatch } from "@ryco/contracts";

import { useServerConfig, applySettingsUpdated } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import { DraftInput } from "../ui/draft-input";
import { SETTINGS_CONTROL_WIDTH, SettingResetButton, SettingsRow } from "./settingsLayout";

/** A node-scoped preference. Paths are interpreted and validated by the selected server. */
export function WorktreeRootSettings({
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
  // Remount the editor on node changes so in-flight errors and drafts never cross environments.
  return (
    <WorktreeRootEditor
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

export function WorktreeRootEditor({
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A removed project must never redirect its edit to the device default.
  const projectMissing =
    requestedProjectId !== "" && !projects.some((project) => project.id === requestedProjectId);
  const projectId = projectMissing ? "" : requestedProjectId;
  const blocked = disabled || saving || projectMissing;
  const settings = config?.settings;
  const override =
    projectId && settings && Object.hasOwn(settings.projectWorktreeRoots, projectId)
      ? settings.projectWorktreeRoots[projectId]
      : null;
  const inherited = projectId !== "" && !override;
  const value = projectId ? (override ?? "") : (settings?.worktreeRoot ?? "");
  const effective = override || settings?.worktreeRoot || "Ryco-managed directory";

  async function save(root: string) {
    if (blocked) return;
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
      description={`Where new worktrees are created. Use an absolute path or ~/; leave empty to ${projectId ? "inherit" : "use the default"}. Existing checkouts keep their paths.`}
      resetAction={
        value ? (
          <SettingResetButton
            label="worktree root"
            tooltip={projectId ? "Use device default" : "Reset to default"}
            ariaLabel={projectId ? "Use device default for worktree root" : undefined}
            disabled={blocked}
            onClick={() => void save("")}
          />
        ) : null
      }
      status={
        <>
          <span className="block break-all">
            {inherited ? "Inherited: " : "Effective: "}
            {effective}
          </span>
          {error ? (
            <span role="alert" className="mt-1 block text-destructive-foreground">
              {error}
            </span>
          ) : saving ? (
            <span role="status" className="mt-1 block">
              Saving…
            </span>
          ) : null}
        </>
      }
      control={
        <DraftInput
          key={projectId}
          className={SETTINGS_CONTROL_WIDTH.lg}
          value={value}
          disabled={blocked}
          onCommit={(root) => {
            void save(root);
          }}
          placeholder={projectId ? "Inherit device default" : "Ryco-managed directory"}
          aria-label="Worktree root directory"
          spellCheck={false}
          autoCapitalize="none"
        />
      }
    />
  );
}
