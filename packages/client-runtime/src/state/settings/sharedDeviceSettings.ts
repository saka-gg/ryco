/**
 * Shared device settings, client side and pure: which value a shareable setting should have on
 * every device, which devices still need it, what each device's row shows, and the per-device
 * patches of every edit a person can make. Devices are the source of truth
 * (docs/shared-device-settings.md); the runner (`sharedDeviceSettingsRunner`) only replays
 * their newest shared value onto devices holding an older one.
 *
 * Rules every function here keeps:
 * - Ordering is `(at, by)`, ties broken by the lowest environment id, so every client picks the
 *   same winner.
 * - A zero stamp is never written: devices that never had a sharing write keep their value.
 * - A device in `override` mode is never caught up; only a person's own command changes it.
 * - A device without the `settingsSharingVersion` capability, or not sharing the key, is
 *   `unsupported`: never caught up, never queued, never sent `settingsSharing`.
 *
 * Kept off the `state/settings` index, which the app shell imports.
 */
import type { EnvironmentId } from "@ryco/contracts";
import type {
  ServerSettings,
  ServerSettingsPatch,
  SettingsSharingEntry,
  SettingsSharingMode,
  SettingsSharingPatchEntry,
  SettingsSharingStamp,
} from "@ryco/contracts/settings";
import {
  SHAREABLE_SERVER_SETTING_KEYS,
  compareSharingStamps,
  isShareableServerSettingKey,
  isZeroSharingStamp,
  keepsWrittenSettingValue,
  readShareableSettingValue,
  readSharingEntry,
  readWrittenShareableSettingValue,
  recordWrittenSettingValues,
  settingSharedAtVersion,
  shareableSettingValuePatch,
  shareableSettingValuesEqual,
  type ShareableServerSettingKey,
  type ShareableSettingValue,
} from "@ryco/shared/settingsSharing";

import type { SettingsSharingClock } from "./settingsSharingClock.ts";
import type { NodeSettingsConfig, NodeSettingsTarget } from "./nodeSettingsTargets.ts";

/** A device as the sharing functions read it: the write itself is not needed. */
export type SharingDevice = Pick<
  NodeSettingsTarget,
  "environmentId" | "label" | "config" | "connected" | "canWrite"
>;

// ── Capability ──────────────────────────────────────────────────

/**
 * The keys a node shares, from its own capability's sharing version; null for a node on an
 * older Ryco (its `settingsSharing` decodes to the empty default, so the settings cannot tell).
 */
export function readNodeSharedSettingKeys(
  config: NodeSettingsConfig | null | undefined,
): ReadonlySet<ShareableServerSettingKey> | null {
  const version = config?.environment?.capabilities?.settingsSharingVersion;
  if (version === undefined) return null;
  return new Set(
    SHAREABLE_SERVER_SETTING_KEYS.filter((key) => settingSharedAtVersion(version, key)),
  );
}

/** Whether a node shares a key: its sharing version covers it and this build knows it. */
export function nodeSharesSetting(
  config: NodeSettingsConfig | null | undefined,
  key: ShareableServerSettingKey,
): boolean {
  return settingSharedAtVersion(config?.environment?.capabilities?.settingsSharingVersion, key);
}

// ── Newest shared value ─────────────────────────────────────────

/** Where the newest shared value of a key came from. */
export interface SharedSettingNewest<K extends ShareableServerSettingKey> {
  readonly stamp: SettingsSharingStamp;
  readonly value: ShareableSettingValue<K>;
  /** The device holding it, or the device the client's cache learned it from. */
  readonly source: EnvironmentId;
  readonly fromCache: boolean;
}

export interface SettingsSharingCacheEntry<K extends ShareableServerSettingKey> {
  readonly stamp: SettingsSharingStamp;
  readonly value: ShareableSettingValue<K>;
  readonly source: EnvironmentId;
}

/**
 * The newest shared value per key this client has seen, so an offline device catches up even
 * when every device holding the value is offline too. A hint only: an entry is used only while
 * its source device is still among the known devices (another account's cache never applies),
 * and a device holding a newer stamp always wins.
 */
export type SettingsSharingCache = {
  readonly [K in ShareableServerSettingKey]?: SettingsSharingCacheEntry<K>;
};

function deviceEntry(device: SharingDevice, key: ShareableServerSettingKey) {
  return device.config === null
    ? null
    : readSharingEntry(device.config.settings.settingsSharing, key);
}

/**
 * The newest shared value of a key: the highest non-zero stamp on any known device in `shared`
 * mode that shares it (online or not, from its last known config), else the cache's when newer.
 * Null while no sharing write ever happened (all stamps zero), so nothing is caught up then.
 */
export function readNewestSharedSetting<K extends ShareableServerSettingKey>(
  devices: ReadonlyArray<SharingDevice>,
  key: K,
  cache?: SettingsSharingCache,
): SharedSettingNewest<K> | null {
  let newest: SharedSettingNewest<K> | null = null;
  for (const device of devices) {
    if (device.config === null || !nodeSharesSetting(device.config, key)) continue;
    const entry = readSharingEntry(device.config.settings.settingsSharing, key);
    if (entry.mode !== "shared" || isZeroSharingStamp(entry.stamp)) continue;
    const order = newest === null ? 1 : compareSharingStamps(entry.stamp, newest.stamp);
    if (order < 0 || (order === 0 && newest !== null && device.environmentId >= newest.source))
      continue;
    newest = {
      stamp: entry.stamp,
      // A path as written (`~/w`), not as this device normalized it: other devices normalize it.
      value: readWrittenShareableSettingValue(device.config.settings, key),
      source: device.environmentId,
      fromCache: false,
    };
  }
  const cached = cache?.[key] as SettingsSharingCacheEntry<K> | undefined;
  if (
    cached !== undefined &&
    !isZeroSharingStamp(cached.stamp) &&
    devices.some((device) => device.environmentId === cached.source) &&
    (newest === null || compareSharingStamps(cached.stamp, newest.stamp) > 0)
  ) {
    newest = { ...cached, fromCache: true };
  }
  return newest;
}

/** The cache with every newer device value recorded; the same object when nothing changed. */
export function mergeSettingsSharingCache(
  cache: SettingsSharingCache,
  devices: ReadonlyArray<SharingDevice>,
): SettingsSharingCache {
  let next: Record<string, unknown> | null = null;
  for (const key of SHAREABLE_SERVER_SETTING_KEYS) {
    const newest = readNewestSharedSetting(devices, key);
    if (newest === null) continue;
    const cached = cache[key];
    if (cached !== undefined && compareSharingStamps(cached.stamp, newest.stamp) >= 0) continue;
    next ??= { ...cache };
    next[key] = { stamp: newest.stamp, value: newest.value, source: newest.source };
  }
  return (next as SettingsSharingCache | null) ?? cache;
}

/** Records a value this client wrote, when newer than the cache's. */
export function recordSettingsSharingCache<K extends ShareableServerSettingKey>(
  cache: SettingsSharingCache,
  key: K,
  entry: SettingsSharingCacheEntry<K>,
): SettingsSharingCache {
  const cached = cache[key];
  if (cached !== undefined && compareSharingStamps(cached.stamp, entry.stamp) >= 0) return cache;
  return { ...cache, [key]: entry };
}

function isStamp(value: unknown): value is SettingsSharingStamp {
  if (typeof value !== "object" || value === null) return false;
  const { at, by } = value as { readonly at?: unknown; readonly by?: unknown };
  return typeof at === "number" && Number.isSafeInteger(at) && at > 0 && typeof by === "string";
}

/**
 * A persisted cache read back leniently: malformed entries and unknown keys are dropped (values
 * are checked by the device that receives them).
 */
export function decodeSettingsSharingCache(raw: unknown): SettingsSharingCache {
  if (typeof raw !== "object" || raw === null) return {};
  const cache: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!isShareableServerSettingKey(key) || typeof entry !== "object" || entry === null) continue;
    const { stamp, value, source } = entry as Record<string, unknown>;
    if (!isStamp(stamp) || typeof source !== "string" || value === undefined) continue;
    cache[key] = { stamp, value, source };
  }
  return cache as SettingsSharingCache;
}

/** Observes every stamp the devices and the cache hold, then issues a fresh stamp. */
export function nextSettingsSharingStamp(
  clock: SettingsSharingClock,
  devices: ReadonlyArray<SharingDevice>,
  cache?: SettingsSharingCache,
): SettingsSharingStamp {
  observeSettingsSharingStamps(clock, devices, cache);
  return clock.next();
}

export function observeSettingsSharingStamps(
  clock: SettingsSharingClock,
  devices: ReadonlyArray<SharingDevice>,
  cache?: SettingsSharingCache,
): void {
  for (const device of devices) {
    for (const entry of Object.values(device.config?.settings.settingsSharing ?? {}))
      clock.observe(entry.stamp);
  }
  for (const entry of Object.values(cache ?? {})) if (entry) clock.observe(entry.stamp);
}

// ── Catch-up attempts (runner bookkeeping, also shown on rows) ──

/** A catch-up this client sent to one device for one key. */
export interface SettingsSharingAttempt {
  /** The newest stamp it carried. */
  readonly stamp: SettingsSharingStamp;
  /** `written`: sent, the device's config does not show it yet; `failed`: the device refused. */
  readonly state: "written" | "failed";
  /** The device's own message, for a failed write. */
  readonly reason?: string;
  /** How many times it was sent for this stamp. */
  readonly tries: number;
  /** Not sent again before this time (ms). */
  readonly retryAt: number;
}

export type SettingsSharingAttempts = ReadonlyMap<
  EnvironmentId,
  ReadonlyMap<ShareableServerSettingKey, SettingsSharingAttempt>
>;

function readAttempt(
  attempts: SettingsSharingAttempts | undefined,
  environmentId: EnvironmentId,
  key: ShareableServerSettingKey,
  stamp: SettingsSharingStamp,
): SettingsSharingAttempt | undefined {
  const attempt = attempts?.get(environmentId)?.get(key);
  return attempt !== undefined && compareSharingStamps(attempt.stamp, stamp) === 0
    ? attempt
    : undefined;
}

// ── Planner ─────────────────────────────────────────────────────

/** One key of a catch-up write: its own patch, so a refused batch can be split per key. */
export interface SettingsSharingWritePart {
  readonly key: ShareableServerSettingKey;
  readonly stamp: SettingsSharingStamp;
  readonly patch: ServerSettingsPatch;
}

/** All of one device's catch-up in one patch (one atomic settings write on the device). */
export interface SettingsSharingCatchUpWrite {
  readonly environmentId: EnvironmentId;
  readonly patch: ServerSettingsPatch;
  readonly parts: ReadonlyArray<SettingsSharingWritePart>;
}

function sharingPatch(
  key: ShareableServerSettingKey,
  value: unknown,
  settings: ServerSettings,
  entry: SettingsSharingPatchEntry | null,
): ServerSettingsPatch {
  const valuePatch =
    value === undefined
      ? {}
      : shareableSettingValuePatch(key, value as ShareableSettingValue<typeof key>, settings);
  // A path's entry carries it as written, as the node records it.
  return recordWrittenSettingValues({ ...valuePatch, settingsSharing: { [key]: entry } });
}

/** Joins per-key patches of one device; their value fields never overlap. */
export function mergeSettingsSharingPatches(
  patches: ReadonlyArray<ServerSettingsPatch>,
): ServerSettingsPatch {
  let merged: ServerSettingsPatch = {};
  for (const patch of patches) {
    merged = {
      ...merged,
      ...patch,
      ...(patch.settingsSharing === undefined && merged.settingsSharing === undefined
        ? {}
        : { settingsSharing: { ...merged.settingsSharing, ...patch.settingsSharing } }),
    };
  }
  return merged;
}

/**
 * The catch-up writes that bring every connected, writable device in `shared` mode holding an
 * older stamp to the newest shared value, one patch per device, sorted by environment id. Each
 * key is a guarded catch-up (`onlyIfOlderShared`), so a device that turned to an override or got
 * a newer value meanwhile drops it, and two clients sending the same catch-up change nothing
 * twice. A key with an attempt for the same stamp is left out until `attempt.retryAt`.
 */
export function planSettingsSharingCatchUp(input: {
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly cache?: SettingsSharingCache;
  readonly attempts?: SettingsSharingAttempts;
  /** Now in ms, for attempt retries. */
  readonly now: number;
}): ReadonlyArray<SettingsSharingCatchUpWrite> {
  const parts = new Map<EnvironmentId, SettingsSharingWritePart[]>();
  for (const key of SHAREABLE_SERVER_SETTING_KEYS) {
    const newest = readNewestSharedSetting(input.devices, key, input.cache);
    if (newest === null) continue;
    for (const device of input.devices) {
      const config = device.config;
      if (config === null || !device.connected || !device.canWrite) continue;
      if (!nodeSharesSetting(config, key)) continue;
      const entry = readSharingEntry(config.settings.settingsSharing, key);
      if (entry.mode !== "shared" || compareSharingStamps(entry.stamp, newest.stamp) >= 0) continue;
      const attempt = readAttempt(input.attempts, device.environmentId, key, newest.stamp);
      if (attempt !== undefined && input.now < attempt.retryAt) continue;
      const list = parts.get(device.environmentId) ?? [];
      list.push({
        key,
        stamp: newest.stamp,
        patch: sharingPatch(key, newest.value, config.settings, {
          mode: "shared",
          stamp: newest.stamp,
          onlyIfOlderShared: true,
        }),
      });
      parts.set(device.environmentId, list);
    }
  }
  return [...parts]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([environmentId, list]) => ({
      environmentId,
      patch: mergeSettingsSharingPatches(list.map((part) => part.patch)),
      parts: list,
    }));
}

// ── View model ──────────────────────────────────────────────────

/** What one device's row shows for a shareable setting. */
export type SharedSettingDeviceState =
  /** Shared and holding the newest shared value (or no sharing write happened yet). */
  | { readonly kind: "shared" }
  /** Keeps its own value. */
  | { readonly kind: "override" }
  /** Shared, older, connected and writable: the runner is bringing it up to date. */
  | { readonly kind: "syncing" }
  /** Shared and older, and this client cannot write it now; it catches up later. */
  | { readonly kind: "queued"; readonly reason: "offline" | "read-only" }
  /** On an older Ryco (or does not share this key): "Update to share settings". */
  | { readonly kind: "unsupported" }
  /** No config known yet. */
  | { readonly kind: "unknown" }
  /** The device refused the newest shared value. */
  | { readonly kind: "couldNotApply"; readonly reason: string };

export interface SharedSettingDeviceView<K extends ShareableServerSettingKey> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The device's value from its last known config; undefined when none is known. */
  readonly value: ShareableSettingValue<K> | undefined;
  /**
   * The value as written by the write that set it: for a path, before the device normalized it
   * (`~/w` where `value` is `/Users/me/w`). Equals `value` for other keys and whenever the
   * device does not know it. This is what the device shares and what rows show and compare.
   */
  readonly written: ShareableSettingValue<K> | undefined;
  /** Whether `written` is the entry's own record rather than `value` standing in for it. */
  readonly writtenRecorded: boolean;
  readonly mode: SettingsSharingMode | undefined;
  readonly stamp: SettingsSharingStamp | undefined;
  /** Its value equals the newest shared value (false while there is none). */
  readonly holdsNewest: boolean;
  readonly state: SharedSettingDeviceState;
}

export type SharedSettingAgreement<K extends ShareableServerSettingKey> =
  | { readonly kind: "none" }
  | { readonly kind: "same"; readonly value: ShareableSettingValue<K> }
  | { readonly kind: "differs" };

export interface SharedSettingView<K extends ShareableServerSettingKey> {
  readonly key: K;
  readonly newest: SharedSettingNewest<K> | null;
  /** Over every device with a known config (offline and older ones included). */
  readonly agreement: SharedSettingAgreement<K>;
  readonly devices: ReadonlyArray<SharedSettingDeviceView<K>>;
}

function deviceState(
  device: SharingDevice,
  key: ShareableServerSettingKey,
  entry: SettingsSharingEntry | null,
  newest: SharedSettingNewest<ShareableServerSettingKey> | null,
  attempts: SettingsSharingAttempts | undefined,
): SharedSettingDeviceState {
  if (device.config === null || entry === null) return { kind: "unknown" };
  if (!nodeSharesSetting(device.config, key)) return { kind: "unsupported" };
  if (entry.mode === "override") return { kind: "override" };
  if (newest === null || compareSharingStamps(entry.stamp, newest.stamp) >= 0)
    return { kind: "shared" };
  const attempt = readAttempt(attempts, device.environmentId, key, newest.stamp);
  if (attempt?.state === "failed")
    return { kind: "couldNotApply", reason: attempt.reason ?? "The device refused the value." };
  if (!device.connected) return { kind: "queued", reason: "offline" };
  if (!device.canWrite) return { kind: "queued", reason: "read-only" };
  return { kind: "syncing" };
}

/** One shareable setting across every known device, for its row. */
export function readSharedSettingView<K extends ShareableServerSettingKey>(input: {
  readonly key: K;
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly cache?: SettingsSharingCache;
  readonly attempts?: SettingsSharingAttempts;
}): SharedSettingView<K> {
  const { key } = input;
  const newest = readNewestSharedSetting(input.devices, key, input.cache);
  const devices = input.devices.map((device): SharedSettingDeviceView<K> => {
    const entry = deviceEntry(device, key);
    const value =
      device.config === null ? undefined : readShareableSettingValue(device.config.settings, key);
    const shares = device.config !== null && nodeSharesSetting(device.config, key);
    const recorded =
      shares && keepsWrittenSettingValue(key) && entry !== null && entry.written !== undefined;
    const written =
      recorded && entry?.written !== undefined ? (entry.written as typeof value) : value;
    return {
      environmentId: device.environmentId,
      label: device.label,
      value,
      written,
      writtenRecorded: recorded,
      mode: shares ? entry?.mode : undefined,
      stamp: shares && entry !== null && !isZeroSharingStamp(entry.stamp) ? entry.stamp : undefined,
      holdsNewest:
        newest !== null &&
        written !== undefined &&
        shareableSettingValuesEqual(written, newest.value),
      state: deviceState(device, key, entry, newest, input.attempts),
    };
  });
  const known = devices.filter((device) => device.written !== undefined);
  const first = known[0];
  const agreement: SharedSettingAgreement<K> =
    first?.written === undefined
      ? { kind: "none" }
      : known.every((device) => sharedDeviceValuesAgree(device, first))
        ? { kind: "same", value: first.written }
        : { kind: "differs" };
  return { key, newest, agreement, devices };
}

/**
 * Whether two devices hold the same value of a shared setting: equal values as written, or, for
 * two devices shared on the same write, the stamp's word for it. Each device stores a path the
 * way it normalized it; when both entries record the value as written that is compared, and
 * entries from before that record (no `written`) agree by their equal stamp alone.
 */
export function sharedDeviceValuesAgree<K extends ShareableServerSettingKey>(
  a: SharedSettingDeviceView<K>,
  b: SharedSettingDeviceView<K>,
  equal: (
    left: ShareableSettingValue<K>,
    right: ShareableSettingValue<K>,
  ) => boolean = shareableSettingValuesEqual,
  shown: (device: SharedSettingDeviceView<K>) => ShareableSettingValue<K> | undefined = (device) =>
    device.written,
): boolean {
  const left = shown(a);
  const right = shown(b);
  if (left === undefined || right === undefined) return false;
  if (equal(left, right)) return true;
  if (a.writtenRecorded && b.writtenRecorded) return false;
  return (
    a.mode === "shared" &&
    b.mode === "shared" &&
    a.stamp !== undefined &&
    b.stamp !== undefined &&
    compareSharingStamps(a.stamp, b.stamp) === 0
  );
}

/** Every shareable setting across every known device (the All devices compare table). */
export function readSharedSettingViews(input: {
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly cache?: SettingsSharingCache;
  readonly attempts?: SettingsSharingAttempts;
}): ReadonlyArray<SharedSettingView<ShareableServerSettingKey>> {
  return SHAREABLE_SERVER_SETTING_KEYS.map((key) => readSharedSettingView({ ...input, key }));
}

/** The keys where one device differs: its overrides and the keys it has not caught up on. */
export function readDeviceSharingDifferences(
  views: ReadonlyArray<SharedSettingView<ShareableServerSettingKey>>,
  environmentId: EnvironmentId,
): ReadonlyArray<{
  readonly key: ShareableServerSettingKey;
  readonly state: SharedSettingDeviceState;
}> {
  return views.flatMap((view) => {
    const device = view.devices.find((entry) => entry.environmentId === environmentId);
    if (device === undefined) return [];
    const { kind } = device.state;
    return kind === "override" ||
      kind === "queued" ||
      kind === "couldNotApply" ||
      kind === "syncing"
      ? [{ key: view.key, state: device.state }]
      : [];
  });
}

// ── Commands ────────────────────────────────────────────────────

export type SettingsSharingSkipReason =
  | "offline"
  | "read-only"
  | "override"
  | "unsupported"
  | "unknown";

/** A person's edit as per-device patches; skipped devices say why. */
export interface SettingsSharingCommand {
  readonly key: ShareableServerSettingKey;
  readonly writes: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly patch: ServerSettingsPatch;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly reason: SettingsSharingSkipReason;
  }>;
  /** The shared value and stamp the edit sets, for the client's cache; null for none. */
  readonly shared: { readonly stamp: SettingsSharingStamp; readonly value: unknown } | null;
}

function writeBlocker(device: SharingDevice): SettingsSharingSkipReason | null {
  if (device.config === null) return "unknown";
  if (!device.connected) return "offline";
  return device.canWrite ? null : "read-only";
}

function buildCommand(
  key: ShareableServerSettingKey,
  devices: ReadonlyArray<SharingDevice>,
  shared: SettingsSharingCommand["shared"],
  patchFor: (
    device: SharingDevice,
    settings: ServerSettings,
  ) => ServerSettingsPatch | SettingsSharingSkipReason,
): SettingsSharingCommand {
  const writes: Array<SettingsSharingCommand["writes"][number]> = [];
  const skipped: Array<SettingsSharingCommand["skipped"][number]> = [];
  for (const device of devices) {
    const blocker = writeBlocker(device);
    const result =
      blocker ?? (device.config === null ? "unknown" : patchFor(device, device.config.settings));
    if (typeof result === "string")
      skipped.push({ environmentId: device.environmentId, label: device.label, reason: result });
    else writes.push({ environmentId: device.environmentId, patch: result });
  }
  return { key, writes, skipped, shared };
}

/**
 * Changes a shared row: the value with a fresh stamp to every device in `shared` mode this
 * client can write now. Overrides keep their value; offline devices catch up later (queued);
 * unsupported devices are left alone. Each write is guarded like a catch-up, so a device that
 * turned to an override meanwhile keeps it.
 */
export function writeSharedSetting<K extends ShareableServerSettingKey>(input: {
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly key: K;
  readonly value: ShareableSettingValue<K>;
  /** From {@link nextSettingsSharingStamp}. */
  readonly stamp: SettingsSharingStamp;
}): SettingsSharingCommand {
  const { key, value, stamp } = input;
  return buildCommand(key, input.devices, { stamp, value }, (device, settings) => {
    if (!nodeSharesSetting(device.config, key)) return "unsupported";
    if (readSharingEntry(settings.settingsSharing, key).mode === "override") return "override";
    return sharingPatch(key, value, settings, { mode: "shared", stamp, onlyIfOlderShared: true });
  });
}

/**
 * Sets a value on one device only (`mode: "override"`); without `value` the device keeps its
 * own value and stops following the shared one. A device on an older Ryco gets a plain edit of
 * the value, without `settingsSharing`.
 */
export function setSettingOverride<K extends ShareableServerSettingKey>(input: {
  readonly device: SharingDevice;
  readonly key: K;
  readonly value?: ShareableSettingValue<K>;
  readonly stamp: SettingsSharingStamp;
}): SettingsSharingCommand {
  const { key, value, stamp } = input;
  return buildCommand(key, [input.device], null, (device, settings) => {
    if (!nodeSharesSetting(device.config, key))
      return value === undefined ? "unsupported" : shareableSettingValuePatch(key, value, settings);
    return sharingPatch(key, value, settings, { mode: "override", stamp });
  });
}

/**
 * A person's edit of one device, as the settings show one device at a time: that device keeps
 * its own value (`setSettingOverride`), unless it is the only known device and still follows
 * the shared value, which it then keeps following (`writeSharedSetting`). A device on an older
 * Ryco gets a plain edit. Null for a device this client does not know.
 */
export function editDeviceSetting<K extends ShareableServerSettingKey>(input: {
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly environmentId: EnvironmentId;
  readonly key: K;
  readonly value: ShareableSettingValue<K>;
  readonly stamp: SettingsSharingStamp;
}): SettingsSharingCommand | null {
  const { devices, key, value, stamp } = input;
  const device = devices.find((entry) => entry.environmentId === input.environmentId);
  if (device === undefined) return null;
  const entry = deviceEntry(device, key);
  const followsShared =
    devices.length === 1 &&
    device.config !== null &&
    nodeSharesSetting(device.config, key) &&
    entry?.mode !== "override";
  return followsShared
    ? writeSharedSetting({ devices: [device], key, value, stamp })
    : setSettingOverride({ device, key, value, stamp });
}

/**
 * One line on what a person's command did across devices: where it landed, which devices take
 * it when they reconnect, and which it left alone and why. Empty parts are left out.
 */
export function describeSettingsSharingResult(
  command: SettingsSharingCommand,
  result: {
    readonly applied: ReadonlyArray<{ readonly label: string }>;
    readonly notApplied: ReadonlyArray<{
      readonly label: string;
      readonly reason: string;
      readonly detail?: string;
    }>;
  },
): string {
  const names = (labels: ReadonlyArray<string>) => labels.join(", ");
  const parts: string[] = [];
  parts.push(
    result.applied.length === 0
      ? "No device was changed now."
      : `Saved on ${names(result.applied.map((device) => device.label))}.`,
  );
  const skipped = (reason: SettingsSharingSkipReason) =>
    command.skipped.filter((device) => device.reason === reason).map((device) => device.label);
  const later = [
    ...(command.shared === null ? [] : skipped("offline")),
    ...result.notApplied
      .filter((device) => device.reason === "disconnected")
      .map((device) => device.label),
  ];
  if (later.length > 0) parts.push(`Applies when they reconnect: ${names(later)}.`);
  if (command.shared === null && skipped("offline").length > 0)
    parts.push(`Offline: ${names(skipped("offline"))}.`);
  if (skipped("override").length > 0)
    parts.push(`Keep their own value: ${names(skipped("override"))}.`);
  if (skipped("read-only").length > 0)
    parts.push(`Only an owner can change: ${names(skipped("read-only"))}.`);
  if (skipped("unsupported").length > 0)
    parts.push(`Need an update to share settings: ${names(skipped("unsupported"))}.`);
  const failed = result.notApplied.filter((device) => device.reason === "failed");
  if (failed.length > 0)
    parts.push(
      `Not saved on ${failed
        .map((device) => (device.detail ? `${device.label} (${device.detail})` : device.label))
        .join(", ")}.`,
    );
  return parts.join(" ");
}

/**
 * Puts one device back on the shared value: the newest shared value and its stamp (from any
 * other device or the cache). While no sharing write happened yet, the device's entry is
 * removed and it keeps its value (shared with the zero stamp).
 */
export function resetSettingToShared<K extends ShareableServerSettingKey>(input: {
  readonly device: SharingDevice;
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly key: K;
  readonly cache?: SettingsSharingCache;
}): SettingsSharingCommand {
  const { key } = input;
  const newest = readNewestSharedSetting(input.devices, key, input.cache);
  return buildCommand(key, [input.device], null, (device, settings) => {
    if (!nodeSharesSetting(device.config, key)) return "unsupported";
    return newest === null
      ? { settingsSharing: { [key]: null } }
      : sharingPatch(key, newest.value, settings, { mode: "shared", stamp: newest.stamp });
  });
}

/**
 * "Use X everywhere": one shared write to every device this client can write now, overrides
 * included (they turn shared). An offline device keeps its mode: a shared one catches up, an
 * override stays one (listed as skipped `offline`).
 */
export function useSettingEverywhere<K extends ShareableServerSettingKey>(input: {
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly key: K;
  readonly value: ShareableSettingValue<K>;
  readonly stamp: SettingsSharingStamp;
}): SettingsSharingCommand {
  const { key, value, stamp } = input;
  return buildCommand(key, input.devices, { stamp, value }, (device, settings) =>
    nodeSharesSetting(device.config, key)
      ? sharingPatch(key, value, settings, { mode: "shared", stamp })
      : "unsupported",
  );
}
