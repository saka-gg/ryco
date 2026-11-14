import type { EnvironmentId } from "@ryco/contracts";
import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import {
  describeSettingsSharingResult,
  readDeviceValuesFromBeforeSharing,
  readSharedSettingViews,
  resolveDeviceDifferences,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import type { ShareableServerSettingKey } from "@ryco/shared/settingsSharing";
import { useMemo, useState } from "react";

import { Button } from "../../ui/button";
import { SettingsNotice } from "../settingsLayout";
import { SHARED_SETTING_DISPLAY } from "./sharedSettingsCatalog";
import {
  useSharedSettingsSnapshot,
  useSharedSettingsSource,
  type SharedSettingsSnapshot,
} from "./sharedSettingsSource";
import { errorMessage } from "~/lib/errorMessage";

/** The device's keys holding a value from before sharing, unlike the shared one. */
function useValuesFromBeforeSharing(
  snapshot: SharedSettingsSnapshot,
  environmentId: EnvironmentId,
): ReadonlyArray<ShareableServerSettingKey> {
  return useMemo(
    () =>
      readDeviceValuesFromBeforeSharing(
        readSharedSettingViews({
          devices: snapshot.devices,
          cache: snapshot.cache,
          attempts: snapshot.attempts,
        }),
        environmentId,
      ),
    [environmentId, snapshot],
  );
}

function settingTitles(keys: ReadonlyArray<ShareableServerSettingKey>): string {
  const titles = keys.map((key) => SHARED_SETTING_DISPLAY[key].title);
  return titles.length <= 4
    ? titles.join(", ")
    : `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more`;
}

/**
 * "<device> has N settings that differ from your shared ones": a device that never took a
 * shared write (added later, or updated to share settings) keeps its own values until a person
 * chooses (docs/shared-device-settings.md). "Use shared values" gives it the shared ones,
 * "Keep its own" makes them its own values; one write either way. Renders nothing while the
 * device has none.
 */
export function DeviceSharingPrompt({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const source = useSharedSettingsSource();
  const snapshot = useSharedSettingsSnapshot();
  const keys = useValuesFromBeforeSharing(snapshot, environmentId);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const device = snapshot.devices.find((entry) => entry.environmentId === environmentId);
  if (device === undefined || (keys.length === 0 && outcome === null)) return null;
  if (keys.length === 0)
    return (
      <SettingsNotice role="status" className="mb-3">
        {outcome}
      </SettingsNotice>
    );
  const writable = device.connected && device.canWrite && device.config !== null;

  const resolve = async (choice: "shared" | "own") => {
    const stamp = source.nextStamp(snapshot.devices);
    if (stamp === null) {
      setOutcome("Shared settings are not ready yet. Try again.");
      return;
    }
    const command = resolveDeviceDifferences({
      device,
      devices: snapshot.devices,
      keys,
      choice,
      stamp,
      cache: snapshot.cache,
    });
    if (command === null) return;
    setBusy(true);
    setOutcome(null);
    try {
      const extra: ReadonlyArray<NodeSettingsTarget> = snapshot.devices.filter(
        (entry) =>
          !source.readDevices().some((known) => known.environmentId === entry.environmentId),
      );
      const result = await source.run(command, extra);
      setOutcome(describeSettingsSharingResult(command, result));
    } catch (error) {
      setOutcome(errorMessage(error, "The change was not saved."));
    }
    setBusy(false);
  };

  return (
    <SettingsNotice
      tone="warning"
      role="status"
      className="mb-3"
      title={`${device.label} has ${keys.length} ${
        keys.length === 1 ? "setting" : "settings"
      } that differ${keys.length === 1 ? "s" : ""} from your shared ones`}
      action={
        <span className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !writable}
            onClick={() => void resolve("shared")}
          >
            Use shared values
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !writable}
            onClick={() => void resolve("own")}
          >
            Keep its own
          </Button>
        </span>
      }
    >
      <span data-testid="device-sharing-prompt" data-device={environmentId}>
        {settingTitles(keys)}.{" "}
        {writable
          ? "Nothing changes on it until you choose."
          : device.connected
            ? `Only an owner of ${device.label} can choose.`
            : `Choose once ${device.label} is connected.`}
        {outcome ? <span className="block">{outcome}</span> : null}
      </span>
    </SettingsNotice>
  );
}

/** One prompt per device that has values from before sharing (All devices). */
export function DeviceSharingPrompts() {
  const snapshot = useSharedSettingsSnapshot();
  if (snapshot.devices.length < 2) return null;
  return (
    <>
      {snapshot.devices.map((device) => (
        <DeviceSharingPrompt key={device.environmentId} environmentId={device.environmentId} />
      ))}
    </>
  );
}
