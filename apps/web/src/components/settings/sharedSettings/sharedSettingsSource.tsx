import type {
  NodeSettingsApplyResult,
  NodeSettingsTarget,
} from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import type {
  SettingsSharingAttempts,
  SettingsSharingCache,
  SettingsSharingCommand,
  SharingDevice,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import type { SettingsSharingStamp } from "@ryco/contracts/settings";
import type { EnvironmentId } from "@ryco/contracts";
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";

import { updateEnvironmentServerSettings } from "../../../environments/runtime";
import {
  readSettingsSharingTargets,
  subscribeSettingsSharingTargets,
} from "../../../environments/settingsSharingTargets";
import { ensureLocalApi } from "../../../localApi";
import { applySettingsUpdated, useServerConfig } from "../../../rpc/serverState";
import { useSettingsTarget, type SettingsTarget } from "../../../settingsTarget";
import {
  nextSettingsSharingEditStamp,
  readSettingsSharingRuntimeRevision,
  readSettingsSharingState,
  runSettingsSharingCommand,
  subscribeSettingsSharingRuntime,
} from "../../../settingsSharing/settingsSharingRuntime";
import { pickSharedRowsDevice } from "./sharedSettingRow.logic";

/**
 * Where shared rows read every device and send a person's edits. The app's own source reads
 * the known nodes and this app's runner; tests pass simulated devices.
 */
export interface SharedSettingsSource {
  /** Every known device as a write target, read now. */
  readonly readDevices: () => ReadonlyArray<NodeSettingsTarget>;
  /** A device's config, connection or write access may have changed. */
  readonly subscribeDevices: (listener: () => void) => () => void;
  readonly readState: () => {
    readonly attempts: SettingsSharingAttempts;
    readonly cache: SettingsSharingCache;
  };
  /** Changes whenever the state (attempts, cache) may have; `subscribeState` tells when. */
  readonly readStateRevision: () => number;
  readonly subscribeState: (listener: () => void) => () => void;
  readonly nextStamp: (devices: ReadonlyArray<SharingDevice>) => SettingsSharingStamp | null;
  /**
   * Sends a person's command; `extra` are devices the page knows that the source does not
   * (the settings target), each read now.
   */
  readonly run: (
    command: SettingsSharingCommand,
    extra?: ReadonlyArray<NodeSettingsTarget>,
  ) => Promise<NodeSettingsApplyResult>;
}

export const WEB_SHARED_SETTINGS_SOURCE: SharedSettingsSource = {
  readDevices: readSettingsSharingTargets,
  subscribeDevices: subscribeSettingsSharingTargets,
  readState: readSettingsSharingState,
  readStateRevision: readSettingsSharingRuntimeRevision,
  subscribeState: subscribeSettingsSharingRuntime,
  nextStamp: nextSettingsSharingEditStamp,
  run: runSettingsSharingCommand,
};

const SharedSettingsSourceContext = createContext<SharedSettingsSource>(WEB_SHARED_SETTINGS_SOURCE);
export const SharedSettingsSourceProvider = SharedSettingsSourceContext.Provider;

export function useSharedSettingsSource(): SharedSettingsSource {
  return useContext(SharedSettingsSourceContext);
}

/** Every device and the runner's state, as the shared rows read them. */
export interface SharedSettingsSnapshot {
  readonly devices: ReadonlyArray<NodeSettingsTarget>;
  readonly attempts: SettingsSharingAttempts;
  readonly cache: SettingsSharingCache;
}

/**
 * The same devices as far as shared rows can tell: a provider-status push replaces a config
 * but keeps its settings and environment, so it re-renders nothing.
 */
function sameDevices(
  a: ReadonlyArray<NodeSettingsTarget>,
  b: ReadonlyArray<NodeSettingsTarget>,
): boolean {
  return (
    a.length === b.length &&
    a.every((device, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        device.environmentId === other.environmentId &&
        device.label === other.label &&
        device.connected === other.connected &&
        device.canWrite === other.canWrite &&
        device.config?.settings === other.config?.settings &&
        device.config?.environment === other.config?.environment
      );
    })
  );
}

function createSnapshotStore(source: SharedSettingsSource) {
  let cached: { readonly revision: number; readonly snapshot: SharedSettingsSnapshot } | null =
    null;
  const subscribe = (listener: () => void) => {
    const stopDevices = source.subscribeDevices(listener);
    const stopState = source.subscribeState(listener);
    return () => {
      stopDevices();
      stopState();
    };
  };
  const read = (): SharedSettingsSnapshot => {
    const revision = source.readStateRevision();
    const devices = source.readDevices();
    if (
      cached !== null &&
      cached.revision === revision &&
      sameDevices(cached.snapshot.devices, devices)
    )
      return cached.snapshot;
    const { attempts, cache } = source.readState();
    // The runner keeps one attempts map and changes it in place: a copy per revision.
    const snapshot: SharedSettingsSnapshot = {
      devices,
      attempts: new Map([...attempts].map(([id, keys]) => [id, new Map(keys)])),
      cache,
    };
    cached = { revision, snapshot };
    return snapshot;
  };
  return { subscribe, read };
}

/** Every known device and the runner's attempts and cache, kept equal while nothing moved. */
export function useSharedSettingsSnapshot(): SharedSettingsSnapshot {
  const source = useSharedSettingsSource();
  const store = useMemo(() => createSnapshotStore(source), [source]);
  const snapshot = useSyncExternalStore(store.subscribe, store.read, store.read);
  const extra = useSettingsTargetDevice();
  return useMemo(
    () =>
      extra === null ||
      snapshot.devices.some((device) => device.environmentId === extra.environmentId)
        ? snapshot
        : { ...snapshot, devices: [...snapshot.devices, extra] },
    [extra, snapshot],
  );
}

/**
 * The device shared rows use on "All devices" while the device the page shows cannot be used
 * (`pickSharedRowsDevice`); null while `enabled` is false or no device can be written now. Only
 * the id: a config push re-renders nothing unless the choice changes.
 */
export function useSharedRowsDevice(
  enabled: boolean,
  preferred: EnvironmentId | null,
): EnvironmentId | null {
  const source = useSharedSettingsSource();
  const read = () => (enabled ? pickSharedRowsDevice(source.readDevices(), preferred) : null);
  return useSyncExternalStore(source.subscribeDevices, read, read);
}

/**
 * The device the settings show, as a write target, for a source that does not list it (the
 * frozen phone tier's own device, a node opened before the device list caught up). Writable
 * as the settings page's own rows are: connected, and not read-only for this client.
 */
export function settingsTargetDevice(target: SettingsTarget): NodeSettingsTarget {
  return {
    environmentId: target.environmentId,
    label: target.nodeLabel,
    config: target.serverConfig,
    connected: target.connected && target.serverConfig !== null,
    canWrite: target.canManage !== false && target.canMutate !== false,
    write: async (patch) => {
      if (target.primary) {
        applySettingsUpdated(await ensureLocalApi().server.updateSettings(patch));
        return;
      }
      await updateEnvironmentServerSettings(target.environmentId, patch);
    },
  };
}

/**
 * The settings target, else this app's own device from its server config (rows rendered
 * outside the settings page's target, as `useSettings` reads them).
 */
function useSettingsTargetDevice(): NodeSettingsTarget | null {
  const target = useSettingsTarget();
  const primaryConfig = useServerConfig();
  return useMemo(() => {
    if (target !== null) return settingsTargetDevice(target);
    if (primaryConfig === null) return null;
    return settingsTargetDevice({
      environmentId: primaryConfig.environment.environmentId,
      nodeLabel: primaryConfig.environment.label,
      serverConfig: primaryConfig,
      primary: true,
      connected: true,
    });
  }, [primaryConfig, target]);
}
