import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";

import { useAppPreferencesLabel } from "../../deviceName";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

/** The clock format timestamps use. Appearance on the settings page. */
export function TimeFormatSetting() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const localScopeLabel = useAppPreferencesLabel();
  return (
    <SettingsRow
      title="Time format"
      description="System default follows your browser or OS clock preference."
      owner="client"
      scope={localScopeLabel}
      resetAction={
        settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
          <SettingResetButton
            label="time format"
            onClick={() =>
              updateSettings({
                timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={settings.timestampFormat}
          onValueChange={(value) => {
            if (value === "locale" || value === "12-hour" || value === "24-hour") {
              updateSettings({ timestampFormat: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Timestamp format">
            <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="locale">
              {TIMESTAMP_FORMAT_LABELS.locale}
            </SelectItem>
            <SelectItem hideIndicator value="12-hour">
              {TIMESTAMP_FORMAT_LABELS["12-hour"]}
            </SelectItem>
            <SelectItem hideIndicator value="24-hour">
              {TIMESTAMP_FORMAT_LABELS["24-hour"]}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
