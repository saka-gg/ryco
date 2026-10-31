import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { WS_METHODS } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  INITIAL_MODEL_OPTION_IDS,
  PROJECT_PREFERENCE_ADDED_KEYS,
  PROJECT_PREFERENCE_VALUE_KEYS,
  ProjectId,
  type EffectiveProjectPreferences,
  type ProjectPreferenceKey,
  type ProjectPreferencesPatch,
  type ProjectPreferenceValueKey,
} from "@ryco/contracts";
import { readEffectiveProjectPreferences } from "@ryco/client-runtime/state/settings";
import {
  projectPreferenceCanReset,
  projectPreferenceResetValue,
  projectPreferencesWritePatch,
  projectPreferenceSupported,
} from "@ryco/client-runtime/state/settings/projectPreferenceEditing";
import {
  PROJECT_PREFERENCE_FIELDS,
  readProjectPreferenceText,
} from "@ryco/shared/projectPreferences";
import { createModelSelection } from "@ryco/shared/model";
import { useServerConfig, applySettingsUpdated } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { isNodeSettingsTargetReadOnly } from "./settingsSections.logic";
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
  const environmentId = target?.environmentId ?? config?.environment.environmentId;
  const capability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings, environmentId ?? null);
  const disabled = !capability.allowed || !config || isNodeSettingsTargetReadOnly(scope, target);
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
    if (blocked || !config || !effective) return;
    const request = generation.current;
    setSaving(true);
    setError(null);
    const nodePatch = projectPreferencesWritePatch({ effective, projectId, patch });
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
  function source(field: ProjectPreferenceKey) {
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
  function reset(field: ProjectPreferenceKey, label: string) {
    if (!projectPreferenceCanReset({ effective, projectId, field })) return null;
    return (
      <SettingResetButton
        label={label}
        tooltip={projectId ? "Use device default" : "Reset to default"}
        ariaLabel={projectId ? `Use device default for ${label}` : undefined}
        disabled={blocked}
        onClick={() => void save({ [field]: projectPreferenceResetValue(field, projectId) })}
      />
    );
  }
  function valueRow(key: ProjectPreferenceValueKey) {
    // A key added since effective preferences first existed waits for the node's reply: an older
    // node's reply has no such key, so its row would show while loading and then go.
    if (!effective && PROJECT_PREFERENCE_ADDED_KEYS.includes(key)) return null;
    if (effective && !projectPreferenceSupported(effective, key)) return null;
    const field = PROJECT_PREFERENCE_FIELDS[key];
    if (!projectId && field.nodeDefaultRow === "separate") return null;
    const value = effective?.[key]?.value;
    const control =
      field.kind === "text" ? (
        <DraftInput
          className={SETTINGS_CONTROL_WIDTH.md}
          value={typeof value === "string" ? value : ""}
          disabled={blocked}
          placeholder={field.placeholder}
          aria-label={field.controlLabel}
          spellCheck={false}
          autoCapitalize="none"
          onCommit={(input) => {
            const next = readProjectPreferenceText(key, input);
            if (next === null) {
              setError(field.invalidMessage);
              return;
            }
            void save({ [key]: next });
          }}
        />
      ) : (
        <SettingsSelect<string>
          ariaLabel={field.controlLabel}
          width="sm"
          // The first option stands in while the effective value loads.
          value={String(
            (field.options.find((option) => option.value === value) ?? field.options[0])?.value,
          )}
          disabled={blocked}
          onValueChange={(id) => {
            const option = field.options.find((candidate) => String(candidate.value) === id);
            if (option) void save({ [key]: option.value });
          }}
          options={field.options.map((option) => ({
            value: String(option.value),
            label: option.label,
          }))}
        />
      );
    return (
      <SettingsRow
        key={key}
        title={field.title}
        owner="node"
        description={field.description}
        status={source(key)}
        resetAction={reset(key, field.resetLabel)}
        control={control}
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
      {PROJECT_PREFERENCE_VALUE_KEYS.map(valueRow)}
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
