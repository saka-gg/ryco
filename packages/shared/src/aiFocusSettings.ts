import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import type { ClientSettingsPatch, ServerSettingsPatch } from "@ryco/contracts/settings";

export const AI_FOCUS_DISCLOSURE_FIELDS = [
  "Thread titles",
  "Project or repository names",
  "Branch names",
  "Bucketed creation and activity age",
  "Running, approval, input, queue, failure, and delivery state",
  "Pull request or linked issue title and state",
  "Up to 600 characters from the latest user request",
] as const;

export const AI_FOCUS_REFRESH_INTERVAL_OPTIONS = [
  { value: 0, label: "Manual only" },
  { value: 5 * 60_000, label: "Every 5 minutes" },
  { value: 10 * 60_000, label: "Every 10 minutes" },
  { value: 30 * 60_000, label: "Every 30 minutes" },
  { value: 60 * 60_000, label: "Every hour" },
  { value: 6 * 60 * 60_000, label: "Every 6 hours" },
  { value: 24 * 60 * 60_000, label: "Every 24 hours" },
] as const;

export interface AiFocusEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly serverConfig: ServerConfig | null;
}

export interface AiFocusEnvironmentRow extends AiFocusEnvironmentInput {
  readonly supported: boolean;
  readonly inherited: boolean;
  readonly effectiveModelSelection: ModelSelection | null;
  readonly effectiveProvider: ServerProvider | null;
}

export function makeAiFocusClientSettingsPatch(input: {
  readonly enabled?: boolean;
  readonly refreshIntervalMs?: number;
}): ClientSettingsPatch {
  return {
    ...(input.enabled !== undefined ? { aiFocusEnabled: input.enabled } : {}),
    ...(input.refreshIntervalMs !== undefined
      ? { aiFocusRefreshIntervalMs: input.refreshIntervalMs }
      : {}),
  } as ClientSettingsPatch;
}

export function resolveAiFocusEnvironmentRows(
  environments: ReadonlyArray<AiFocusEnvironmentInput>,
): ReadonlyArray<AiFocusEnvironmentRow> {
  return environments.map((environment) => {
    const serverConfig = environment.serverConfig;
    const supported = serverConfig?.environment.capabilities.threadPriorityRanking === true;
    const override = serverConfig?.settings.inboxPriorityModelSelection ?? null;
    const effectiveModelSelection = serverConfig
      ? (override ?? serverConfig.settings.textGenerationModelSelection)
      : null;
    const effectiveProvider =
      effectiveModelSelection === null
        ? null
        : (serverConfig?.providers.find(
            (provider) => provider.instanceId === effectiveModelSelection.instanceId,
          ) ?? null);
    return {
      ...environment,
      supported,
      inherited: override === null,
      effectiveModelSelection,
      effectiveProvider,
    };
  });
}

export function isAvailableAiFocusProviderInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): boolean {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return Boolean(
    provider &&
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.status !== "disabled" &&
    provider.status !== "error",
  );
}

export function makeAiFocusModelOverridePatch(input: {
  readonly serverConfig: ServerConfig;
  readonly selection: ModelSelection | null;
}): ServerSettingsPatch {
  if (
    input.selection !== null &&
    !isAvailableAiFocusProviderInstance(input.serverConfig.providers, input.selection.instanceId)
  ) {
    throw new Error("That provider instance is not available on this environment.");
  }
  return { inboxPriorityModelSelection: input.selection };
}

export function selectAiFocusManualRefreshTargets(
  rows: ReadonlyArray<AiFocusEnvironmentRow>,
): ReadonlyArray<EnvironmentId> {
  return rows.filter((row) => row.connected && row.supported).map((row) => row.environmentId);
}
