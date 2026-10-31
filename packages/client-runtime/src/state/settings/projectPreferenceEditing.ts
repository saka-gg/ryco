/**
 * Writes to project preferences and the node defaults they inherit, shared by every settings
 * surface. Kept off the `state/settings` index, which the app shell imports.
 */
import type {
  EffectiveProjectPreferences,
  ProjectPreferenceKey,
  ProjectPreferencesExpected,
  ProjectPreferencesPatch,
  ProjectPreferenceValueKey,
  ServerSettings,
  ServerSettingsPatch,
} from "@ryco/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@ryco/contracts/settings";

import type { NodeSettingsConfig } from "./nodeSettingsFanOut.ts";

/**
 * Whether the node reports this preference. An older node's reply omits keys added after it, so
 * a surface hides those rows instead of guessing a value.
 */
export function projectPreferenceSupported(
  effective: EffectiveProjectPreferences,
  key: ProjectPreferenceKey,
): boolean {
  return Object.hasOwn(effective, key);
}

/**
 * The settings patch for one edit, with compare-and-set values for exactly the fields it
 * changes, so concurrent edits to other fields never collide. A project edit (`projectId` set)
 * compares the project's own overrides, and an initial model it never set as "absent", which
 * the node keeps apart from a reset. A node edit (no `projectId`) compares the node's effective
 * values, and a model only Ryco's built-in default fills as unset (null).
 */
export function projectPreferencesWritePatch(input: {
  readonly effective: EffectiveProjectPreferences;
  readonly projectId?: string | null | undefined;
  readonly patch: ProjectPreferencesPatch;
}): ServerSettingsPatch {
  const { effective, projectId, patch } = input;
  const fields = Object.keys(patch) as ReadonlyArray<ProjectPreferenceKey>;
  if (projectId) {
    const current = effective.overrides;
    const expected = Object.fromEntries(
      fields.map((field) => [
        field,
        field === "initialModelSelection" && !Object.hasOwn(current, field)
          ? "absent"
          : (current[field] ?? null),
      ]),
    ) as ProjectPreferencesExpected;
    return {
      projectPreferences: { [projectId]: patch },
      expectedProjectPreferences: { [projectId]: expected },
    };
  }
  // Node defaults reset to a value, never to null, except the initial model (see
  // `projectPreferenceResetValue`), so this patch is a node settings patch.
  return {
    ...patch,
    expectedNodePreferences: Object.fromEntries(
      fields.map((field) => [
        field,
        field === "initialModelSelection" && effective.initialModelSelection.source === "builtin"
          ? null
          : effective[field]?.value,
      ]),
    ),
  } as ServerSettingsPatch;
}

/** Whether a node keeps project preferences, and with them the compare-and-set of node defaults. */
export function nodeKeepsProjectPreferences(config: NodeSettingsConfig): boolean {
  return config.environment.capabilities.projectPreferences === true;
}

/**
 * A node-default edit written to every node (`applyNodeSettingsPatch`): each node's patch
 * compares that node's own current values, read from its own config, the way
 * {@link projectPreferencesWritePatch} compares the values the editing node showed. A value
 * copied from another node would refuse a write the node should take, or pass a guard it should
 * fail. Only for keys every node with {@link nodeKeepsProjectPreferences} knows; the initial model
 * is never written across nodes, whose provider instances differ.
 */
export function nodePreferencesPatchFor(patch: {
  readonly [K in ProjectPreferenceValueKey]?: ServerSettings[K];
}): (config: NodeSettingsConfig) => ServerSettingsPatch {
  const fields = Object.keys(patch) as ReadonlyArray<ProjectPreferenceValueKey>;
  return (config) =>
    ({
      ...patch,
      expectedNodePreferences: Object.fromEntries(
        fields.map((field) => [field, config.settings[field] ?? null]),
      ),
    }) as ServerSettingsPatch;
}

function overriddenForProject(
  effective: EffectiveProjectPreferences | null,
  field: ProjectPreferenceKey,
): boolean {
  const source = effective?.[field]?.source;
  return source === "project" || source === "legacy-project";
}

/**
 * Whether a field has something to reset: a project's own override, or a node value other than
 * Ryco's default (a model the node chose).
 */
export function projectPreferenceCanReset(input: {
  readonly effective: EffectiveProjectPreferences | null;
  readonly projectId?: string | null | undefined;
  readonly field: ProjectPreferenceKey;
}): boolean {
  const { effective, projectId, field } = input;
  if (projectId) return overriddenForProject(effective, field);
  if (field === "initialModelSelection") return effective?.initialModelSelection.source === "node";
  return effective !== null && effective[field]?.value !== DEFAULT_SERVER_SETTINGS[field];
}

/**
 * What a reset writes: null, so a project inherits again or the node's model falls back to
 * Ryco's built-in one, and otherwise Ryco's default for the node setting.
 */
export function projectPreferenceResetValue(
  field: ProjectPreferenceKey,
  projectId?: string | null,
): ProjectPreferencesPatch[ProjectPreferenceKey] {
  if (projectId || field === "initialModelSelection") return null;
  return DEFAULT_SERVER_SETTINGS[field];
}
