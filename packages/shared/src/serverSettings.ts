import { ServerSettings, type ServerSettingsPatch } from "@ryco/contracts";
import { Equal, Schema } from "effect";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  try {
    const decoded = Schema.decodeUnknownSync(ServerSettingsJson)(raw);
    return extractPersistedServerObservabilitySettings(decoded);
  } catch {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/**
 * Applies a server settings patch while treating textGenerationModelSelection as
 * replace-on-provider/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  for (const [field, value] of Object.entries(patch.expectedNodePreferences ?? {})) {
    if (!Equal.equals(current[field as keyof typeof current] ?? null, value))
      throw new Error("Node preferences changed elsewhere. Reload before saving.");
  }
  for (const [projectId, expected] of Object.entries(patch.expectedProjectPreferences ?? {})) {
    const currentPreferences = current.projectPreferences[projectId] ?? {};
    for (const [field, value] of Object.entries(expected)) {
      const actual =
        field === "initialModelSelection" && !Object.hasOwn(currentPreferences, field)
          ? "absent"
          : (currentPreferences[field as keyof typeof currentPreferences] ?? null);
      if (!Equal.equals(actual, value))
        throw new Error("Project preferences changed elsewhere. Reload before saving.");
    }
  }
  const {
    expectedProjectPreferences: _expected,
    expectedNodePreferences: _expectedNode,
    projectPreferences: _projects,
    ...persistedPatch
  } = patch;
  let next = deepMerge(current, persistedPatch);
  if (patch.initialModelSelection !== undefined)
    next = { ...next, initialModelSelection: patch.initialModelSelection };
  if (patch.projectPreferences !== undefined) {
    const projects = new Map(Object.entries(current.projectPreferences));
    for (const [projectId, preferencesPatch] of Object.entries(patch.projectPreferences)) {
      if (preferencesPatch === null) {
        projects.delete(projectId);
        continue;
      }
      const preferences = { ...projects.get(projectId) };
      for (const [field, value] of Object.entries(preferencesPatch)) {
        if (value === null && field !== "initialModelSelection")
          delete preferences[field as keyof typeof preferences];
        else Object.assign(preferences, { [field]: value });
      }
      if (Object.keys(preferences).length) projects.set(projectId, preferences);
      else projects.delete(projectId);
    }
    next = { ...next, projectPreferences: Object.fromEntries(projects) };
  }
  if (patch.projectWorktreeSubmodules !== undefined) {
    const modes = new Map(Object.entries(current.projectWorktreeSubmodules));
    for (const [projectId, mode] of Object.entries(patch.projectWorktreeSubmodules)) {
      if (mode === null) modes.delete(projectId);
      else modes.set(projectId, mode);
    }
    next = { ...next, projectWorktreeSubmodules: Object.fromEntries(modes) };
  }
  if (patch.projectWorktreeRoots !== undefined) {
    const roots = new Map(Object.entries(current.projectWorktreeRoots));
    for (const [projectId, root] of Object.entries(patch.projectWorktreeRoots)) {
      if (root === null || root === "") roots.delete(projectId);
      else roots.set(projectId, root);
    }
    next = { ...next, projectWorktreeRoots: Object.fromEntries(roots) };
  }
  if (patch.projectStorageRetention !== undefined) {
    const policies = new Map(Object.entries(current.projectStorageRetention));
    for (const [projectId, policy] of Object.entries(patch.projectStorageRetention)) {
      if (policy === null) policies.delete(projectId);
      else policies.set(projectId, policy);
    }
    next = { ...next, projectStorageRetention: Object.fromEntries(policies) };
  }
  const nextWithReplacements =
    patch.providerInstances !== undefined
      ? {
          ...next,
          providerInstances: patch.providerInstances,
        }
      : next;
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
