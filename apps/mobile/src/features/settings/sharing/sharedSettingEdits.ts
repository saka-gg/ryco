import type {
  NodeSettingsApplyResult,
  NodeSettingsTarget,
} from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import type { SettingsSharingRuntime } from "@ryco/client-runtime/state/settings/settingsSharingRuntime";
import {
  describeSettingsSharingResult,
  editDeviceSetting,
  // Not a React hook: the command "Use … everywhere" sends.
  useSettingEverywhere as settingEverywhereCommand,
  type SettingsSharingSkipReason,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import type { EnvironmentId } from "@ryco/contracts";
import type {
  ShareableServerSettingKey,
  ShareableSettingValue,
} from "@ryco/shared/settingsSharing";

/**
 * The phone's edits of shared device settings (docs/shared-device-settings.md), through the same
 * commands as the web's settings rows, so an edit never turns a shared setting into a node's own
 * value by accident:
 *
 * - An edit on one node's panel gives that node its own value (`editDeviceSetting`), stamped, or
 *   keeps the only node on the shared value.
 * - "Use on every node" is one shared write (`useSettingEverywhere`): every node this phone may
 *   change now takes it, own values included, and offline nodes catch up when any Ryco client
 *   sees them again.
 */

/** What an edit needs of the phone's sharing runtime. */
export type SharedSettingEditRuntime = Pick<SettingsSharingRuntime, "nextEditStamp" | "runCommand">;

const SKIP_MESSAGES: Record<SettingsSharingSkipReason, string> = {
  offline: "Connect this node to change it.",
  "read-only": "Connect as the node owner to change this.",
  override: "This node keeps its own value.",
  unsupported: "Update this node to change this here.",
  unknown: "This node's settings have not loaded yet.",
};

function failureMessage(result: NodeSettingsApplyResult): string | null {
  const refused = result.notApplied[0];
  if (refused === undefined) return null;
  if (refused.reason === "failed") return refused.detail ?? `${refused.label} refused the value.`;
  return refused.reason === "read-only" ? SKIP_MESSAGES["read-only"] : SKIP_MESSAGES.offline;
}

/**
 * Saves one node's value of a shared setting. Throws with the reason when it was not saved, as
 * a plain settings write does.
 */
export async function saveNodeSharedSetting<K extends ShareableServerSettingKey>(input: {
  readonly runtime: SharedSettingEditRuntime;
  /** Every node the phone knows, as write targets (`homeNodeSettingsTargets`). */
  readonly targets: ReadonlyArray<NodeSettingsTarget>;
  readonly environmentId: EnvironmentId;
  readonly key: K;
  readonly value: ShareableSettingValue<K>;
}): Promise<void> {
  const { runtime, targets } = input;
  const stamp = runtime.nextEditStamp(targets);
  if (stamp === null) throw new Error("Shared settings are not ready yet. Try again.");
  const command = editDeviceSetting({
    devices: targets,
    environmentId: input.environmentId,
    key: input.key,
    value: input.value,
    stamp,
  });
  if (command === null) throw new Error(SKIP_MESSAGES.unknown);
  const skipped = command.skipped[0];
  if (command.writes.length === 0 && skipped !== undefined)
    throw new Error(SKIP_MESSAGES[skipped.reason]);
  const failure = failureMessage(await runtime.runCommand(command, targets));
  if (failure !== null) throw new Error(failure);
}

/**
 * Gives every node this value: one shared write to every node the phone may change now, and
 * the rest when they reconnect. Says in one line what it did.
 */
export async function applySharedSettingToAllNodes<K extends ShareableServerSettingKey>(input: {
  readonly runtime: SharedSettingEditRuntime;
  readonly targets: ReadonlyArray<NodeSettingsTarget>;
  readonly key: K;
  readonly value: ShareableSettingValue<K>;
}): Promise<string> {
  const { runtime, targets } = input;
  const stamp = runtime.nextEditStamp(targets);
  if (stamp === null) return "Shared settings are not ready yet. Try again.";
  const command = settingEverywhereCommand({
    devices: targets,
    key: input.key,
    value: input.value,
    stamp,
  });
  const result = await runtime.runCommand(command, targets);
  return describeSettingsSharingResult(command, result);
}
