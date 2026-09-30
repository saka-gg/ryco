import type {
  EffectiveProjectPreferences,
  EnvironmentApi,
  ModelSelection,
  ProjectId,
  ServerConfig,
} from "@ryco/contracts";

/** Fresh drafts replace traits exactly; omission is not a request to retain sticky traits. */
export function initialDraftModelSelection(input: {
  readonly effective: EffectiveProjectPreferences | null;
  readonly fallback: ModelSelection;
  readonly explicit?: ModelSelection | undefined;
}): ModelSelection {
  const selection =
    input.explicit ?? input.effective?.initialModelSelection.value ?? input.fallback;
  return { ...selection, options: selection.options ?? [] };
}

/** Never infer support from cached values or fall back after a capable node fails. */
export async function readEffectiveProjectPreferences(input: {
  readonly api: EnvironmentApi;
  readonly config: ServerConfig | null | undefined;
  readonly projectId?: ProjectId;
}): Promise<EffectiveProjectPreferences | null> {
  if (input.config?.environment.capabilities.projectPreferences !== true) return null;
  const read = input.api.server?.getProjectPreferences;
  if (!read) throw new Error("Project preferences are unavailable on this connection.");
  return read(input.projectId === undefined ? {} : { projectId: input.projectId });
}
