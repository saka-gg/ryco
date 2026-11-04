import type { EnvironmentId } from "@ryco/contracts";
import type {
  NodeSettingsApplyResult,
  NodeSettingsConfig,
} from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import {
  editDeviceSetting,
  resetSettingToShared,
  settingsSharingCommandCatchUps,
  sharedDeviceValuesAgree,
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
  /**
   * Its own value from its last known config, as written (a shared path reads `~/w`, not the
   * device's `/Users/me/w`); undefined while none is known.
   */
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
  /**
   * Every device that follows the shared value holds (or is catching up to) the same value:
   * one control, which writes all of them. A device keeping its own value, or one the device
   * refused, shows the list instead.
   */
  | {
      readonly kind: "same";
      readonly value: ShareableSettingValue<K>;
      /** The devices with a known value, all on it. */
      readonly deviceCount: number;
      /** Offline devices that take it when they reconnect. */
      readonly queued: number;
      /** Devices this reader may not change, which take it once an owner opens them. */
      readonly waitingForOwner: number;
      readonly syncing: number;
      /** Devices on an older Ryco, which the control does not change. */
      readonly needUpdate: ReadonlyArray<string>;
      /** Devices whose settings are not known yet, left out of the count. */
      readonly notLoaded: number;
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
  return device.written;
}

/** Whether two devices agree on what they show (`sharedDeviceValuesAgree`). */
function sameSetting<K extends ShareableServerSettingKey>(
  view: SharedSettingView<K>,
  a: SharedSettingView<K>["devices"][number],
  b: SharedSettingView<K>["devices"][number],
  equal: (left: ShareableSettingValue<K>, right: ShareableSettingValue<K>) => boolean,
): boolean {
  return sharedDeviceValuesAgree(a, b, equal, (device) => shownValue(view, device));
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
      value: entry.written,
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
  // One control writes only devices following the shared value: a device keeping its own
  // value (even an equal one), one with a value from before sharing, or one that refused the
  // value shows in the list, with its mark.
  const oneControlWritesAll = known.every(
    (entry) =>
      entry.state.kind !== "override" &&
      entry.state.kind !== "differs" &&
      entry.state.kind !== "couldNotApply",
  );
  if (allSame && shares && oneControlWritesAll && !input.open && firstValue !== undefined) {
    // This app's own device first: its stored value is the one it uses.
    const count = (kind: SharedSettingDeviceState["kind"], reason?: string) =>
      rows.filter(
        (row) =>
          row.state.kind === kind &&
          (reason === undefined || (row.state.kind === "queued" && row.state.reason === reason)),
      ).length;
    return {
      kind: "same",
      value: firstValue,
      deviceCount: known.length,
      queued: count("queued", "offline"),
      waitingForOwner: count("queued", "read-only"),
      syncing: count("syncing"),
      needUpdate: rows.flatMap((row) =>
        row.state.kind === "unsupported" && row.value !== undefined ? [row.label] : [],
      ),
      notLoaded: rows.filter((row) => row.value === undefined).length,
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
  /**
   * For a row that edits one field of a larger value: puts the edited field of `edited` into a
   * device's own value. Its one control and "Use … everywhere" then change only that field on
   * each device, never the fields the row does not show.
   */
  readonly applyField?: (
    current: ShareableSettingValue<K>,
    edited: ShareableSettingValue<K>,
  ) => ShareableSettingValue<K>;
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
  const { applyField } = input;
  const edited = action.kind === "all" || action.kind === "everywhere" ? action.value : null;
  const field =
    applyField === undefined || edited === null
      ? {}
      : { valueFor: (current: ShareableSettingValue<K>) => applyField(current, edited) };
  if (action.kind === "all")
    return writeSharedSetting({ devices, key, value: action.value, stamp, ...field });
  if (action.kind === "everywhere")
    return settingEverywhereCommand({ devices, key, value: action.value, stamp, ...field });
  return editDeviceSetting({
    devices,
    environmentId: action.environmentId,
    key,
    value: action.value,
    stamp,
  });
}

function skippedNote(skipped: SettingsSharingCommand["skipped"][number]): string {
  switch (skipped.reason) {
    case "offline":
      return `Not saved: ${skipped.label} is offline.`;
    case "read-only":
      return `Not saved: only the owner of ${skipped.label} can change it.`;
    case "unsupported":
      return `Not saved: update ${skipped.label} to change this setting.`;
    case "unknown":
      return `Not saved: ${skipped.label}'s settings have not loaded yet.`;
    case "override":
      return `${skipped.label} keeps its own value.`;
  }
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
  if (input.action.kind === "device") {
    // A one-device edit the device could not take now: nothing is kept for it.
    for (const skipped of input.command.skipped) notes.push(skippedNote(skipped));
  }
  const catchUps = new Set(settingsSharingCommandCatchUps(input.command, input.result));
  for (const failed of input.result.notApplied) {
    if (failed.reason === "failed")
      notes.push(`Couldn't save on ${failed.label}: ${failed.detail ?? "it refused the value"}.`);
    else if (failed.reason === "disconnected")
      notes.push(
        catchUps.has(failed.environmentId)
          ? `${failed.label} went offline; it catches up when it reconnects.`
          : `${failed.label} went offline before the change was saved there.`,
      );
    else if (failed.reason === "read-only")
      notes.push(`Not saved on ${failed.label}: only its owner can change it.`);
    else notes.push(`Not saved on ${failed.label}: update it to change this setting.`);
  }
  return notes;
}

/**
 * The device shared rows use on "All devices" when the device the page shows cannot be used:
 * any device this client may write now (connected, a config, writable; a hosted grant is
 * already false while its role snapshot is stale), this app's own first. Its rows only edit
 * through the shared commands, which write every device they can reach; offline devices catch
 * up. Null when none can be written now, so the rows wait as before.
 */
export function pickSharedRowsDevice(
  devices: ReadonlyArray<
    Pick<SharingDevice, "environmentId" | "config" | "connected" | "canWrite">
  >,
  preferred: EnvironmentId | null,
): EnvironmentId | null {
  const writable = devices.filter(
    (device) => device.connected && device.canWrite && device.config !== null,
  );
  return (
    writable.find((device) => device.environmentId === preferred)?.environmentId ??
    writable[0]?.environmentId ??
    null
  );
}
