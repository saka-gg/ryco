import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import { createSettingsSharingRuntime } from "@ryco/client-runtime/state/settings/settingsSharingRuntime";

import { readCachedMobileHubProfile } from "../../../hostedHub/hubProfile";
import { useHostedHubStore } from "../../../hostedHub/state";
import { uuidv4 } from "../../../lib/uuid";
import { createMobileSettingsSharingStorage } from "../../../platform/settingsSharingStorage";
import { mobileSettingsSharingNamespace } from "./settingsSharingNamespace";

/** Whose devices the phone's sharing state serves now (`mobileSettingsSharingNamespace`). */
export function readMobileSettingsSharingNamespace() {
  return mobileSettingsSharingNamespace(
    useHostedHubStore.getState(),
    readCachedMobileHubProfile()?.origin,
  );
}

/**
 * The phone's shared-device-settings runtime (`createSettingsSharingRuntime`, as on the web):
 * its client id, clock and cache in the phone's own storage, per namespace, and the nodes the
 * phone lists as write targets. `SettingsSharingBridge` publishes those targets and runs the
 * runtime while the app is in the foreground; settings screens send their edits through it.
 */

let targets: ReadonlyArray<NodeSettingsTarget> = [];
const targetListeners = new Set<() => void>();

/** Every node the phone lists, as write targets read when Home last rendered them. */
export function publishSettingsSharingTargets(next: ReadonlyArray<NodeSettingsTarget>): void {
  if (next === targets) return;
  targets = next;
  for (const listener of Array.from(targetListeners)) listener();
}

export function readSettingsSharingTargets(): ReadonlyArray<NodeSettingsTarget> {
  return targets;
}

function subscribeSettingsSharingTargets(listener: () => void): () => void {
  targetListeners.add(listener);
  return () => {
    targetListeners.delete(listener);
  };
}

function subscribeHostedAccount(listener: () => void): () => void {
  let last = JSON.stringify(readMobileSettingsSharingNamespace());
  const unsubscribe = useHostedHubStore.subscribe(() => {
    const next = JSON.stringify(readMobileSettingsSharingNamespace());
    if (next === last) return;
    last = next;
    listener();
  });
  return () => void unsubscribe();
}

export const mobileSettingsSharing = createSettingsSharingRuntime({
  readNamespace: () => readMobileSettingsSharingNamespace(),
  subscribeNamespace: subscribeHostedAccount,
  storage: createMobileSettingsSharingStorage(),
  generateId: uuidv4,
  readTargets: readSettingsSharingTargets,
  subscribeTargets: subscribeSettingsSharingTargets,
});
