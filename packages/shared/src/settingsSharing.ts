/**
 * Which node settings devices share, and the rules a node applies to a sharing write. Runtime
 * data on purpose (contracts stay schema-only): the node validates patches with it, advertises
 * its shareable keys from it, and clients plan catch-up writes with it.
 *
 * Model (docs/shared-device-settings.md): each shareable key on each device is `shared` or
 * `override`, with the stamp of the write that set it. A missing entry is shared with the zero
 * stamp, which is never written, so at rollout nothing changes until a person picks a value.
 */
import {
  DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ServerSettings,
  type ServerSettingsPatch,
  type SettingsSharing,
  type SettingsSharingEntry,
  type SettingsSharingMode,
  type SettingsSharingStamp,
} from "@ryco/contracts/settings";
// Import-light on purpose: the node's boot path loads this through `serverSettings`, and one more
// shared module here splits the boot chunks.
import * as Equal from "effect/Equal";

export type SettingSharingClass = "shareable" | "device-only";

/**
 * Every `ServerSettings` key with its sharing class; a key added to `ServerSettings` fails
 * typecheck here until it is classified.
 *
 * Device-only: identity and machine facts (icon), anything keyed by node-local ids (project
 * maps, provider instances and the model selections that name them), power and process
 * priority, observability, provider binaries and secrets, CLIProxyAPI hubs, and the sharing
 * record itself.
 */
export const SERVER_SETTING_SHARING = {
  // Names a provider instance, which is per device.
  initialModelSelection: "device-only",
  runSetupScript: "shareable",
  projectPreferences: "device-only",
  environmentIcon: "device-only",
  responseStreamingMode: "shareable",
  enableProviderUpdateChecks: "shareable",
  automaticUpdates: "shareable",
  lowerAgentProcessPriority: "device-only",
  continueThreadsAfterRestart: "shareable",
  // The simulators and emulators of this machine.
  devicesEnabled: "device-only",
  agentDevicesEnabled: "device-only",
  deviceOnboardingCompleted: "device-only",
  deviceHosts: "device-only",
  autoResumeLimitedThreads: "shareable",
  snoozeLimitedThreads: "shareable",
  promptSuggestions: "shareable",
  storageRetention: "shareable",
  projectStorageRetention: "device-only",
  lifecycleSuggestions: "shareable",
  projectLifecycleSuggestions: "device-only",
  // Paths are shareable, and the usual per-device overrides.
  worktreeRoot: "shareable",
  chatsRoot: "shareable",
  chatFolderCleanupAfterDays: "shareable",
  worktreeSubmodules: "shareable",
  projectWorktreeSubmodules: "device-only",
  projectWorktreeRoots: "device-only",
  worktreeBranchPrefix: "shareable",
  worktreeBranchChangeTypes: "shareable",
  defaultThreadEnvMode: "shareable",
  defaultAgentTokenMode: "shareable",
  addProjectBaseDirectory: "shareable",
  // Names a provider instance, which is per device.
  textGenerationModelSelection: "device-only",
  commitMessageInstructions: "shareable",
  pullRequestInstructions: "shareable",
  gitWritingStyle: "shareable",
  projectGitWritingStyle: "device-only",
  pullRequestTemplates: "shareable",
  threadAutoSettleAfterDays: "shareable",
  // Binaries, homes and secrets of this machine.
  providers: "device-only",
  providerInstances: "device-only",
  providerEventLogs: "device-only",
  cliProxyHubs: "device-only",
  usagePriceOverrides: "shareable",
  observability: "device-only",
  // On/off and delegation limits.
  agentControl: "shareable",
  settingsSharing: "device-only",
} as const satisfies Record<keyof ServerSettings, SettingSharingClass>;

export type ShareableServerSettingKey = {
  [K in keyof typeof SERVER_SETTING_SHARING]: (typeof SERVER_SETTING_SHARING)[K] extends "shareable"
    ? K
    : never;
}[keyof typeof SERVER_SETTING_SHARING];

/** The shareable keys, in catalog order. */
export const SHAREABLE_SERVER_SETTING_KEYS: ReadonlyArray<ShareableServerSettingKey> = (
  Object.keys(SERVER_SETTING_SHARING) as Array<keyof typeof SERVER_SETTING_SHARING>
).filter((key): key is ShareableServerSettingKey => SERVER_SETTING_SHARING[key] === "shareable");

const SHAREABLE_KEY_SET: ReadonlySet<string> = new Set(SHAREABLE_SERVER_SETTING_KEYS);

export function isShareableServerSettingKey(key: string): key is ShareableServerSettingKey {
  return SHAREABLE_KEY_SET.has(key);
}

// ── Sharing versions ────────────────────────────────────────────

/**
 * The sharing version that made each key shareable. A node advertises only its version
 * (`ExecutionEnvironmentCapabilities.settingsSharingVersion`), never key names. Rules: a key
 * made shareable later gets the next version and `SETTINGS_SHARING_VERSION` moves to it; a key
 * never leaves the set and never changes its version.
 */
export const SHAREABLE_SETTING_SINCE_VERSION = {
  runSetupScript: 1,
  responseStreamingMode: 1,
  enableProviderUpdateChecks: 1,
  automaticUpdates: 1,
  continueThreadsAfterRestart: 1,
  autoResumeLimitedThreads: 1,
  snoozeLimitedThreads: 1,
  storageRetention: 1,
  lifecycleSuggestions: 1,
  worktreeRoot: 1,
  chatsRoot: 1,
  chatFolderCleanupAfterDays: 1,
  worktreeSubmodules: 1,
  worktreeBranchPrefix: 1,
  worktreeBranchChangeTypes: 1,
  defaultThreadEnvMode: 1,
  defaultAgentTokenMode: 1,
  addProjectBaseDirectory: 1,
  commitMessageInstructions: 1,
  pullRequestInstructions: 1,
  gitWritingStyle: 1,
  pullRequestTemplates: 1,
  threadAutoSettleAfterDays: 1,
  usagePriceOverrides: 1,
  agentControl: 1,
  promptSuggestions: 2,
} as const satisfies Record<ShareableServerSettingKey, number>;

/** This build's sharing version: the highest version of any key it shares. */
export const SETTINGS_SHARING_VERSION: number = Math.max(
  ...Object.values<number>(SHAREABLE_SETTING_SINCE_VERSION),
);

/**
 * Whether a node advertising `version` shares `key`: both sides must know the key, so a key
 * newer than the node (or unknown to this build) does not share. Undefined: an older Ryco.
 */
export function settingSharedAtVersion(
  version: number | undefined,
  key: ShareableServerSettingKey,
  sinceVersion: Readonly<
    Record<ShareableServerSettingKey, number>
  > = SHAREABLE_SETTING_SINCE_VERSION,
): boolean {
  if (version === undefined || !Number.isSafeInteger(version) || version < 1) return false;
  const since = sinceVersion[key];
  return since !== undefined && since <= version;
}

// ── Stamps ──────────────────────────────────────────────────────

/** The stamp of a key never written by a sharing write. Never sent; sorts before every stamp. */
export const ZERO_SHARING_STAMP: SettingsSharingStamp = { at: 0, by: "" };

export function isZeroSharingStamp(stamp: SettingsSharingStamp): boolean {
  return stamp.at === 0;
}

/** Orders stamps by `(at, by)`, so every client picks the same winner. */
export function compareSharingStamps(a: SettingsSharingStamp, b: SettingsSharingStamp): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.by === b.by) return 0;
  return a.by < b.by ? -1 : 1;
}

/** A key's entry on a device: the stored one, else shared with the zero stamp. */
export function readSharingEntry(
  sharing: SettingsSharing | undefined,
  key: ShareableServerSettingKey,
): SettingsSharingEntry {
  const entry = sharing !== undefined && Object.hasOwn(sharing, key) ? sharing[key] : undefined;
  return entry ?? { mode: "shared", stamp: ZERO_SHARING_STAMP };
}

// ── Values ──────────────────────────────────────────────────────

export type ShareableSettingValue<K extends ShareableServerSettingKey> =
  K extends "threadAutoSettleAfterDays"
    ? NonNullable<ServerSettings["threadAutoSettleAfterDays"]> | null
    : ServerSettings[K];

/**
 * A key's effective value on a device. The auto-settle rule reads its default while unset, as
 * the node applies it.
 */
export function readShareableSettingValue<K extends ShareableServerSettingKey>(
  settings: ServerSettings,
  key: K,
): ShareableSettingValue<K> {
  // As `resolveAutoSettleAfterDays` (threadSettlement) reads it.
  if (key === "threadAutoSettleAfterDays")
    return (
      settings.threadAutoSettleAfterDays === undefined
        ? DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        : settings.threadAutoSettleAfterDays
    ) as ShareableSettingValue<K>;
  return settings[key] as ShareableSettingValue<K>;
}

/** Structural equality of two values of one key, as the node's own compare-and-set compares. */
export function shareableSettingValuesEqual(a: unknown, b: unknown): boolean {
  return Equal.equals(a, b);
}

/**
 * The patch fields that write a key, beyond the key itself: dropped with the key when a
 * catch-up is skipped, so a skipped key changes nothing.
 */
const COMPANION_PATCH_FIELDS: Partial<
  Record<ShareableServerSettingKey, ReadonlyArray<keyof ServerSettingsPatch>>
> = {
  responseStreamingMode: ["enableLegacyTokenStreaming"],
  threadAutoSettleAfterDays: ["expectedThreadAutoSettleAfterDays"],
};

/**
 * The patch that sets `value` for `key` on a device whose settings are `current`. Map keys
 * are replaced whole: entries the value does not hold are removed.
 */
export function shareableSettingValuePatch<K extends ShareableServerSettingKey>(
  key: K,
  value: ShareableSettingValue<K>,
  current: ServerSettings,
): ServerSettingsPatch {
  if (key === "usagePriceOverrides") {
    const next = value as ServerSettings["usagePriceOverrides"];
    const entries: Record<string, ServerSettings["usagePriceOverrides"][string] | null> = {};
    for (const model of Object.keys(current.usagePriceOverrides)) entries[model] = null;
    for (const [model, override] of Object.entries(next)) entries[model] = override;
    return { usagePriceOverrides: entries };
  }
  return { [key]: value } as ServerSettingsPatch;
}

// ── Values as written ───────────────────────────────────────────

/**
 * Keys a node stores differently from how they were written: paths, with `~/` expanded and
 * symlinks resolved on that machine. Their sharing entry keeps the value as written
 * (`SettingsSharingEntry.written`), and that is what other devices are caught up to and
 * compared by, so `~/w` stays right on a Mac (`/Users/me/w`) and on Linux (`/home/me/w`).
 */
export const WRITTEN_VALUE_SETTING_KEYS = [
  "worktreeRoot",
  "chatsRoot",
] as const satisfies ReadonlyArray<ShareableServerSettingKey>;

export type WrittenValueSettingKey = (typeof WRITTEN_VALUE_SETTING_KEYS)[number];

const WRITTEN_VALUE_KEY_SET: ReadonlySet<string> = new Set(WRITTEN_VALUE_SETTING_KEYS);

export function keepsWrittenSettingValue(key: string): key is WrittenValueSettingKey {
  return WRITTEN_VALUE_KEY_SET.has(key);
}

/**
 * The patch with each sharing entry of a {@link WRITTEN_VALUE_SETTING_KEYS} key carrying the
 * patch's own value of that key as `written`, and a `written` without its value dropped. A node
 * calls it on the patch as received, before it normalizes any value, so `written` is always what
 * the writer sent; clients build the same entries for their optimistic copy.
 */
export function recordWrittenSettingValues(patch: ServerSettingsPatch): ServerSettingsPatch {
  const sharing = patch.settingsSharing;
  if (sharing === undefined) return patch;
  let next: Record<string, unknown> | null = null;
  for (const key of WRITTEN_VALUE_SETTING_KEYS) {
    const entry = Object.hasOwn(sharing, key) ? sharing[key] : undefined;
    if (entry === undefined || entry === null) continue;
    const value = patch[key];
    if (entry.written === value) continue;
    const { written: _written, ...rest } = entry;
    next ??= { ...sharing };
    next[key] = typeof value === "string" ? { ...rest, written: value } : rest;
  }
  return next === null
    ? patch
    : { ...patch, settingsSharing: next as NonNullable<ServerSettingsPatch["settingsSharing"]> };
}

/**
 * A key's value as the device's sharing entry has it written: for a
 * {@link WRITTEN_VALUE_SETTING_KEYS} key the value before the device normalized it, when the
 * entry knows it; otherwise the stored value. This is the value a device shares.
 */
export function readWrittenShareableSettingValue<K extends ShareableServerSettingKey>(
  settings: ServerSettings,
  key: K,
): ShareableSettingValue<K> {
  if (keepsWrittenSettingValue(key)) {
    const written = readSharingEntry(settings.settingsSharing, key).written;
    if (written !== undefined) return written as ShareableSettingValue<K>;
  }
  return readShareableSettingValue(settings, key);
}

// ── Applying a sharing patch on a node ──────────────────────────

function patchWritesKey(patch: ServerSettingsPatch, key: ShareableServerSettingKey): boolean {
  if (patch[key] !== undefined) return true;
  return (COMPANION_PATCH_FIELDS[key] ?? []).some((field) => patch[field] !== undefined);
}

function withoutKey(
  patch: ServerSettingsPatch,
  key: ShareableServerSettingKey,
): ServerSettingsPatch {
  const next: Record<string, unknown> = { ...patch };
  delete next[key];
  for (const field of COMPANION_PATCH_FIELDS[key] ?? []) delete next[field];
  return next as ServerSettingsPatch;
}

/**
 * Resolves a patch's `settingsSharing` against a node's current settings, before the patch is
 * applied: rejects entries for keys that are not shareable here and `shared` entries without
 * their value, and drops each catch-up (`onlyIfOlderShared`) the node no longer needs (an
 * override, or a stamp not older) together with its value. Returns the patch to apply, without
 * `settingsSharing`, and the sharing entries to write (`null` removes one).
 */
export function resolveSettingsSharingPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): {
  readonly patch: ServerSettingsPatch;
  readonly entries: ReadonlyMap<ShareableServerSettingKey, SettingsSharingEntry | null>;
  readonly skipped: ReadonlyArray<ShareableServerSettingKey>;
} {
  const { settingsSharing, ...rest } = patch;
  let next: ServerSettingsPatch = rest;
  const entries = new Map<ShareableServerSettingKey, SettingsSharingEntry | null>();
  const skipped: ShareableServerSettingKey[] = [];
  for (const [key, entry] of Object.entries(settingsSharing ?? {})) {
    if (!isShareableServerSettingKey(key))
      throw new Error(`"${key}" is not a shared setting on this device.`);
    if (entry === null) {
      entries.set(key, null);
      continue;
    }
    // Skipped before the value check, so resolving an already resolved patch is a no-op.
    if (entry.onlyIfOlderShared === true) {
      const stored = readSharingEntry(current.settingsSharing, key);
      if (stored.mode !== "shared" || compareSharingStamps(entry.stamp, stored.stamp) <= 0) {
        next = withoutKey(next, key);
        skipped.push(key);
        continue;
      }
    }
    const writesValue = patchWritesKey(rest, key);
    if (entry.mode === "shared" && !writesValue)
      throw new Error(`A shared "${key}" must be written with its value.`);
    entries.set(key, {
      mode: entry.mode,
      stamp: entry.stamp,
      ...(writesValue && keepsWrittenSettingValue(key) && entry.written !== undefined
        ? { written: entry.written }
        : {}),
    });
  }
  return { patch: next, entries, skipped };
}

/**
 * The sharing record after a patch: the resolved entries written, and every shared key with a
 * non-zero stamp whose value an unstamped write changed (an older client, an agent, a
 * one-device edit) turned into an override with its stamp kept. That edit stays on this device
 * and is never carried to others; a key still on the zero stamp stays shared, so nothing at
 * rollout becomes an override on its own.
 */
export function nextSettingsSharing(
  current: ServerSettings,
  next: ServerSettings,
  entries: ReadonlyMap<ShareableServerSettingKey, SettingsSharingEntry | null>,
): SettingsSharing {
  const sharing = new Map<string, SettingsSharingEntry>(Object.entries(current.settingsSharing));
  for (const [key, entry] of entries) {
    if (entry === null) sharing.delete(key);
    else sharing.set(key, entry);
  }
  for (const key of SHAREABLE_SERVER_SETTING_KEYS) {
    if (entries.has(key)) continue;
    const stored = readSharingEntry(current.settingsSharing, key);
    if (stored.mode !== "shared" || isZeroSharingStamp(stored.stamp)) continue;
    if (
      shareableSettingValuesEqual(
        readShareableSettingValue(current, key),
        readShareableSettingValue(next, key),
      )
    )
      continue;
    sharing.set(key, { mode: "override" satisfies SettingsSharingMode, stamp: stored.stamp });
  }
  // `written` stands for the stored value: kept while the value stays, dropped once it changes
  // without one (an unstamped edit, or a stamped one that did not carry it).
  for (const key of WRITTEN_VALUE_SETTING_KEYS) {
    const entry = sharing.get(key);
    if (entry === undefined || entries.get(key)?.written !== undefined) continue;
    const { written: _written, ...rest } = entry;
    const storedWritten = readSharingEntry(current.settingsSharing, key).written;
    const keep =
      storedWritten !== undefined &&
      shareableSettingValuesEqual(
        readShareableSettingValue(current, key),
        readShareableSettingValue(next, key),
      );
    sharing.set(key, keep ? { ...rest, written: storedWritten } : rest);
  }
  return Object.fromEntries(sharing);
}
