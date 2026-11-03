import type { EnvironmentId } from "@ryco/contracts";
import type {
  NodeSettingsApplyResult,
  NodeSettingsConfig,
} from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import {
  resetSettingToShared,
  setSettingOverride,
  useSettingEverywhere as settingEverywhereCommand,
  writeSharedSetting,
  type SettingsSharingCache,
  type SettingsSharingCommand,
  type SharedSettingDeviceState,
  type SharedSettingView,
  type SharingDevice,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import type { SettingsSharingStamp } from "@ryco/contracts/settings";
import {
  compareSharingStamps,
  shareableSettingValuesEqual,
  type ShareableServerSettingKey,
  type ShareableSettingValue,
} from "@ryco/shared/settingsSharing";

/**
 * What one shared row shows and which command each edit sends (docs/shared-device-settings.md).
 * Pure: the row component reads every device and the runner's state and renders this.
 */

/** The device bar's choice: every device at once, or one device's own values. */
export type SharedSettingsMode =
  | { readonly kind: "all" }
  | { readonly kind: "device"; readonly environmentId: EnvironmentId };

export interface SharedRowDevice<K extends ShareableServerSettingKey> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** Its own value from its last known config; undefined while none is known. */
  readonly value: ShareableSettingValue<K> | undefined;
  readonly state: SharedSettingDeviceState;
  /** This client may change its value now (connected, writable, and it knows the setting). */
  readonly editable: boolean;
  /** It knows the setting at all (an older node may not); false disables its control. */
  readonly knowsSetting: boolean;
}

export type SharedRowModel<K extends ShareableServerSettingKey> =
  /** One device: the only one, or the one the device bar shows. */
  | {
      readonly kind: "single";
      readonly device: SharedRowDevice<K> | null;
      /** The other devices whose value differs from this one's. */
      readonly others: ReadonlyArray<{
        readonly label: string;
        readonly value: ShareableSettingValue<K>;
      }>;
      readonly deviceCount: number;
    }
  /** Every device holds (or is catching up to) the same value: one control. */
  | {
      readonly kind: "same";
      readonly value: ShareableSettingValue<K>;
      readonly deviceCount: number;
      /** Offline or read-only devices that take it when they can. */
      readonly queued: number;
      readonly syncing: number;
      readonly editable: boolean;
    }
  /** Each device with its own control. */
  | {
      readonly kind: "list";
      readonly devices: ReadonlyArray<SharedRowDevice<K>>;
      readonly deviceCount: number;
      /** Devices not on the value "Use … everywhere" offers. */
      readonly differs: number;
      /** What "Use … everywhere" writes; null while every device already agrees. */
      readonly everywhere: ShareableSettingValue<K> | null;
      readonly everywhereEditable: boolean;
    };

/** The value a device is on or is catching up to: the newest shared one while it syncs or waits. */
function shownValue<K extends ShareableServerSettingKey>(
  view: SharedSettingView<K>,
  device: SharedSettingView<K>["devices"][number],
): ShareableSettingValue<K> | undefined {
  const { kind } = device.state;
  if ((kind === "queued" || kind === "syncing") && view.newest !== null) return view.newest.value;
  return device.value;
}

/**
 * Whether two devices agree: the same value, or both shared on the same write. A device stores
 * a path the way it normalized it (`~/` expanded, symlinks resolved), so the same shared write
 * can read differently on each device; its stamp says it took the same value.
 */
function sameSetting<K extends ShareableServerSettingKey>(
  view: SharedSettingView<K>,
  a: SharedSettingView<K>["devices"][number],
  b: SharedSettingView<K>["devices"][number],
  equal: (left: ShareableSettingValue<K>, right: ShareableSettingValue<K>) => boolean,
): boolean {
  const left = shownValue(view, a);
  const right = shownValue(view, b);
  if (left === undefined || right === undefined) return false;
  if (equal(left, right)) return true;
  return (
    a.state.kind === "shared" &&
    b.state.kind === "shared" &&
    a.stamp !== undefined &&
    b.stamp !== undefined &&
    compareSharingStamps(a.stamp, b.stamp) === 0
  );
}

export function readSharedRowModel<K extends ShareableServerSettingKey>(input: {
  readonly view: SharedSettingView<K>;
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly mode: SharedSettingsMode;
  /** "Set per device" opened the list while every device agrees. */
  readonly open: boolean;
  /** Whether a device knows the setting (older nodes drop unknown keys). */
  readonly knowsSetting?: (config: NodeSettingsConfig) => boolean;
  /** The part of the value this row edits, when it edits one field of a larger setting. */
  readonly compareBy?: (value: ShareableSettingValue<K>) => unknown;
}): SharedRowModel<K> {
  const { view } = input;
  const project = input.compareBy;
  const equal = (left: ShareableSettingValue<K>, right: ShareableSettingValue<K>) =>
    project === undefined
      ? shareableSettingValuesEqual(left, right)
      : shareableSettingValuesEqual(project(left), project(right));
  const rows = view.devices.map((entry): SharedRowDevice<K> => {
    const device = input.devices.find(
      (candidate) => candidate.environmentId === entry.environmentId,
    );
    const config = device?.config ?? null;
    const knowsSetting = config === null || (input.knowsSetting?.(config) ?? true);
    return {
      environmentId: entry.environmentId,
      label: entry.label,
      connected: device?.connected === true,
      value: entry.value,
      state: entry.state,
      knowsSetting,
      editable:
        device !== undefined &&
        device.connected &&
        device.canWrite &&
        config !== null &&
        knowsSetting,
    };
  });
  const deviceCount = rows.length;
  const single = (device: SharedRowDevice<K> | null): SharedRowModel<K> => {
    const own = device?.value;
    return {
      kind: "single",
      device,
      deviceCount,
      others:
        device === null || own === undefined
          ? []
          : rows.flatMap((other) =>
              other.environmentId === device.environmentId ||
              other.value === undefined ||
              equal(other.value, own)
                ? []
                : [{ label: other.label, value: other.value }],
            ),
    };
  };
  if (input.mode.kind === "device") {
    const { environmentId } = input.mode;
    return single(rows.find((row) => row.environmentId === environmentId) ?? null);
  }
  if (rows.length <= 1) return single(rows[0] ?? null);

  const known = view.devices.filter((entry) => shownValue(view, entry) !== undefined);
  const first = known[0];
  const shares = known.some((entry) => entry.state.kind !== "unsupported");
  const allSame =
    first !== undefined && known.every((entry) => sameSetting(view, entry, first, equal));
  const firstValue = first === undefined ? undefined : shownValue(view, first);
  if (allSame && shares && !input.open && firstValue !== undefined) {
    // This app's own device first: its stored value is the one it uses.
    return {
      kind: "same",
      value: firstValue,
      deviceCount,
      queued: rows.filter((row) => row.state.kind === "queued").length,
      syncing: rows.filter((row) => row.state.kind === "syncing").length,
      editable: rows.some((row) => row.editable && row.state.kind !== "unsupported"),
    };
  }
  // "Use … everywhere" offers the shared value while a device still holds it, else the value of
  // the first device (this app's own device comes first).
  const holdingNewest = view.newest !== null && view.devices.some((entry) => entry.holdsNewest);
  const everywhere = allSame
    ? null
    : holdingNewest && view.newest !== null
      ? view.newest.value
      : (firstValue ?? null);
  const differs =
    everywhere === null
      ? 0
      : view.devices.filter((entry) => {
          const value = shownValue(view, entry);
          return value !== undefined && !equal(value, everywhere);
        }).length;
  return {
    kind: "list",
    devices: rows,
    deviceCount,
    differs,
    everywhere,
    everywhereEditable: rows.some((row) => row.editable && row.state.kind !== "unsupported"),
  };
}

/** A person's edit on a shared row. */
export type SharedRowAction<K extends ShareableServerSettingKey> =
  /** The one control of a row whose devices agree. */
  | { readonly kind: "all"; readonly value: ShareableSettingValue<K> }
  /** One device's control: its own value, unless it is the only device. */
  | {
      readonly kind: "device";
      readonly environmentId: EnvironmentId;
      readonly value: ShareableSettingValue<K>;
    }
  | { readonly kind: "reset"; readonly environmentId: EnvironmentId }
  | { readonly kind: "everywhere"; readonly value: ShareableSettingValue<K> };

/**
 * The command an action sends; null when it writes nothing (an unknown device, or no stamp
 * yet). An edit of the only device follows the shared value unless it already keeps its own;
 * an edit of one device among several gives it its own value.
 */
export function buildSharedRowCommand<K extends ShareableServerSettingKey>(input: {
  readonly key: K;
  readonly action: SharedRowAction<K>;
  readonly view: SharedSettingView<K>;
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly cache?: SettingsSharingCache;
  readonly nextStamp: () => SettingsSharingStamp | null;
}): SettingsSharingCommand | null {
  const { key, action, devices } = input;
  if (action.kind === "reset") {
    const device = devices.find((entry) => entry.environmentId === action.environmentId);
    return device === undefined
      ? null
      : resetSettingToShared({
          device,
          devices,
          key,
          ...(input.cache === undefined ? {} : { cache: input.cache }),
        });
  }
  const stamp = input.nextStamp();
  if (stamp === null) return null;
  if (action.kind === "all")
    return writeSharedSetting({ devices, key, value: action.value, stamp });
  if (action.kind === "everywhere")
    return settingEverywhereCommand({ devices, key, value: action.value, stamp });
  const device = devices.find((entry) => entry.environmentId === action.environmentId);
  if (device === undefined) return null;
  const entry = input.view.devices.find((view) => view.environmentId === action.environmentId);
  const followsShared =
    devices.length === 1 &&
    entry !== undefined &&
    entry.state.kind !== "unsupported" &&
    entry.state.kind !== "override";
  return followsShared
    ? writeSharedSetting({ devices: [device], key, value: action.value, stamp })
    : setSettingOverride({ device, key, value: action.value, stamp });
}

/** What an edit could not do, in one line each: devices left out and refused writes. */
export function describeSharedRowOutcome<K extends ShareableServerSettingKey>(input: {
  readonly action: SharedRowAction<K>;
  readonly command: SettingsSharingCommand;
  readonly result: NodeSettingsApplyResult;
  readonly view: SharedSettingView<K>;
}): ReadonlyArray<string> {
  const notes: string[] = [];
  if (input.action.kind === "everywhere") {
    for (const skipped of input.command.skipped) {
      const mode = input.view.devices.find(
        (device) => device.environmentId === skipped.environmentId,
      )?.mode;
      // A shared device catches up on its own; one with its own value cannot be told now.
      if (skipped.reason === "offline" && mode === "override")
        notes.push(`${skipped.label} keeps its own value until it is online.`);
      if (skipped.reason === "read-only" && mode === "override")
        notes.push(`${skipped.label} keeps its own value: only its owner can change it.`);
    }
  }
  for (const failed of input.result.notApplied) {
    if (failed.reason === "failed")
      notes.push(`Couldn't save on ${failed.label}: ${failed.detail ?? "it refused the value"}.`);
    else if (failed.reason === "disconnected")
      notes.push(`${failed.label} went offline; it catches up when it reconnects.`);
  }
  return notes;
}
