import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/** The Open chat tabs setting: open chats as tabs in the chat header on desktop and web. */
export function OpenChatTabsSetting() {
  const openChatTabs = useSettings((settings) => settings.openChatTabs);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      title="Open chat tabs"
      description="Keep the chats you open as tabs in the chat header, like a browser."
      resetAction={
        openChatTabs !== DEFAULT_UNIFIED_SETTINGS.openChatTabs ? (
          <SettingResetButton
            label="open chat tabs"
            onClick={() => updateSettings({ openChatTabs: DEFAULT_UNIFIED_SETTINGS.openChatTabs })}
          />
        ) : null
      }
      control={
        <Switch
          checked={openChatTabs}
          onCheckedChange={(checked) => updateSettings({ openChatTabs: Boolean(checked) })}
          aria-label="Show open chats as tabs"
        />
      }
    />
  );
}
