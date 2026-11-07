import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/**
 * Where a simulator an agent opens shows up: floating over the chat, or as a
 * device tab in the workspace panel.
 */
export function DeviceAutoShowFloatingSetting() {
  const enabled = useSettings((settings) => settings.deviceAutoShowFloating);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      title="Float devices agents open"
      description="Show a simulator an agent starts or opens in a small window over the chat. Off opens it as a tab in the workspace panel."
      resetAction={
        enabled !== DEFAULT_UNIFIED_SETTINGS.deviceAutoShowFloating ? (
          <SettingResetButton
            label="float devices agents open"
            onClick={() =>
              updateSettings({
                deviceAutoShowFloating: DEFAULT_UNIFIED_SETTINGS.deviceAutoShowFloating,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ deviceAutoShowFloating: Boolean(checked) })
          }
          aria-label="Float devices agents open over the chat"
        />
      }
    />
  );
}
