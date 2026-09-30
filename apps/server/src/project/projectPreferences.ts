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
  const legacy =
    overrides && Object.hasOwn(overrides, "initialModelSelection")
      ? null
      : project?.defaultModelSelection;
  const model = initial ?? legacy ?? settings.initialModelSelection;
  const root = project ? settings.projectWorktreeRoots[project.id] : undefined;
  return {
    overrides: overrides ?? {},
    initialModelSelection: {
      value: model ?? { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
      source: initial
        ? "project"
        : legacy
          ? "legacy-project"
          : settings.initialModelSelection
            ? "node"
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
