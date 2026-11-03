/**
 * Simulated devices for shared-settings tests (tests only): each applies a write the way a
 * node does (`applyServerSettingsPatch`, which carries the node's sharing rules), and a real
 * runner keeps them converged, as this app's runtime does.
 */
import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import { createSettingsSharingClock } from "@ryco/client-runtime/state/settings/settingsSharingClock";
import { nextSettingsSharingStamp } from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import {
  createSettingsSharingRunner,
  executeSettingsSharingCommand,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettingsRunner";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ServerConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@ryco/contracts";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { SETTINGS_SHARING_VERSION } from "@ryco/shared/settingsSharing";
import { useSyncExternalStore, type ReactNode } from "react";

import { SettingsTargetProvider } from "../../../settingsTarget";
import type { SharedSettingsSource } from "./sharedSettingsSource";

export interface TestDevice {
  readonly environmentId: EnvironmentId;
  label: string;
  config: ServerConfig;
  connected: boolean;
  canWrite: boolean;
  /** A message for a patch this device refuses (a path invalid there). */
  reject: ((patch: ServerSettingsPatch) => string | null) | null;
  readonly writes: ServerSettingsPatch[];
}

export function testDeviceConfig(input: {
  readonly environmentId: EnvironmentId;
  readonly settings?: Partial<ServerSettings>;
  /** Null: an older Ryco without shared settings. */
  readonly sharingVersion?: number | null;
  readonly capabilities?: Record<string, unknown>;
  /** Other config fields (`chats`, ...). */
  readonly extra?: Partial<ServerConfig>;
}): ServerConfig {
  return {
    environment: {
      environmentId: input.environmentId,
      label: input.environmentId,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        projectPreferences: true,
        ...input.capabilities,
        ...(input.sharingVersion === null
          ? {}
          : { settingsSharingVersion: input.sharingVersion ?? SETTINGS_SHARING_VERSION }),
      },
    },
    settings: { ...DEFAULT_SERVER_SETTINGS, ...input.settings },
    providers: [],
    ...input.extra,
  } as unknown as ServerConfig;
}

export function createTestSharedSettings(
  initial: ReadonlyArray<{
    readonly id: string;
    readonly label?: string;
    readonly settings?: Partial<ServerSettings>;
    readonly connected?: boolean;
    readonly canWrite?: boolean;
    readonly sharingVersion?: number | null;
    readonly capabilities?: Record<string, unknown>;
    readonly extra?: Partial<ServerConfig>;
  }>,
) {
  const listeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const notifyState = () => {
    revision += 1;
    for (const listener of Array.from(stateListeners)) listener();
  };
  const devices: TestDevice[] = initial.map((entry) => {
    const environmentId = EnvironmentId.make(entry.id);
    return {
      environmentId,
      label: entry.label ?? entry.id,
      config: testDeviceConfig({
        environmentId,
        ...(entry.settings === undefined ? {} : { settings: entry.settings }),
        ...(entry.sharingVersion === undefined ? {} : { sharingVersion: entry.sharingVersion }),
        ...(entry.capabilities === undefined ? {} : { capabilities: entry.capabilities }),
        ...(entry.extra === undefined ? {} : { extra: entry.extra }),
      }),
      connected: entry.connected ?? true,
      canWrite: entry.canWrite ?? true,
      reject: null,
      writes: [],
    };
  });
  // Read targets keep their identity while nothing changed, like the app's reads.
  let targets: ReadonlyArray<NodeSettingsTarget> = [];
  const rebuild = () => {
    targets = devices.map((device): NodeSettingsTarget => ({
      environmentId: device.environmentId,
      label: device.label,
      config: device.config,
      connected: device.connected,
      canWrite: device.canWrite,
      write: async (patch) => {
        if (!device.connected) throw new Error("not connected");
        const refused = device.reject?.(patch) ?? null;
        if (refused !== null) throw new Error(refused);
        device.writes.push(patch);
        device.config = {
          ...device.config,
          settings: applyServerSettingsPatch(device.config.settings, patch),
        };
        rebuild();
        // The node's config push.
        queueMicrotask(notify);
        return device.config.settings;
      },
    }));
  };
  rebuild();
  const clock = createSettingsSharingClock({ clientId: "test-client", now: Date.now });
  const runner = createSettingsSharingRunner({
    readTargets: () => targets,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clock,
    debounceMs: 10,
    retry: { initialMs: 50, maxMs: 200 },
    onAttemptsChange: notifyState,
  });
  const source: SharedSettingsSource = {
    readDevices: () => targets,
    subscribeDevices: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readState: () => ({ attempts: runner.readAttempts(), cache: runner.readCache() }),
    readStateRevision: () => revision,
    subscribeState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    nextStamp: (current) => nextSettingsSharingStamp(clock, current, runner.readCache()),
    run: async (command, extra = []) => {
      const result = await executeSettingsSharingCommand([...targets, ...extra], command);
      runner.noteCommand(command, result);
      notifyState();
      return result;
    },
  };
  const device = (id: string): TestDevice => {
    const found = devices.find((entry) => entry.environmentId === id);
    if (!found) throw new Error(`No test device ${id}`);
    return found;
  };
  return {
    source,
    runner,
    devices,
    device,
    /** Changes a device as its config push or connection change would. */
    update: (id: string, change: (device: TestDevice) => void) => {
      change(device(id));
      rebuild();
      notify();
    },
    settings: (id: string) => device(id).config.settings,
    subscribe: source.subscribeDevices,
  };
}

export type TestSharedSettings = ReturnType<typeof createTestSharedSettings>;

/** The settings target of one simulated device, following its config as it changes. */
export function TestDeviceTarget(props: {
  readonly network: TestSharedSettings;
  readonly id: string;
  readonly children: ReactNode;
}) {
  const { network, id } = props;
  const read = () => network.source.readDevices().find((entry) => entry.environmentId === id);
  const target = useSyncExternalStore(network.subscribe, read, read);
  if (target === undefined) return null;
  return (
    <SettingsTargetProvider
      value={{
        environmentId: target.environmentId,
        nodeLabel: target.label,
        serverConfig: target.config as ServerConfig,
        primary: false,
        connected: target.connected,
        canManage: target.canWrite,
      }}
    >
      {props.children}
    </SettingsTargetProvider>
  );
}
