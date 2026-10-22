import { type ChatWidth, DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";

const CHAT_WIDTH_OPTIONS: ReadonlyArray<SettingsSelectOption<ChatWidth>> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

/** The Chat width setting: how far the timeline and composer grow on large screens. */
export function ChatWidthSetting() {
  const chatWidth = useSettings((settings) => settings.chatWidth);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      title="Chat width"
      description="How wide messages and the composer grow on large screens."
      resetAction={
        chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
          <SettingResetButton
            label="chat width"
            onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}
          />
        ) : null
      }
      control={
        <SettingsSelect
          value={chatWidth}
          onValueChange={(value) => updateSettings({ chatWidth: value })}
          options={CHAT_WIDTH_OPTIONS}
          ariaLabel="Chat width"
          width="sm"
        />
      }
    />
  );
}
