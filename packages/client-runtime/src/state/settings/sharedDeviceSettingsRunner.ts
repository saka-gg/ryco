/**
 * Keeps shared device settings converged from this client: on every device config push it
 * plans the catch-up (`planSettingsSharingCatchUp`) and sends one patch per device, at most one
 * pass at a time. It never writes a device this client cannot write at that moment: each
 * device is read again right before its write, so a hosted session that lost its mutation
 * capability, or a newer session generation, never inherits a write planned under the old one.
 * A refused batch is split per key, so one value a device rejects (a path invalid there) is
 * reported as "couldn't apply" for that key alone and the others still land; a refused key is
 * retried with exponential backoff, never in a loop.
 *
 * Effectful but platform-free: targets, subscriptions, timers, persistence and the clock are
 * injected. Kept off the `state/settings` index, which the app shell imports.
 */
import type { EnvironmentId } from "@ryco/contracts";
import {
  compareSharingStamps,
  readSharingEntry,
  type ShareableServerSettingKey,
} from "@ryco/shared/settingsSharing";

import {
  nodeSettingsBlocker,
  nodeSettingsWriteFailureDetail,
  writeNodeSettingsPatches,
  type NodeSettingsApplyResult,
  type NodeSettingsTarget,
} from "./nodeSettingsTargets.ts";
import type { SettingsSharingClock } from "./settingsSharingClock.ts";
import {
  decodeSettingsSharingCache,
  mergeSettingsSharingCache,
  observeSettingsSharingStamps,
  planSettingsSharingCatchUp,
  readNewestSharedSetting,
  recordSettingsSharingCache,
  type SettingsSharingAttempt,
  type SettingsSharingAttempts,
  type SettingsSharingCache,
  type SettingsSharingCatchUpWrite,
  type SettingsSharingCommand,
  type SettingsSharingWritePart,
} from "./sharedDeviceSettings.ts";

/** How long a sent catch-up waits for the device's config to show it before it is sent again. */
export const SETTINGS_SHARING_WRITTEN_SETTLE_MS = 30_000;
export const SETTINGS_SHARING_RETRY_INITIAL_MS = 2_000;
export const SETTINGS_SHARING_RETRY_MAX_MS = 10 * 60_000;
export const SETTINGS_SHARING_DEBOUNCE_MS = 250;

/** The wait before the `tries`-th resend: doubling from the initial delay, capped. */
export function settingsSharingRetryDelay(
  tries: number,
  initialMs = SETTINGS_SHARING_RETRY_INITIAL_MS,
  maxMs = SETTINGS_SHARING_RETRY_MAX_MS,
): number {
  const exponent = Math.max(0, Math.min(tries - 1, 30));
  return Math.min(maxMs, initialMs * 2 ** exponent);
}

export interface SettingsSharingCacheStore {
  /** The persisted cache, any shape (read leniently). Scope it to the set of devices it serves. */
  readonly read: () => unknown;
  readonly write: (cache: SettingsSharingCache) => void;
}

export interface SettingsSharingTimers {
  readonly set: (callback: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface SettingsSharingRunnerOptions {
  /**
   * Every device this client knows, read now: each target's `connected` and `canWrite` must
   * reflect this moment (hosted: the node session's current mutation capability).
   */
  readonly readTargets: () => ReadonlyArray<NodeSettingsTarget>;
  /** Calls the listener whenever a device's config, connection or capability may have changed. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly clock: SettingsSharingClock;
  readonly cache?: SettingsSharingCacheStore;
  readonly now?: () => number;
  readonly timers?: SettingsSharingTimers;
  readonly debounceMs?: number;
  readonly retry?: { readonly initialMs?: number; readonly maxMs?: number };
  /** After the attempts (and so the rows' syncing / couldn't-apply states) changed. */
  readonly onAttemptsChange?: () => void;
}

export interface SettingsSharingRunner {
  readonly start: () => void;
  readonly stop: () => void;
  /** Runs a pass now (also while a debounce is pending) and resolves when it is done. */
  readonly runNow: () => Promise<void>;
  readonly readAttempts: () => SettingsSharingAttempts;
  readonly readCache: () => SettingsSharingCache;
  /** Records a value a person's command wrote, so offline devices catch up from this client. */
  readonly noteCommand: (command: SettingsSharingCommand, result: NodeSettingsApplyResult) => void;
}

const DEFAULT_TIMERS: SettingsSharingTimers = {
  set: (callback, ms) => globalThis.setTimeout(callback, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSettingsSharingRunner(
  options: SettingsSharingRunnerOptions,
): SettingsSharingRunner {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const debounceMs = options.debounceMs ?? SETTINGS_SHARING_DEBOUNCE_MS;
  const retryDelay = (tries: number) =>
    settingsSharingRetryDelay(tries, options.retry?.initialMs, options.retry?.maxMs);

  let cache: SettingsSharingCache = decodeSettingsSharingCache(options.cache?.read());
  const attempts = new Map<EnvironmentId, Map<ShareableServerSettingKey, SettingsSharingAttempt>>();
  let started = false;
  let unsubscribe: (() => void) | null = null;
  let debounceHandle: unknown = null;
  let retryHandle: unknown = null;
  let running: Promise<void> | null = null;
  let rerun = false;

  const notifyAttempts = () => options.onAttemptsChange?.();

  const setCache = (next: SettingsSharingCache) => {
    if (next === cache) return;
    cache = next;
    options.cache?.write(cache);
  };

  const setAttempt = (
    environmentId: EnvironmentId,
    key: ShareableServerSettingKey,
    attempt: SettingsSharingAttempt | null,
  ) => {
    const forDevice = attempts.get(environmentId) ?? new Map();
    if (attempt === null) forDevice.delete(key);
    else forDevice.set(key, attempt);
    if (forDevice.size === 0) attempts.delete(environmentId);
    else attempts.set(environmentId, forDevice);
  };

  /** Drops attempts a device's config settled: applied, superseded, overridden, or gone. */
  const pruneAttempts = (targets: ReadonlyArray<NodeSettingsTarget>): boolean => {
    let changed = false;
    for (const [environmentId, forDevice] of attempts) {
      const target = targets.find((entry) => entry.environmentId === environmentId);
      for (const [key, attempt] of forDevice) {
        const newest = readNewestSharedSetting(targets, key, cache);
        const entry =
          target?.config == null
            ? null
            : readSharingEntry(target.config.settings.settingsSharing, key);
        const settled =
          target === undefined ||
          newest === null ||
          compareSharingStamps(newest.stamp, attempt.stamp) !== 0 ||
          (entry !== null &&
            (entry.mode !== "shared" || compareSharingStamps(entry.stamp, attempt.stamp) >= 0));
        if (settled) {
          setAttempt(environmentId, key, null);
          changed = true;
        }
      }
    }
    return changed;
  };

  const recordOutcome = (
    environmentId: EnvironmentId,
    part: SettingsSharingWritePart,
    failure: { readonly reason: string } | null,
  ) => {
    const previous = attempts.get(environmentId)?.get(part.key);
    const tries =
      previous !== undefined && compareSharingStamps(previous.stamp, part.stamp) === 0
        ? previous.tries + 1
        : 1;
    const at = now();
    setAttempt(
      environmentId,
      part.key,
      failure === null
        ? {
            stamp: part.stamp,
            state: "written",
            tries,
            retryAt: at + Math.max(SETTINGS_SHARING_WRITTEN_SETTLE_MS, retryDelay(tries)),
          }
        : {
            stamp: part.stamp,
            state: "failed",
            reason: failure.reason,
            tries,
            retryAt: at + retryDelay(tries),
          },
    );
  };

  /** The device as it is now, if this client may write it now. */
  const writableNow = (environmentId: EnvironmentId): NodeSettingsTarget | null => {
    if (!started) return null;
    const target = options.readTargets().find((entry) => entry.environmentId === environmentId);
    return target !== undefined && nodeSettingsBlocker(target) === null ? target : null;
  };

  const sendCatchUp = async (write: SettingsSharingCatchUpWrite) => {
    const target = writableNow(write.environmentId);
    if (target === null) return;
    try {
      await target.write(write.patch);
      for (const part of write.parts) recordOutcome(write.environmentId, part, null);
      return;
    } catch (error) {
      if (write.parts.length === 1) {
        const [part] = write.parts;
        if (part !== undefined)
          recordOutcome(write.environmentId, part, {
            reason: nodeSettingsWriteFailureDetail(error) ?? "The device refused the value.",
          });
        return;
      }
    }
    // A refused batch: one key at a time, to name the key the device rejects.
    for (const part of write.parts) {
      const single = writableNow(write.environmentId);
      if (single === null) return;
      try {
        await single.write(part.patch);
        recordOutcome(write.environmentId, part, null);
      } catch (error) {
        recordOutcome(write.environmentId, part, {
          reason: nodeSettingsWriteFailureDetail(error) ?? "The device refused the value.",
        });
      }
    }
  };

  const scheduleRetry = () => {
    if (retryHandle !== null) timers.clear(retryHandle);
    retryHandle = null;
    if (!started) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const forDevice of attempts.values())
      for (const attempt of forDevice.values()) earliest = Math.min(earliest, attempt.retryAt);
    if (!Number.isFinite(earliest)) return;
    retryHandle = timers.set(
      () => {
        retryHandle = null;
        void runNow();
      },
      Math.max(0, earliest - now()),
    );
  };

  const pass = async () => {
    const targets = options.readTargets();
    observeSettingsSharingStamps(options.clock, targets, cache);
    setCache(mergeSettingsSharingCache(cache, targets));
    const pruned = pruneAttempts(targets);
    const plan = planSettingsSharingCatchUp({ devices: targets, cache, attempts, now: now() });
    if (plan.length > 0) {
      await Promise.all(plan.map(sendCatchUp));
      notifyAttempts();
    } else if (pruned) {
      notifyAttempts();
    }
  };

  const runNow = (): Promise<void> => {
    if (!started) return Promise.resolve();
    if (running !== null) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await pass();
        } while (rerun && started);
      } finally {
        running = null;
        scheduleRetry();
      }
    })();
    return running;
  };

  const schedule = () => {
    if (!started || debounceHandle !== null) return;
    debounceHandle = timers.set(() => {
      debounceHandle = null;
      void runNow();
    }, debounceMs);
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      unsubscribe = options.subscribe(schedule);
      schedule();
    },
    stop: () => {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      if (debounceHandle !== null) timers.clear(debounceHandle);
      if (retryHandle !== null) timers.clear(retryHandle);
      debounceHandle = null;
      retryHandle = null;
    },
    runNow,
    readAttempts: () => attempts,
    readCache: () => cache,
    noteCommand: (command, result) => {
      const shared = command.shared;
      const source = result.applied[0]?.environmentId;
      if (shared === null || source === undefined) return;
      setCache(
        recordSettingsSharingCache(cache, command.key, {
          stamp: shared.stamp,
          value: shared.value as never,
          source,
        }),
      );
      schedule();
    },
  };
}

/**
 * Sends a person's command: each device its own patch through its own connection, re-checked
 * against the targets as they are now (a device that went offline or lost write access is
 * reported, not written). Devices the command skipped are not reported again.
 */
export function executeSettingsSharingCommand(
  targets: ReadonlyArray<NodeSettingsTarget>,
  command: SettingsSharingCommand,
): Promise<NodeSettingsApplyResult> {
  const patches = new Map(command.writes.map((write) => [write.environmentId, write.patch]));
  return writeNodeSettingsPatches(
    targets.filter((target) => patches.has(target.environmentId)),
    (target) => patches.get(target.environmentId) ?? null,
  );
}
