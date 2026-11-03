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
 * - A zero stamp is never written, and a device that never took a shared write (its key at the
 *   zero stamp) is never caught up to a value unlike its own: it shows `differs` until a person
 *   chooses (`resolveDeviceDifferences`). Only a person's edit that meant it (`covers` in this
 *   client's cache: it was offline when the edit went out) or an equal value carries it along.
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
import type {
  NodeSettingsApplyResult,
  NodeSettingsConfig,
  NodeSettingsTarget,
} from "./nodeSettingsTargets.ts";

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
  /** A device of this namespace: the entry applies only while it is among the known devices. */
  readonly source: EnvironmentId;
  /**
   * Devices this client's own edit was meant for that could not take it then (offline, or gone
   * mid-write) while following the shared value: they take it when they reconnect, even one
   * that never had a shared write. Kept only with this stamp.
   */
  readonly covers?: ReadonlyArray<EnvironmentId>;
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

/**
 * Records a value this client wrote, when newer than the cache's. For the same stamp (a pass
 * already learned it from a device that took the write) it adds the devices the edit covers.
 */
export function recordSettingsSharingCache<K extends ShareableServerSettingKey>(
  cache: SettingsSharingCache,
  key: K,
  entry: SettingsSharingCacheEntry<K>,
): SettingsSharingCache {
  const cached = cache[key];
  if (cached !== undefined) {
    const order = compareSharingStamps(cached.stamp, entry.stamp);
    if (order > 0) return cache;
    if (order === 0) {
      const covers = [...new Set([...(cached.covers ?? []), ...(entry.covers ?? [])])];
      if (covers.length === (cached.covers?.length ?? 0)) return cache;
      return { ...cache, [key]: { ...cached, covers } };
    }
  }
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
    const { stamp, value, source, covers } = entry as Record<string, unknown>;
    if (!isStamp(stamp) || typeof source !== "string" || value === undefined) continue;
    const covered = Array.isArray(covers)
      ? covers.filter((id): id is string => typeof id === "string")
      : [];
    cache[key] = { stamp, value, source, ...(covered.length > 0 ? { covers: covered } : {}) };
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

// ── Devices that never shared ───────────────────────────────────

/**
 * Whether a device keeps a value from before sharing that the newest shared value would
 * replace: it shares the key in `shared` mode at the zero stamp (no shared write ever reached
 * it: a device added later, or a node updated to share settings), and its value differs from
 * the newest. Such a device is never caught up on its own; it shows `differs` until a person
 * picks the shared value or keeps its own. Not when this client's own edit covered it (it was
 * offline when the person's edit went out).
 */
function keepsValueFromBeforeSharing(
  device: SharingDevice,
  key: ShareableServerSettingKey,
  entry: SettingsSharingEntry | null,
  newest: SharedSettingNewest<ShareableServerSettingKey> | null,
  cache: SettingsSharingCache | undefined,
): boolean {
  if (device.config === null || entry === null || newest === null) return false;
  if (entry.mode !== "shared" || !isZeroSharingStamp(entry.stamp)) return false;
  if (!nodeSharesSetting(device.config, key)) return false;
  const cached = cache?.[key];
  if (
    cached !== undefined &&
    compareSharingStamps(cached.stamp, newest.stamp) === 0 &&
    cached.covers?.includes(device.environmentId) === true
  )
    return false;
  return !shareableSettingValuesEqual(
    readWrittenShareableSettingValue(device.config.settings, key),
    newest.value,
  );
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
 * older stamp to the newest shared value, one patch per device, sorted by environment id. A
 * device that never took a shared write and holds another value is left alone
 * (`keepsValueFromBeforeSharing`). Each
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
      // A value from before sharing waits for a person; an equal one just takes the stamp.
      if (keepsValueFromBeforeSharing(device, key, entry, newest, input.cache)) continue;
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
  | { readonly kind: "couldNotApply"; readonly reason: string }
  /**
   * Never took a shared write and keeps a value unlike the shared one (a device added later, a
   * node updated to share settings): left alone until a person uses the shared value or keeps
   * its own (`resolveDeviceDifferences`).
   */
  | { readonly kind: "differs" };

export interface SharedSettingDeviceView<K extends ShareableServerSettingKey> {
  readonly key: K;
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
  cache: SettingsSharingCache | undefined,
): SharedSettingDeviceState {
  if (device.config === null || entry === null) return { kind: "unknown" };
  if (!nodeSharesSetting(device.config, key)) return { kind: "unsupported" };
  if (entry.mode === "override") return { kind: "override" };
  if (newest === null || compareSharingStamps(entry.stamp, newest.stamp) >= 0)
    return { kind: "shared" };
  if (keepsValueFromBeforeSharing(device, key, entry, newest, cache)) return { kind: "differs" };
  // Same value at the zero stamp: only the stamp is still to come, nothing a person would see.
  if (
    isZeroSharingStamp(entry.stamp) &&
    shareableSettingValuesEqual(
      readWrittenShareableSettingValue(device.config.settings, key),
      newest.value,
    )
  )
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
      key,
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
      state: deviceState(device, key, entry, newest, input.attempts, input.cache),
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
 * two devices shared on the same write of a path, the stamp's word for it. Each device stores a
 * path the way it normalized it; when both entries record the value as written that is
 * compared, and entries from before that record (no `written`) agree by their equal stamp
 * alone. Every other key is stored as written, so its values decide: equal stamps holding
 * different values (a hand-edited settings file) differ.
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
  if (!keepsWrittenSettingValue(a.key) || (a.writtenRecorded && b.writtenRecorded)) return false;
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

/**
 * The keys where one device differs from the others, for its "Where this device differs": its
 * own values, the values it has not taken yet (queued, syncing, refused), a value from before
 * sharing (`differs`), and, while no shared write happened yet, a value unlike another
 * device's (also `differs`). A key an older node does not share is listed when its value
 * differs too. `value` is what the device holds, as written.
 */
export function readDeviceSharingDifferences(
  views: ReadonlyArray<SharedSettingView<ShareableServerSettingKey>>,
  environmentId: EnvironmentId,
): ReadonlyArray<{
  readonly key: ShareableServerSettingKey;
  readonly state: SharedSettingDeviceState;
  readonly value: ShareableSettingValue<ShareableServerSettingKey> | undefined;
}> {
  return views.flatMap((view) => {
    const device = view.devices.find((entry) => entry.environmentId === environmentId);
    if (device === undefined) return [];
    const { kind } = device.state;
    const differsFromOthers =
      view.agreement.kind === "differs" &&
      view.devices.some(
        (other) =>
          other.environmentId !== environmentId &&
          other.written !== undefined &&
          !sharedDeviceValuesAgree(device, other),
      );
    const listed =
      kind === "override" ||
      kind === "queued" ||
      kind === "couldNotApply" ||
      kind === "syncing" ||
      kind === "differs" ||
      // Before any shared write every device is on its own value; after one, a device on the
      // shared value does not differ, the others say why.
      (kind === "shared" && view.newest === null && differsFromOthers) ||
      (kind === "unsupported" && differsFromOthers);
    if (!listed) return [];
    const state: SharedSettingDeviceState = kind === "shared" ? { kind: "differs" } : device.state;
    return [{ key: view.key, state, value: device.written }];
  });
}

/**
 * The keys where a device that never took a shared write keeps a value unlike the shared one
 * (state `differs` against a newest shared value): what "<device> has N settings that differ
 * from your shared ones" counts.
 */
export function readDeviceValuesFromBeforeSharing(
  views: ReadonlyArray<SharedSettingView<ShareableServerSettingKey>>,
  environmentId: EnvironmentId,
): ReadonlyArray<ShareableServerSettingKey> {
  return views.flatMap((view) =>
    view.newest !== null &&
    view.devices.some(
      (device) => device.environmentId === environmentId && device.state.kind === "differs",
    )
      ? [view.key]
      : [],
  );
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
  /** The key it changes (the first one, for `resolveDeviceDifferences` over several). */
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
  /**
   * With `shared`: the devices following the shared value (in `shared` mode now), written now or
   * skipped offline. One this edit misses (offline, or gone mid-write) takes it when it
   * reconnects; any other device it misses keeps what it has.
   */
  readonly followers: ReadonlyArray<EnvironmentId>;
}

/** The devices a shared command missed that take it when they reconnect. */
export function settingsSharingCommandCatchUps(
  command: SettingsSharingCommand,
  result: NodeSettingsApplyResult,
): ReadonlyArray<EnvironmentId> {
  if (command.shared === null) return [];
  const missed = new Set<EnvironmentId>([
    ...command.skipped
      .filter((device) => device.reason === "offline")
      .map((device) => device.environmentId),
    ...result.notApplied
      .filter((device) => device.reason === "disconnected")
      .map((device) => device.environmentId),
  ]);
  return command.followers.filter((environmentId) => missed.has(environmentId));
}

function writeBlocker(device: SharingDevice): SettingsSharingSkipReason | null {
  if (!device.connected) return "offline";
  return device.canWrite ? null : "read-only";
}

/**
 * Per-device patches of one edit. What the edit means for a device (`patchFor`: it keeps its
 * own value, it does not share the key) is decided first, from its last known config, so an
 * offline device that would not take the edit anyway is not promised it; then whether it can
 * be written now.
 */
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
  const followers: EnvironmentId[] = [];
  for (const device of devices) {
    const result = device.config === null ? "unknown" : patchFor(device, device.config.settings);
    const reason = typeof result === "string" ? result : writeBlocker(device);
    if (reason !== null)
      skipped.push({ environmentId: device.environmentId, label: device.label, reason });
    else if (typeof result !== "string")
      writes.push({ environmentId: device.environmentId, patch: result });
    if (
      shared !== null &&
      typeof result !== "string" &&
      (reason === null || reason === "offline") &&
      deviceEntry(device, key)?.mode === "shared"
    )
      followers.push(device.environmentId);
  }
  return { key, writes, skipped, shared, followers };
}

/**
 * For an edit of one field of a larger value: each device's own value with the edited field
 * put in (`valueFor`), so a device keeps the fields the edit did not touch. One value for every
 * device without it.
 */
type DeviceValue<K extends ShareableServerSettingKey> = (
  current: ShareableSettingValue<K>,
) => ShareableSettingValue<K>;

function valueForDevice<K extends ShareableServerSettingKey>(
  key: K,
  value: ShareableSettingValue<K>,
  valueFor: DeviceValue<K> | undefined,
  settings: ServerSettings,
): ShareableSettingValue<K> {
  return valueFor === undefined ? value : valueFor(readWrittenShareableSettingValue(settings, key));
}

/**
 * The shared value of a command whose devices may each get their own value (`valueFor`): the
 * one value when every device it reaches gets the same, else null, so no device that missed it
 * is later given another device's other fields.
 */
function commonSharedValue<K extends ShareableServerSettingKey>(
  key: K,
  devices: ReadonlyArray<SharingDevice>,
  value: ShareableSettingValue<K>,
  valueFor: DeviceValue<K> | undefined,
): { readonly value: ShareableSettingValue<K> } | null {
  if (valueFor === undefined) return { value };
  let common: { readonly value: ShareableSettingValue<K> } | null = null;
  for (const device of devices) {
    if (device.config === null || !nodeSharesSetting(device.config, key)) continue;
    const own = valueForDevice(key, value, valueFor, device.config.settings);
    if (common === null) common = { value: own };
    else if (!shareableSettingValuesEqual(common.value, own)) return null;
  }
  return common ?? { value };
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
  /** For a row that edits one field: each device's own value with that field put in. */
  readonly valueFor?: DeviceValue<K>;
}): SettingsSharingCommand {
  const { key, value, stamp, valueFor } = input;
  const followers = input.devices.filter(
    (device) =>
      device.config !== null &&
      readSharingEntry(device.config.settings.settingsSharing, key).mode !== "override",
  );
  const common = commonSharedValue(key, followers, value, valueFor);
  return buildCommand(
    key,
    input.devices,
    common === null ? null : { stamp, value: common.value },
    (device, settings) => {
      if (!nodeSharesSetting(device.config, key)) return "unsupported";
      if (readSharingEntry(settings.settingsSharing, key).mode === "override") return "override";
      return sharingPatch(key, valueForDevice(key, value, valueFor, settings), settings, {
        mode: "shared",
        stamp,
        onlyIfOlderShared: true,
      });
    },
  );
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
  result: NodeSettingsApplyResult,
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
  // Only devices that follow the shared value take it later; the rest keep what they have.
  const catchUps = new Set<EnvironmentId>(settingsSharingCommandCatchUps(command, result));
  const labelOf = (environmentId: EnvironmentId) =>
    command.skipped.find((device) => device.environmentId === environmentId)?.label ??
    result.notApplied.find((device) => device.environmentId === environmentId)?.label ??
    environmentId;
  const later = [...catchUps].map(labelOf);
  if (later.length > 0) parts.push(`Applies when they reconnect: ${names(later)}.`);
  const offline = command.skipped
    .filter((device) => device.reason === "offline" && !catchUps.has(device.environmentId))
    .map((device) => device.label);
  if (offline.length > 0) parts.push(`Offline: ${names(offline)}.`);
  const gone = result.notApplied
    .filter((device) => device.reason === "disconnected" && !catchUps.has(device.environmentId))
    .map((device) => device.label);
  if (gone.length > 0) parts.push(`Went offline before it was saved: ${names(gone)}.`);
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
  /** For a row that edits one field: each device's own value with that field put in. */
  readonly valueFor?: DeviceValue<K>;
}): SettingsSharingCommand {
  const { key, value, stamp, valueFor } = input;
  const common = commonSharedValue(key, input.devices, value, valueFor);
  return buildCommand(
    key,
    input.devices,
    common === null ? null : { stamp, value: common.value },
    (device, settings) =>
      nodeSharesSetting(device.config, key)
        ? sharingPatch(key, valueForDevice(key, value, valueFor, settings), settings, {
            mode: "shared",
            stamp,
          })
        : "unsupported",
  );
}

/**
 * Settles a device's values from before sharing (`readDeviceValuesFromBeforeSharing`) in one
 * write: `shared` gives it the newest shared value and stamp of each key (as "Reset to
 * shared"), `own` keeps each of its values as its own (an override, stamped). Keys without a
 * shared value (any more) are left out. One patch, so the device takes all of them or none.
 */
export function resolveDeviceDifferences(input: {
  readonly device: SharingDevice;
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly keys: ReadonlyArray<ShareableServerSettingKey>;
  readonly choice: "shared" | "own";
  /** For `own`, from {@link nextSettingsSharingStamp}. */
  readonly stamp: SettingsSharingStamp;
  readonly cache?: SettingsSharingCache;
}): SettingsSharingCommand | null {
  const [first] = input.keys;
  if (first === undefined) return null;
  return buildCommand(first, [input.device], null, (device, settings) => {
    const patches: ServerSettingsPatch[] = [];
    for (const key of input.keys) {
      if (!nodeSharesSetting(device.config, key)) continue;
      if (input.choice === "own") {
        patches.push(
          sharingPatch(key, undefined, settings, { mode: "override", stamp: input.stamp }),
        );
        continue;
      }
      const newest = readNewestSharedSetting(input.devices, key, input.cache);
      if (newest !== null)
        patches.push(
          sharingPatch(key, newest.value, settings, { mode: "shared", stamp: newest.stamp }),
        );
    }
    return patches.length === 0 ? "unsupported" : mergeSettingsSharingPatches(patches);
  });
}
