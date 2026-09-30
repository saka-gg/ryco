import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { WS_METHODS } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
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
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

export function ProjectPreferenceSettings() {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const capability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
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
        description="Update this node to configure inherited project defaults."
        control={null}
      />
    );
  return (
    <ProjectPreferenceEditor
      key={environmentId}
      disabled={disabled}
      projects={projects
        .filter((project) => project.environmentId === environmentId)
        .map((project) => ({ id: project.id, title: project.name }))}
    />
  );
}

function ProjectPreferenceEditor(props: {
  readonly disabled: boolean;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  const config = useServerConfig();
  const target = useSettingsTarget();
  const [selectedProject, setSelectedProject] = useState("");
  const projectId = selectedProject;
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
    if (!result) return "Loading effective value…";
    return result.source === "project" || result.source === "legacy-project"
      ? "Overridden for this project"
      : projectId
        ? `Inherited from ${result.source === "builtin" ? "Ryco defaults" : "node defaults"}`
        : result.source === "builtin"
          ? "Ryco default"
          : "Node default";
  }
  function reset(field: keyof ProjectPreferencesPatch) {
    const overridden =
      effective?.[field]?.source === "project" || effective?.[field]?.source === "legacy-project";
    if (projectId && !overridden) return null;
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={blocked}
        onClick={() => {
          const value = projectId
            ? null
            : field === "initialModelSelection"
              ? null
              : DEFAULT_UNIFIED_SETTINGS[field];
          void save({ [field]: value });
        }}
      >
        {projectId ? "Use node default" : "Reset"}
      </Button>
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
        title="Project default scope"
        owner="node"
        scope={target?.nodeLabel ?? "This node"}
        description="Defaults apply to new threads and worktrees. Each project can inherit or override individual fields. Existing threads keep their choices."
        control={
          <Select
            value={projectId ? `project:${projectId}` : "node"}
            disabled={props.disabled || saving}
            onValueChange={(value, details) => {
              // The Select can suggest its first option when a project disappears.
              // Only an intentional user selection may change the editing scope.
              if (details.reason === "none") {
                details.cancel();
                return;
              }
              // A removed option can produce null; it must not redirect edits to node defaults.
              if (value === "node") setSelectedProject("");
              else if (typeof value === "string" && value.startsWith("project:"))
                setSelectedProject(value.slice(8));
            }}
          >
            <SelectTrigger aria-label="Project default scope">
              <SelectValue>
                {props.projects.find((project) => project.id === projectId)?.title ??
                  (projectId ? "Project removed" : "Node defaults")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="node">Node defaults</SelectItem>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={`project:${project.id}`}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Initial model and effort"
        owner="node"
        description={source("initialModelSelection")}
        resetAction={reset("initialModelSelection")}
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
        description={source("defaultThreadEnvMode")}
        resetAction={reset("defaultThreadEnvMode")}
        control={
          <Select
            value={effective?.defaultThreadEnvMode.value ?? "local"}
            disabled={blocked}
            onValueChange={(value) => {
              if (value === "local" || value === "worktree")
                void save({ defaultThreadEnvMode: value });
            }}
          >
            <SelectTrigger aria-label="Default thread mode">
              <SelectValue>
                {effective?.defaultThreadEnvMode.value === "worktree" ? "New worktree" : "Local"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="worktree">New worktree</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Worktree branch prefix"
        owner="node"
        description={`${source("worktreeBranchPrefix")}. Empty means no prefix; existing branches keep their names.`}
        resetAction={reset("worktreeBranchPrefix")}
        control={
          <DraftInput
            value={effective?.worktreeBranchPrefix.value ?? ""}
            disabled={blocked}
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
        description={`${source("runSetupScript")}. Run the project's existing setup script after creating a worktree.`}
        resetAction={reset("runSetupScript")}
        control={
          <Select
            value={effective?.runSetupScript.value === false ? "skip" : "run"}
            disabled={blocked}
            onValueChange={(value) => void save({ runSetupScript: value === "run" })}
          >
            <SelectTrigger aria-label="Worktree setup">
              <SelectValue>
                {effective?.runSetupScript.value === false ? "Skip setup" : "Run setup"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="run">Run setup</SelectItem>
              <SelectItem value="skip">Skip setup</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {saving && (
        <p role="status" className="text-xs text-muted-foreground">
          Saving…
        </p>
      )}
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>
            Reload
          </Button>
        </div>
      )}
    </>
  );
}
