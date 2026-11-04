/**
 * Simulated devices for shared-settings tests: each applies a patch the way a node does
 * (`applyServerSettingsPatch`, which carries the node's sharing rules) and notifies listeners,
 * like a config push.
 */
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@ryco/contracts/settings";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { SETTINGS_SHARING_VERSION, recordWrittenSettingValues } from "@ryco/shared/settingsSharing";

import type { NodeSettingsConfig, NodeSettingsTarget } from "./nodeSettingsTargets.ts";

export interface SimulatedDevice {
  readonly environmentId: EnvironmentId;
  settings: ServerSettings;
  connected: boolean;
  canWrite: boolean;
  /** Its sharing version; null: an older Ryco without the capability. */
  sharingVersion: number | null;
  /**
   * Its home folder: like a node, it records a shared path as written, then stores `~/…` paths
   * (worktree root, chats folder) expanded against it. Undefined stores paths as written.
   */
  home: string | undefined;
  /** Throws with this message for a patch it refuses. */
  reject: ((patch: ServerSettingsPatch) => string | null) | null;
  readonly writes: ServerSettingsPatch[];
  readonly target: () => NodeSettingsTarget;
}

export function createDeviceNetwork() {
  const listeners = new Set<() => void>();
  const devices: SimulatedDevice[] = [];
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const add = (
    id: string,
    input: {
      readonly settings?: Partial<ServerSettings>;
      readonly connected?: boolean;
      readonly canWrite?: boolean;
      readonly sharingVersion?: number | null;
      readonly home?: string;
    } = {},
  ): SimulatedDevice => {
    const device: SimulatedDevice = {
      environmentId: EnvironmentId.make(id),
      settings: { ...DEFAULT_SERVER_SETTINGS, ...input.settings },
      connected: input.connected ?? true,
      canWrite: input.canWrite ?? true,
      sharingVersion:
        input.sharingVersion === undefined ? SETTINGS_SHARING_VERSION : input.sharingVersion,
      home: input.home,
      reject: null,
      writes: [],
      target: () => ({
        environmentId: device.environmentId,
        label: id,
        config: {
          environment: {
            capabilities:
              device.sharingVersion === null
                ? {}
                : { settingsSharingVersion: device.sharingVersion },
          },
          settings: device.settings,
        } as unknown as NodeSettingsConfig,
        connected: device.connected,
        canWrite: device.canWrite,
        write: async (patch) => {
          if (!device.connected) throw new Error("not connected");
          const refused = device.reject?.(patch) ?? null;
          if (refused !== null) throw new Error(refused);
          device.writes.push(patch);
          device.settings = applyServerSettingsPatch(
            device.settings,
            normalizePaths(recordWrittenSettingValues(patch), device.home),
          );
          void Promise.resolve().then(notify);
          return device.settings;
        },
      }),
    };
    devices.push(device);
    return device;
  };
  return {
    add,
    devices,
    notify,
    readTargets: () => devices.map((device) => device.target()),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Expands `~/` in the path settings a node normalizes, as `serverSettings.ts` does. */
function normalizePaths(patch: ServerSettingsPatch, home: string | undefined): ServerSettingsPatch {
  if (home === undefined) return patch;
  const expand = (path: string | undefined) =>
    path !== undefined && path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
  const next: Record<string, unknown> = { ...patch };
  for (const key of ["worktreeRoot", "chatsRoot"] as const) {
    const value = expand(patch[key]);
    if (value !== undefined) next[key] = value;
  }
  return next as ServerSettingsPatch;
}

/** Timers run only when the test advances them. */
export function createManualTimers(clock: { now: number }) {
  let nextId = 0;
  const pending = new Map<number, { readonly at: number; readonly callback: () => void }>();
  return {
    timers: {
      set: (callback: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { at: clock.now + ms, callback });
        return id;
      },
      clear: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    /** Moves time forward and runs every timer due by then. */
    advance: (ms: number) => {
      clock.now += ms;
      for (const [id, timer] of [...pending].toSorted(([, a], [, b]) => a.at - b.at)) {
        if (timer.at > clock.now) continue;
        pending.delete(id);
        timer.callback();
      }
    },
    pendingCount: () => pending.size,
  };
}
