/**
 * Which envelope configures a provider instance, as the registry resolves it: an explicit
 * `providerInstances` entry wins; otherwise a built-in driver's default instance (whose id is its
 * driver kind) mirrors the legacy `providers.<kind>` settings. Whether the instance runs is decided
 * here too, so everything that acts on an instance agrees with the registry.
 *
 * Imports only contracts, so lazily loaded features can resolve an instance without pulling the
 * driver registry into their chunk.
 *
 * @module providerInstanceConfig
 */
import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
} from "@ryco/contracts";

/** A built-in driver's default instance from the legacy settings; `undefined` for other ids. */
export const legacyProviderInstanceConfig = (
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): ProviderInstanceConfig | undefined =>
  Object.hasOwn(settings.providers, instanceId)
    ? {
        driver: ProviderDriverKind.make(instanceId),
        config: settings.providers[instanceId as keyof ServerSettings["providers"]],
      }
    : undefined;

export const providerInstanceConfigFor = (
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): ProviderInstanceConfig | undefined =>
  settings.providerInstances[instanceId] ?? legacyProviderInstanceConfig(settings, instanceId);

/**
 * Whether the registry runs an instance: the envelope's `enabled` wins, then a boolean `enabled` of
 * its config as the driver's schema decoded it (with that driver's default), else it runs.
 */
export const resolveInstanceEnabled = (
  entry: ProviderInstanceConfig,
  decodedConfig: unknown,
): boolean => {
  const enabled = (decodedConfig as { readonly enabled?: unknown } | null | undefined)?.enabled;
  return entry.enabled ?? (typeof enabled === "boolean" ? enabled : true);
};
