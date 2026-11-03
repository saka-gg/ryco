import type { ServerProvider, ServerProviderModel } from "@ryco/contracts";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelCapabilities,
} from "@ryco/contracts/model";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@ryco/contracts/provider-instance";
import { createModelCapabilities, normalizeModelSlug } from "@ryco/shared/model";
import { findServerProviderModel } from "@ryco/shared/serverProviderModels";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

export function getProviderDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const snapshot = getProviderSnapshot(providers, provider);
  return snapshot?.displayName?.trim() || formatProviderDriverKindLabel(provider);
}

export function getProviderInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.showInteractionModeToggle ?? true;
}

export function getProviderSupportsAskMode(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.supportsAskMode ?? false;
}

/**
 * Why the `auto` runtime mode is unavailable for this instance's model, or null when it may run.
 * Only an explicit `false` in the provider's own report refuses: absent support (an older server,
 * a custom model, a report that does not cover it) is unknown, and the server decides.
 */
export function getAutoRuntimeModeUnavailableReason(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
): string | null {
  const entry = findServerProviderModel(models, model);
  return entry?.supportsAutoMode === false
    ? `${entry.name} can't run in Auto mode on this provider.`
    : null;
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

// Resolve an instance selection to the correlated live driver. If the
// instance is absent, fall back to a live enabled provider instead of
// inferring a driver from the missing instance id.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  if (requestedEntry?.enabled) {
    return requestedEntry.driver;
  }
  return providers.find((candidate) => candidate.enabled)?.driver ?? DEFAULT_DRIVER_KIND;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  return getDefaultProviderModel(getProviderModels(providers, provider), provider);
}

/** The default model of one provider instance, given the models it reports. */
export function getDefaultProviderModel(
  models: ReadonlyArray<ServerProviderModel>,
  provider: ProviderDriverKind,
): string {
  const configuredDefault = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  return (
    models.find((model) => model.slug === configuredDefault)?.slug ??
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    configuredDefault
  );
}

/**
 * Why a checkpoint revert cannot run on this provider, or null when it may.
 * Only an explicit `false` refuses: an absent field means an older server, so
 * the server decides.
 */
export function checkpointRevertUnsupportedMessage(
  provider: ServerProvider | undefined,
): string | null {
  if (provider?.supportsConversationRollback !== false) return null;
  const label = provider.displayName ?? formatProviderDriverKindLabel(provider.driver);
  return `${label} can't remove turns from its conversation, so this thread can't be reverted. Start a new thread to try a different approach.`;
}
