import type {
  NodeSettingsApplyResult,
  NodeSettingsTarget,
} from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import { createSettingsSharingRuntime } from "@ryco/client-runtime/state/settings/settingsSharingRuntime";
import type {
  SettingsSharingAttempts,
  SettingsSharingCache,
  SettingsSharingCommand,
  SharingDevice,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import type { SettingsSharingStamp } from "@ryco/contracts/settings";

import { isHostedHubMode } from "../env";
import {
  readSettingsSharingNamespace,
  readSettingsSharingTargets,
  subscribeSettingsSharingTargets,
} from "../environments/settingsSharingTargets";
import { useHostedHubStore } from "../hostedHub/state";

/**
 * This app's shared-device-settings runtime (`createSettingsSharingRuntime`): one runner per
 * namespace (this app's own connections, or the signed-in Hub account), started once after boot
 * so a device that comes back online catches up with settings closed too. Its writes go through
 * each device's target as it is at that moment, so a hosted browser writes only through a node
 * session that grants the write now; a superseded session generation never inherits one.
 *
 * Loaded on demand (`settingsSharingStart`, and the settings page's shared rows); nothing in
 * the app entry imports it.
 */

function generateClientId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Calls `listener` when the signed-in Hub account changes (hosted only). */
function subscribeHostedAccount(listener: () => void): () => void {
  let lastAccount = useHostedHubStore.getState().account?.id;
  let lastStatus = useHostedHubStore.getState().accountStatus;
  const unsubscribe = useHostedHubStore.subscribe(() => {
    const state = useHostedHubStore.getState();
    if (state.account?.id === lastAccount && state.accountStatus === lastStatus) return;
    lastAccount = state.account?.id;
    lastStatus = state.accountStatus;
    listener();
  });
  return () => void unsubscribe();
}

const runtime = createSettingsSharingRuntime({
  readNamespace: readSettingsSharingNamespace,
  subscribeNamespace: (listener) =>
    isHostedHubMode() ? subscribeHostedAccount(listener) : () => undefined,
  storage: {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  },
  generateId: generateClientId,
  readTargets: readSettingsSharingTargets,
  subscribeTargets: subscribeSettingsSharingTargets,
});

/**
 * Starts keeping shared settings converged; the returned function stops this start. Follows
 * the signed-in Hub account: another account gets its own client id, clock and cache.
 */
export function startSettingsSharing(): () => void {
  return runtime.start();
}

/** Calls `listener` when the runner's attempts (syncing, couldn't apply) or namespace change. */
export function subscribeSettingsSharingRuntime(listener: () => void): () => void {
  return runtime.subscribe(listener);
}

/** Changes whenever {@link subscribeSettingsSharingRuntime} notifies. */
export function readSettingsSharingRuntimeRevision(): number {
  return runtime.readRevision();
}

/**
 * What rows read besides the devices: the runner's attempts and the newest-value cache. Reads
 * only; the runner is made by a start or a person's edit, never by a render.
 */
export function readSettingsSharingState(): {
  readonly attempts: SettingsSharingAttempts;
  readonly cache: SettingsSharingCache;
} {
  return runtime.readState();
}

/** A fresh stamp for a person's edit, later than every stamp the devices and the cache hold. */
export function nextSettingsSharingEditStamp(
  devices: ReadonlyArray<SharingDevice>,
): SettingsSharingStamp | null {
  return runtime.nextEditStamp(devices);
}

/**
 * Sends a person's command to the devices it writes, each re-read now, and records a shared
 * value so offline devices catch up from this client.
 */
export function runSettingsSharingCommand(
  command: SettingsSharingCommand,
  extra: ReadonlyArray<NodeSettingsTarget> = [],
): Promise<NodeSettingsApplyResult> {
  return runtime.runCommand(command, extra);
}

/** Tests only: forget the runner and its starts. */
export function __resetSettingsSharingRuntimeForTests(): void {
  runtime.reset();
}
