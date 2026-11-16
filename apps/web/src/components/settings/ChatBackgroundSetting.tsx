import {
  CHAT_BACKGROUND_OPTIONS,
  hasAppearancePreferenceOverride,
  type AppearancePreferenceKey,
  type ChatBackgroundPreference,
} from "../../themes/appearancePreferences";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";

const OPTIONS: ReadonlyArray<SettingsSelectOption<ChatBackgroundPreference>> =
  CHAT_BACKGROUND_OPTIONS.map((option) => ({ value: option.value, label: option.label }));

/** Appearance → Chat background: the animated field behind an empty chat. */
export function ChatBackgroundSetting({
  value,
  onChange,
  onReset,
}: {
  readonly value: string;
  readonly onChange: (key: AppearancePreferenceKey, value: string) => void;
  readonly onReset: (key: AppearancePreferenceKey) => void;
}) {
  return (
    <SettingsRow
      title="Chat background"
      description="An animated field behind new, empty chats. Click empty space to stir it. Reduced motion keeps it still."
      resetAction={
        hasAppearancePreferenceOverride("chatBackground") ? (
          <SettingResetButton label="chat background" onClick={() => onReset("chatBackground")} />
        ) : null
      }
      control={
        <SettingsSelect
          value={value as ChatBackgroundPreference}
          onValueChange={(next) => onChange("chatBackground", next)}
          options={OPTIONS}
          ariaLabel="Chat background"
          width="sm"
        />
      }
    />
  );
}
