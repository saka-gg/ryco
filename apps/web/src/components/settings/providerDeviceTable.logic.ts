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
  readonly nameKey: string | null;
  readonly first: DeviceInstance;
  readonly byDevice: Map<EnvironmentId, DeviceInstance>;
  match: "id" | "name";
  /** Only one device holds this driver and id: it may still join a row by name. */
  readonly leftover: boolean;
}

function idKey(driver: ProviderDriverKind, instanceId: ProviderInstanceId): string {
  return `${driver}\u0000${instanceId}`;
}

/** The name an instance may match by: a given name on an instance someone added. */
function entryNameKey(entry: DeviceInstance): string | null {
  const name = entry.isDefault ? null : customName(entry.instance);
  return name === null ? null : nameKey(entry.driver, name);
}

/**
 * Groups every device's provider instances into one row per provider. Instances with the same
 * driver and id on several devices are one row, always. An instance whose driver and id no
 * other device holds joins a row of the same driver and the same given name when that row has
 * no instance on its device ("matched by name"), so a provider added under another id on each
 * device still reads as one. A cell is never overwritten: a device holds at most one instance
 * of a row. An instance without a given name only ever matches by id. Rows keep the order of
 * the first device that lists them (each device's own provider order), then later devices' new
 * rows.
 */
export function groupProviderInstancesAcrossDevices(
  devices: ReadonlyArray<ProviderTableDevice>,
): ReadonlyArray<ProviderTableRow> {
  const entries: DeviceInstance[] = [];
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
    }
  }

  // The devices holding each driver and id: two or more always share one row.
  const idDevices = new Map<string, Set<EnvironmentId>>();
  for (const entry of entries) {
    const key = idKey(entry.driver, entry.instanceId);
    const holders = idDevices.get(key) ?? new Set<EnvironmentId>();
    holders.add(entry.environmentId);
    idDevices.set(key, holders);
  }

  // First by driver and id, each in the place its first instance is listed.
  const ordered: Group[] = [];
  const byId = new Map<string, Group>();
  for (const entry of entries) {
    const key = idKey(entry.driver, entry.instanceId);
    const existing = byId.get(key);
    if (existing !== undefined) {
      if (!existing.byDevice.has(entry.environmentId)) {
        existing.byDevice.set(entry.environmentId, entry);
      }
      continue;
    }
    const group: Group = {
      key: `id:${key}`,
      nameKey: entryNameKey(entry),
      first: entry,
      byDevice: new Map([[entry.environmentId, entry]]),
      match: "id",
      leftover: (idDevices.get(key)?.size ?? 0) < 2,
    };
    ordered.push(group);
    byId.set(key, group);
  }

  // Then each leftover joins a row of its driver and name with no instance on its device yet:
  // a row several devices share first, else an earlier leftover's.
  const merged = new Set<Group>();
  for (const group of ordered) {
    if (!group.leftover || group.nameKey === null) continue;
    const { environmentId } = group.first;
    const fits = (other: Group) =>
      other !== group &&
      !merged.has(other) &&
      other.nameKey === group.nameKey &&
      !other.byDevice.has(environmentId);
    const target =
      ordered.find((other) => !other.leftover && fits(other)) ??
      ordered.slice(0, ordered.indexOf(group)).find((other) => other.leftover && fits(other));
    if (target === undefined) continue;
    target.byDevice.set(environmentId, group.first);
    target.match = "name";
    merged.add(group);
  }
  const groups = ordered.filter((group) => !merged.has(group));

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
