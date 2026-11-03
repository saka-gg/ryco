import type {
  NodeSettingsApplyResult,
  NodeSettingsTarget,
} from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import {
  createScopedSettingsSharingPersistence,
  settingsSharingNamespaceKey,
  type SettingsSharingClock,
  type SettingsSharingStorage,
} from "@ryco/client-runtime/state/settings/settingsSharingClock";
import {
  nextSettingsSharingStamp,
  type SettingsSharingAttempts,
  type SettingsSharingCache,
  type SettingsSharingCommand,
  type SharingDevice,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import {
  createSettingsSharingRunner,
  executeSettingsSharingCommand,
  type SettingsSharingRunner,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettingsRunner";
import type { SettingsSharingStamp } from "@ryco/contracts/settings";

import { isHostedHubMode } from "../env";
import {
  readSettingsSharingNamespace,
  readSettingsSharingTargets,
  subscribeSettingsSharingTargets,
} from "../environments/settingsSharingTargets";
import { useHostedHubStore } from "../hostedHub/state";

/**
 * This app's shared-device-settings runner (docs/shared-device-settings.md): one per namespace
 * (this app's own connections, or the signed-in Hub account), started once after boot so a
 * device that comes back online catches up with settings closed too. Its writes go through
 * each device's target as it is at that moment, so a hosted browser writes only through a
 * node session that grants the write now; a superseded session generation never inherits one.
 *
 * Loaded on demand (`settingsSharingStart`, and the settings page's shared rows); nothing in
 * the app entry imports it.
 */

interface ActiveRunner {
  readonly key: string;
  readonly runner: SettingsSharingRunner;
  readonly clock: SettingsSharingClock;
}

let active: ActiveRunner | null = null;
let starts = 0;
let stopNamespaceFollow: (() => void) | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function notify(): void {
  revision += 1;
  for (const listener of Array.from(listeners)) listener();
}

function browserStorage(): SettingsSharingStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  };
}

function generateClientId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function stopActive(): void {
  if (active === null) return;
  active.runner.stop();
  active = null;
}

/** The runner of the current namespace, made when the namespace changed; null while none. */
function currentRunner(): ActiveRunner | null {
  const namespace = readSettingsSharingNamespace();
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
    storage: browserStorage(),
    namespace,
    now: Date.now,
    generateId: generateClientId,
  });
  const runner = createSettingsSharingRunner({
    readTargets: readSettingsSharingTargets,
    subscribe: subscribeSettingsSharingTargets,
    clock: persistence.clock,
    cache: persistence.cache,
    onAttemptsChange: notify,
  });
  active = { key, runner, clock: persistence.clock };
  if (starts > 0) runner.start();
  notify();
  return active;
}

/**
 * Starts keeping shared settings converged; the returned function stops this start. Follows
 * the signed-in Hub account: another account gets its own client id, clock and cache.
 */
export function startSettingsSharing(): () => void {
  starts += 1;
  if (starts === 1) {
    if (isHostedHubMode()) {
      let lastAccount = useHostedHubStore.getState().account?.id;
      let lastStatus = useHostedHubStore.getState().accountStatus;
      const unsubscribe = useHostedHubStore.subscribe(() => {
        const state = useHostedHubStore.getState();
        if (state.account?.id === lastAccount && state.accountStatus === lastStatus) return;
        lastAccount = state.account?.id;
        lastStatus = state.accountStatus;
        currentRunner();
      });
      stopNamespaceFollow = () => void unsubscribe();
    }
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
}

/** Calls `listener` when the runner's attempts (syncing, couldn't apply) or namespace change. */
export function subscribeSettingsSharingRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever {@link subscribeSettingsSharingRuntime} notifies. */
export function readSettingsSharingRuntimeRevision(): number {
  return revision;
}

const NO_ATTEMPTS: SettingsSharingAttempts = new Map();

/**
 * What rows read besides the devices: the runner's attempts and the newest-value cache. Reads
 * only; the runner is made by a start or a person's edit, never by a render.
 */
export function readSettingsSharingState(): {
  readonly attempts: SettingsSharingAttempts;
  readonly cache: SettingsSharingCache;
} {
  const current = active;
  return current === null
    ? { attempts: NO_ATTEMPTS, cache: {} }
    : { attempts: current.runner.readAttempts(), cache: current.runner.readCache() };
}

/** A fresh stamp for a person's edit, later than every stamp the devices and the cache hold. */
export function nextSettingsSharingEditStamp(
  devices: ReadonlyArray<SharingDevice>,
): SettingsSharingStamp | null {
  const current = currentRunner();
  if (current === null) return null;
  return nextSettingsSharingStamp(current.clock, devices, current.runner.readCache());
}

/**
 * Sends a person's command to the devices it writes, each re-read now, and records a shared
 * value so offline devices catch up from this client.
 */
export async function runSettingsSharingCommand(
  command: SettingsSharingCommand,
  extra: ReadonlyArray<NodeSettingsTarget> = [],
): Promise<NodeSettingsApplyResult> {
  const result = await executeSettingsSharingCommand(
    [...readSettingsSharingTargets(), ...extra],
    command,
  );
  const current = currentRunner();
  current?.runner.noteCommand(command, result);
  notify();
  return result;
}

/** Tests only: forget the runner and its starts. */
export function __resetSettingsSharingRuntimeForTests(): void {
  stopNamespaceFollow?.();
  stopNamespaceFollow = null;
  stopActive();
  starts = 0;
  listeners.clear();
  revision = 0;
}
