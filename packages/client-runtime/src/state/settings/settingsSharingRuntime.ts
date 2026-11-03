/**
 * An app's shared-device-settings runtime (docs/shared-device-settings.md): one runner per
 * namespace (the app's own connections, or one Hub account), its persisted client id, clock and
 * newest-value cache, and the way a person's edit is stamped and sent. The web and the mobile
 * app each make one with their own storage, namespace and device list; everything else is here.
 *
 * - `start()` is counted: the runner runs while any start holds, and the last stop stops it and
 *   forgets it (the next start reads the persisted cache again).
 * - The namespace is read again on every start, edit and namespace change, so another account
 *   gets its own client id, clock and cache, and a runner never outlives its account.
 * - Every write goes through each device's target as it is at that moment (`readTargets`): a
 *   hosted session that lost its write grant, or a newer session generation, never inherits one.
 *
 * Effectful but platform-free (no DOM or React Native): storage, ids, time and devices are
 * injected. Kept off the `state/settings` index, which the app shell imports.
 */
import type { SettingsSharingStamp } from "@ryco/contracts/settings";

import type { NodeSettingsApplyResult, NodeSettingsTarget } from "./nodeSettingsTargets.ts";
import {
  createScopedSettingsSharingPersistence,
  settingsSharingNamespaceKey,
  type SettingsSharingClock,
  type SettingsSharingNamespace,
  type SettingsSharingStorage,
} from "./settingsSharingClock.ts";
import {
  nextSettingsSharingStamp,
  type SettingsSharingAttempts,
  type SettingsSharingCache,
  type SettingsSharingCommand,
  type SharingDevice,
} from "./sharedDeviceSettings.ts";
import {
  createSettingsSharingRunner,
  executeSettingsSharingCommand,
  type SettingsSharingRunner,
  type SettingsSharingRunnerOptions,
} from "./sharedDeviceSettingsRunner.ts";

export interface SettingsSharingRuntimeOptions {
  /** Whose devices the sharing state serves now; null while there is no one (signed out). */
  readonly readNamespace: () => SettingsSharingNamespace | null;
  /** Calls the listener when the namespace may have changed (an account change). */
  readonly subscribeNamespace?: (listener: () => void) => () => void;
  /** Synchronous string storage for the client id, clock and cache. */
  readonly storage: SettingsSharingStorage;
  readonly generateId: () => string;
  readonly now?: () => number;
  /** Every known device as a write target, read now. */
  readonly readTargets: SettingsSharingRunnerOptions["readTargets"];
  readonly subscribeTargets: SettingsSharingRunnerOptions["subscribe"];
  /** Runner overrides, for tests (timers, debounce). */
  readonly runner?: Pick<SettingsSharingRunnerOptions, "timers" | "debounceMs" | "retry">;
}

export interface SettingsSharingRuntime {
  /** Starts keeping shared settings converged; the returned function stops this start. */
  readonly start: () => () => void;
  /** Whether a start holds now. */
  readonly running: () => boolean;
  /** Calls the listener when the runner's attempts (syncing, couldn't apply) or namespace change. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Changes whenever {@link SettingsSharingRuntime.subscribe} notifies. */
  readonly readRevision: () => number;
  /** What rows read besides the devices. Reads only: never makes a runner. */
  readonly readState: () => {
    readonly attempts: SettingsSharingAttempts;
    readonly cache: SettingsSharingCache;
  };
  /** A fresh stamp for a person's edit; null while there is no namespace. */
  readonly nextEditStamp: (devices: ReadonlyArray<SharingDevice>) => SettingsSharingStamp | null;
  /**
   * Sends a person's command to the devices it writes, each read now (`extra`: devices the
   * caller knows that `readTargets` does not), and records a shared value so offline devices
   * catch up from this client.
   */
  readonly runCommand: (
    command: SettingsSharingCommand,
    extra?: ReadonlyArray<NodeSettingsTarget>,
  ) => Promise<NodeSettingsApplyResult>;
  /** Tests only: forget the runner, its starts and listeners. */
  readonly reset: () => void;
}

interface ActiveRunner {
  readonly key: string;
  readonly runner: SettingsSharingRunner;
  readonly clock: SettingsSharingClock;
}

const NO_ATTEMPTS: SettingsSharingAttempts = new Map();

export function createSettingsSharingRuntime(
  options: SettingsSharingRuntimeOptions,
): SettingsSharingRuntime {
  const now = options.now ?? Date.now;
  let active: ActiveRunner | null = null;
  let starts = 0;
  let stopNamespaceFollow: (() => void) | null = null;
  let revision = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    revision += 1;
    for (const listener of Array.from(listeners)) listener();
  };

  const stopActive = () => {
    if (active === null) return;
    active.runner.stop();
    active = null;
  };

  /** The runner of the current namespace, made when the namespace changed; null while none. */
  const currentRunner = (): ActiveRunner | null => {
    const namespace = options.readNamespace();
    if (namespace === null) {
      if (active !== null) {
        stopActive();
        notify();
      }
      return null;
    }
    const key = settingsSharingNamespaceKey(namespace);
    if (active?.key === key) return active;
    stopActive();
    const persistence = createScopedSettingsSharingPersistence({
      storage: options.storage,
      namespace,
      now,
      generateId: options.generateId,
    });
    const runner = createSettingsSharingRunner({
      readTargets: options.readTargets,
      subscribe: options.subscribeTargets,
      clock: persistence.clock,
      cache: persistence.cache,
      now,
      onAttemptsChange: notify,
      ...options.runner,
    });
    active = { key, runner, clock: persistence.clock };
    if (starts > 0) runner.start();
    notify();
    return active;
  };

  return {
    start: () => {
      starts += 1;
      if (starts === 1) {
        stopNamespaceFollow = options.subscribeNamespace?.(() => void currentRunner()) ?? null;
        currentRunner()?.runner.start();
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        starts -= 1;
        if (starts > 0) return;
        stopNamespaceFollow?.();
        stopNamespaceFollow = null;
        stopActive();
        notify();
      };
    },
    running: () => starts > 0,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readRevision: () => revision,
    readState: () => {
      const current = active;
      return current === null
        ? { attempts: NO_ATTEMPTS, cache: {} }
        : { attempts: current.runner.readAttempts(), cache: current.runner.readCache() };
    },
    nextEditStamp: (devices) => {
      const current = currentRunner();
      if (current === null) return null;
      return nextSettingsSharingStamp(current.clock, devices, current.runner.readCache());
    },
    runCommand: async (command, extra = []) => {
      // The namespace the edit was made in: an account switch while it is written must not
      // put this value in the next account's cache.
      const owner = currentRunner();
      const known = options.readTargets();
      const result = await executeSettingsSharingCommand(
        [
          ...known,
          // Each device is written once, through the target the runtime knows when it has one.
          ...extra.filter(
            (device) => !known.some((target) => target.environmentId === device.environmentId),
          ),
        ],
        command,
      );
      if (owner !== null && currentRunner() === owner) owner.runner.noteCommand(command, result);
      notify();
      return result;
    },
    reset: () => {
      stopNamespaceFollow?.();
      stopNamespaceFollow = null;
      stopActive();
      starts = 0;
      listeners.clear();
      revision = 0;
    },
  };
}
