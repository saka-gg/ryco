import {
  DEFAULT_RESPONSE_STREAMING_MODE,
  type ResponseStreamingMode,
  ServerSettings,
  type ServerSettingsPatch,
} from "@ryco/contracts/settings";
import * as Equal from "effect/Equal";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const PersistedSettingsObjectJson = fromLenientJson(Schema.Record(Schema.String, Schema.Unknown));

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
    // Decode only this key so an unrelated invalid setting cannot hide the endpoints.
    const persisted = Schema.decodeUnknownSync(PersistedSettingsObjectJson)(raw);
    const decoded = Schema.decodeUnknownSync(ServerSettings)(
      persisted.observability === undefined ? {} : { observability: persisted.observability },
    );
    return extractPersistedServerObservabilitySettings(decoded);
  } catch {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }
}

/**
 * The streaming mode a legacy `enableLegacyTokenStreaming` value stands for: on is token
 * output; off leaves token output for the default and keeps any other mode.
 */
function responseStreamingModeFromLegacyTokenStreaming(
  enabled: boolean,
  current: ResponseStreamingMode,
): ResponseStreamingMode {
  if (enabled) return "token";
  return current === "token" ? DEFAULT_RESPONSE_STREAMING_MODE : current;
}

/**
 * Upgrades a settings file written before `responseStreamingMode`: a saved token-streaming
 * opt-in keeps token output. Everything else in the object is left to the schema.
 */
export function migrateLegacyServerSettings(persisted: unknown): unknown {
  if (
    !Predicate.isObject(persisted) ||
    Object.hasOwn(persisted, "responseStreamingMode") ||
    persisted.enableLegacyTokenStreaming !== true
  ) {
    return persisted;
  }
  return { ...persisted, responseStreamingMode: "token" satisfies ResponseStreamingMode };
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
  if (patch.expectedThreadAutoSettleAfterDays !== undefined) {
    // Off (null) is a value someone chose, so only a missing key counts as never set.
    const actual =
      current.threadAutoSettleAfterDays === undefined
        ? "absent"
        : current.threadAutoSettleAfterDays;
    if (actual !== patch.expectedThreadAutoSettleAfterDays)
      throw new Error("The auto-settle rule changed elsewhere. Reload before saving.");
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
    expectedThreadAutoSettleAfterDays: _expectedAutoSettle,
    projectPreferences: _projects,
    cliProxyHubs: _cliProxyHubs,
    enableLegacyTokenStreaming: legacyTokenStreaming,
    ...persistedPatch
  } = patch;
  let next = deepMerge(current, persistedPatch);
  if (patch.responseStreamingMode === undefined && legacyTokenStreaming !== undefined)
    next = {
      ...next,
      responseStreamingMode: responseStreamingModeFromLegacyTokenStreaming(
        legacyTokenStreaming,
        current.responseStreamingMode,
      ),
    };
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
  if (patch.projectLifecycleSuggestions !== undefined) {
    const policies = new Map(Object.entries(current.projectLifecycleSuggestions));
    for (const [projectId, policy] of Object.entries(patch.projectLifecycleSuggestions)) {
      if (policy === null) policies.delete(projectId);
      else policies.set(projectId, policy);
    }
    next = { ...next, projectLifecycleSuggestions: Object.fromEntries(policies) };
  }
  if (patch.cliProxyHubs !== undefined) {
    const hubs = new Map(Object.entries(current.cliProxyHubs));
    for (const [hubId, hub] of Object.entries(patch.cliProxyHubs)) {
      if (hub === null) hubs.delete(hubId);
      else hubs.set(hubId, hub);
    }
    next = { ...next, cliProxyHubs: Object.fromEntries(hubs) as ServerSettings["cliProxyHubs"] };
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
