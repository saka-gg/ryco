// The providers × devices table of Providers & models: every provider instance of every known
// device, grouped into one row per provider, and each device's state of it.
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
} from "@ryco/contracts";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import { isProviderReady } from "@ryco/shared/providerCapabilities";

import { getDriverOption } from "./providerDriverMeta";
import { deriveProviderSettingsInstanceRows } from "./providerSettingsInstances";

/** A device as the table reads it: its last known config, and whether this client may edit it. */
export interface ProviderTableDevice {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Its last known settings and provider status; null while none is known. */
  readonly config: {
    readonly settings: Pick<UnifiedSettings, "providers" | "providerInstances">;
    readonly providers: ReadonlyArray<ServerProvider>;
  } | null;
  /** Reachable now (a stale config is shown read only). */
  readonly online: boolean;
  /** This client may change its settings now (owner, or the hosted grant). */
  readonly canEdit: boolean;
}

/** One device's state of a provider, from the data the client already has. */
export type ProviderCellStatus =
  | "ready"
  | "sign-in"
  | "attention"
  | "not-installed"
  | "off"
  | "checking"
  /** The device has no such instance. */
  | "missing"
  /** No config known for the device. */
  | "unknown";

export interface ProviderTableCell {
  readonly environmentId: EnvironmentId;
  readonly status: ProviderCellStatus;
  /** The device's own instance id, for Edit; null when it has none. */
  readonly instanceId: ProviderInstanceId | null;
  /** From the device's last known config while it is offline: read only. */
  readonly stale: boolean;
  /** Edit (an instance) or Add (a missing one) may open for this device now. */
  readonly actionable: boolean;
}

export interface ProviderTableRow {
  readonly key: string;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  /** The instance id the row was first seen with (the id an Add proposes). */
  readonly instanceId: ProviderInstanceId;
  readonly isDefault: boolean;
  /** "id": every device holds the same instance id; "name": some only share driver and name. */
  readonly match: "id" | "name";
  /** The name a custom instance carries, for an Add on another device. */
  readonly customName: string | null;
  readonly accentColor: string | null;
  readonly cells: ReadonlyArray<ProviderTableCell>;
}

/** The label a person gave an instance, if any. */
function customName(instance: ProviderInstanceConfig): string | null {
  const name = instance.displayName?.trim();
  return name ? name : null;
}

function nameKey(driver: ProviderDriverKind, name: string): string {
  return `${driver}\u0000${name.toLocaleLowerCase()}`;
}

/** A device's state of one of its instances. */
export function providerInstanceStatus(
  instance: ProviderInstanceConfig,
  live: ServerProvider | undefined,
): Exclude<ProviderCellStatus, "missing" | "unknown"> {
  if (instance.enabled === false) return "off";
  if (live === undefined) return "checking";
  if (!live.enabled || live.status === "disabled") return "off";
  if (!live.installed || live.availability === "unavailable") return "not-installed";
  if (live.auth.status === "unauthenticated") return "sign-in";
  return isProviderReady(live) ? "ready" : "attention";
}

interface DeviceInstance {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly live: ServerProvider | undefined;
}

interface Group {
  readonly key: string;
  readonly first: DeviceInstance;
  readonly byDevice: Map<EnvironmentId, DeviceInstance>;
  match: "id" | "name";
}

/**
 * Groups every device's provider instances into one row per provider. Instances with the same
 * id on several devices are one row. An instance whose id no other device holds joins a row of
 * the same driver and the same given name when that row has no instance on its device yet
 * ("matched by name"), so a provider added under another id on each device still reads as one.
 * An instance without a given name only ever matches by id. Rows keep the order of the first
 * device that lists them (each device's own provider order), then later devices' new rows.
 */
export function groupProviderInstancesAcrossDevices(
  devices: ReadonlyArray<ProviderTableDevice>,
): ReadonlyArray<ProviderTableRow> {
  // Every device's instances first: an id another device also holds always groups by id.
  const entries: DeviceInstance[] = [];
  const idDevices = new Map<ProviderInstanceId, number>();
  for (const device of devices) {
    if (device.config === null) continue;
    const live = new Map(
      device.config.providers.map((provider) => [provider.instanceId, provider] as const),
    );
    for (const row of deriveProviderSettingsInstanceRows(
      device.config.settings,
      device.config.providers,
    )) {
      entries.push({
        environmentId: device.environmentId,
        instanceId: row.instanceId,
        instance: row.instance,
        driver: row.driver,
        isDefault: row.isDefault,
        live: live.get(row.instanceId),
      });
      idDevices.set(row.instanceId, (idDevices.get(row.instanceId) ?? 0) + 1);
    }
  }

  const groups: Group[] = [];
  const byId = new Map<ProviderInstanceId, Group>();
  const byName = new Map<string, Group[]>();
  for (const entry of entries) {
    const sameId = byId.get(entry.instanceId);
    if (sameId !== undefined) {
      sameId.byDevice.set(entry.environmentId, entry);
      continue;
    }
    const name = entry.isDefault ? null : customName(entry.instance);
    const key = name === null ? null : nameKey(entry.driver, name);
    if (key !== null && (idDevices.get(entry.instanceId) ?? 0) < 2) {
      const free = (byName.get(key) ?? []).find(
        (group) => !group.byDevice.has(entry.environmentId),
      );
      if (free !== undefined) {
        free.byDevice.set(entry.environmentId, entry);
        free.match = "name";
        continue;
      }
    }
    const group: Group = {
      key: `id:${entry.instanceId}`,
      first: entry,
      byDevice: new Map([[entry.environmentId, entry]]),
      match: "id",
    };
    groups.push(group);
    byId.set(entry.instanceId, group);
    if (key !== null) byName.set(key, [...(byName.get(key) ?? []), group]);
  }

  return groups.map((group): ProviderTableRow => {
    const { first } = group;
    const name = customName(first.instance);
    return {
      key: group.key,
      driver: first.driver,
      displayName: name ?? getDriverOption(first.driver)?.label ?? String(first.driver),
      instanceId: first.instanceId,
      isDefault: first.isDefault,
      match: group.match,
      customName: first.isDefault ? null : name,
      accentColor: first.instance.accentColor ?? null,
      cells: devices.map((device): ProviderTableCell => {
        const entry = group.byDevice.get(device.environmentId);
        const stale = !device.online;
        if (device.config === null)
          return {
            environmentId: device.environmentId,
            status: "unknown",
            instanceId: null,
            stale,
            actionable: false,
          };
        const actionable = device.online && device.canEdit;
        if (entry === undefined)
          return {
            environmentId: device.environmentId,
            status: "missing",
            instanceId: null,
            stale,
            // Only a provider someone added can be added elsewhere; built-ins are always there.
            actionable: actionable && !first.isDefault,
          };
        return {
          environmentId: device.environmentId,
          status: providerInstanceStatus(entry.instance, entry.live),
          instanceId: entry.instanceId,
          stale,
          actionable,
        };
      }),
    };
  });
}

export const PROVIDER_CELL_LABELS: Readonly<Record<ProviderCellStatus, string>> = {
  ready: "Ready",
  "sign-in": "Needs sign-in",
  attention: "Needs attention",
  "not-installed": "Not installed",
  off: "Off",
  checking: "Checking",
  missing: "Not set up",
  unknown: "Not known yet",
};
