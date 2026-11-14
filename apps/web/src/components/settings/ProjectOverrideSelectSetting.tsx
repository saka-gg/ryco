import { useState } from "react";
import type {
  ExecutionEnvironmentCapabilities,
  ServerSettings,
  ServerSettingsPatch,
} from "@ryco/contracts";

import { applySettingsUpdated, useServerConfig } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { isNodeSettingsTargetReadOnly } from "./settingsSections.logic";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import type { ShareableServerSettingKey } from "@ryco/shared/settingsSharing";
import { SettingsRow } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";
import { errorMessage } from "~/lib/errorMessage";

const INHERIT = "inherit";

/**
 * One node setting with per-project overrides, edited as a select: the node default when
 * `projectId` is empty, else that project's override with an Inherit choice.
 */
export interface ProjectOverrideSelectSpec<Value extends string> {
  readonly title: string;
  readonly description: string;
  readonly ariaLabel: string;
  readonly options: ReadonlyArray<{
    readonly value: Value;
    readonly label: string;
    readonly description: string;
  }>;
  /** Trigger width; wide enough for the longest option label (default `md`). */
  readonly controlWidth?: "md" | "lg";
  readonly isValue: (value: string) => value is Value;
  /** Whether the node knows the setting; older nodes drop unknown keys. */
  readonly supported: (capabilities: ExecutionEnvironmentCapabilities) => boolean;
  /** The node default and the project's own override (null inherits). */
  readonly select: (
    settings: ServerSettings | undefined,
    projectId: string,
  ) => { readonly node: Value; readonly override: Value | null };
  readonly patch: (projectId: string | null, value: Value | null) => ServerSettingsPatch;
  /**
   * The node default is this shared device setting: on the settings page its row shows every
   * device. A project's override stays on its device.
   */
  readonly sharedKey?: ShareableServerSettingKey;
  readonly unsupportedStatus: string;
  readonly inheritStatus: (node: Value) => string;
  readonly saveFailed: string;
}

interface ProjectOverrideSelectProps {
  readonly projectId: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

/**
 * Disabled without a loaded config, when the settings target is read-only
 * (`isNodeSettingsTargetReadOnly`), and on nodes too old to know the setting.
 */
export function ProjectOverrideSelectSetting<Value extends string>({
  spec,
  projectId,
  projects,
}: ProjectOverrideSelectProps & { readonly spec: ProjectOverrideSelectSpec<Value> }) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  if (projectId === "" && spec.sharedKey !== undefined)
    return <SharedDefaultSelect spec={spec} sharedKey={spec.sharedKey} />;
  return (
    <ProjectOverrideSelectEditor
      key={environmentId ?? "disconnected"}
      spec={spec}
      projectId={projectId}
      projects={projects}
      disabled={!config || isNodeSettingsTargetReadOnly(scope, target)}
    />
  );
}

export function ProjectOverrideSelectEditor<Value extends string>({
  spec,
  projectId: requestedProjectId,
  projects,
  disabled,
}: ProjectOverrideSelectProps & {
  readonly spec: ProjectOverrideSelectSpec<Value>;
  readonly disabled: boolean;
}) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const supported = config ? spec.supported(config.environment.capabilities) : false;
  // A removed project must never redirect its edit to the device default.
  const projectMissing =
    requestedProjectId !== "" && !projects.some((project) => project.id === requestedProjectId);
  const projectId = projectMissing ? "" : requestedProjectId;
  const editingDisabled = disabled || !supported || projectMissing;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { node, override } = spec.select(config?.settings, projectId);
  const value: string = projectId ? (override ?? INHERIT) : node;

  async function save(next: string | null) {
    if (editingDisabled || saving || !next) return;
    const chosen = next === INHERIT ? null : next;
    if (chosen !== null && !spec.isValue(chosen)) return;
    setSaving(true);
    setError(null);
    // No `finally`: the React Compiler cannot lower it and would skip this
    // component. The catch takes every failure, so saving always ends below.
    try {
      const patch = spec.patch(projectId || null, chosen);
      if (target) await updateEnvironmentServerSettings(target.environmentId, patch);
      else applySettingsUpdated(await ensureLocalApi().server.updateSettings(patch));
    } catch (cause) {
      setError(errorMessage(cause, spec.saveFailed));
    }
    setSaving(false);
  }

  const options = [
    ...(projectId ? [{ value: INHERIT, label: "Inherit" }] : []),
    ...spec.options.map((option) => ({ value: option.value, label: option.label })),
  ];
  return (
    <SettingsRow
      title={spec.title}
      description={spec.description}
      owner="node"
      scope={target?.nodeLabel ?? "This node"}
      status={
        <>
          {error ? (
            <span role="alert" className="text-destructive-foreground">
              {error}
            </span>
          ) : saving ? (
            <span role="status">Saving…</span>
          ) : !supported ? (
            spec.unsupportedStatus
          ) : value === INHERIT ? (
            spec.inheritStatus(node)
          ) : (
            spec.options.find((option) => option.value === value)?.description
          )}
        </>
      }
      control={
        <SettingsSelect
          ariaLabel={spec.ariaLabel}
          width={spec.controlWidth ?? "md"}
          value={value}
          disabled={editingDisabled || saving}
          onValueChange={(next) => void save(next)}
          options={options}
        />
      }
    />
  );
}

/** The device default of a setting shared across devices: one row for every device. */
function SharedDefaultSelect<Value extends string>({
  spec,
  sharedKey,
}: {
  readonly spec: ProjectOverrideSelectSpec<Value>;
  readonly sharedKey: ShareableServerSettingKey;
}) {
  return (
    <SharedSettingRow
      settingKey={sharedKey}
      title={spec.title}
      description={spec.description}
      knowsSetting={(config) => spec.supported(config.environment.capabilities)}
      unknownSettingStatus={spec.unsupportedStatus}
      // Stands in, disabled, until the device's config arrives.
      defaultValue={spec.select(undefined, "").node as never}
      render={(control) => (
        <SettingsSelect
          ariaLabel={sharedControlLabel(spec.ariaLabel, control)}
          width={spec.controlWidth ?? "md"}
          value={String(control.value)}
          disabled={control.disabled}
          onValueChange={(next) => {
            if (spec.isValue(next)) control.onChange(next as never);
          }}
          options={spec.options.map((option) => ({ value: option.value, label: option.label }))}
        />
      )}
    />
  );
}
