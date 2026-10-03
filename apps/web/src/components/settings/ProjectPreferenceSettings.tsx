import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { WS_METHODS } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import {
  DEFAULT_UNIFIED_SETTINGS,
  INITIAL_MODEL_OPTION_IDS,
  type ProjectPreferencesExpected,
  ProjectId,
  WorktreeBranchPrefix,
  type EffectiveProjectPreferences,
  type ProjectPreferencesPatch,
  type ServerSettingsPatch,
} from "@ryco/contracts";
import { readEffectiveProjectPreferences } from "@ryco/client-runtime/state/settings";
import { createModelSelection } from "@ryco/shared/model";
import { useServerConfig, applySettingsUpdated } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { ensureEnvironmentApi } from "../../environmentApi";
import { ensureLocalApi } from "../../localApi";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { DraftInput } from "../ui/draft-input";
import { Button } from "../ui/button";
import { SettingResetButton, SettingsBlock, SettingsNotice, SettingsRow } from "./settingsLayout";
import { SETTINGS_CONTROL_WIDTH } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

export function ProjectPreferenceSettings({
  projectId,
  projects,
}: {
  readonly projectId: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const capability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  const disabled =
    !capability.allowed ||
    scope === "client" ||
    !config ||
    (scope === "node" && !target) ||
    Boolean(
      target && (!target.connected || target.canManage === false || target.canMutate === false),
    );
  if (config?.environment.capabilities.projectPreferences !== true)
    return (
      <SettingsRow
        title="Project defaults"
        owner="node"
        description="Update this device's Ryco server to configure inherited project defaults."
      />
    );
  return (
    <ProjectPreferenceEditor
      key={environmentId}
      projectId={projectId}
      disabled={disabled}
      projects={projects}
    />
  );
}

function ProjectPreferenceEditor(props: {
  readonly projectId: string;
  readonly disabled: boolean;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const projectId = props.projectId;
  const projectMissing = Boolean(
    projectId && !props.projects.some((project) => project.id === projectId),
  );
  const [effective, setEffective] = useState<EffectiveProjectPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    setEffective(null);
    setError(null);
    if (projectMissing) {
      setError("Project no longer exists.");
      return;
    }
    if (!config || props.disabled) return;
    void Promise.resolve()
      .then(() =>
        readEffectiveProjectPreferences({
          api: ensureEnvironmentApi(config.environment.environmentId),
          config,
          ...(projectId ? { projectId: ProjectId.make(projectId) } : {}),
        }),
      )
      .then((result) => {
        if (generation.current === request) setEffective(result);
      })
      .catch((cause) => {
        if (generation.current === request)
          setError(cause instanceof Error ? cause.message : "Could not load project defaults.");
      });
    return () => {
      generation.current++;
    };
  }, [config, projectId, props.disabled, reload, projectMissing]);
  const blocked = props.disabled || projectMissing || saving || effective === null;

  async function save(patch: ProjectPreferencesPatch) {
    if (blocked || !config) return;
    const request = generation.current;
    setSaving(true);
    setError(null);
    const current = effective?.overrides ?? {};
    const expected = Object.fromEntries(
      Object.keys(patch).map((field) => [
        field,
        field === "initialModelSelection" && !Object.hasOwn(current, field)
          ? "absent"
          : (current[field as keyof typeof current] ?? null),
      ]),
    );
    const nodePatch: ServerSettingsPatch = projectId
      ? {
          projectPreferences: { [projectId]: patch },
          expectedProjectPreferences: { [projectId]: expected as ProjectPreferencesExpected },
        }
      : ({
          ...patch,
          expectedNodePreferences: Object.fromEntries(
            Object.keys(patch).map((field) => [
              field,
              field === "initialModelSelection" &&
              effective?.initialModelSelection.source === "builtin"
                ? null
                : effective?.[field as keyof ProjectPreferencesPatch]?.value,
            ]),
          ),
        } as ServerSettingsPatch);
    try {
      if (target) await updateEnvironmentServerSettings(target.environmentId, nodePatch);
      else applySettingsUpdated(await ensureLocalApi().server.updateSettings(nodePatch));
      if (generation.current === request) setReload((value) => value + 1);
    } catch (cause) {
      if (generation.current === request)
        setError(cause instanceof Error ? cause.message : "Could not save project defaults.");
    } finally {
      setSaving(false);
    }
  }
  function source(field: keyof ProjectPreferencesPatch) {
    const result = effective?.[field];
    if (!result) return "Loading…";
    return result.source === "project" || result.source === "legacy-project"
      ? "Overridden for this project"
      : projectId
        ? `Inherited from ${result.source === "builtin" ? "Ryco defaults" : "device defaults"}`
        : result.source === "builtin"
          ? "Ryco default"
          : "Device default";
  }
  function reset(field: keyof ProjectPreferencesPatch, label: string) {
    const overridden =
      effective?.[field]?.source === "project" || effective?.[field]?.source === "legacy-project";
    const changedOnNode =
      field === "initialModelSelection"
        ? effective?.initialModelSelection.source === "node"
        : effective !== null && effective[field].value !== DEFAULT_UNIFIED_SETTINGS[field];
    if (projectId ? !overridden : !changedOnNode) return null;
    return (
      <SettingResetButton
        label={label}
        tooltip={projectId ? "Use device default" : "Reset to default"}
        ariaLabel={projectId ? `Use device default for ${label}` : undefined}
        disabled={blocked}
        onClick={() => {
          const value = projectId
            ? null
            : field === "initialModelSelection"
              ? null
              : DEFAULT_UNIFIED_SETTINGS[field];
          void save({ [field]: value });
        }}
      />
    );
  }
  const model = effective?.initialModelSelection.value;
  const entries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(config?.providers ?? []),
  );
  const instance = entries.find((entry) => entry.instanceId === model?.instanceId);
  return (
    <>
      <SettingsRow
        title="Initial model and effort"
        owner="node"
        description="The model and reasoning effort new threads start with."
        status={source("initialModelSelection")}
        resetAction={reset("initialModelSelection", "initial model")}
        control={
          model && config ? (
            <div className="flex flex-wrap justify-end gap-2">
              <ProviderModelPicker
                activeInstanceId={model.instanceId}
                model={model.model}
                modelOptions={model.options}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  { ...DEFAULT_UNIFIED_SETTINGS, ...config.settings },
                  config.providers,
                  model.instanceId,
                  model.model,
                )}
                disabled={blocked}
                triggerVariant="outline"
                onInstanceModelChange={(instanceId, slug, options) =>
                  void save({
                    initialModelSelection: createModelSelection(
                      instanceId,
                      slug,
                      options?.filter((option) =>
                        (INITIAL_MODEL_OPTION_IDS as readonly string[]).includes(option.id),
                      ),
                    ),
                  })
                }
              />
              {instance && (
                <TraitsPicker
                  provider={instance.driverKind}
                  models={instance.models}
                  model={model.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={model.options}
                  allowPromptInjectedEffort={false}
                  hideAgent
                  disabled={blocked}
                  triggerVariant="outline"
                  onModelOptionsChange={(options) =>
                    void save({
                      initialModelSelection: createModelSelection(
                        model.instanceId,
                        model.model,
                        options,
                      ),
                    })
                  }
                />
              )}
            </div>
          ) : null
        }
      />
      <SettingsRow
        title="New threads"
        owner="node"
        description="Whether new threads work in the project folder or a fresh worktree."
        status={source("defaultThreadEnvMode")}
        resetAction={reset("defaultThreadEnvMode", "new threads")}
        control={
          <SettingsSelect<"local" | "worktree">
            ariaLabel="Default thread mode"
            width="sm"
            value={effective?.defaultThreadEnvMode.value ?? "local"}
            disabled={blocked}
            onValueChange={(value) => void save({ defaultThreadEnvMode: value })}
            options={[
              { value: "local", label: "Local" },
              { value: "worktree", label: "New worktree" },
            ]}
          />
        }
      />
      <SettingsRow
        title="Worktree branch prefix"
        owner="node"
        description="A Git namespace for generated branches. Empty means no prefix; existing branches keep their names."
        status={source("worktreeBranchPrefix")}
        resetAction={reset("worktreeBranchPrefix", "worktree branch prefix")}
        control={
          <DraftInput
            className={SETTINGS_CONTROL_WIDTH.md}
            value={effective?.worktreeBranchPrefix.value ?? ""}
            disabled={blocked}
            placeholder="No prefix"
            aria-label="Worktree branch prefix"
            spellCheck={false}
            autoCapitalize="none"
            onCommit={(value) => {
              const prefix = value.trim();
              if (!Schema.is(WorktreeBranchPrefix)(prefix)) {
                setError(
                  "Use a valid Git namespace of up to 128 characters without a trailing slash.",
                );
                return;
              }
              void save({ worktreeBranchPrefix: prefix });
            }}
          />
        }
      />
      <SettingsRow
        title="Worktree setup"
        owner="node"
        description="Run the project's setup script after creating a worktree."
        status={source("runSetupScript")}
        resetAction={reset("runSetupScript", "worktree setup")}
        control={
          <SettingsSelect<"run" | "skip">
            ariaLabel="Worktree setup"
            width="sm"
            value={effective?.runSetupScript.value === false ? "skip" : "run"}
            disabled={blocked}
            onValueChange={(value) => void save({ runSetupScript: value === "run" })}
            options={[
              { value: "run", label: "Run setup" },
              { value: "skip", label: "Skip setup" },
            ]}
          />
        }
      />
      {error ? (
        <SettingsBlock>
          <SettingsNotice
            tone="error"
            action={
              <Button variant="outline" size="xs" onClick={() => setReload((value) => value + 1)}>
                Reload
              </Button>
            }
          >
            {error}
          </SettingsNotice>
        </SettingsBlock>
      ) : saving ? (
        <SettingsBlock role="status" className="py-2.5 text-xs text-muted-foreground">
          Saving…
        </SettingsBlock>
      ) : null}
    </>
  );
}
