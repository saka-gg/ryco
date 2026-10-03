import {
  DEFAULT_MODEL,
  ProviderInstanceId,
  type EffectiveProjectPreferences,
  type ModelSelection,
  type ProjectId,
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
    defaultThreadEnvMode: {
      value: overrides?.defaultThreadEnvMode ?? settings.defaultThreadEnvMode,
      source: overrides?.defaultThreadEnvMode !== undefined ? "project" : "node",
    },
    worktreeBranchPrefix: {
      value: overrides?.worktreeBranchPrefix ?? settings.worktreeBranchPrefix,
      source: overrides?.worktreeBranchPrefix !== undefined ? "project" : "node",
    },
    runSetupScript: {
      value: overrides?.runSetupScript ?? settings.runSetupScript,
      source: overrides?.runSetupScript !== undefined ? "project" : "node",
    },
    worktreeRoot: {
      value: root || settings.worktreeRoot,
      source: root ? "project" : settings.worktreeRoot ? "node" : "builtin",
    },
  };
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
