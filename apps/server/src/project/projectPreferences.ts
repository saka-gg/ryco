import {
  DEFAULT_MODEL,
  PROJECT_PREFERENCE_VALUE_KEYS,
  ProviderInstanceId,
  type EffectiveProjectPreferences,
  type ModelSelection,
  type PreferenceSource,
  type ProjectId,
  type ProjectPreferences,
  type ProjectPreferenceValueKey,
  type ServerSettings,
  type ThreadEnvMode,
} from "@ryco/contracts";

/**
 * Authoritative creation preferences. No client state, filesystem access, or
 * execution/security policy belongs here. Feature-specific policy resolvers
 * consume the same settings/project input but own their own bounded schemas.
 */
export function resolveProjectPreferences(input: {
  readonly settings: ServerSettings;
  readonly project?: {
    readonly id: ProjectId;
    readonly defaultModelSelection: ModelSelection | null;
  };
}): EffectiveProjectPreferences {
  const { settings, project } = input;
  const overrides = project ? settings.projectPreferences[project.id] : undefined;
  const initial = overrides?.initialModelSelection;
  // A model saved on the project before project defaults moved into settings
  // ranks below the node's default: it was usually that day's built-in model,
  // copied in when the project was created, and providers retire models. It
  // only stands in for Ryco's built-in model, and an explicit project reset
  // (`initialModelSelection: null`) masks it.
  const legacy =
    (overrides && Object.hasOwn(overrides, "initialModelSelection")) ||
    settings.initialModelSelection
      ? null
      : project?.defaultModelSelection;
  const model = initial ?? settings.initialModelSelection ?? legacy;
  const root = project ? settings.projectWorktreeRoots[project.id] : undefined;
  return {
    overrides: overrides ?? {},
    initialModelSelection: {
      value: model ?? { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
      source: initial
        ? "project"
        : settings.initialModelSelection
          ? "node"
          : legacy
            ? "legacy-project"
            : "builtin",
    },
    ...inheritNodeSettings(settings, overrides),
    worktreeRoot: {
      value: root || settings.worktreeRoot,
      source: root ? "project" : settings.worktreeRoot ? "node" : "builtin",
    },
  };
}

type InheritedPreferences = {
  readonly [K in ProjectPreferenceValueKey]: Exclude<EffectiveProjectPreferences[K], undefined>;
};

/**
 * Every registry key but the initial model: a project override wins, otherwise the node setting
 * of the same name applies.
 */
function inheritNodeSettings(
  settings: ServerSettings,
  overrides: ProjectPreferences | undefined,
): InheritedPreferences {
  const inherited: Record<string, { readonly value: unknown; readonly source: PreferenceSource }> =
    {};
  for (const key of PROJECT_PREFERENCE_VALUE_KEYS) {
    inherited[key] = {
      value: overrides?.[key] ?? settings[key],
      source: overrides?.[key] !== undefined ? "project" : "node",
    };
  }
  return inherited as InheritedPreferences;
}

/** Omitted creation choices inherit; explicit choices (including false/empty) win. */
export function resolveThreadCreationPreferences(input: {
  readonly effective: EffectiveProjectPreferences;
  readonly modelSelection?: ModelSelection;
  readonly envMode?: ThreadEnvMode;
  readonly worktreeBranchPrefix?: string;
  readonly runSetupScript?: boolean;
}) {
  return {
    modelSelection: input.modelSelection ?? input.effective.initialModelSelection.value,
    envMode: input.envMode ?? input.effective.defaultThreadEnvMode.value,
    worktreeBranchPrefix: input.worktreeBranchPrefix ?? input.effective.worktreeBranchPrefix.value,
    runSetupScript: input.runSetupScript ?? input.effective.runSetupScript.value,
  };
}
