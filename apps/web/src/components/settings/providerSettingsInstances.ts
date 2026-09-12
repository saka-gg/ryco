import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
} from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@ryco/contracts/settings";
import { Equal } from "effect";

import { DRIVER_OPTIONS } from "./providerDriverMeta";

export interface ProviderSettingsInstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty: boolean;
}

function hasDefaultProviderSlot(driver: ProviderDriverKind): boolean {
  return Object.hasOwn(DEFAULT_UNIFIED_SETTINGS.providers, driver);
}

function defaultInstanceForDriver(
  settings: UnifiedSettings,
  driver: ProviderDriverKind,
): { readonly instance: ProviderInstanceConfig; readonly isDirty: boolean } | null {
  // Registry and future instance-only drivers require explicit installation/configuration.
  if (!hasDefaultProviderSlot(driver)) return null;
  type LegacyProviderSettings = UnifiedSettings["providers"][keyof UnifiedSettings["providers"]];
  const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
  const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings
  >;
  const instanceId = defaultInstanceIdForDriver(driver);
  const explicitInstance = settings.providerInstances?.[instanceId];
  const legacyConfig = legacyProviders[driver]!;
  const defaultLegacyConfig = defaultLegacyProviders[driver]!;

  return {
    instance:
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig),
    isDirty: explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig),
  };
}

export function deriveProviderSettingsInstanceRows(
  settings: UnifiedSettings,
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderSettingsInstanceRow> {
  const visibleDrivers = DRIVER_OPTIONS.map((definition) => definition.value).filter(
    (driver) =>
      driver !== "cursor" ||
      serverProviders.some(
        (provider) => provider.instanceId === defaultInstanceIdForDriver(driver),
      ),
  );
  const visibleDriverSet = new Set(visibleDrivers);
  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();

  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const list = instancesByDriver.get(instance.driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(instance.driver, list);
  }

  const rows: ProviderSettingsInstanceRow[] = [];
  for (const driver of visibleDrivers) {
    const instanceId = defaultInstanceIdForDriver(driver);
    const defaultInstance = defaultInstanceForDriver(settings, driver);
    if (defaultInstance) {
      rows.push({
        instanceId,
        instance: defaultInstance.instance,
        driver,
        isDefault: true,
        isDirty: defaultInstance.isDirty,
      });
    }

    for (const [customId, instance] of instancesByDriver.get(driver) ?? []) {
      if (defaultInstance && customId === instanceId) continue;
      rows.push({
        instanceId: customId,
        instance,
        driver: instance.driver,
        isDefault: false,
        isDirty: true,
      });
    }
  }

  for (const [driver, instances] of instancesByDriver) {
    if (visibleDriverSet.has(driver)) continue;
    for (const [instanceId, instance] of instances) {
      rows.push({
        instanceId,
        instance,
        driver,
        isDefault:
          hasDefaultProviderSlot(driver) && instanceId === defaultInstanceIdForDriver(driver),
        isDirty: true,
      });
    }
  }

  return rows;
}

export function resolveSelectedProviderSettingsInstance(
  rows: ReadonlyArray<ProviderSettingsInstanceRow>,
  selectedInstanceId: ProviderInstanceId | null,
): ProviderSettingsInstanceRow | null {
  return rows.find((row) => row.instanceId === selectedInstanceId) ?? rows.at(0) ?? null;
}

export type ProviderSettingsListNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function resolveProviderSettingsListNavigationIndex(
  currentIndex: number,
  key: ProviderSettingsListNavigationKey,
  rowCount: number,
): number | null {
  if (rowCount <= 0 || currentIndex < 0 || currentIndex >= rowCount) return null;
  if (key === "Home") return 0;
  if (key === "End") return rowCount - 1;
  if (key === "ArrowDown") return (currentIndex + 1) % rowCount;
  return (currentIndex - 1 + rowCount) % rowCount;
}
