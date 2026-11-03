import type { EnvironmentId } from "@ryco/contracts";
import {
  readDeviceSharingDifferences,
  readSharedSettingViews,
  type SharedSettingDeviceState,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import { readShareableSettingValue } from "@ryco/shared/settingsSharing";
import { useMemo } from "react";

import { Button } from "../../ui/button";
import { settingsSection } from "../settingsRegistry";
import { SettingsCard, SettingsRow, SettingsSection } from "../settingsLayout";
import { openSharedSetting } from "./openSharedSetting";
import { formatSharedSettingValue, SHARED_SETTING_DISPLAY } from "./sharedSettingsCatalog";
import { useSharedSettingsSnapshot } from "./sharedSettingsSource";

function stateLabel(state: SharedSettingDeviceState): string {
  switch (state.kind) {
    case "override":
      return "Own value";
    case "queued":
      return state.reason === "offline" ? "Queued until online" : "Queued for an owner";
    case "syncing":
      return "Syncing";
    case "couldNotApply":
      return `Couldn't apply: ${state.reason}`;
    case "unsupported":
      return "Needs an update to share settings";
    case "unknown":
    case "shared":
      return "";
  }
}

/**
 * A device page's "Where this device differs": its shared settings with their own value,
 * waiting for it, or refused by it, each with Open.
 * Self-contained: it reads every device itself.
 */
export function DeviceSharingDifferences({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const snapshot = useSharedSettingsSnapshot();
  const differences = useMemo(
    () =>
      readDeviceSharingDifferences(
        readSharedSettingViews({
          devices: snapshot.devices,
          cache: snapshot.cache,
          attempts: snapshot.attempts,
        }),
        environmentId,
      ),
    [environmentId, snapshot],
  );
  const device = snapshot.devices.find((entry) => entry.environmentId === environmentId);
  // One device never differs from itself.
  if (device === undefined || snapshot.devices.length < 2) return null;
  return (
    <div data-testid="device-sharing-differences">
      <SettingsSection title="Where this device differs" bare>
        <SettingsCard>
          {differences.length === 0 ? (
            <SettingsRow
              title="Matches the other devices"
              description="This device matches the others on every shared setting."
            />
          ) : (
            differences.map(({ key, state }) => {
              const display = SHARED_SETTING_DISPLAY[key];
              const value = device.config
                ? formatSharedSettingValue(
                    key,
                    readShareableSettingValue(device.config.settings, key),
                  )
                : "—";
              return (
                <SettingsRow
                  key={key}
                  title={display.title}
                  description={`${settingsSection(display.section).title} · here: ${value}`}
                  status={stateLabel(state)}
                  control={
                    <Button size="xs" variant="outline" onClick={() => openSharedSetting(key)}>
                      Open
                    </Button>
                  }
                />
              );
            })
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
