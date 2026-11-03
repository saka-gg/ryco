import type { EnvironmentId } from "@ryco/contracts";
import { ServerSettings } from "@ryco/contracts/settings";
import {
  nodeSharesSetting,
  readSharedSettingView,
  setSettingOverride,
  writeSharedSetting,
  type SettingsSharingCache,
  type SettingsSharingCommand,
  type SettingsSharingSkipReason,
  type SharingDevice,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import type { NodeSettingsApplyResult } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import type { SettingsSharingStamp } from "@ryco/contracts/settings";
import {
  readShareableSettingValue,
  readSharingEntry,
  shareableSettingValuesEqual,
  SHAREABLE_SERVER_SETTING_KEYS,
  type ShareableServerSettingKey,
  type ShareableSettingValue,
} from "@ryco/shared/settingsSharing";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The device part of the settings file: the settings every device shares
 * (`@ryco/shared/settingsSharing`), as the devices hold them. Never a device-only key (provider
 * instances, CLIProxyAPI hubs, the default and text-generation models, ...), never a secret, and
 * nothing that names a node, an account or a connection. A restore writes them through the
 * sharing commands, to every device or to the devices a person picks.
 */

/**
 * Which shareable keys travel. Every key must be placed: a key made shareable later fails
 * typecheck here until someone decides. Left out: paths, which hold a machine's own folders
 * (its account name) and are the usual per-device values.
 */
export const DEVICE_SETTINGS_FILE_SCOPE = {
  runSetupScript: true,
  responseStreamingMode: true,
  enableProviderUpdateChecks: true,
  automaticUpdates: true,
  continueThreadsAfterRestart: true,
  autoResumeLimitedThreads: true,
  snoozeLimitedThreads: true,
  storageRetention: true,
  lifecycleSuggestions: true,
  worktreeRoot: false,
  chatsRoot: false,
  chatFolderCleanupAfterDays: true,
  worktreeSubmodules: true,
  worktreeBranchPrefix: true,
  worktreeBranchChangeTypes: true,
  defaultThreadEnvMode: true,
  defaultAgentTokenMode: true,
  addProjectBaseDirectory: false,
  commitMessageInstructions: true,
  pullRequestInstructions: true,
  gitWritingStyle: true,
  pullRequestTemplates: true,
  threadAutoSettleAfterDays: true,
  usagePriceOverrides: true,
  agentControl: true,
} as const satisfies Record<ShareableServerSettingKey, boolean>;

export type DeviceSettingsFileKey = {
  [
    K in keyof typeof DEVICE_SETTINGS_FILE_SCOPE
  ]: (typeof DEVICE_SETTINGS_FILE_SCOPE)[K] extends true ? K : never;
}[keyof typeof DEVICE_SETTINGS_FILE_SCOPE];

export const DEVICE_SETTINGS_FILE_KEYS = SHAREABLE_SERVER_SETTING_KEYS.filter(
  (key): key is DeviceSettingsFileKey => DEVICE_SETTINGS_FILE_SCOPE[key],
);

/** The device section of a settings file: one value per shared setting. */
export type DeviceSettingsFileSection = {
  readonly [K in DeviceSettingsFileKey]?: ShareableSettingValue<K>;
};

const show = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/**
 * What the devices share now, for a backup: per key the newest shared value (`writeSharedSetting`
 * wrote it, possibly to a device that is offline now), else the value every device agrees on,
 * else the value of `preferred` (the device the settings show), else of the first device that
 * has one. Keys no device has a config for stay out.
 */
export function buildDeviceSettingsSection(input: {
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly cache?: SettingsSharingCache;
  readonly preferred?: EnvironmentId | null;
}): DeviceSettingsFileSection {
  const section: Record<string, unknown> = {};
  for (const key of DEVICE_SETTINGS_FILE_KEYS) {
    const view = readSharedSettingView({
      key,
      devices: input.devices,
      ...(input.cache === undefined ? {} : { cache: input.cache }),
    });
    const fallback =
      view.devices.find(
        (device) => device.environmentId === input.preferred && device.value !== undefined,
      ) ?? view.devices.find((device) => device.value !== undefined);
    const value =
      view.newest !== null
        ? view.newest.value
        : view.agreement.kind === "same"
          ? view.agreement.value
          : fallback?.value;
    if (value !== undefined) section[key] = value;
  }
  return section as DeviceSettingsFileSection;
}

/** A device section read from a file: the values it may restore, and what it refused. */
export interface DeviceSettingsFileValues {
  readonly values: DeviceSettingsFileSection;
  readonly warnings: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a file's device section. Untrusted: each value is checked against its setting's schema
 * as the node decodes it; a key the section does not carry or a refused value is a warning.
 * Null when the file has no device section (an older file, or one with this app's settings only).
 */
export function readDeviceSettingsSection(raw: unknown): DeviceSettingsFileValues | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return { values: {}, warnings: ["deviceSettings: not an object"] };
  const values: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(DEVICE_SETTINGS_FILE_KEYS as ReadonlyArray<string>).includes(key)) {
      warnings.push(`${key}: not a device setting this file carries, left as it is`);
      continue;
    }
    const fileKey = key as DeviceSettingsFileKey;
    // One field of the node's own schema, decoded as the node decodes it (defaults included).
    const schema = Schema.Struct({ [fileKey]: ServerSettings.fields[fileKey] });
    const decoded = Schema.decodeUnknownOption(schema as Schema.Decoder<Record<string, unknown>>)({
      [fileKey]: value,
    });
    if (Option.isNone(decoded) || !Object.hasOwn(decoded.value, fileKey)) {
      warnings.push(`${key}: invalid value, kept the current one`);
      continue;
    }
    values[fileKey] = decoded.value[fileKey];
  }
  return { values: values as DeviceSettingsFileSection, warnings };
}

/** Where a restore writes: every device (shared), or only the picked ones (their own values). */
export type DeviceRestoreTargets =
  | { readonly kind: "every" }
  | { readonly kind: "chosen"; readonly environmentIds: ReadonlySet<EnvironmentId> };

/** A device a person can pick for "Only these devices": connected, writable, with a config. */
export function deviceTakesOwnValueNow(device: SharingDevice): boolean {
  return device.config !== null && device.connected && device.canWrite;
}

/** What a restore would do on one device, before anything is written. */
export interface DeviceRestorePreview {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** `key: old -> new` for every value that changes there. */
  readonly changes: ReadonlyArray<string>;
  /** Why it is not written now: queued (offline or read only) until it is back. */
  readonly waits: "offline" | "read-only" | null;
  /** Keys it keeps its own value for (an override a shared restore does not touch). */
  readonly keepsOwn: ReadonlyArray<DeviceSettingsFileKey>;
  /** Keys it gets as its own value (only some devices picked). */
  readonly becomesOwn: ReadonlyArray<DeviceSettingsFileKey>;
}

function fileEntries(values: DeviceSettingsFileSection) {
  return DEVICE_SETTINGS_FILE_KEYS.flatMap((key) =>
    Object.hasOwn(values, key)
      ? [{ key, value: values[key] as ShareableSettingValue<DeviceSettingsFileKey> }]
      : [],
  );
}

/** Per target device, what restoring `values` would change. Devices without a config stay out. */
export function previewDeviceSettingsRestore(input: {
  readonly values: DeviceSettingsFileSection;
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly targets: DeviceRestoreTargets;
}): ReadonlyArray<DeviceRestorePreview> {
  const { targets } = input;
  const entries = fileEntries(input.values);
  return input.devices.flatMap((device): DeviceRestorePreview[] => {
    const config = device.config;
    if (config === null) return [];
    if (targets.kind === "chosen" && !targets.environmentIds.has(device.environmentId)) return [];
    const changes: string[] = [];
    const keepsOwn: DeviceSettingsFileKey[] = [];
    const becomesOwn: DeviceSettingsFileKey[] = [];
    for (const { key, value } of entries) {
      const current = readShareableSettingValue(config.settings, key);
      const shares = nodeSharesSetting(config, key);
      const own =
        shares && readSharingEntry(config.settings.settingsSharing, key).mode === "override";
      if (targets.kind === "every" && own) {
        if (!shareableSettingValuesEqual(current, value)) keepsOwn.push(key);
        continue;
      }
      if (shareableSettingValuesEqual(current, value)) continue;
      changes.push(`${key}: ${show(current)} -> ${show(value)}`);
      if (targets.kind === "chosen" && shares && !own) becomesOwn.push(key);
    }
    const waits = !device.connected ? "offline" : !device.canWrite ? "read-only" : null;
    return [
      {
        environmentId: device.environmentId,
        label: device.label,
        changes,
        waits,
        keepsOwn,
        becomesOwn,
      },
    ];
  });
}

/**
 * The sharing commands of a restore, one per key and kind. To every device: a shared write
 * (`writeSharedSetting`) for each key some device holds otherwise, so offline devices catch up
 * and overrides keep their value, plus a plain edit for a writable device on an older Ryco.
 * To picked devices: each gets the value as its own (`setSettingOverride`). Null stamp: sharing
 * is not ready (no signed-in account).
 */
export function buildDeviceSettingsRestoreCommands(input: {
  readonly values: DeviceSettingsFileSection;
  readonly devices: ReadonlyArray<SharingDevice>;
  readonly targets: DeviceRestoreTargets;
  readonly nextStamp: () => SettingsSharingStamp | null;
}): ReadonlyArray<SettingsSharingCommand> | null {
  const commands: SettingsSharingCommand[] = [];
  const known = input.devices.filter((device) => device.config !== null);
  for (const { key, value } of fileEntries(input.values)) {
    const differs = (device: SharingDevice) =>
      device.config !== null &&
      !shareableSettingValuesEqual(readShareableSettingValue(device.config.settings, key), value);
    if (input.targets.kind === "every") {
      if (!known.some(differs)) continue;
      const stamp = input.nextStamp();
      if (stamp === null) return null;
      commands.push(writeSharedSetting({ devices: known, key, value, stamp }));
      for (const device of known) {
        if (nodeSharesSetting(device.config, key) || !differs(device)) continue;
        if (!deviceTakesOwnValueNow(device)) continue;
        commands.push(setSettingOverride({ device, key, value, stamp }));
      }
      continue;
    }
    const { environmentIds } = input.targets;
    for (const device of known) {
      if (!environmentIds.has(device.environmentId) || !differs(device)) continue;
      const stamp = input.nextStamp();
      if (stamp === null) return null;
      commands.push(setSettingOverride({ device, key, value, stamp }));
    }
  }
  return commands;
}

/** How a restore went on one device. */
export interface DeviceRestoreOutcome {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly applied: ReadonlyArray<DeviceSettingsFileKey>;
  /** Waiting for the device (offline or read only): it catches up later. */
  readonly queued: ReadonlyArray<DeviceSettingsFileKey>;
  /** Left as they are: the device keeps its own value, or needs an update. */
  readonly kept: ReadonlyArray<{
    readonly key: DeviceSettingsFileKey;
    readonly reason: Exclude<SettingsSharingSkipReason, "offline" | "read-only">;
  }>;
  readonly failed: ReadonlyArray<{ readonly key: DeviceSettingsFileKey; readonly detail: string }>;
}

/** Folds each command and its result into one outcome per device, in the devices' order. */
export function summarizeDeviceSettingsRestore(
  devices: ReadonlyArray<SharingDevice>,
  runs: ReadonlyArray<{
    readonly command: SettingsSharingCommand;
    readonly result: NodeSettingsApplyResult;
  }>,
): ReadonlyArray<DeviceRestoreOutcome> {
  type Mutable = {
    applied: DeviceSettingsFileKey[];
    queued: DeviceSettingsFileKey[];
    kept: Array<DeviceRestoreOutcome["kept"][number]>;
    failed: Array<DeviceRestoreOutcome["failed"][number]>;
  };
  const byDevice = new Map<EnvironmentId, Mutable>();
  const entry = (environmentId: EnvironmentId) => {
    let found = byDevice.get(environmentId);
    if (found === undefined) {
      found = { applied: [], queued: [], kept: [], failed: [] };
      byDevice.set(environmentId, found);
    }
    return found;
  };
  // Devices some command writes, per key: a skip there is settled by that other write.
  const written = new Map<string, Set<EnvironmentId>>();
  for (const { command } of runs) {
    const set = written.get(command.key) ?? new Set<EnvironmentId>();
    for (const write of command.writes) set.add(write.environmentId);
    written.set(command.key, set);
  }
  for (const { command, result } of runs) {
    const key = command.key as DeviceSettingsFileKey;
    const writtenTo = new Set(command.writes.map((write) => write.environmentId));
    for (const skipped of command.skipped) {
      if (written.get(key)?.has(skipped.environmentId)) continue;
      if (skipped.reason === "offline" || skipped.reason === "read-only")
        entry(skipped.environmentId).queued.push(key);
      else entry(skipped.environmentId).kept.push({ key, reason: skipped.reason });
    }
    for (const applied of result.applied) {
      if (writtenTo.has(applied.environmentId)) entry(applied.environmentId).applied.push(key);
    }
    for (const missed of result.notApplied) {
      if (missed.reason === "failed")
        entry(missed.environmentId).failed.push({
          key,
          detail: missed.detail ?? "The device refused the value.",
        });
      else if (missed.reason === "unsupported")
        entry(missed.environmentId).kept.push({ key, reason: "unsupported" });
      else entry(missed.environmentId).queued.push(key);
    }
  }
  return devices.flatMap((device) => {
    const found = byDevice.get(device.environmentId);
    return found === undefined
      ? []
      : [{ environmentId: device.environmentId, label: device.label, ...found }];
  });
}
