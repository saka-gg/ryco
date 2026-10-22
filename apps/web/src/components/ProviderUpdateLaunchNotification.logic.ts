import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@ryco/contracts";
import { isBlockingProviderCompatibilityStatus } from "@ryco/shared/providerCapabilities";

export type ProviderUpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly status: "behind_latest";
    readonly latestVersion: string;
  };
};

export type ProviderUpdateToastType = "warning" | "loading" | "error" | "success";
export type ProviderUpdateToastPhase = "initial" | "running" | "failed" | "unchanged" | "succeeded";

export interface ProviderUpdateToastView {
  readonly phase: ProviderUpdateToastPhase;
  readonly type: ProviderUpdateToastType;
  readonly title: string;
  readonly description: string;
  readonly dismissAfterVisibleMs?: number;
}

export interface EnvironmentNotificationOrigin {
  readonly environmentId: EnvironmentId;
  readonly nodeLabel: string;
}

const PROVIDER_UPDATE_SUCCESS_VISIBLE_MS = 3_000;

function formatVersion(value: string): string {
  return value.startsWith("v") ? value : `v${value}`;
}

function chooseRepresentativeProvider(
  current: ServerProvider | undefined,
  candidate: ServerProvider,
): ServerProvider {
  if (!current) {
    return candidate;
  }
  const defaultInstanceId = defaultInstanceIdForDriver(candidate.driver);
  if (candidate.instanceId === defaultInstanceId) {
    return candidate;
  }
  if (current.instanceId === defaultInstanceId) {
    return current;
  }
  return candidate.checkedAt.localeCompare(current.checkedAt) >= 0 ? candidate : current;
}

function dedupeProvidersByDriver<T extends ServerProvider>(providers: ReadonlyArray<T>): T[] {
  const latestProviderByDriver = new Map<ProviderDriverKind, T>();

  for (const provider of providers) {
    latestProviderByDriver.set(
      provider.driver,
      chooseRepresentativeProvider(latestProviderByDriver.get(provider.driver), provider) as T,
    );
  }

  return [...latestProviderByDriver.values()];
}

function dedupeProvidersByInstanceId<T extends ServerProvider>(providers: ReadonlyArray<T>): T[] {
  const latestProviderByInstanceId = new Map<ProviderInstanceId, T>();

  for (const provider of providers) {
    const current = latestProviderByInstanceId.get(provider.instanceId);
    if (!current || provider.checkedAt.localeCompare(current.checkedAt) >= 0) {
      latestProviderByInstanceId.set(provider.instanceId, provider);
    }
  }

  return [...latestProviderByInstanceId.values()];
}

function getProviderUpdatedTitle(provider: Pick<ServerProvider, "driver" | "version">): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  return provider.version
    ? `${providerName} updated: ${formatVersion(provider.version)}`
    : `${providerName} updated`;
}

function getProviderUpdatedDescription(providerCount: number): string {
  return providerCount === 1
    ? "New sessions will use the updated provider."
    : "New sessions will use the updated providers.";
}

function getProviderFailedUpdateTitle(
  provider: Pick<ServerProvider, "driver" | "versionAdvisory">,
): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const attemptedVersion = provider.versionAdvisory?.latestVersion;
  return attemptedVersion
    ? `${providerName} ${formatVersion(attemptedVersion)} update failed`
    : `${providerName} update failed`;
}

export function isProviderUpdateCandidate(
  provider: ServerProvider,
): provider is ProviderUpdateCandidate {
  return (
    provider.enabled &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.latestVersion !== null
  );
}

/**
 * An update candidate Ryco actually offers: its latest version is not rated unsupported/broken
 * for this Ryco release (the server refuses to install those). Deliberately separate from
 * `isProviderUpdateCandidate`, which the progress view uses to detect "no longer outdated" — a
 * re-rating during an update must not read as a successful update.
 */
export function isProviderUpdateOffered(
  provider: ServerProvider,
): provider is ProviderUpdateCandidate {
  return (
    isProviderUpdateCandidate(provider) &&
    !isBlockingProviderCompatibilityStatus(provider.compatibilityAdvisory?.latestVersionStatus)
  );
}

export function isProviderUpdateActive(provider: Pick<ServerProvider, "updateState">): boolean {
  return provider.updateState?.status === "queued" || provider.updateState?.status === "running";
}

export function collectProviderUpdateCandidates(
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateCandidate[] {
  return dedupeProvidersByDriver(providers.filter(isProviderUpdateOffered));
}

export function hasOneClickUpdateProviderCandidate(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  if (!isProviderUpdateOffered(candidate)) {
    return false;
  }
  if (
    candidate.versionAdvisory.canUpdate !== true ||
    candidate.versionAdvisory.updateCommand === null
  ) {
    return false;
  }

  const driverProviders = providers.filter((provider) => provider.driver === candidate.driver);
  if (driverProviders.length === 0) {
    return false;
  }

  const updateCommands = new Set<string>();
  for (const provider of driverProviders) {
    if (!isProviderUpdateCandidate(provider)) {
      continue;
    }
    const advisory = provider.versionAdvisory;
    if (!advisory || advisory.canUpdate !== true || advisory.updateCommand === null) {
      return false;
    }
    updateCommands.add(advisory.updateCommand);
  }

  return updateCommands.size === 1;
}

export function canOneClickUpdateProviderCandidate(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  return (
    !isProviderUpdateActive(candidate) && hasOneClickUpdateProviderCandidate(candidate, providers)
  );
}

export function providerUpdateNotificationKey(
  providers: ReadonlyArray<ProviderUpdateCandidate>,
  origin?: Pick<EnvironmentNotificationOrigin, "environmentId">,
): string | null {
  const parts = dedupeProvidersByDriver(providers)
    .map((provider) => {
      const advisory = provider.versionAdvisory;
      return [provider.instanceId, provider.driver, advisory.latestVersion].join(":");
    })
    .toSorted();

  return parts.length > 0
    ? [origin?.environmentId ?? "unknown-environment", ...parts].join("|")
    : null;
}

export function providerUpdateCandidateKey(provider: ProviderUpdateCandidate): string {
  return providerUpdateNotificationKey([provider])!;
}

export function withProviderUpdateOrigin(
  view: ProviderUpdateToastView,
  origin: EnvironmentNotificationOrigin,
): ProviderUpdateToastView {
  return {
    ...view,
    title: `${view.title} · ${origin.nodeLabel}`,
    description: `On ${origin.nodeLabel}. ${view.description}`,
  };
}

export function formatProviderList(providers: ReadonlyArray<Pick<ServerProvider, "driver">>) {
  const names = providers.map(
    (provider) => PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
  );
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function getProviderUpdateInitialToastView(input: {
  readonly updateProviders: ReadonlyArray<ProviderUpdateCandidate>;
  readonly oneClickProviders: ReadonlyArray<ProviderUpdateCandidate>;
}): ProviderUpdateToastView {
  return {
    phase: "initial",
    type: "warning",
    title: getProviderUpdateInitialToastTitle(input.updateProviders),
    description:
      input.oneClickProviders.length > 0
        ? "Install the update now or review provider settings."
        : `${formatProviderList(input.updateProviders)} can be updated from provider settings.`,
  };
}

export function getProviderUpdateRunningToastView(providerCount: number): ProviderUpdateToastView {
  return {
    phase: "running",
    type: "loading",
    title: providerCount === 1 ? "Updating provider" : "Updating providers",
    description: "Running provider update command.",
  };
}

export function getProviderUpdateRejectedToastView(
  providerCount: number,
  message: string,
): ProviderUpdateToastView {
  return {
    phase: "failed",
    type: "error",
    title: providerCount === 1 ? "Provider update failed" : "Provider updates failed",
    description: message,
  };
}

export function getProviderUpdateProgressToastView(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerCount: number;
}): ProviderUpdateToastView {
  const providers = dedupeProvidersByDriver(input.providers);
  const failedProviders = providers.filter((provider) => provider.updateState?.status === "failed");
  if (failedProviders.length > 0) {
    return {
      phase: "failed",
      type: "error",
      title: failedProviders.length === 1 ? "Provider update failed" : "Provider updates failed",
      description: getFailedProviderUpdateDescription(failedProviders),
    };
  }

  const unchangedProviders = providers.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  if (unchangedProviders.length > 0) {
    return {
      phase: "unchanged",
      type: "warning",
      title:
        unchangedProviders.length === 1
          ? "Provider still needs an update"
          : "Providers still need updates",
      description: `${formatProviderList(unchangedProviders)} ${
        unchangedProviders.length === 1 ? "still appears" : "still appear"
      } outdated. Check provider settings for details.`,
    };
  }

  if (providers.some(isProviderUpdateActive)) {
    return getProviderUpdateRunningToastView(input.providerCount);
  }

  const hasCompleteProviderSnapshots = providers.length >= input.providerCount;
  const allProvidersUpdated =
    hasCompleteProviderSnapshots &&
    providers.every(
      (provider) =>
        provider.updateState?.status === "succeeded" || !isProviderUpdateCandidate(provider),
    );
  if (allProvidersUpdated) {
    return {
      phase: "succeeded",
      type: "success",
      title: input.providerCount === 1 ? "Provider updated" : "Provider updates finished",
      description: getProviderUpdatedDescription(input.providerCount),
      dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
    };
  }

  return getProviderUpdateRunningToastView(input.providerCount);
}

export function getSingleProviderUpdateProgressToastView(
  provider: ServerProvider,
): ProviderUpdateToastView {
  const view = getProviderUpdateProgressToastView({
    providers: [provider],
    providerCount: 1,
  });
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;

  switch (view.phase) {
    case "running":
      return {
        ...view,
        title: `Updating ${providerName}`,
      };
    case "failed":
      return {
        ...view,
        title: getProviderFailedUpdateTitle(provider),
      };
    case "unchanged":
      return {
        ...view,
        title: `${providerName} still needs an update`,
      };
    case "succeeded":
      return {
        ...view,
        title: getProviderUpdatedTitle(provider),
      };
    default:
      return view;
  }
}

export function collectUpdatedProviderSnapshots(input: {
  readonly results: ReadonlyArray<
    PromiseSettledResult<{ readonly providers: ReadonlyArray<ServerProvider> }>
  >;
  readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
}): ServerProvider[] {
  const matchedProviders: ServerProvider[] = [];

  for (const result of input.results) {
    if (result.status !== "fulfilled") {
      continue;
    }
    for (const provider of result.value.providers) {
      if (input.providerInstanceIds.has(provider.instanceId)) {
        matchedProviders.push(provider);
      }
    }
  }

  return dedupeProvidersByInstanceId(matchedProviders);
}

export function firstRejectedProviderUpdateMessage(
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
): string | null {
  const rejected = results.find((result) => result.status === "rejected");
  if (!rejected) {
    return null;
  }
  return rejected.reason instanceof Error ? rejected.reason.message : "Provider update failed.";
}

function getProviderUpdateInitialToastTitle(
  providers: ReadonlyArray<ProviderUpdateCandidate>,
): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
    return `Update Available: ${providerName} ${formatVersion(provider.versionAdvisory.latestVersion)}`;
  }
  return `Updates Available: ${providers.length} providers`;
}

function getFailedProviderUpdateDescription(providers: ReadonlyArray<ServerProvider>): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    if (provider.updateState?.message) {
      return provider.updateState.message;
    }
  }
  return `${formatProviderList(providers)} failed to update. Check provider settings for details.`;
}
