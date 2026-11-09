import type {
  AcpRegistryAuthMethod,
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import type { ProviderDriverKind } from "@ryco/contracts/provider-instance";
import {
  readAcpAgentConfig,
  type AcpAgentConfig,
} from "@ryco/client-runtime/state/settings/acpAgentConfig";
import {
  getProviderDriverDefinition,
  PROVIDER_DRIVER_DEFINITIONS,
  type ProviderDriverDefinition,
} from "@ryco/client-runtime/state/settings/providerDrivers";
import {
  environmentDraftRowFromVariable,
  resolveEnvironmentDrafts,
  withEnvironmentDraftValue,
  type EnvironmentDraftRow,
} from "@ryco/client-runtime/state/settings/providerInstanceEnvironment";
import {
  buildProviderDefaultResetPatch,
  buildProviderInstanceDeletePatch,
  buildProviderInstanceUpdatePatch,
  deriveProviderModelsForDisplay,
  deriveProviderSettingsInstanceRows,
  newProviderInstanceConfig,
  readProviderConfigStringArray,
  resolveCustomModelSlug,
  textGenerationSelectionAfterInstanceEdit,
  uniqueProviderInstanceId,
  withProviderInstanceCustomModels,
  type ProviderInstancePatch,
  type ProviderSettingsInstanceRow,
} from "@ryco/client-runtime/state/settings/providerInstanceSettings";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  providerSettingsTextFieldDisplay,
  readProviderConfigBoolean,
  readProviderConfigString,
  type ProviderSettingsFieldModel,
} from "@ryco/client-runtime/state/settings/providerSettingsFields";
import { REDACTED_SETTING_SECRET } from "@ryco/shared/settingsSecrets";

import {
  buildProviderAccounts,
  type ProviderAccountRow,
  type ProviderAccountsEnvironment,
} from "../providerAccountsModel";

type MachineConfig = Pick<ServerConfig, "settings" | "providers">;

/** The drivers "Add provider" offers, in the web's order. */
export interface AddProviderChoice {
  readonly driver: ProviderDriverKind;
  readonly label: string;
  /** An early-access marker, shown under the label. */
  readonly badge: string | undefined;
}

export const ADD_PROVIDER_CHOICES: ReadonlyArray<AddProviderChoice> =
  PROVIDER_DRIVER_DEFINITIONS.map((definition) => ({
    driver: definition.value,
    label: definition.label,
    badge: definition.badgeLabel,
  }));

export function providerDisplayName(
  instance: ProviderInstanceConfig,
  definition: ProviderDriverDefinition | undefined,
): string {
  const name = instance.displayName === undefined ? "" : instance.displayName.trim();
  if (name.length > 0) return name;
  return definition === undefined ? String(instance.driver) : definition.label;
}

/** The machine's account rows (status, sign-in) by instance, for the instances it reports. */
function accountRowsByInstance(
  node: ProviderAccountsEnvironment | null,
  config: MachineConfig,
): ReadonlyMap<ProviderInstanceId, ProviderAccountRow> {
  if (node === null) return new Map();
  const view = buildProviderAccounts({
    environments: [node],
    configs: new Map([[node.environmentId, config]]),
  });
  const rows = view.nodes.length === 0 ? null : view.nodes[0]!.rows;
  return new Map((rows ?? []).map((row) => [row.instanceId, row] as const));
}

/** A row's short state when the machine reports no provider for it yet. */
function unreportedStatus(instance: ProviderInstanceConfig, connected: boolean): string {
  if (instance.enabled === false) return "Disabled";
  return connected ? "Checking…" : "Not connected";
}

// ── The list ─────────────────────────────────────────────────────────

export interface ProviderInstanceListRow {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly status: string;
  /** "Added" for an instance beyond the driver's built-in one. */
  readonly detail: string | undefined;
}

export interface ProviderInstancesListView {
  /** `null` while the machine has not sent its settings. */
  readonly rows: ReadonlyArray<ProviderInstanceListRow> | null;
  /** Every id an added instance may not take. */
  readonly takenIds: ReadonlySet<string>;
}

export function buildProviderInstancesList(input: {
  readonly node: ProviderAccountsEnvironment | null;
  readonly config: MachineConfig | null;
  readonly connected: boolean;
}): ProviderInstancesListView {
  if (input.config === null) return { rows: null, takenIds: new Set() };
  const config = input.config;
  const accounts = accountRowsByInstance(input.node, config);
  const rows = deriveProviderSettingsInstanceRows(config.settings, config.providers).map(
    (row): ProviderInstanceListRow => {
      const definition = getProviderDriverDefinition(row.driver);
      const account = accounts.get(row.instanceId);
      const extra = row.isDefault ? undefined : "Added";
      const badge = definition === undefined ? undefined : definition.badgeLabel;
      return {
        instanceId: row.instanceId,
        driver: row.driver,
        label: providerDisplayName(row.instance, definition),
        status:
          account === undefined
            ? unreportedStatus(row.instance, input.connected)
            : row.instance.enabled === false
              ? "Disabled"
              : account.status,
        detail: [extra, badge].filter(Boolean).join(" · ") || undefined,
      };
    },
  );
  return {
    rows,
    takenIds: new Set([
      ...rows.map((row) => row.instanceId),
      ...Object.keys(config.settings.providerInstances ?? {}),
    ]),
  };
}

/** The new instance and the patch that adds it; the caller opens it once saved. */
export function buildAddProviderInstance(input: {
  readonly settings: MachineConfig["settings"];
  readonly takenIds: ReadonlySet<string>;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly config?: Record<string, unknown> | undefined;
}): { readonly instanceId: ProviderInstanceId; readonly patch: ProviderInstancePatch } {
  const instanceId = uniqueProviderInstanceId(input.driver, input.label, input.takenIds);
  return {
    instanceId,
    patch: buildProviderInstanceUpdatePatch({
      settings: input.settings,
      instanceId,
      instance: newProviderInstanceConfig({
        driver: input.driver,
        label: input.label,
        config: input.config,
      }),
      driver: input.driver,
      isDefault: false,
    }),
  };
}

// ── One instance ─────────────────────────────────────────────────────

/** One driver setting as a row shows it. Secrets show only whether one is saved. */
export interface ProviderFieldRow {
  readonly field: ProviderSettingsFieldModel;
  readonly kind: "text" | "secret" | "switch" | "select";
  /** What the row shows on the right; never a secret. */
  readonly value: string;
  readonly checked: boolean;
  /** What a text prompt starts with: the stored value, never a secret or a redacted URL. */
  readonly promptDefault: string;
  /** A secret is saved, so the row offers Clear. */
  readonly saved: boolean;
  readonly note: string | undefined;
}

function selectLabel(field: ProviderSettingsFieldModel, stored: string): string {
  const value = stored === "" ? (field.defaultStringValue ?? "") : stored;
  const option = (field.options ?? []).find((candidate) => candidate.value === value);
  if (option !== undefined) return option.label;
  return value === "" ? "Default" : value;
}

export function providerFieldRow(
  field: ProviderSettingsFieldModel,
  config: unknown,
): ProviderFieldRow {
  const stored = readProviderConfigString(config, field.key);
  const base = { field, checked: false, promptDefault: "", saved: false, note: field.description };
  if (field.control === "switch") {
    const checked = readProviderConfigBoolean(config, field.key, field.defaultBooleanValue);
    return { ...base, kind: "switch", value: checked ? "On" : "Off", checked };
  }
  if (field.control === "select") {
    return { ...base, kind: "select", value: selectLabel(field, stored), promptDefault: stored };
  }
  if (field.control === "password") {
    const saved = providerSettingsTextFieldDisplay(field, stored).savedSecret || stored.length > 0;
    return { ...base, kind: "secret", value: saved ? "Set" : "Not set", saved };
  }
  const display = providerSettingsTextFieldDisplay(field, stored);
  if (display.hiddenCredentials) {
    return {
      ...base,
      kind: "text",
      value: stored.split(REDACTED_SETTING_SECRET).join("•••"),
      note: "Credentials in this address are hidden. To change it, enter it again in full.",
    };
  }
  return {
    ...base,
    kind: "text",
    value: stored.length > 0 ? stored : "Default",
    promptDefault: stored,
  };
}

/**
 * The config after a prompt for a text or secret row. An empty answer over a saved secret keeps
 * it (only Clear removes one), and `null` means "nothing to save".
 */
export function configWithFieldText(
  config: unknown,
  row: ProviderFieldRow,
  text: string,
): Record<string, unknown> | undefined | null {
  if (row.kind === "secret" && row.saved && text.length === 0) return null;
  return nextProviderConfigWithFieldValue(config, row.field, text);
}

export function configWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean,
): Record<string, unknown> | undefined {
  return nextProviderConfigWithFieldValue(config, field, value);
}

/** One environment variable as a row shows it: a secret's value never, only Set or Not set. */
export interface ProviderEnvironmentRow {
  readonly name: string;
  readonly sensitive: boolean;
  readonly value: string;
  /** The plain value a prompt may start with; "" for a secret. */
  readonly promptDefault: string;
}

export function providerEnvironmentRows(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<ProviderEnvironmentRow> {
  return environment.map((variable) => {
    if (variable.sensitive) {
      const set = variable.valueRedacted === true || variable.value.length > 0;
      return {
        name: variable.name,
        sensitive: true,
        value: set ? "Set" : "Not set",
        promptDefault: "",
      };
    }
    return {
      name: variable.name,
      sensitive: false,
      value: variable.value.length > 0 ? variable.value : "Empty",
      promptDefault: variable.value,
    };
  });
}

export interface ProviderInstanceDetail {
  readonly row: ProviderSettingsInstanceRow;
  readonly definition: ProviderDriverDefinition | undefined;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly account: ProviderAccountRow | undefined;
  readonly status: string;
  readonly statusDetail: string | undefined;
  readonly version: string | undefined;
  readonly fields: ReadonlyArray<ProviderFieldRow>;
  readonly builtInModelCount: number;
  readonly customModels: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly environmentRows: ReadonlyArray<ProviderEnvironmentRow>;
  /** An ACP Registry instance's agent; `null` for other drivers. */
  readonly acp: AcpAgentConfig | null;
  readonly canRemove: boolean;
  readonly canReset: boolean;
  readonly liveProvider: ServerProvider | undefined;
}

const EMPTY_ENVIRONMENT: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [];

/** One instance's settings view, or `null` when the machine has no such instance (any more). */
export function buildProviderInstanceDetail(input: {
  readonly node: ProviderAccountsEnvironment | null;
  readonly config: MachineConfig;
  readonly instanceId: ProviderInstanceId;
  readonly connected: boolean;
}): ProviderInstanceDetail | null {
  const { config } = input;
  const row = deriveProviderSettingsInstanceRows(config.settings, config.providers).find(
    (candidate) => candidate.instanceId === input.instanceId,
  );
  if (row === undefined) return null;
  const definition = getProviderDriverDefinition(row.driver);
  const account = accountRowsByInstance(input.node, config).get(row.instanceId);
  const liveProvider = config.providers.find((provider) => provider.instanceId === row.instanceId);
  const enabled = row.instance.enabled ?? true;
  const customModels = readProviderConfigStringArray(row.instance.config, "customModels");
  const models = deriveProviderModelsForDisplay({
    liveModels: liveProvider === undefined ? undefined : liveProvider.models,
    customModels,
  });
  const environment = row.instance.environment ?? EMPTY_ENVIRONMENT;
  const isAcp = row.driver === "acpRegistry";
  return {
    row,
    definition,
    displayName: providerDisplayName(row.instance, definition),
    enabled,
    account,
    status:
      account === undefined || !enabled
        ? unreportedStatus(row.instance, input.connected)
        : account.status,
    statusDetail: account === undefined || !enabled ? undefined : account.detail,
    version:
      liveProvider === undefined || liveProvider.version === null
        ? undefined
        : liveProvider.version,
    fields:
      definition === undefined || isAcp
        ? []
        : deriveProviderSettingsFields(definition).map((field) =>
            providerFieldRow(field, row.instance.config),
          ),
    builtInModelCount: models.filter((model) => !model.isCustom).length,
    customModels,
    environment,
    environmentRows: providerEnvironmentRows(environment),
    acp: isAcp ? readAcpAgentConfig(row.instance.config) : null,
    canRemove: !row.isDefault,
    canReset: row.isDefault && row.isDirty,
    liveProvider,
  };
}

function textGenerationInstanceId(settings: MachineConfig["settings"]): ProviderInstanceId {
  return settings.textGenerationModelSelection.instanceId;
}

/** The patch that saves an edit of the instance (text generation leaves an instance disabled). */
export function providerInstanceEditPatch(
  settings: MachineConfig["settings"],
  row: ProviderSettingsInstanceRow,
  next: ProviderInstanceConfig,
): ProviderInstancePatch {
  return buildProviderInstanceUpdatePatch({
    settings,
    instanceId: row.instanceId,
    instance: next,
    driver: row.driver,
    isDefault: row.isDefault,
    textGenerationModelSelection: textGenerationSelectionAfterInstanceEdit({
      instanceId: row.instanceId,
      previous: row.instance,
      next,
      textGenerationInstanceId: textGenerationInstanceId(settings),
    }),
  });
}

export function providerInstanceRemovePatch(
  settings: MachineConfig["settings"],
  row: ProviderSettingsInstanceRow,
): ProviderInstancePatch {
  return buildProviderInstanceDeletePatch({
    settings,
    instanceId: row.instanceId,
    textGenerationInstanceId: textGenerationInstanceId(settings),
  });
}

export function providerInstanceResetPatch(
  settings: MachineConfig["settings"],
  row: ProviderSettingsInstanceRow,
): ProviderInstancePatch | null {
  return buildProviderDefaultResetPatch({
    settings,
    driver: row.driver,
    textGenerationInstanceId: textGenerationInstanceId(settings),
  });
}

// ── Custom models ────────────────────────────────────────────────────

export type InstanceEdit =
  | { readonly ok: true; readonly instance: ProviderInstanceConfig }
  | { readonly ok: false; readonly error: string };

export function instanceWithAddedModel(detail: ProviderInstanceDetail, text: string): InstanceEdit {
  const liveModels = detail.liveProvider === undefined ? undefined : detail.liveProvider.models;
  const resolved = resolveCustomModelSlug({
    text,
    driverKind: detail.definition === undefined ? null : detail.definition.value,
    models: deriveProviderModelsForDisplay({ liveModels, customModels: detail.customModels }),
    customModels: detail.customModels,
  });
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    instance: withProviderInstanceCustomModels(detail.row.instance, [
      ...detail.customModels,
      resolved.slug,
    ]),
  };
}

export function instanceWithoutModel(
  detail: ProviderInstanceDetail,
  slug: string,
): ProviderInstanceConfig {
  return withProviderInstanceCustomModels(
    detail.row.instance,
    detail.customModels.filter((model) => model !== slug),
  );
}

// ── Environment variables ────────────────────────────────────────────

export type EnvironmentEdit =
  | {
      readonly ok: true;
      readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
    }
  | { readonly ok: false; readonly error: string };

const draftId = (index: number) => `phone-env-${index}`;

function draftsOf(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): EnvironmentDraftRow[] {
  return environment.map((variable, index) =>
    environmentDraftRowFromVariable(variable, draftId(index)),
  );
}

/**
 * Publishes drafts by the web editor's rules (`resolveEnvironmentDrafts`), refusing the edit when
 * the row it changed has an issue: a phone edit is one complete step, never a half-typed draft.
 */
function publishDrafts(
  rows: ReadonlyArray<EnvironmentDraftRow>,
  editedId: string,
): EnvironmentEdit {
  const resolution = resolveEnvironmentDrafts(rows);
  const issue = resolution.issues.get(editedId);
  if (issue !== undefined) return { ok: false, error: issue.message };
  return { ok: true, environment: resolution.environment };
}

function editVariable(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  name: string,
  edit: (row: EnvironmentDraftRow) => EnvironmentDraftRow,
): EnvironmentEdit {
  const rows = draftsOf(environment);
  const index = rows.findIndex((row) => row.name === name);
  if (index === -1) return { ok: false, error: `${name} is no longer set on this provider.` };
  rows[index] = edit(rows[index]!);
  return publishDrafts(rows, draftId(index));
}

/** Adds a variable, sensitive unless told otherwise. A name already set is refused. */
export function environmentWithAdded(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  variable: { readonly name: string; readonly value: string; readonly sensitive: boolean },
): EnvironmentEdit {
  const rows = draftsOf(environment);
  const id = draftId(rows.length);
  rows.push({
    id,
    name: variable.name.trim(),
    value: variable.value,
    sensitive: variable.sensitive,
    valueRedacted: false,
    saved: undefined,
  });
  return publishDrafts(rows, id);
}

/** Replaces a value. An empty one keeps a stored secret, as on the web. */
export function environmentWithValue(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  name: string,
  value: string,
): EnvironmentEdit {
  return editVariable(environment, name, (row) => withEnvironmentDraftValue(row, value));
}

/**
 * Marks a variable sensitive or plain. A stored secret only becomes plain text with a new value,
 * since the phone never learns the stored one.
 */
export function environmentWithSensitivity(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  name: string,
  sensitive: boolean,
  value?: string,
): EnvironmentEdit {
  return editVariable(environment, name, (row) =>
    value === undefined
      ? { ...row, sensitive }
      : withEnvironmentDraftValue({ ...row, sensitive }, value),
  );
}

export function environmentWithout(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  name: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return environment.filter((variable) => variable.name !== name);
}

/** Whether turning this variable into plain text needs a new value (it holds a stored secret). */
export function environmentNeedsValueForPlain(row: ProviderEnvironmentRow): boolean {
  return row.sensitive && row.value === "Set";
}

// ── ACP agent sign-in ────────────────────────────────────────────────

/** How one ACP sign-in method reads on a row, and whether Ryco can run it from here. */
export interface AcpAuthMethodRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string | undefined;
  /** An agent-run sign-in this device can start; env-var and terminal methods are set up by hand. */
  readonly runnable: boolean;
}

export function acpAuthMethodRow(method: AcpRegistryAuthMethod): AcpAuthMethodRow {
  if (method.type === "env_var") {
    const variables = (method.variables ?? []).map(
      (variable) =>
        `${variable.name}${variable.optional ? " (optional)" : ""}${variable.secret ? " (sensitive)" : ""}`,
    );
    return {
      id: method.id,
      label: method.name,
      detail: `Set ${variables.length > 0 ? variables.join(", ") : "its variables"} under Environment variables, then start a new chat.`,
      runnable: false,
    };
  }
  if (method.type === "terminal") {
    return {
      id: method.id,
      label: method.name,
      detail: "Finish this sign-in in a terminal on the machine, then start a new chat.",
      runnable: false,
    };
  }
  return { id: method.id, label: method.name, detail: method.description, runnable: true };
}
