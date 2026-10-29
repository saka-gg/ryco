import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@ryco/contracts";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@ryco/contracts/settings";

type EnablementSettings = Pick<ServerSettings, "providers" | "providerInstances">;
type LegacySlots = Readonly<Record<string, { readonly enabled: boolean }>>;

const DEFAULT_SLOTS: LegacySlots = DEFAULT_SERVER_SETTINGS.providers;

/**
 * The registry's rule for one envelope: its flag, else its config's, else the driver's default.
 * Driver config schemas decode a boolean `enabled` unchanged and default it to the legacy slot's
 * default, so this equals the decoded value. Drivers without a slot have no `enabled` key.
 */
export function providerInstanceEnvelopeEnabled(
  entry: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean {
  if (entry.enabled !== undefined) return entry.enabled;
  const config = entry.config;
  const flag =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? (config as { readonly enabled?: unknown }).enabled
      : undefined;
  if (typeof flag === "boolean") return flag;
  return Object.hasOwn(DEFAULT_SLOTS, entry.driver) ? DEFAULT_SLOTS[entry.driver]!.enabled : true;
}

/** Effective state of an instance id; undefined when the id is not configured at all. */
export function resolveProviderInstanceEnabled(
  settings: EnablementSettings,
  instanceId: string,
): boolean | undefined {
  const explicit = settings.providerInstances;
  if (Object.hasOwn(explicit, instanceId)) {
    return providerInstanceEnvelopeEnabled(explicit[instanceId as ProviderInstanceId]!);
  }
  // A default instance without an explicit entry mirrors its legacy slot.
  const slots: LegacySlots = settings.providers;
  return Object.hasOwn(slots, instanceId) ? slots[instanceId]!.enabled : undefined;
}

/**
 * Enabled instances in fallback order: default slots in `providers` key order, then the remaining
 * explicit instances in insertion order. The driver comes from the envelope when there is one.
 */
export function listEnabledProviderInstances(
  settings: EnablementSettings,
): ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly driver: ProviderDriverKind }> {
  const explicit = settings.providerInstances;
  const slotIds = Object.keys(settings.providers);
  const ids = [...slotIds, ...Object.keys(explicit).filter((id) => !slotIds.includes(id))];
  return ids.flatMap((id) =>
    resolveProviderInstanceEnabled(settings, id)
      ? [
          {
            instanceId: id as ProviderInstanceId,
            driver: Object.hasOwn(explicit, id)
              ? explicit[id as ProviderInstanceId]!.driver
              : (id as ProviderDriverKind),
          },
        ]
      : [],
  );
}
