/**
 * claudeCliModels — the installed Claude Code's own model report (`initialize`'s `models`), read
 * by the capabilities probe and used to correct one instance's snapshot.
 *
 * The manifest stays the source of the model list and its controls. The CLI report only narrows
 * or annotates them, never adds: it marks whether a model can run Auto mode, removes the Fast
 * toggle where the CLI says Fast mode is unsupported, and drops effort options the CLI does not
 * offer. The data is per instance (a proxied instance's CLI may report differently from a
 * first-party one), so it lives on that instance's snapshot and never in the process-wide catalog.
 *
 * Loaded only from the lazy Claude driver chunk.
 *
 * @module provider/claudeCliModels
 */
import type {
  ProviderOptionDescriptor,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@ryco/contracts";
import { Effect, Ref } from "effect";

import { type ClaudeModelCatalog, normalizeClaudeCatalogEffort } from "./ClaudeModelCatalog.ts";

const CLAUDE_CLI_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeCliEffortLevel = (typeof CLAUDE_CLI_EFFORT_LEVELS)[number];

/** One row of Claude Code's model report. Server-internal; never a contract. */
export interface ClaudeCliModelInfo {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<ClaudeCliEffortLevel>;
  readonly supportsFastMode?: boolean;
  readonly supportsAutoMode?: boolean;
}

const MAX_CLI_MODEL_ROWS = 64;
const MAX_CLI_MODEL_STRING_LENGTH = 128;
/** Aliases whose target changes between releases; without `resolvedModel` they name nothing. */
const RELEASE_DEPENDENT_ALIASES: ReadonlySet<string> = new Set(["default", "best", "opusplan"]);
const CONTEXT_SUFFIX = /\[[^\]]*\]$/;

type BooleanFlag = "supportsEffort" | "supportsFastMode" | "supportsAutoMode";
const BOOLEAN_FLAGS: ReadonlyArray<BooleanFlag> = [
  "supportsEffort",
  "supportsFastMode",
  "supportsAutoMode",
];

/** A bounded, trimmed, non-empty string; `null` when present but malformed. */
function readCliString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_CLI_MODEL_STRING_LENGTH ? trimmed : null;
}

function parseClaudeCliModelRow(raw: unknown): ClaudeCliModelInfo | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const value = readCliString(record.value);
  const resolvedModel = readCliString(record.resolvedModel);
  if (!value || resolvedModel === null) return undefined;
  const flags: { -readonly [Flag in BooleanFlag]?: boolean } = {};
  for (const flag of BOOLEAN_FLAGS) {
    const flagValue = record[flag];
    if (flagValue === undefined) continue;
    if (typeof flagValue !== "boolean") return undefined;
    flags[flag] = flagValue;
  }
  const rawLevels = record.supportedEffortLevels;
  if (rawLevels !== undefined && !Array.isArray(rawLevels)) return undefined;
  // Unknown levels (a newer CLI's) are dropped; a list with none left reports nothing.
  const levels = rawLevels
    ? CLAUDE_CLI_EFFORT_LEVELS.filter((level) => rawLevels.includes(level))
    : [];
  return {
    value,
    ...(resolvedModel ? { resolvedModel } : {}),
    ...flags,
    ...(levels.length > 0 ? { supportedEffortLevels: levels } : {}),
  };
}

/**
 * Validates the untrusted `models` field of Claude Code's `initialize` result. Undefined means
 * no CLI data: the field is missing, not an array, or has no valid row.
 */
export function parseClaudeCliModels(raw: unknown): ReadonlyArray<ClaudeCliModelInfo> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows = raw.slice(0, MAX_CLI_MODEL_ROWS).flatMap((row) => parseClaudeCliModelRow(row) ?? []);
  return rows.length > 0 ? rows : undefined;
}

function normalizeModelIdentifier(identifier: string): string {
  return identifier.replace(CONTEXT_SUFFIX, "").toLowerCase();
}

interface IdentifiedCliRow {
  readonly row: ClaudeCliModelInfo;
  /** Compared with a model's slug: the value Ryco would send and the model it resolves to. */
  readonly slugIds: ReadonlyArray<string>;
  /** Compared with a model's aliases: the model the row resolves to, else its value. */
  readonly aliasId: string;
}

/**
 * A row's identifiers, without context suffixes; undefined for a release-dependent alias that
 * does not say what it resolves to. A row that names its resolved model describes that model
 * only, so its alias value never matches a manifest alias: the CLI's `opus` may already be a newer
 * Opus than the manifest's, and a proxied instance can remap `sonnet` to another model entirely.
 * Ryco sends the slug, so a value that is the slug itself still describes it.
 */
function identifyCliRow(row: ClaudeCliModelInfo): IdentifiedCliRow | undefined {
  const value = normalizeModelIdentifier(row.value);
  if (row.resolvedModel === undefined) {
    return RELEASE_DEPENDENT_ALIASES.has(value)
      ? undefined
      : { row, slugIds: [value], aliasId: value };
  }
  const resolved = normalizeModelIdentifier(row.resolvedModel);
  return { row, slugIds: [value, resolved], aliasId: resolved };
}

/** The rows describing `model`: those naming its slug, else those naming one of its aliases. */
function matchCliRows(
  model: ServerProviderModel,
  rows: ReadonlyArray<IdentifiedCliRow>,
): ReadonlyArray<ClaudeCliModelInfo> {
  const slug = model.slug.toLowerCase();
  const exact = rows.filter((entry) => entry.slugIds.includes(slug));
  if (exact.length > 0) return exact.map((entry) => entry.row);
  const aliases = new Set(model.aliases?.map((alias) => alias.toLowerCase()));
  if (aliases.size === 0) return [];
  return rows.filter((entry) => aliases.has(entry.aliasId)).map((entry) => entry.row);
}

/** A flag counts only when every matching row reports the same value; otherwise it is unknown. */
function agreedFlag(
  rows: ReadonlyArray<ClaudeCliModelInfo>,
  flag: BooleanFlag,
): boolean | undefined {
  const first = rows[0]?.[flag];
  return rows.every((row) => row[flag] === first) ? first : undefined;
}

/** The effort levels every reporting row offers; undefined when no row reports any. */
function intersectEffortLevels(
  rows: ReadonlyArray<ClaudeCliModelInfo>,
): ReadonlySet<string> | undefined {
  let levels: ReadonlySet<string> | undefined;
  for (const row of rows) {
    if (!row.supportedEffortLevels) continue;
    const known = levels;
    levels = new Set(
      known
        ? row.supportedEffortLevels.filter((level) => known.has(level))
        : row.supportedEffortLevels,
    );
  }
  return levels;
}

/**
 * Keeps the effort options whose CLI value (through the manifest `effortMap`) the CLI offers.
 * Options sent without an effort flag (the prompt-injected ones) are always kept. When no offered
 * option would remain the descriptor is left as it is. A dropped default moves to the highest
 * remaining option ranked below it, else to the first remaining one.
 */
function narrowEffortDescriptor(
  descriptor: SelectProviderOptionDescriptor,
  levels: ReadonlySet<string>,
  catalog: ClaudeModelCatalog,
  slug: string,
): SelectProviderOptionDescriptor {
  const cliValues = descriptor.options.map((option) =>
    normalizeClaudeCatalogEffort(catalog, option.id, slug),
  );
  const offered = cliValues.map((value) => value !== undefined && levels.has(value));
  if (!offered.includes(true)) return descriptor;
  const keep = cliValues.map((value, index) => value === undefined || offered[index] === true);
  if (!keep.includes(false)) return descriptor;

  const oldDefault = descriptor.options.findIndex((option) => option.isDefault);
  let nextDefault = oldDefault;
  if (oldDefault >= 0 && !keep[oldDefault]) {
    nextDefault = keep.lastIndexOf(true, oldDefault);
    if (nextDefault < 0) nextDefault = keep.indexOf(true);
  }
  const options = descriptor.options.flatMap((option, index) => {
    if (!keep[index]) return [];
    if (index === nextDefault) return [option.isDefault ? option : { ...option, isDefault: true }];
    if (!option.isDefault) return [option];
    const { isDefault: _isDefault, ...rest } = option;
    return [rest];
  });
  const { currentValue: previousValue, ...rest } = descriptor;
  const currentValue =
    previousValue === undefined || options.some((option) => option.id === previousValue)
      ? previousValue
      : descriptor.options[nextDefault]?.id;
  return { ...rest, options, ...(currentValue !== undefined ? { currentValue } : {}) };
}

function applyRowsToModel(
  model: ServerProviderModel,
  rows: ReadonlyArray<ClaudeCliModelInfo>,
  catalog: ClaudeModelCatalog,
): ServerProviderModel {
  const supportsAutoMode = agreedFlag(rows, "supportsAutoMode");
  const supportsFastMode = agreedFlag(rows, "supportsFastMode");
  const effortLevels = intersectEffortLevels(rows);

  const descriptors = model.capabilities?.optionDescriptors;
  let descriptorsChanged = false;
  const nextDescriptors = descriptors?.flatMap((descriptor): Array<ProviderOptionDescriptor> => {
    // `true` with no manifest toggle adds nothing: the adapter honours only manifest descriptors.
    if (
      supportsFastMode === false &&
      descriptor.type === "boolean" &&
      descriptor.id === "fastMode"
    ) {
      descriptorsChanged = true;
      return [];
    }
    if (descriptor.type === "select" && descriptor.id === "effort" && effortLevels?.size) {
      const narrowed = narrowEffortDescriptor(descriptor, effortLevels, catalog, model.slug);
      if (narrowed !== descriptor) descriptorsChanged = true;
      return [narrowed];
    }
    return [descriptor];
  });
  const autoModeChanged =
    supportsAutoMode !== undefined && supportsAutoMode !== model.supportsAutoMode;
  if (!descriptorsChanged && !autoModeChanged) return model;
  return {
    ...model,
    ...(descriptorsChanged && model.capabilities && nextDescriptors
      ? { capabilities: { ...model.capabilities, optionDescriptors: nextDescriptors } }
      : {}),
    ...(supportsAutoMode !== undefined ? { supportsAutoMode } : {}),
  };
}

/**
 * Corrects manifest models with the CLI report: narrows or annotates, never adds. Custom models
 * and models no row describes are returned as they are.
 */
export function applyClaudeCliModelInfo(
  models: ReadonlyArray<ServerProviderModel>,
  cli: ReadonlyArray<ClaudeCliModelInfo>,
  catalog: ClaudeModelCatalog,
): ReadonlyArray<ServerProviderModel> {
  const rows = cli.flatMap((row) => identifyCliRow(row) ?? []);
  if (rows.length === 0) return models;
  return models.map((model) => {
    if (model.isCustom) return model;
    const matched = matchCliRows(model, rows);
    return matched.length > 0 ? applyRowsToModel(model, matched, catalog) : model;
  });
}

export interface ClaudeCliModelMemory {
  readonly remember: (
    version: string | null,
    models: ReadonlyArray<ClaudeCliModelInfo>,
  ) => Effect.Effect<void>;
  readonly recall: (
    version: string | null,
  ) => Effect.Effect<ReadonlyArray<ClaudeCliModelInfo> | undefined>;
}

/**
 * One instance's last good CLI model report, keyed by the parsed CLI version: a failed or partial
 * probe never overwrites it, and another (or an unparsed) version drops it.
 */
export const makeClaudeCliModelMemory = Effect.fn("makeClaudeCliModelMemory")(function* () {
  const ref = yield* Ref.make<
    { readonly version: string; readonly models: ReadonlyArray<ClaudeCliModelInfo> } | undefined
  >(undefined);
  return {
    remember: (version, models) => Ref.set(ref, version === null ? undefined : { version, models }),
    recall: (version) =>
      Ref.modify(ref, (entry) =>
        entry !== undefined && entry.version === version
          ? [entry.models, entry]
          : [undefined, undefined],
      ),
  } satisfies ClaudeCliModelMemory;
});
