import type { NodeSettingsConfig } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";

import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";

const UNSUPPORTED_STATUS =
  "This node does not support prompt suggestions. Update the node to change this setting.";

// An older node would silently drop the key: its control stays disabled.
const nodeSuggestsPrompts = (config: NodeSettingsConfig): boolean =>
  config.environment.capabilities.promptSuggestions === true;

/** Node setting: after a Claude or Codex turn, offer the predicted next message (Tab accepts). */
export function PromptSuggestionSettings() {
  return (
    <SettingsSection title="Suggestions" owner="node">
      <SharedSettingRow
        settingKey="promptSuggestions"
        description="After a Claude or Codex turn, show the message you are likely to send next in the empty composer. Tab fills it in, Escape hides it. Each suggestion is one extra cached request on your plan. Codex needs 0.165 or later; open Claude chats pick up a change when their session restarts."
        knowsSetting={nodeSuggestsPrompts}
        unknownSettingStatus={UNSUPPORTED_STATUS}
        defaultValue={DEFAULT_UNIFIED_SETTINGS.promptSuggestions}
        resetLabel="suggest next prompt"
        render={(control) => (
          <Switch
            checked={control.value}
            disabled={control.disabled}
            onCheckedChange={(checked) => control.onChange(Boolean(checked))}
            aria-label={sharedControlLabel("Suggest next prompt", control)}
          />
        )}
      />
    </SettingsSection>
  );
}
