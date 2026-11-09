import type {
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
  ServerProvider,
  ServerProviderModel,
  ServerSettings,
} from "@ryco/contracts";
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  type ProviderDriverKind,
} from "@ryco/contracts/provider-instance";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@ryco/contracts/settings";
import { normalizeModelSlug } from "@ryco/shared/model";
import * as Equal from "effect/Equal";

import { MAX_CUSTOM_MODEL_LENGTH } from "../composer/modelSelection.ts";
import { normalizeProviderAccentColor } from "../composer/providerInstances.ts";
import { PROVIDER_DRIVER_DEFINITIONS } from "./providerDrivers.ts";

// ── The instance list ────────────────────────────────────────────────

export interface ProviderSettingsInstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  /** A built-in driver's slot (its id is the driver's): reset to defaults, never removed. */
  readonly isDefault: boolean;
  /** Differs from the built-in defaults, so a reset changes something. */
  readonly isDirty: boolean;
}

/** The settings the rows read; a device's server settings carry them too. */
export type ProviderInstanceSettings = Pick<UnifiedSettings, "providers" | "providerInstances">;

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const DEFAULT_LEGACY_PROVIDERS = DEFAULT_UNIFIED_SETTINGS.providers as Readonly<
  Record<string, LegacyProviderSettings | undefined>
>;

function hasDefaultProviderSlot(driver: ProviderDriverKind): boolean {
  return Object.hasOwn(DEFAULT_UNIFIED_SETTINGS.providers, driver);
}

function defaultInstanceForDriver(
  settings: ProviderInstanceSettings,
  driver: ProviderDriverKind,
): { readonly instance: ProviderInstanceConfig; readonly isDirty: boolean } | null {
  // Registry and future instance-only drivers require explicit installation/configuration.
  if (!hasDefaultProviderSlot(driver)) return null;
  const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
  const instanceId = defaultInstanceIdForDriver(driver);
  const explicitInstance = settings.providerInstances?.[instanceId];
  const legacyConfig = legacyProviders[driver]!;
  const defaultLegacyConfig = DEFAULT_LEGACY_PROVIDERS[driver]!;

  return {
    instance:
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig),
    isDirty: explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig),
  };
}

/**
 * Every provider instance of a device, as its settings list them: each built-in driver's default
 * slot (synthesized from the legacy `providers` settings until it is edited), then that driver's
 * added instances, then instances of drivers this build does not ship. Cursor's default slot only
 * shows on a device that reports a Cursor provider.
 */
export function deriveProviderSettingsInstanceRows(
  settings: ProviderInstanceSettings,
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderSettingsInstanceRow> {
  const visibleDrivers = PROVIDER_DRIVER_DEFINITIONS.map((definition) => definition.value).filter(
    (driver) =>
      driver !== "cursor" ||
      serverProviders.some(
        (provider) => provider.instanceId === defaultInstanceIdForDriver(driver),
      ),
  );
  const visibleDriverSet = new Set(visibleDrivers);
  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();

  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const list = instancesByDriver.get(instance.driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(instance.driver, list);
  }

  const rows: ProviderSettingsInstanceRow[] = [];
  for (const driver of visibleDrivers) {
    const instanceId = defaultInstanceIdForDriver(driver);
    const defaultInstance = defaultInstanceForDriver(settings, driver);
    if (defaultInstance) {
      rows.push({
        instanceId,
        instance: defaultInstance.instance,
        driver,
        isDefault: true,
        isDirty: defaultInstance.isDirty,
      });
    }

    for (const [customId, instance] of instancesByDriver.get(driver) ?? []) {
      if (defaultInstance && customId === instanceId) continue;
      rows.push({
        instanceId: customId,
        instance,
        driver: instance.driver,
        isDefault: false,
        isDirty: true,
      });
    }
  }

  for (const [driver, instances] of instancesByDriver) {
    if (visibleDriverSet.has(driver)) continue;
    for (const [instanceId, instance] of instances) {
      rows.push({
        instanceId,
        instance,
        driver,
        isDefault:
          hasDefaultProviderSlot(driver) && instanceId === defaultInstanceIdForDriver(driver),
        isDirty: true,
      });
    }
  }

  return rows;
}

export function resolveSelectedProviderSettingsInstance(
  rows: ReadonlyArray<ProviderSettingsInstanceRow>,
  selectedInstanceId: ProviderInstanceId | null,
): ProviderSettingsInstanceRow | null {
  return rows.find((row) => row.instanceId === selectedInstanceId) ?? rows.at(0) ?? null;
}

// ── Settings patches ─────────────────────────────────────────────────

/** The server settings an instance edit changes. Fits both the web's and a node's patch. */
export type ProviderInstancePatch = Partial<
  Pick<ServerSettings, "providers" | "providerInstances" | "textGenerationModelSelection">
>;

/**
 * The patch that saves one instance. `providerInstances` is replaced whole (the server takes no
 * per-entry patch), echoing the other instances as the server sent them: their redacted secrets
 * mean "unchanged". Editing a built-in default slot promotes it into `providerInstances` and
 * resets its legacy `providers` entry, so the two never disagree.
 */
export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): ProviderInstancePatch {
  const legacyProviderDefault = input.isDefault
    ? DEFAULT_LEGACY_PROVIDERS[input.driver]
    : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

/**
 * The text generation selection to write with an instance edit: the default when the edit
 * disables the instance text generation uses, so it is not left on a disabled instance.
 */
export function textGenerationSelectionAfterInstanceEdit(input: {
  readonly instanceId: ProviderInstanceId;
  readonly previous: ProviderInstanceConfig;
  readonly next: ProviderInstanceConfig;
  readonly textGenerationInstanceId: ProviderInstanceId | null;
}): ServerSettings["textGenerationModelSelection"] | undefined {
  const disabling = input.next.enabled === false && (input.previous.enabled ?? true);
  return disabling && input.textGenerationInstanceId === input.instanceId
    ? DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection
    : undefined;
}

function withoutInstance<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  instanceId: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[instanceId];
  return next;
}

/** A client setting keyed by instance (model preferences), without one instance's entry. */
export function withoutProviderInstanceEntry<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  instanceId: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  return withoutInstance(record, instanceId);
}

/**
 * The server patch that removes an added instance, returning text generation to its default
 * when it used that instance. Client settings keyed by the instance (model preferences,
 * favorites) are each client's own to drop.
 */
export function buildProviderInstanceDeletePatch(input: {
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly textGenerationInstanceId: ProviderInstanceId | null;
}): ProviderInstancePatch {
  return {
    providerInstances: withoutInstance(input.settings.providerInstances, input.instanceId),
    ...(input.textGenerationInstanceId === input.instanceId
      ? { textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection }
      : {}),
  };
}

/**
 * The server patch that resets a built-in default slot to factory defaults: its legacy
 * `providers` entry and any `providerInstances` entry it was promoted into, which deletes its
 * environment variables and stored secrets. `null` for a driver without a built-in slot.
 */
export function buildProviderDefaultResetPatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly driver: ProviderDriverKind;
  readonly textGenerationInstanceId: ProviderInstanceId | null;
}): ProviderInstancePatch | null {
  const defaultLegacyProvider = DEFAULT_LEGACY_PROVIDERS[input.driver];
  if (defaultLegacyProvider === undefined) return null;
  const instanceId = defaultInstanceIdForDriver(input.driver);
  return {
    providers: {
      ...input.settings.providers,
      [input.driver]: defaultLegacyProvider,
    } as ServerSettings["providers"],
    providerInstances: withoutInstance(input.settings.providerInstances, instanceId),
    ...(input.textGenerationInstanceId === instanceId
      ? { textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection }
      : {}),
  };
}

// ── Adding an instance ───────────────────────────────────────────────

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const INSTANCE_ID_MAX_LENGTH = 64;

/**
 * A label as an id suffix: lower case, runs of other characters as `_`, at most 48 characters
 * so the id with its driver prefix stays within the 64-character slug cap of `ProviderInstanceId`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/** The id an instance with this label gets, such as `codex_work` for "Work"; "" without one. */
export function providerInstanceIdForLabel(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

/** What is wrong with a new instance id, by the server's slug rules, or `null` when it is valid. */
export function providerInstanceIdError(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > INSTANCE_ID_MAX_LENGTH) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

/**
 * A free id for a new instance named `label`: its label id, numbered (`codex_work_2`) when that
 * is taken, or `<driver>_instance` without a usable label.
 */
export function uniqueProviderInstanceId(
  driver: ProviderDriverKind,
  label: string,
  existing: ReadonlySet<string>,
): ProviderInstanceId {
  const base = providerInstanceIdForLabel(driver, label) || `${driver}_instance`;
  let candidate = base;
  for (let suffix = 2; existing.has(candidate); suffix += 1) {
    const tail = `_${suffix}`;
    candidate = `${base.slice(0, INSTANCE_ID_MAX_LENGTH - tail.length)}${tail}`;
  }
  return ProviderInstanceId.make(candidate);
}

/** A new, enabled instance; empty label, accent and config are left out. */
export function newProviderInstanceConfig(input: {
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly accentColor?: string | undefined;
  readonly config?: Record<string, unknown> | undefined;
}): ProviderInstanceConfig {
  const label = input.label.trim();
  const accentColor = normalizeProviderAccentColor(input.accentColor ?? "");
  const config = input.config ?? {};
  return {
    driver: input.driver,
    enabled: true,
    ...(label.length > 0 ? { displayName: label } : {}),
    ...(accentColor ? { accentColor } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

// ── Editing an instance ──────────────────────────────────────────────

/** The instance with its display name; an empty name drops it, so the driver label shows. */
export function withProviderInstanceDisplayName(
  instance: ProviderInstanceConfig,
  value: string,
): ProviderInstanceConfig {
  const trimmed = value.trim();
  const { displayName: _omit, ...rest } = instance;
  return trimmed.length > 0 ? { ...rest, displayName: trimmed } : rest;
}

/** The instance with its accent color; one that does not normalize drops it. */
export function withProviderInstanceAccentColor(
  instance: ProviderInstanceConfig,
  value: string,
): ProviderInstanceConfig {
  const normalized = normalizeProviderAccentColor(value);
  const { accentColor: _omit, ...rest } = instance;
  return normalized ? { ...rest, accentColor: normalized } : rest;
}

/** The instance with its driver config; `undefined` drops it, so the driver defaults apply. */
export function withProviderInstanceConfig(
  instance: ProviderInstanceConfig,
  config: Record<string, unknown> | undefined,
): ProviderInstanceConfig {
  const { config: _omit, ...rest } = instance;
  return config !== undefined ? { ...rest, config } : rest;
}

/** The instance with its environment; an empty one drops the key. */
export function withProviderInstanceEnvironment(
  instance: ProviderInstanceConfig,
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ProviderInstanceConfig {
  const { environment: _omit, ...rest } = instance;
  return environment.length > 0 ? { ...rest, environment } : rest;
}

/**
 * A string[] at `key` of the opaque config blob, without non-string entries. `customModels` is
 * typed `string[]` by every driver schema, but the envelope carries the config as unknown.
 */
export function readProviderConfigStringArray(config: unknown, key: string): ReadonlyArray<string> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The instance with its custom model list. An empty list is kept: "the user cleared it" differs
 * from the driver default.
 */
export function withProviderInstanceCustomModels(
  instance: ProviderInstanceConfig,
  customModels: ReadonlyArray<string>,
): ProviderInstanceConfig {
  const base =
    instance.config !== null && typeof instance.config === "object"
      ? { ...(instance.config as Record<string, unknown>) }
      : {};
  return { ...instance, config: { ...base, customModels: [...customModels] } };
}

/**
 * The models an instance shows: the ones its provider reports, then its custom models from the
 * current config (reported models lag behind settings writes, so an add or remove shows at once).
 */
export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    (input.liveModels ?? [])
      .filter((model) => model.isCustom)
      .map((model) => [model.slug, model] as const),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const customModels = input.customModels.map(
    (slug) =>
      liveCustomModelsBySlug.get(slug) ?? {
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      },
  );
  return [...serverModels, ...customModels];
}

/**
 * A custom model slug to add, normalized for its driver, or why it cannot be added: empty, built
 * in already, too long, or saved already.
 */
export function resolveCustomModelSlug(input: {
  readonly text: string;
  readonly driverKind: ProviderDriverKind | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly customModels: ReadonlyArray<string>;
}): { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly error: string } {
  const slug = input.driverKind
    ? normalizeModelSlug(input.text, input.driverKind)
    : input.text.trim() || null;
  if (!slug) return { ok: false, error: "Enter a model slug." };
  if (input.models.some((model) => !model.isCustom && model.slug === slug)) {
    return { ok: false, error: "That model is already built in." };
  }
  if (slug.length > MAX_CUSTOM_MODEL_LENGTH) {
    return {
      ok: false,
      error: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
    };
  }
  if (input.customModels.includes(slug)) {
    return { ok: false, error: "That custom model is already saved." };
  }
  return { ok: true, slug };
}
