/**
 * The phone's per-node "New tasks" panel as plain data: the scopes it offers (the node's own
 * defaults, or one of its projects), the rows a scope shows, and a controller that reads the
 * node's effective preferences and writes each edit back to that node only.
 *
 * Every rule is the shared one the web settings use: the registry decides the rows, the node's
 * own reply decides which of them it supports, and each write carries the compare-and-set values
 * `projectPreferencesWritePatch` builds, so a node whose values changed elsewhere refuses it.
 */
import { readEffectiveProjectPreferences } from "@ryco/client-runtime/state/settings";
import {
  applyNodeSettingsPatch,
  describeNodeSettingsApplyResult,
  readNodeSettingsAgreement,
  type NodeSettingsAgreement,
  type NodeSettingsTarget,
} from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import {
  nodeKeepsProjectPreferences,
  nodePreferencesPatchFor,
  projectPreferenceCanReset,
  projectPreferenceResetValue,
  projectPreferencesWritePatch,
  projectPreferenceSupported,
} from "@ryco/client-runtime/state/settings/projectPreferenceEditing";
import type {
  EffectiveProjectPreferences,
  EnvironmentApi,
  ModelSelection,
  ProjectId,
  ProjectKind,
  ProjectPreferenceKey,
  ProjectPreferencesPatch,
  ProjectPreferenceValueKey,
  ProviderOptionSelectionValue,
  ServerConfig,
  ServerSettingsPatch,
} from "@ryco/contracts";
import { INITIAL_MODEL_OPTION_IDS, PROJECT_PREFERENCE_VALUE_KEYS } from "@ryco/contracts/settings";
import { createModelSelection } from "@ryco/shared/model";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import {
  PROJECT_PREFERENCE_FIELDS,
  PROJECT_PREFERENCE_PROJECT_GONE,
  projectPreferenceSourceLabel,
  projectPreferenceValueLabel,
  readProjectPreferenceText,
} from "@ryco/shared/projectPreferences";
import {
  selectWorktreeSubmodules,
  WORKTREE_SUBMODULE_OPTIONS,
} from "@ryco/shared/worktreeSubmodules";

import {
  applyModelOption,
  buildModelPickerModel,
  listModelPickerEntries,
  resolveModelPickerSelection,
  type ModelPickerModel,
} from "../threads/modelPickerModel";

// ---------------------------------------------------------------------------
// Scopes

export interface NewTaskDefaultsScope {
  /** Null: the node's own defaults, which every project without an override inherits. */
  readonly projectId: ProjectId | null;
  readonly label: string;
}

/** The node's defaults, then each of its projects. Chats are never a scope: they take no task. */
export function newTaskDefaultsScopes(
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly name: string;
    readonly kind?: ProjectKind | undefined;
  }>,
): ReadonlyArray<NewTaskDefaultsScope> {
  return [
    { projectId: null, label: "Node defaults" },
    ...excludeChatProjects(projects).map((project) => ({
      projectId: project.id,
      label: project.name,
    })),
  ];
}

/**
 * The scope a chip selected, or the node's defaults once that project is gone. An edit still
 * open for the gone project names it (`save`), so it never lands on the node's defaults.
 */
export function resolveNewTaskDefaultsScope(
  selected: ProjectId | null,
  scopes: ReadonlyArray<NewTaskDefaultsScope>,
): ProjectId | null {
  return selected !== null && scopes.some((scope) => scope.projectId === selected)
    ? selected
    : null;
}

// ---------------------------------------------------------------------------
// The initial model

const INITIAL_OPTION_IDS: ReadonlySet<string> = new Set(INITIAL_MODEL_OPTION_IDS);

/** A new task's model keeps only the traits a creation preset may carry, as on the web. */
export function initialModelSelection(selection: ModelSelection): ModelSelection {
  return createModelSelection(
    selection.instanceId,
    selection.model,
    selection.options?.filter((option) => INITIAL_OPTION_IDS.has(option.id)),
  );
}

/** The model sheet for a node's initial model: that node's models, with preset traits only. */
export function initialModelPicker(input: {
  readonly config: ServerConfig | null;
  readonly selection: ModelSelection;
  readonly query?: string;
}): ModelPickerModel {
  const picker = buildModelPickerModel({
    serverConfig: input.config,
    currentSelection: input.selection,
    query: input.query ?? "",
  });
  const options = picker.options.filter((option) => INITIAL_OPTION_IDS.has(option.id));
  const reasoning = options.find((option) => option.kind === "select");
  return {
    ...picker,
    options,
    hasOptionRail: options.length > 0,
    pillReasoningLabel: reasoning?.choices.find((choice) => choice.selected)?.shortLabel ?? null,
    pillFastEnabled: options.some((option) => option.id === "fastMode" && option.enabled),
  };
}

/** The edit a tap on a model in the sheet makes, or null when it changes nothing. */
export function initialModelPickPatch(
  picker: ModelPickerModel,
  key: string,
): ProjectPreferencesPatch | null {
  const next = resolveModelPickerSelection(picker, key);
  return next ? { initialModelSelection: initialModelSelection(next) } : null;
}

/**
 * The edit a tap on the sheet's trait rail makes, or null when it changes nothing. The model's
 * traits come from the node's whole list, not the searched one: a search that hides the
 * selected model from the list still shows its rail, and its taps still apply.
 */
export function initialModelOptionPatch(
  config: ServerConfig | null,
  selection: ModelSelection,
  optionId: string,
  value: ProviderOptionSelectionValue,
): ProjectPreferencesPatch | null {
  if (!INITIAL_OPTION_IDS.has(optionId)) return null;
  const capabilities =
    listModelPickerEntries(initialModelPicker({ config, selection })).find(
      (entry) => entry.selected,
    )?.capabilities ?? null;
  const next = applyModelOption(selection, capabilities, optionId, value);
  return next === selection ? null : { initialModelSelection: initialModelSelection(next) };
}

function initialModelLabel(config: ServerConfig | null, selection: ModelSelection): string {
  const picker = initialModelPicker({ config, selection });
  const reasoning = picker.options
    .find((option) => option.kind === "select")
    ?.choices.find((choice) => choice.selected);
  return reasoning ? `${picker.pillLabel} · ${reasoning.label}` : picker.pillLabel;
}

// ---------------------------------------------------------------------------
// Rows

/** Back to what the scope inherits: the node's default for a project, Ryco's for the node. */
export interface NewTaskDefaultReset {
  readonly label: string;
  readonly patch: ProjectPreferencesPatch;
}

interface NewTaskDefaultRowBase {
  readonly title: string;
  /** The value as it reads. */
  readonly value: string;
  /** Where the value comes from, worded as on the web ("Node default", …). */
  readonly source: string;
  readonly reset: NewTaskDefaultReset | null;
}

export interface NewTaskDefaultModelRow extends NewTaskDefaultRowBase {
  readonly kind: "model";
  readonly key: "initialModelSelection";
  readonly selection: ModelSelection;
}

export interface NewTaskDefaultSelectRow extends NewTaskDefaultRowBase {
  readonly kind: "select";
  readonly key: ProjectPreferenceValueKey;
  readonly description: string;
  readonly choices: ReadonlyArray<{
    readonly label: string;
    readonly selected: boolean;
    readonly patch: ProjectPreferencesPatch;
  }>;
}

export interface NewTaskDefaultTextRow extends NewTaskDefaultRowBase {
  readonly kind: "text";
  readonly key: ProjectPreferenceValueKey;
  readonly description: string;
  readonly text: string;
  readonly placeholder: string;
  readonly accessibilityLabel: string;
}

export type NewTaskDefaultRow =
  | NewTaskDefaultModelRow
  | NewTaskDefaultSelectRow
  | NewTaskDefaultTextRow;

function resetOf(
  effective: EffectiveProjectPreferences,
  projectId: ProjectId | null,
  field: ProjectPreferenceKey,
  label: string,
): NewTaskDefaultReset | null {
  if (!projectPreferenceCanReset({ effective, projectId, field })) return null;
  return {
    label: projectId ? `Use node default for ${label}` : `Use Ryco default for ${label}`,
    patch: { [field]: projectPreferenceResetValue(field, projectId) } as ProjectPreferencesPatch,
  };
}

/**
 * The rows of one scope, from the node's own answer: the initial model, then every registry
 * setting the node reports (for the node's own defaults, those without a row of their own). A
 * node that omits a setting (older than it) gets no row for it, and no answer gets no rows: the
 * phone never stands in a value for the node.
 */
export function buildNewTaskDefaultRows(input: {
  readonly effective: EffectiveProjectPreferences | null;
  readonly projectId: ProjectId | null;
  readonly config: ServerConfig | null;
}): ReadonlyArray<NewTaskDefaultRow> {
  const { effective, projectId } = input;
  if (!effective) return [];
  const scope = { projectId, nodeNoun: "node" } as const;
  const model = effective.initialModelSelection;
  const rows: NewTaskDefaultRow[] = [
    {
      kind: "model",
      key: "initialModelSelection",
      title: "Provider and model",
      value: initialModelLabel(input.config, model.value),
      source: projectPreferenceSourceLabel(model.source, scope),
      reset: resetOf(effective, projectId, "initialModelSelection", "initial model"),
      selection: model.value,
    },
  ];
  for (const key of PROJECT_PREFERENCE_VALUE_KEYS) {
    const current = effective[key];
    if (!projectPreferenceSupported(effective, key) || current === undefined) continue;
    const field = PROJECT_PREFERENCE_FIELDS[key];
    // A node default with a row of its own elsewhere is listed for projects only, as on the web.
    if (!projectId && field.nodeDefaultRow === "separate") continue;
    const base = {
      key,
      title: field.title,
      description: field.description,
      value: projectPreferenceValueLabel(key, current.value),
      source: projectPreferenceSourceLabel(current.source, scope),
      reset: resetOf(effective, projectId, key, field.resetLabel),
    };
    rows.push(
      field.kind === "text"
        ? {
            ...base,
            kind: "text",
            text: typeof current.value === "string" ? current.value : "",
            placeholder: field.placeholder,
            accessibilityLabel: field.controlLabel,
          }
        : {
            ...base,
            kind: "select",
            choices: field.options.map((option) => ({
              label: option.label,
              selected: option.value === current.value,
              patch: { [key]: option.value } as ProjectPreferencesPatch,
            })),
          },
    );
  }
  return rows;
}

/** Where the scope's submodule mode comes from, worded as every other row's source. */
function submodulesDetail(source: "project" | "node", projectId: ProjectId | null): string {
  const label = projectPreferenceSourceLabel(source, { projectId, nodeNoun: "node" });
  if (source === "project") return `${label}.`;
  return projectId
    ? `${label}. Repository configuration can override it.`
    : `${label}. New worktrees also honor project overrides and repository configuration.`;
}

/** How new worktrees of this scope initialize submodules (read-only here). */
export function worktreeSubmodulesRow(
  config: ServerConfig | null,
  projectId: ProjectId | null,
): { readonly value: string; readonly detail: string } {
  if (!config) return { value: "Connect a machine", detail: submodulesDetail("node", null) };
  if (config.environment.capabilities.worktreeSubmoduleSettings !== true)
    return {
      value: "Update this machine",
      detail: "This node does not support configurable submodules.",
    };
  const selected = selectWorktreeSubmodules({
    settings: config.settings,
    projectId: projectId ?? undefined,
  });
  return {
    value:
      WORKTREE_SUBMODULE_OPTIONS.find((option) => option.value === selected.mode)?.label ??
      selected.mode,
    // No repository mode is passed, so the mode is the project's own or the node's.
    detail: submodulesDetail(selected.source === "project" ? "project" : "node", projectId),
  };
}

// ---------------------------------------------------------------------------
// Apply to all connected nodes

export interface NewTaskDefaultsApplyChoice {
  readonly key: ProjectPreferenceValueKey;
  readonly title: string;
  readonly value: string;
  /** Whether the nodes agree on it now, and each one's value when they do not. */
  readonly detail: string;
}

function describeAgreement(
  key: ProjectPreferenceValueKey,
  agreement: NodeSettingsAgreement<unknown>,
): string {
  if (agreement.kind !== "mixed") return "Same on every connected node.";
  const values = agreement.values
    .map((entry) => `${entry.label}: ${projectPreferenceValueLabel(key, entry.value)}`)
    .join(", ");
  return `Differs: ${values}.`;
}

/**
 * The node defaults "Apply to all connected nodes" offers, one at a time so one tap never
 * overwrites a setting the user did not pick. Never the initial model, whose provider instances
 * differ per node, and never a project override, whose project ids do.
 */
export function newTaskDefaultsApplyChoices(
  rows: ReadonlyArray<NewTaskDefaultRow>,
  targets: ReadonlyArray<NodeSettingsTarget>,
): ReadonlyArray<NewTaskDefaultsApplyChoice> {
  return rows.flatMap((row) =>
    row.kind === "model"
      ? []
      : [
          {
            key: row.key,
            title: row.title,
            value: row.value,
            detail: describeAgreement(
              row.key,
              readNodeSettingsAgreement(targets, (settings) => settings[row.key], {
                supported: nodeKeepsProjectPreferences,
              }),
            ),
          },
        ],
  );
}

// ---------------------------------------------------------------------------
// Controller

export interface NewTaskDefaultsInput {
  readonly label: string;
  /** The node's last known config; its identity changes with every settings push. */
  readonly config: ServerConfig | null;
  /** The node's api while it is connected; reads need one. */
  readonly api: EnvironmentApi | undefined;
  /** This device may change the node's settings now (`canChangeNodeSettings`). */
  readonly editable: boolean;
  readonly projectId: ProjectId | null;
}

export type NewTaskDefaultsPhase = "offline" | "loading" | "ready" | "unsupported" | "failed";

export interface NewTaskDefaultsState {
  readonly phase: NewTaskDefaultsPhase;
  /** The node's answer for `projectId`, kept while a newer read of the same scope runs. */
  readonly effective: EffectiveProjectPreferences | null;
  /** The scope `effective` answers for. */
  readonly projectId: ProjectId | null;
  readonly saving: boolean;
  /** A refused write ("<node>: <message>") or a value that cannot be saved. */
  readonly error: string | null;
  readonly applying: boolean;
  /** What "Apply to all connected nodes" did last. */
  readonly applyStatus: string | null;
}

export interface NewTaskDefaultsController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => NewTaskDefaultsState;
  /** The panel's current inputs; a new config, api or scope reads the node again. */
  readonly setInput: (input: NewTaskDefaultsInput) => void;
  readonly reload: () => Promise<void>;
  /**
   * Writes an edit made for `projectId`'s rows (null: the node's defaults). An edit for a scope
   * the panel has left meanwhile is dropped, so a gone project's edit never lands elsewhere.
   */
  readonly save: (projectId: ProjectId | null, patch: ProjectPreferencesPatch) => Promise<void>;
  readonly saveText: (
    projectId: ProjectId | null,
    key: ProjectPreferenceValueKey,
    text: string,
  ) => Promise<void>;
  readonly applyToAllNodes: (
    key: ProjectPreferenceValueKey,
    targets: ReadonlyArray<NodeSettingsTarget>,
  ) => Promise<void>;
}

const INITIAL_STATE: NewTaskDefaultsState = {
  phase: "offline",
  effective: null,
  projectId: null,
  saving: false,
  error: null,
  applying: false,
  applyStatus: null,
};

/**
 * Whether the panel's values may take an edit: the node answered for this scope and nothing of
 * this panel is being written. A re-read after a settings push keeps the values on screen and
 * editable; the node's compare-and-set refuses an edit made against values it no longer has.
 */
function editableState(state: NewTaskDefaultsState): boolean {
  return state.effective !== null && state.phase !== "failed" && !state.saving && !state.applying;
}

/**
 * Whether "Apply to all connected nodes" may copy a value now: only once the node's newest read
 * landed, as on the web, which disables it while it reads again. Every other node compares its
 * own value, so no compare-and-set would catch a stale value copied from here.
 */
function applicableState(state: NewTaskDefaultsState): boolean {
  return editableState(state) && state.phase === "ready";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Could not save.";
}

/**
 * Reads and writes one node's new-task defaults. Each read gets a generation: an answer for a
 * scope, config or connection the panel has since left is dropped, as in the web editor.
 * Writes go only to this node, through `write`; the node checks owner access and
 * compare-and-set itself. After every write, refused or not, the node is read again, so a
 * refusal ("changed elsewhere") shows its current values next to the message.
 */
export function createNewTaskDefaultsController(deps: {
  readonly write: (patch: ServerSettingsPatch) => Promise<unknown>;
}): NewTaskDefaultsController {
  let input: NewTaskDefaultsInput | null = null;
  let state = INITIAL_STATE;
  // Every read gets one; only the newest may answer.
  let generation = 0;
  // The newest read, which a write's read-back waits for.
  let reading: Promise<void> = Promise.resolve();
  // Changes with the scope or the connection, which a write's outcome no longer belongs to.
  let scope = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<NewTaskDefaultsState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  function load(): Promise<void> {
    reading = read();
    return reading;
  }

  function read(): Promise<void> {
    const request = ++generation;
    const current = input;
    if (!current?.api || !current.config) {
      update({ phase: "offline", effective: null, projectId: current?.projectId ?? null });
      return Promise.resolve();
    }
    const { api, config, projectId } = current;
    update({
      phase: "loading",
      effective: state.projectId === projectId ? state.effective : null,
      projectId,
    });
    return Promise.resolve()
      .then(() =>
        readEffectiveProjectPreferences({ api, config, ...(projectId ? { projectId } : {}) }),
      )
      .then(
        (effective) => {
          if (generation !== request) return;
          update(
            effective ? { phase: "ready", effective } : { phase: "unsupported", effective: null },
          );
        },
        () => {
          // Never fall back to cached values once the node failed to answer.
          if (generation === request) update({ phase: "failed", effective: null });
        },
      );
  }

  /**
   * Reads the node again and waits until its newest read landed. A settings push meanwhile
   * starts a newer read and drops this one, and until the newer one lands the panel still shows
   * the values from before the write.
   */
  async function readBack(): Promise<void> {
    let awaited = load();
    await awaited;
    while (awaited !== reading) {
      awaited = reading;
      await awaited;
    }
  }

  function writable(): boolean {
    return input?.editable === true && editableState(state);
  }

  /** Whether an edit made for `projectId`'s rows may go out now; says why not when it is gone. */
  function inScope(projectId: ProjectId | null): boolean {
    if (projectId === state.projectId) return true;
    // A project removed while its dialog or sheet was open: the panel shows the node's defaults
    // now, which this edit was never meant for.
    if (projectId !== null) update({ error: PROJECT_PREFERENCE_PROJECT_GONE, applyStatus: null });
    return false;
  }

  async function save(projectId: ProjectId | null, patch: ProjectPreferencesPatch): Promise<void> {
    const effective = state.effective;
    const label = input?.label ?? "";
    if (!inScope(projectId) || !writable() || effective === null) return;
    const request = scope;
    update({ saving: true, error: null, applyStatus: null });
    let error: string | null = null;
    try {
      await deps.write(projectPreferencesWritePatch({ effective, projectId, patch }));
    } catch (cause) {
      error = `${label}: ${errorMessage(cause)}`;
    }
    // A scope left meanwhile has its own read running; its panel shows nothing of this write.
    if (scope === request) {
      update({ error });
      // Still saving until the node's newest values are read back, so a second edit never
      // compares with the values from before this one.
      await readBack();
    }
    update({ saving: false });
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    setInput: (next) => {
      const previous = input;
      input = next;
      const sameScope =
        previous !== null && previous.projectId === next.projectId && previous.api === next.api;
      if (sameScope && previous.config === next.config) return;
      if (!sameScope) {
        scope += 1;
        update({ error: null, applyStatus: null });
      }
      void load();
    },
    reload: load,
    save,
    saveText: async (projectId, key, text) => {
      const field = PROJECT_PREFERENCE_FIELDS[key];
      const current = state.effective?.[key];
      if (!inScope(projectId) || field.kind !== "text" || current === undefined || !writable())
        return;
      const next = readProjectPreferenceText(key, text);
      if (next === null) {
        update({ error: field.invalidMessage });
        return;
      }
      if (next === current.value) return;
      await save(projectId, { [key]: next } as ProjectPreferencesPatch);
    },
    applyToAllNodes: async (key, targets) => {
      const current = state.effective?.[key];
      // A project override never goes to other nodes: their project ids differ.
      if (
        state.projectId !== null ||
        current === undefined ||
        input?.editable !== true ||
        !applicableState(state)
      )
        return;
      const request = scope;
      update({ applying: true, applyStatus: null, error: null });
      const result = await applyNodeSettingsPatch(
        targets,
        nodePreferencesPatchFor({ [key]: current.value } as Parameters<
          typeof nodePreferencesPatchFor
        >[0]),
        { supported: nodeKeepsProjectPreferences },
      );
      update({
        applying: false,
        applyStatus: scope === request ? describeNodeSettingsApplyResult(result) : null,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The panel's view

export interface NewTaskDefaultsView {
  readonly rows: ReadonlyArray<NewTaskDefaultRow>;
  /** The rows take an edit now. */
  readonly canEdit: boolean;
  /** "Apply to all connected nodes" may copy a value now: the node's newest read landed. */
  readonly canApply: boolean;
  /** One line about the panel as a whole: a failed read, an older node, read-only, loading. */
  readonly notice: string | null;
  readonly error: string | null;
  readonly applyStatus: string | null;
}

export function buildNewTaskDefaultsView(input: {
  readonly state: NewTaskDefaultsState;
  readonly label: string;
  readonly config: ServerConfig | null;
  /**
   * Why this device may not change the node's settings now (`nodeSettingsReadOnlyReason`), or
   * null when it may.
   */
  readonly readOnly: string | null;
}): NewTaskDefaultsView {
  const { state } = input;
  const editable = input.readOnly === null;
  const rows = buildNewTaskDefaultRows({
    effective: state.effective,
    projectId: state.projectId,
    config: input.config,
  });
  const notice =
    state.phase === "failed"
      ? `Could not load ${input.label}'s defaults. Reconnect and try again.`
      : state.phase === "unsupported"
        ? "Update this node to change its new-task defaults here."
        : input.readOnly !== null
          ? input.readOnly
          : rows.length === 0
            ? "Loading…"
            : null;
  return {
    rows,
    canEdit: editable && editableState(state),
    canApply: editable && applicableState(state),
    notice,
    error: state.error,
    applyStatus: state.applyStatus,
  };
}
